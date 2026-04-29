"""Coverage tests for recently-added backend code paths.

This module targets endpoints / code branches that the existing suite doesn't
exercise, in particular:

* ``GET /api/consultation-notes/{id}/prescription.pdf``
  (render_prescription_pdf is a ~350-line function — this walks through it).
* Consult-notes list filtering (date_from / date_to / has_prescription).
* Backup download + delete + path-traversal guards.
* Attachment too-large rejection + already-deleted 404.
* Invoice → note linking via appointment_id.
* Small services.py branches (overpaid invoice, discount rendering, etc.).
* SPA fallback + `spa_fallback` path-traversal guard when no frontend build.
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timedelta

import pytest

from backend import services
from backend.models import Invoice, InvoiceItem, Patient, Settings


# ---------------------------------------------------------------------------
# Printable prescription: PDF + HTML edge cases
# ---------------------------------------------------------------------------
def _make_note_with_rx(client, patient_id: int) -> int:
    rx = [
        {"drug": "Paracetamol", "strength": "500mg",
         "frequency": "TDS", "duration": "5 days",
         "instructions": "after food"},
        # Free-text row (string, not dict) to hit the str-branch of _rx_row.
        "Salt-water gargle 3×/day",
        # Blank row is skipped.
        "",
        # Non-dict / non-string — also skipped (safety net).
        None,
        # Dict with only a drug (no strength/frequency) so empty cells render.
        {"drug": "Multivitamin"},
    ]
    note = client.post(
        "/api/consultation-notes",
        json={
            "patient_id": patient_id,
            "chief_complaint": "Fever + body-ache",
            "diagnosis": "Viral illness",
            "treatment_advised": "Rest + hydration",
            "notes": "Follow up in a week",
            "prescription_notes": "Stop if rash appears",
            "prescription_items": json.dumps(rx),
        },
    ).json()
    return note["id"]


def test_prescription_pdf_download(client, settings, patient):
    nid = _make_note_with_rx(client, patient["id"])
    r = client.get(f"/api/consultation-notes/{nid}/prescription.pdf")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.content.startswith(b"%PDF"), "not a valid PDF"
    # Filename should include sanitised patient name + zero-padded note id.
    cd = r.headers.get("content-disposition", "")
    assert "Rx_" in cd and f"{nid:05d}" in cd


def test_prescription_pdf_missing_note(client, settings):
    r = client.get("/api/consultation-notes/999999/prescription.pdf")
    assert r.status_code == 404


def test_prescription_pdf_missing_patient_linked_via_appointment(client, settings, patient, procedures):
    """Attach the note to an appointment so the PDF renderer walks the
    ``appointment_date`` branch instead of falling back to ``updated_at``."""
    appt = client.post("/api/appointments", json={
        "patient_id": patient["id"],
        "procedure_id": procedures["Consultation"]["id"],
        "start": "2026-04-22T09:00:00",
        "end": "2026-04-22T09:20:00",
    }).json()
    note = client.post("/api/consultation-notes", json={
        "patient_id": patient["id"],
        "appointment_id": appt["id"],
        "chief_complaint": "Cough",
        "prescription_items": json.dumps([
            {"drug": "Azithromycin", "strength": "500mg",
             "frequency": "OD", "duration": "3 days"},
        ]),
    }).json()
    r = client.get(f"/api/consultation-notes/{note['id']}/prescription.pdf")
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF")


def test_prescription_html_without_any_rx_rows(client, settings, patient):
    """A note with only advice / diagnosis (no drugs) should still render —
    the printed page is useful even without a medicine table."""
    n = client.post("/api/consultation-notes", json={
        "patient_id": patient["id"],
        "chief_complaint": "Routine check",
        "diagnosis": "All clear",
        "treatment_advised": "Continue lifestyle advice",
    }).json()
    r = client.get(f"/api/consultation-notes/{n['id']}/prescription")
    assert r.status_code == 200
    assert "All clear" in r.text


# ---------------------------------------------------------------------------
# Consultation note listing: date filters + has_prescription filter
# ---------------------------------------------------------------------------
def _make_note(client, pid: int, *, has_rx: bool) -> dict:
    payload = {"patient_id": pid, "chief_complaint": "x"}
    if has_rx:
        payload["prescription_items"] = json.dumps([
            {"drug": "Vit-C", "strength": "500mg"},
        ])
    return client.post("/api/consultation-notes", json=payload).json()


def test_consult_notes_filter_has_prescription(client, patient):
    with_rx = _make_note(client, patient["id"], has_rx=True)
    without = _make_note(client, patient["id"], has_rx=False)

    r = client.get("/api/consultation-notes", params={"has_prescription": "true"})
    ids = {n["id"] for n in r.json()}
    assert with_rx["id"] in ids
    assert without["id"] not in ids

    r = client.get("/api/consultation-notes", params={"has_prescription": "false"})
    ids = {n["id"] for n in r.json()}
    assert without["id"] in ids
    assert with_rx["id"] not in ids


def test_consult_notes_filter_by_iso_date_range(client, patient):
    n = _make_note(client, patient["id"], has_rx=False)
    # Both a full ISO timestamp and a date-only bound should work, because
    # the backend accepts both shapes on `date_from`/`date_to`.
    r = client.get("/api/consultation-notes", params={
        "date_from": "2020-01-01",
        "date_to": "2099-12-31T23:59:59",
    })
    assert n["id"] in {x["id"] for x in r.json()}

    # Malformed bound must be silently dropped (not 500).
    r = client.get("/api/consultation-notes", params={"date_from": "not-a-date"})
    assert r.status_code == 200

    # Date-only date_from with 'Z' should be normalised.
    r = client.get("/api/consultation-notes", params={
        "date_from": "2020-01-01T00:00:00Z",
    })
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Backups: create, list, download, delete, traversal guard
# ---------------------------------------------------------------------------
def test_backup_create_download_delete_roundtrip(client):
    r = client.post("/api/backups")
    assert r.status_code == 201, r.text
    name = r.json()["name"]

    listing = client.get("/api/backups").json()
    assert any(b["name"] == name for b in listing["backups"])

    r = client.get(f"/api/backups/{name}/download")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/zip")
    assert len(r.content) > 0

    r = client.delete(f"/api/backups/{name}")
    assert r.status_code == 204

    # After deletion the download should 404.
    r = client.get(f"/api/backups/{name}/download")
    assert r.status_code == 404


def test_backup_download_blocks_path_traversal(client):
    # ``..`` resolves to the parent directory, which sits outside BACKUP_DIR,
    # so the guard should refuse to serve it.
    r = client.get("/api/backups/../download")
    # The URL either fails the traversal check (400) or is rewritten by
    # starlette before reaching the handler (404). Both are fine — the
    # important thing is that no file is served.
    assert r.status_code in (400, 404, 405)


def test_backup_delete_blocks_path_traversal(client):
    r = client.delete("/api/backups/..")
    assert r.status_code in (400, 404, 405, 307)


def test_backup_download_404_on_unknown_name(client):
    r = client.get("/api/backups/does-not-exist/download")
    assert r.status_code == 404


def test_backup_delete_404_on_unknown_name(client):
    r = client.delete("/api/backups/does-not-exist")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Attachment edge cases: file too large + already-deleted 404
# ---------------------------------------------------------------------------
def _make_note_id(client) -> int:
    p = client.post("/api/patients", json={"name": "Tiny Patient"}).json()
    n = client.post(
        "/api/consultation-notes",
        json={"patient_id": p["id"], "chief_complaint": "x"},
    ).json()
    return n["id"]


def test_attachment_too_large_is_rejected(client, monkeypatch):
    """Pushing past the configured limit should return 413 without leaving
    a partial file behind. Monkeypatch the limit down to 8 bytes so the
    test doesn't actually have to upload megabytes of data."""
    from backend import main as main_module

    monkeypatch.setattr(main_module, "_MAX_ATTACHMENT_BYTES", 8)
    nid = _make_note_id(client)
    big = b"0123456789" * 5   # 50 bytes — comfortably over 8.
    r = client.post(
        f"/api/consultation-notes/{nid}/attachments",
        files={"file": ("big.pdf", io.BytesIO(big), "application/pdf")},
    )
    assert r.status_code == 413, r.text


