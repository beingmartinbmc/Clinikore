"""ConsultationNote tests (prescription / visit-note equivalent).

The plan adds structured per-visit notes via ``ConsultationNote``:
chief complaint, diagnosis, treatment_advised, free-text notes. The
HTTP routes for this resource are part of Milestone C; until then we
exercise the model via the ORM so we still get coverage for:

* One-note-per-appointment uniqueness (``appointment_id`` UNIQUE).
* Round-trip read/update with ``updated_at`` changing on edit.
* Soft delete via ``deleted_at``.

The ``treatment_advised`` field is how "prescription" content is stored —
a doctor writing "Amoxicillin 500mg BD 5 days; return in 7 days" puts
that text here, and it appears on the printable visit summary.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from backend.models import (
    Appointment,
    ConsultationNote,
    Patient,
    utcnow,
)


def _mk_patient_and_appt(s):
    p = Patient(name="Priya")
    s.add(p)
    s.commit()
    s.refresh(p)
    now = datetime.now(timezone.utc)
    a = Appointment(
        patient_id=p.id, start=now, end=now + timedelta(minutes=30),
    )
    s.add(a)
    s.commit()
    s.refresh(a)
    return p, a


def test_structured_fields_persist(session):
    p, a = _mk_patient_and_appt(session)
    note = ConsultationNote(
        patient_id=p.id,
        appointment_id=a.id,
        chief_complaint="Toothache, upper-right",
        diagnosis="Irreversible pulpitis 16",
        treatment_advised=(
            "Rx: Amoxicillin 500mg TDS x 5d, Ibuprofen 400mg PRN. "
            "Return for RCT initiation in 48h."
        ),
        notes="Anxious patient; discussed sedation option.",
    )
    session.add(note)
    session.commit()
    session.refresh(note)

    assert note.id is not None
    assert "RCT" in note.treatment_advised
    # created_at / updated_at are auto-populated.
    assert note.created_at is not None
    assert note.updated_at is not None


def test_one_note_per_appointment(session):
    """`appointment_id` is UNIQUE — attempting to attach a second note to
    the same appointment must fail at the DB level. That constraint keeps
    the visit timeline unambiguous."""
    import sqlalchemy.exc as sa_exc
    import pytest

    p, a = _mk_patient_and_appt(session)
    session.add(ConsultationNote(
        patient_id=p.id, appointment_id=a.id,
        chief_complaint="First visit",
    ))
    session.commit()

    session.add(ConsultationNote(
        patient_id=p.id, appointment_id=a.id,
        chief_complaint="Accidental duplicate",
    ))
    with pytest.raises(sa_exc.IntegrityError):
        session.commit()
    session.rollback()


def test_update_bumps_updated_at(session):
    p, a = _mk_patient_and_appt(session)
    note = ConsultationNote(patient_id=p.id, appointment_id=a.id,
                            chief_complaint="first draft")
    session.add(note)
    session.commit()
    session.refresh(note)
    original_updated = note.updated_at

    # Simulate an edit — the API layer also sets updated_at; we do it here.
    note.chief_complaint = "edited"
    note.updated_at = utcnow()
    session.add(note)
    session.commit()
    session.refresh(note)
    assert note.updated_at >= original_updated
    assert note.chief_complaint == "edited"


def test_soft_delete_via_deleted_at(session):
    p, a = _mk_patient_and_appt(session)
    note = ConsultationNote(patient_id=p.id, appointment_id=a.id)
    session.add(note)
    session.commit()
    session.refresh(note)

    note.deleted_at = utcnow()
    session.add(note)
    session.commit()
    session.refresh(note)
    assert note.deleted_at is not None


# ---------- /api/consultation-notes global listing ------------------------
def test_global_listing_returns_notes_with_patient_name(client):
    p = client.post("/api/patients", json={"name": "Rohan Das"}).json()
    client.post(
        "/api/consultation-notes",
        json={
            "patient_id": p["id"],
            "chief_complaint": "Headache",
            "diagnosis": "Tension-type headache",
        },
    )
    rows = client.get("/api/consultation-notes").json()
    assert len(rows) == 1
    assert rows[0]["patient_name"] == "Rohan Das"
    assert rows[0]["chief_complaint"] == "Headache"


def test_global_listing_filters_by_prescription_and_search(client):
    p1 = client.post("/api/patients", json={"name": "Aarav S."}).json()
    p2 = client.post("/api/patients", json={"name": "Meera K."}).json()
    # One note with a structured Rx, one without.
    client.post(
        "/api/consultation-notes",
        json={
            "patient_id": p1["id"],
            "chief_complaint": "Fever",
            "diagnosis": "Viral fever",
            "prescription_items": '[{"drug":"Paracetamol","strength":"500 mg"}]',
        },
    )
    client.post(
        "/api/consultation-notes",
        json={
            "patient_id": p2["id"],
            "chief_complaint": "BP review",
            "diagnosis": "Essential hypertension",
        },
    )
    rx_only = client.get(
        "/api/consultation-notes", params={"has_prescription": True},
    ).json()
    assert len(rx_only) == 1
    assert rx_only[0]["patient_name"] == "Aarav S."

    no_rx = client.get(
        "/api/consultation-notes", params={"has_prescription": False},
    ).json()
    assert len(no_rx) == 1
    assert no_rx[0]["patient_name"] == "Meera K."

    # Search matches patient name and SOAP fields.
    by_name = client.get(
        "/api/consultation-notes", params={"q": "Meera"},
    ).json()
    assert len(by_name) == 1

    by_complaint = client.get(
        "/api/consultation-notes", params={"q": "hypertension"},
    ).json()
    assert len(by_complaint) == 1


def test_global_listing_patient_filter(client):
    p1 = client.post("/api/patients", json={"name": "Ishaan"}).json()
    p2 = client.post("/api/patients", json={"name": "Diya"}).json()
    for pid in (p1["id"], p2["id"]):
        client.post(
            "/api/consultation-notes",
            json={"patient_id": pid, "chief_complaint": "Visit"},
        )
    rows = client.get(
        "/api/consultation-notes", params={"patient_id": p2["id"]},
    ).json()
    assert len(rows) == 1
    assert rows[0]["patient_id"] == p2["id"]


# ---------- invoice print/pdf pulls linked Rx --------------------------------
def test_invoice_print_includes_linked_prescription(client):
    """If a consultation note is linked to an invoice, the printable
    invoice and the invoice PDF should carry the prescription — otherwise
    the patient leaves with a bill that says "Rx issued" but no Rx on it.
    """
    p = client.post("/api/patients", json={"name": "Neha P."}).json()
    inv = client.post("/api/invoices", json={
        "patient_id": p["id"],
        "notes": "Acne follow-up — Rx issued.",
        "items": [{"description": "Skin Consultation",
                   "quantity": 1, "unit_price": 800}],
    }).json()
    client.post(
        "/api/consultation-notes",
        json={
            "patient_id": p["id"],
            "invoice_id": inv["id"],
            "chief_complaint": "Acne follow-up",
            "diagnosis": "Moderate acne vulgaris",
            "prescription_items": (
                '[{"drug":"Isotretinoin","strength":"20mg",'
                '"frequency":"1 cap at night","duration":"30 days",'
                '"instructions":"With food"}]'
            ),
        },
    )

    html = client.get(f"/api/invoices/{inv['id']}/print").text
    assert "Prescription (Rx)" in html
    assert "Isotretinoin 20mg" in html
    assert "30 days" in html

    pdf = client.get(f"/api/invoices/{inv['id']}/pdf").content
    assert pdf.startswith(b"%PDF-")


def test_invoice_print_without_linked_note_has_no_rx_block(client):
    p = client.post("/api/patients", json={"name": "Kiran"}).json()
    inv = client.post("/api/invoices", json={
        "patient_id": p["id"],
        "items": [{"description": "Consultation",
                   "quantity": 1, "unit_price": 500}],
    }).json()
    html = client.get(f"/api/invoices/{inv['id']}/print").text
    assert "Prescription (Rx)" not in html