def test_double_delete_attachment_returns_404(client):
    nid = _make_note_id(client)
    a = client.post(
        f"/api/consultation-notes/{nid}/attachments",
        files={"file": ("a.pdf", io.BytesIO(b"abc"), "application/pdf")},
    ).json()
    assert client.delete(f"/api/attachments/{a['id']}").status_code == 204
    # Soft-deleted — second delete should not find it.
    assert client.delete(f"/api/attachments/{a['id']}").status_code == 404
    # Nor should the file endpoint.
    assert client.get(f"/api/attachments/{a['id']}/file").status_code == 404


# ---------------------------------------------------------------------------
# Invoice → consultation note linking (both directions)
# ---------------------------------------------------------------------------
def test_invoice_note_link_via_appointment(client, patient, procedures):
    appt = client.post("/api/appointments", json={
        "patient_id": patient["id"],
        "procedure_id": procedures["Consultation"]["id"],
        "start": "2026-04-22T10:00:00",
        "end": "2026-04-22T10:15:00",
    }).json()
    note = client.post("/api/consultation-notes", json={
        "patient_id": patient["id"],
        "appointment_id": appt["id"],
        "chief_complaint": "Cold",
    }).json()
    inv = client.post("/api/invoices", json={
        "patient_id": patient["id"],
        "appointment_id": appt["id"],
        "items": [{"description": "Consult", "quantity": 1, "unit_price": 200}],
    }).json()

    # Note auto-links because invoice shares appointment_id.
    linked = client.get(f"/api/invoices/{inv['id']}/note").json()
    assert linked is not None
    assert linked["id"] == note["id"]


def test_invoice_note_link_returns_null_when_none(client, patient):
    inv = client.post("/api/invoices", json={
        "patient_id": patient["id"],
        "items": [{"description": "x", "quantity": 1, "unit_price": 100}],
    }).json()
    r = client.get(f"/api/invoices/{inv['id']}/note")
    assert r.status_code == 200
    assert r.json() is None


def test_invoice_note_link_404_on_unknown_invoice(client):
    assert client.get("/api/invoices/99999/note").status_code == 404


# ---------------------------------------------------------------------------
# services.render_invoice_pdf — overpaid + discount branches
# ---------------------------------------------------------------------------
def test_invoice_pdf_overpaid_and_with_discount(client, settings, patient):
    """Exercise the two colour branches of the balance row (overpaid,
    fully paid) plus the discount line, which the main suite skips."""
    fields = getattr(Settings, "model_fields", None) or Settings.__fields__
    s = Settings(**{k: v for k, v in settings.items() if k in fields})
    pat = Patient(id=1, name=patient["name"])
    items = [
        InvoiceItem(description="Consult", quantity=1, unit_price=500, invoice_id=1),
    ]
    inv = Invoice(
        id=1, patient_id=1,
        total=450, paid=600, discount_amount=50,
    )
    pdf = services.render_invoice_pdf(inv, pat, items, settings=s)
    assert pdf[:4] == b"%PDF"

    # Exact settle → "Fully Paid" branch.
    inv.paid = inv.total
    pdf2 = services.render_invoice_pdf(inv, pat, items, settings=s)
    assert pdf2[:4] == b"%PDF"


def test_clinic_header_legacy_wrapper(settings):
    """`_clinic_header` is a tiny shim around :class:`ClinicHeader` that
    older callers still use. Cover both the populated path and the
    settings-less fallback (which uses the hardcoded clinic defaults)."""
    fields = getattr(Settings, "model_fields", None) or Settings.__fields__
    s = Settings(**{k: v for k, v in settings.items() if k in fields})
    name, addr, phone, doctor = services._clinic_header(s)
    assert name == "Kapoor Family Clinic"
    assert "Park Street" in addr
    assert phone.endswith("00000")
    assert doctor.startswith("Aisha")

    # settings=None uses the fallback constants — doctor_name stays empty
    # (there is no fallback) but clinic_name is non-empty.
    name, addr, phone, doctor = services._clinic_header(None)
    assert name  # non-empty fallback
    assert doctor == ""


# ---------------------------------------------------------------------------
# Dashboard summary + lifecycle pending-count branch
# ---------------------------------------------------------------------------
def test_dashboard_reports_pending_treatment_patients(client, patient, procedures):
    """A patient with an active treatment plan should bump the
    ``pending_treatment_patients`` counter on /api/dashboard."""
    rct = procedures["Root Canal Treatment"]
    plan = client.post("/api/treatment-plans", json={
        "patient_id": patient["id"], "title": "Upper-right molar",
        "steps": [
            {"title": "RCT", "procedure_id": rct["id"], "sequence": 1,
             "estimated_cost": 8000},
        ],
    }).json()
    assert plan["status"] == "planned"

    summary = client.get("/api/dashboard").json()
    assert summary["pending_treatment_patients"] >= 1
    assert summary["patients"] >= 1


# ---------------------------------------------------------------------------
# Undo: token for no-op path (expired / unknown)
# ---------------------------------------------------------------------------
def test_undo_unknown_token_is_410(client):
    r = client.post("/api/undo/does-not-exist")
    assert r.status_code == 410
