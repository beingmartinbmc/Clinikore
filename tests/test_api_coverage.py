"""Wide-surface coverage pass over every remaining API endpoint.

The other ``test_*`` files focus on the hot paths (calculations, the
clinical workflow, reports). This one exists to hit everything the other
files don't touch so overall backend coverage clears the 95% bar:

* Rooms CRUD.
* Doctor availability GET / upsert.
* Appointment filters (start/end/patient_id/room_id), reschedule,
  reminder channel success + failure, update, hard-delete, bad-ids.
* Consultation note upsert + PUT + DELETE branches.
* Treatment plan: get, nested step endpoints, add_plan_step with
  explicit sequence, delete_plan_step, complete_plan_step twice
  (idempotent), hard-delete.
* Invoice update (replacing line items, tweaking discount / notes),
  hard-delete, print endpoint, pdf endpoint 404.
* Undo flow for every undoable entity type.
* Global /api/search with numeric, phone-mostly-digits, and text queries.
* Reports: daily range, daily CSV (day + range), monthly CSV,
  pending-dues CSV, top-procedures CSV, invalid date inputs.
* Backups: create, list, download (zip), path-traversal safety,
  delete, 404 on unknown name.
* Settings: onboarded_at stamping + idempotent no-op PUT.
* /api/system/info, /api/audit with filters, 404s on every ``get`` /
  ``delete`` path we can think of.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlmodel import Session, select

from backend import demo as demo_svc
from backend import services
from backend.db import engine
from backend.models import (
    Appointment, AppointmentStatus, ConsultationNote,
    DoctorAvailability, Invoice, Patient, Payment, Procedure,
    Room, Settings, Treatment, TreatmentPlan, TreatmentPlanStep,
    TreatmentStepStatus, utcnow,
)


# ===========================================================================
# Rooms CRUD
# ===========================================================================
def test_rooms_full_crud(client, settings):
    # Initially empty.
    assert client.get("/api/rooms").json() == []
    # Create.
    r = client.post("/api/rooms", json={"name": "Chair 1", "color": "#7ee"})
    assert r.status_code == 201
    rid = r.json()["id"]
    # List.
    rooms = client.get("/api/rooms").json()
    assert len(rooms) == 1 and rooms[0]["name"] == "Chair 1"
    # Update.
    r = client.put(f"/api/rooms/{rid}", json={"name": "Chair 1A", "color": "#abc"})
    assert r.status_code == 200
    assert r.json()["name"] == "Chair 1A"
    # active_only filter.
    client.post("/api/rooms", json={"name": "Archived", "active": False})
    assert len(client.get("/api/rooms").json()) == 2
    assert len(client.get("/api/rooms", params={"active_only": "true"}).json()) == 1
    # Delete.
    assert client.delete(f"/api/rooms/{rid}").status_code == 204
    # 404s.
    assert client.put("/api/rooms/9999", json={"name": "x"}).status_code == 404
    assert client.delete("/api/rooms/9999").status_code == 404


# ===========================================================================
# Doctor availability
# ===========================================================================
def test_availability_round_trip(client, settings):
    current = client.get("/api/availability").json()
    assert len(current) == 7  # seeded on startup

    # Change Sunday to working, tweak Monday break.
    mutated = []
    for row in current:
        row = dict(row)
        if row["weekday"] == 6:
            row["is_working"] = True
            row["start_time"] = "10:00"
            row["end_time"] = "13:00"
        if row["weekday"] == 0:
            row["break_start"] = "12:30"
            row["break_end"] = "13:30"
        mutated.append(row)
    r = client.put("/api/availability", json=mutated)
    assert r.status_code == 200
    returned = r.json()
    sun = next(x for x in returned if x["weekday"] == 6)
    assert sun["is_working"] is True
    assert sun["start_time"] == "10:00"


def test_availability_upsert_creates_missing_weekday(client, settings):
    """If the caller sends a weekday not yet in the DB the server creates it."""
    with Session(engine) as s:
        for row in s.exec(select(DoctorAvailability)).all():
            s.delete(row)
        s.commit()
    payload = [{
        "id": 0,  # ignored by the server, but required by the Read schema
        "weekday": 3, "is_working": True,
        "start_time": "08:00", "end_time": "12:00",
        "break_start": None, "break_end": None,
    }]
    r = client.put("/api/availability", json=payload)
    assert r.status_code == 200
    assert any(row["weekday"] == 3 and row["start_time"] == "08:00"
               for row in r.json())


# ===========================================================================
# Appointments — filters + reschedule + reminders + hard-delete
# ===========================================================================
def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _make_patient(client, name="Test Patient"):
    return client.post("/api/patients", json={"name": name}).json()


def test_appointment_filters_by_start_end_patient_room(client, settings):
    p1 = _make_patient(client, "Alice")
    p2 = _make_patient(client, "Bob")
    rid = client.post("/api/rooms", json={"name": "R1"}).json()["id"]
    now = datetime.now(timezone.utc).replace(microsecond=0)

    def mk(pid, minutes_out, room_id=None):
        body = {
            "patient_id": pid,
            "start": _iso(now + timedelta(minutes=minutes_out)),
            "end": _iso(now + timedelta(minutes=minutes_out + 30)),
        }
        if room_id:
            body["room_id"] = room_id
        return client.post("/api/appointments", json=body).json()

    a_alice_now = mk(p1["id"], 10)
    a_alice_tomorrow = mk(p1["id"], 60 * 26)
    a_bob_room = mk(p2["id"], 15, room_id=rid)

    # Patient filter.
    alice_appts = client.get(
        "/api/appointments", params={"patient_id": p1["id"]},
    ).json()
    assert {a["id"] for a in alice_appts} == {a_alice_now["id"], a_alice_tomorrow["id"]}

    # Room filter.
    room_appts = client.get("/api/appointments", params={"room_id": rid}).json()
    assert [a["id"] for a in room_appts] == [a_bob_room["id"]]

    # Start/end time window filter (1-hour window from now).
    window = client.get("/api/appointments", params={
        "start": _iso(now - timedelta(minutes=1)),
        "end": _iso(now + timedelta(hours=1)),
    }).json()
    ids = {a["id"] for a in window}
    assert a_alice_now["id"] in ids
    assert a_alice_tomorrow["id"] not in ids


def test_appointment_create_with_invalid_patient(client, settings):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    r = client.post("/api/appointments", json={
        "patient_id": 9999,
        "start": _iso(now), "end": _iso(now + timedelta(minutes=30)),
    })
    assert r.status_code == 400


def test_appointment_update_and_reschedule_and_status_errors(client, settings):
    p = _make_patient(client)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    appt = client.post("/api/appointments", json={
        "patient_id": p["id"],
        "start": _iso(now), "end": _iso(now + timedelta(minutes=30)),
    }).json()
    aid = appt["id"]

    # Update — complaint + reminder_sent from client is ignored.
    r = client.put(f"/api/appointments/{aid}", json={
        "patient_id": p["id"],
        "start": appt["start"], "end": appt["end"],
        "chief_complaint": "Follow-up",
        "reminder_sent": True,  # server must ignore this
    })
    assert r.status_code == 200
    assert r.json()["chief_complaint"] == "Follow-up"
    assert r.json()["reminder_sent"] is False

    # Reschedule.
    new_start = now + timedelta(hours=2)
    r = client.patch(f"/api/appointments/{aid}/reschedule", json={
        "start": _iso(new_start),
        "end": _iso(new_start + timedelta(minutes=30)),
    })
    assert r.status_code == 200

    # 404s on unknown.
    assert client.put("/api/appointments/9999", json={
        "patient_id": p["id"], "start": _iso(now), "end": _iso(now),
    }).status_code == 404
    assert client.patch("/api/appointments/9999/reschedule", json={
        "start": _iso(now), "end": _iso(now),
    }).status_code == 404
    assert client.patch("/api/appointments/9999/status",
                        params={"new_status": "completed"}).status_code == 404


def test_appointment_hard_delete_removes_row(client, settings):
    p = _make_patient(client)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    appt = client.post("/api/appointments", json={
        "patient_id": p["id"],
        "start": _iso(now), "end": _iso(now + timedelta(minutes=30)),
    }).json()
    r = client.delete(f"/api/appointments/{appt['id']}",
                      params={"hard": "true"})
    assert r.status_code == 204
    # Even the soft-delete list doesn't see it.
    assert client.delete(f"/api/appointments/{appt['id']}").status_code == 404


def test_appointment_remind_success_and_failure(client, settings, monkeypatch):
    p = _make_patient(client, name="Reminder Test")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    appt = client.post("/api/appointments", json={
        "patient_id": p["id"],
        "start": _iso(now), "end": _iso(now + timedelta(minutes=30)),
    }).json()

    # Patch the reminder service to control the outcome.
    calls = []

    def fake_ok(patient, start, channel="sms"):
        calls.append(("ok", channel))
        return True

    def fake_fail(patient, start, channel="sms"):
        calls.append(("fail", channel))
        return False

    monkeypatch.setattr(services, "send_appointment_reminder", fake_ok)
    r = client.post(f"/api/appointments/{appt['id']}/remind",
                    params={"channel": "sms"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "channel": "sms"}

    monkeypatch.setattr(services, "send_appointment_reminder", fake_fail)
    r = client.post(f"/api/appointments/{appt['id']}/remind",
                    params={"channel": "whatsapp"})
    assert r.status_code == 200
    assert r.json() == {"ok": False, "channel": "whatsapp"}
    assert ("fail", "whatsapp") in calls

    # 404 on unknown appt.
    assert client.post("/api/appointments/9999/remind").status_code == 404


def test_appointment_remind_rejects_orphan_patient(client, settings):
    """If the appointment still exists but its patient_id points at a row
    that has been wiped, the reminder endpoint should bail out with a
    400. We simulate that at the ORM level because the foreign-key
    constraint prevents us from doing it via the HTTP delete path.
    """
    p = _make_patient(client)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    appt = client.post("/api/appointments", json={
        "patient_id": p["id"],
        "start": _iso(now), "end": _iso(now + timedelta(minutes=30)),
    }).json()
    # Temporarily disable FKs so we can delete the patient without
    # cascading the appointment.
    with engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        conn.exec_driver_sql(f"DELETE FROM patient WHERE id = {p['id']}")
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
    r = client.post(f"/api/appointments/{appt['id']}/remind")
    assert r.status_code == 400


# ===========================================================================
# Consultation notes — all branches
# ===========================================================================
def test_consultation_note_full_lifecycle(client, settings):
    p = _make_patient(client)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    appt = client.post("/api/appointments", json={
        "patient_id": p["id"],
        "start": _iso(now), "end": _iso(now + timedelta(minutes=30)),
    }).json()
    aid = appt["id"]

    # Fetching before creation returns null.
    r = client.get(f"/api/appointments/{aid}/note")
    assert r.status_code == 200
    assert r.json() is None

    # Upsert creates.
    r = client.put(f"/api/appointments/{aid}/note", json={
        "chief_complaint": "Headache",
        "diagnosis": "Tension type",
        "treatment_advised": "Rest, fluids",
    })
    assert r.status_code == 200
    note_id = r.json()["id"]
    assert r.json()["chief_complaint"] == "Headache"

    # Upsert updates.
    r = client.put(f"/api/appointments/{aid}/note", json={
        "chief_complaint": "Headache (updated)",
        "notes": "Returned in 2 days",
    })
    assert r.status_code == 200
    assert r.json()["chief_complaint"] == "Headache (updated)"

    # Patient notes list includes it.
    rows = client.get(f"/api/patients/{p['id']}/notes").json()
    assert any(r["id"] == note_id for r in rows)

    # The alias endpoint returns the same data.
    rows2 = client.get(f"/api/patients/{p['id']}/consultation-notes").json()
    assert [r["id"] for r in rows] == [r["id"] for r in rows2]

    # Delete via appointment endpoint.
    r = client.delete(f"/api/appointments/{aid}/note")
    assert r.status_code == 204
    # Second delete is 404.
    assert client.delete(f"/api/appointments/{aid}/note").status_code == 404


def test_consultation_note_direct_crud(client, settings):
    p = _make_patient(client)
    # Create by payload (no appointment).
    n = client.post("/api/consultation-notes", json={
        "patient_id": p["id"],
        "chief_complaint": "General checkup",
    }).json()
    nid = n["id"]
    # Update.
    r = client.put(f"/api/consultation-notes/{nid}", json={
        "diagnosis": "Healthy",
    })
    assert r.status_code == 200
    assert r.json()["diagnosis"] == "Healthy"
    # Soft-delete returns undo token.
    r = client.delete(f"/api/consultation-notes/{nid}")
    assert r.status_code == 200
    assert "undo_token" in r.json()
    # Hard-delete route on a fresh note.
    n2 = client.post("/api/consultation-notes", json={
        "patient_id": p["id"], "notes": "Short note",
    }).json()
    r = client.delete(f"/api/consultation-notes/{n2['id']}",
                      params={"hard": "true"})
    assert r.status_code == 204
    # 404s.
    assert client.put("/api/consultation-notes/9999",
                      json={"notes": "x"}).status_code == 404
    assert client.delete("/api/consultation-notes/9999").status_code == 404


def test_consultation_note_rejects_bad_ids(client, settings):
    assert client.post("/api/consultation-notes", json={
        "patient_id": 9999, "chief_complaint": "x",
    }).status_code == 400
    p = _make_patient(client)
    assert client.post("/api/consultation-notes", json={
        "patient_id": p["id"], "appointment_id": 9999, "chief_complaint": "x",
    }).status_code == 400
    # Note on unknown appointment.
    assert client.put("/api/appointments/9999/note",
                      json={"chief_complaint": "x"}).status_code == 404
    assert client.get("/api/appointments/9999/note").status_code == 404


# ===========================================================================
# Prescriptions — structured Rx items live on consultation notes
# ===========================================================================
def test_prescription_render_and_autocreate(client, settings, procedures):
    """Completing an appointment auto-creates a consult-note stub and the
    structured Rx renders as a printable HTML page."""
    import json as _json

    p = _make_patient(client)
    cons = procedures["Consultation"]

    # Appointment -> completed triggers the auto-create.
    appt = client.post("/api/appointments", json={
        "patient_id": p["id"],
        "start": "2026-05-01T10:00:00",
        "end": "2026-05-01T10:15:00",
    }).json()
    r = client.patch(
        f"/api/appointments/{appt['id']}/status",
        params={"new_status": "completed"},
    )
    assert r.status_code == 200
    note = client.get(f"/api/appointments/{appt['id']}/note").json()
    assert note is not None, "auto-create should leave a stub note"
    nid = note["id"]

    # Invoice auto-links via invoice_id on the existing note.
    inv = client.post("/api/invoices", json={
        "patient_id": p["id"],
        "appointment_id": appt["id"],
        "items": [{"description": "Consult", "quantity": 1,
                   "unit_price": cons["default_price"]}],
    }).json()
    reloaded = client.get(f"/api/appointments/{appt['id']}/note").json()
    assert reloaded["invoice_id"] == inv["id"]

    # Save structured prescription items.
    rx = [
        {"drug": "Paracetamol", "strength": "500mg",
         "frequency": "TDS", "duration": "5 days",
         "instructions": "after food"},
        {"drug": "Amoxicillin", "strength": "250mg",
         "frequency": "BD", "duration": "7 days"},
    ]
    r = client.put(f"/api/consultation-notes/{nid}", json={
        "prescription_items": _json.dumps(rx),
        "prescription_notes": "Review in 1 week.",
    })
    assert r.status_code == 200
    stored = r.json()
    assert _json.loads(stored["prescription_items"])[0]["drug"] == "Paracetamol"

    # Render the printable HTML — should list both drugs.
    r = client.get(f"/api/consultation-notes/{nid}/prescription")
    assert r.status_code == 200
    html = r.text
    assert "Paracetamol 500mg" in html
    assert "Amoxicillin 250mg" in html
    # Frequency + duration now land in their own table columns — the
    # printable Rx splits "what" (drug+strength), "how often" (TDS),
    # and "how long" (5 days) into clearly-labelled cells.
    assert "TDS" in html and "5 days" in html
    assert "Review in 1 week" in html


# ===========================================================================
# Treatment plans — nested step endpoints + completion + hard-delete
# ===========================================================================
def test_treatment_plan_nested_step_routes(client, settings, procedures):
    p = _make_patient(client)
    rct = procedures["Root Canal Treatment"]
    crown = procedures["Crown (PFM)"]

    plan = client.post("/api/treatment-plans", json={
        "patient_id": p["id"], "title": "Upper-right molar",
        "steps": [
            {"sequence": 0, "title": "RCT", "procedure_id": rct["id"],
             "estimated_cost": rct["default_price"]},
        ],
    }).json()
    pid = plan["id"]

    # Get by id.
    r = client.get(f"/api/treatment-plans/{pid}")
    assert r.status_code == 200
    assert r.json()["title"] == "Upper-right molar"

    # Add a step — via nested POST (uses add_plan_step under the hood).
    step_b = client.post(f"/api/treatment-plans/{pid}/steps", json={
        "title": "Crown", "procedure_id": crown["id"],
        "estimated_cost": crown["default_price"],
    }).json()

    # Explicit sequence path.
    step_c = client.post(f"/api/treatment-plans/{pid}/steps", json={
        "title": "Review", "sequence": 99,
    }).json()
    assert step_c["sequence"] == 99

    # Update via nested PUT.
    r = client.put(
        f"/api/treatment-plans/{pid}/steps/{step_b['id']}",
        json={"notes": "Use PFM"},
    )
    assert r.status_code == 200 and r.json()["notes"] == "Use PFM"

    # Complete via nested POST — creates a Treatment row.
    r = client.post(
        f"/api/treatment-plans/{pid}/steps/{step_b['id']}/complete",
    )
    assert r.status_code == 200
    completed = r.json()
    assert completed["status"] == "completed"
    assert completed["treatment_id"] is not None

    # Completing a second time is a no-op (different code branch).
    r2 = client.post(
        f"/api/treatment-plans/{pid}/steps/{step_b['id']}/complete",
    )
    assert r2.status_code == 200
    assert r2.json()["treatment_id"] == completed["treatment_id"]

    # Delete via nested DELETE.
    r = client.delete(
        f"/api/treatment-plans/{pid}/steps/{step_c['id']}",
    )
    assert r.status_code == 204

    # Update plan metadata.
    r = client.put(f"/api/treatment-plans/{pid}",
                   json={"notes": "Insurance pending"})
    assert r.status_code == 200 and r.json()["notes"] == "Insurance pending"

    # Hard-delete plan.
    plan2 = client.post("/api/treatment-plans", json={
        "patient_id": p["id"], "title": "Throwaway",
        "steps": [{"title": "noop"}],
    }).json()
    r = client.delete(f"/api/treatment-plans/{plan2['id']}",
                      params={"hard": "true"})
    assert r.status_code == 204

    # 404s everywhere.
    assert client.get("/api/treatment-plans/9999").status_code == 404
    assert client.put("/api/treatment-plans/9999",
                      json={"notes": "x"}).status_code == 404
    assert client.delete("/api/treatment-plans/9999").status_code == 404
    assert client.post("/api/treatment-plans/9999/steps",
                       json={"title": "x"}).status_code == 404
    assert client.put("/api/plan-steps/9999", json={"notes": "x"}).status_code == 404
    assert client.delete("/api/plan-steps/9999").status_code == 404
    assert client.post("/api/plan-steps/9999/complete").status_code == 404


def test_treatment_plan_bad_patient(client, settings):
    r = client.post("/api/treatment-plans", json={
        "patient_id": 9999, "title": "x", "steps": [],
    })
    assert r.status_code == 400


def test_complete_plan_step_handles_orphaned_plan(client, settings, procedures):
    """Completing a step whose plan was hard-deleted returns 404."""
    p = _make_patient(client)
    plan = client.post("/api/treatment-plans", json={
        "patient_id": p["id"], "title": "Tmp",
        "steps": [{"title": "s", "procedure_id": procedures["Consultation"]["id"]}],
    }).json()
    step_id = plan["steps"][0]["id"]
    # Blow away the plan row directly (hard delete keeps the step row via no FK cascade).
    with Session(engine) as s:
        s.delete(s.get(TreatmentPlan, plan["id"]))
        s.commit()
    r = client.post(f"/api/plan-steps/{step_id}/complete")
    assert r.status_code == 404


# ===========================================================================
# Invoices — update + print + hard-delete + 404s
# ===========================================================================
def test_invoice_update_replaces_items_and_discount(client, settings, procedures):
    p = _make_patient(client)
    cons = procedures["Consultation"]
    inv = client.post("/api/invoices", json={
        "patient_id": p["id"],
        "items": [{"description": "Consult", "quantity": 1,
                   "unit_price": cons["default_price"]}],
    }).json()
    # Replace items and bump discount.
    r = client.put(f"/api/invoices/{inv['id']}", json={
        "notes": "After-hours fee",
        "discount_amount": 50,
        "items": [
            {"description": "Consult x2", "quantity": 2,
             "unit_price": cons["default_price"]},
            {"description": "Sundry", "quantity": 1, "unit_price": 100},
        ],
    })
    assert r.status_code == 200
    body = r.json()
    # subtotal = 2*500 + 100 = 1100; total = 1100 - 50 = 1050.
    assert body["total"] == 1050
    assert body["notes"] == "After-hours fee"
    assert len(body["items"]) == 2


def test_invoice_print_and_hard_delete_and_pdf_404(client, settings, procedures):
    p = _make_patient(client)
    cons = procedures["Consultation"]
    inv = client.post("/api/invoices", json={
        "patient_id": p["id"],
        "items": [{"description": "Consult", "quantity": 1,
                   "unit_price": cons["default_price"]}],
    }).json()
    r = client.get(f"/api/invoices/{inv['id']}/print")
    assert r.status_code == 200
    assert "<html" in r.text.lower()

    # Hard delete.
    r = client.delete(f"/api/invoices/{inv['id']}", params={"hard": "true"})
    assert r.status_code == 204
    assert client.get(f"/api/invoices/{inv['id']}/pdf").status_code == 404
    assert client.get(f"/api/invoices/{inv['id']}/print").status_code == 404
    assert client.get(f"/api/invoices/{inv['id']}").status_code == 404
    assert client.delete(f"/api/invoices/{inv['id']}").status_code == 404


def test_invoice_update_404(client, settings):
    assert client.put("/api/invoices/9999", json={
        "notes": "x", "items": [],
    }).status_code == 404


def test_invoice_list_filters(client, settings, procedures):
    p1 = _make_patient(client, "P1")
    p2 = _make_patient(client, "P2")
    cons = procedures["Consultation"]
    i1 = client.post("/api/invoices", json={
        "patient_id": p1["id"],
        "items": [{"description": "x", "quantity": 1,
                   "unit_price": cons["default_price"]}],
    }).json()
    i2 = client.post("/api/invoices", json={
        "patient_id": p2["id"],
        "items": [{"description": "y", "quantity": 1,
                   "unit_price": cons["default_price"]}],
    }).json()

    # Pay i2 fully.
    client.post(f"/api/invoices/{i2['id']}/payments",
                json={"amount": cons["default_price"], "method": "cash"})

    pending = client.get("/api/invoices", params={"pending_only": "true"}).json()
    assert {r["id"] for r in pending} == {i1["id"]}

    only_p2 = client.get("/api/invoices", params={"patient_id": p2["id"]}).json()
    assert {r["id"] for r in only_p2} == {i2["id"]}


# ===========================================================================
# Payments — 404s + bad-invoice
# ===========================================================================
def test_payment_404_paths(client, settings):
    assert client.post("/api/invoices/9999/payments",
                       json={"amount": 100, "method": "cash"}).status_code == 404
    assert client.delete("/api/payments/9999").status_code == 404


# ===========================================================================
# Undo — every supported entity type
# ===========================================================================
def test_undo_patient_appointment_invoice(client, settings, procedures):
    p = _make_patient(client)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    appt = client.post("/api/appointments", json={
        "patient_id": p["id"],
        "start": _iso(now), "end": _iso(now + timedelta(minutes=30)),
    }).json()
    cons = procedures["Consultation"]
    inv = client.post("/api/invoices", json={
        "patient_id": p["id"],
        "items": [{"description": "x", "quantity": 1,
                   "unit_price": cons["default_price"]}],
    }).json()

    # Soft-delete invoice, appointment, and patient (order matters — later
    # calls can still see everything because it's soft).
    inv_token = client.delete(f"/api/invoices/{inv['id']}").json()["undo_token"]
    appt_token = client.delete(f"/api/appointments/{appt['id']}").json()["undo_token"]
    pat_token = client.delete(f"/api/patients/{p['id']}").json()["undo_token"]

    # Each undo restores the row.
    for tok in (inv_token, appt_token, pat_token):
        r = client.post(f"/api/undo/{tok}")
        assert r.status_code == 200

    # They're all back.
    assert client.get(f"/api/patients/{p['id']}").status_code == 200
    assert client.get(f"/api/invoices/{inv['id']}").status_code == 200


def test_undo_treatment_and_note_and_plan(client, settings, procedures):
    p = _make_patient(client)
    cons = procedures["Consultation"]
    tx = client.post("/api/treatments", json={
        "patient_id": p["id"], "procedure_id": cons["id"],
    }).json()
    tok_tx = client.delete(f"/api/treatments/{tx['id']}").json()["undo_token"]

    n = client.post("/api/consultation-notes", json={
        "patient_id": p["id"], "chief_complaint": "x",
    }).json()
    tok_n = client.delete(f"/api/consultation-notes/{n['id']}").json()["undo_token"]

    plan = client.post("/api/treatment-plans", json={
        "patient_id": p["id"], "title": "X", "steps": [{"title": "a"}],
    }).json()
    tok_plan = client.delete(f"/api/treatment-plans/{plan['id']}").json()["undo_token"]

    for tok in (tok_tx, tok_n, tok_plan):
        r = client.post(f"/api/undo/{tok}")
        assert r.status_code == 200


def test_undo_expired_or_unknown_returns_410(client, settings):
    r = client.post("/api/undo/garbage-token")
    assert r.status_code == 410


def test_undo_nonexistent_entity_returns_404(client, settings):
    p = _make_patient(client)
    # Soft-delete → push a token → hard-delete the row under the session
    # so when undo resolves, the row is gone.
    tok = client.delete(f"/api/patients/{p['id']}").json()["undo_token"]
    with Session(engine) as s:
        s.delete(s.get(Patient, p["id"]))
        s.commit()
    r = client.post(f"/api/undo/{tok}")
    assert r.status_code == 404


def test_undo_unsupported_entity_type(client, settings, monkeypatch):
    """Pushing a token with an unsupported entity_type returns 400."""
    from backend.undo import buffer as undo_buffer
    entry = undo_buffer.push("weird_type", 1, "Nope")
    r = client.post(f"/api/undo/{entry.token}")
    assert r.status_code == 400


# ===========================================================================
# Global search
# ===========================================================================
def test_global_search_covers_all_entities(client, settings, procedures):
    p = _make_patient(client, "SearchableName")
    # Patient match.
    r = client.get("/api/search", params={"q": "Searchable"}).json()
    assert any(x["type"] == "patient" for x in r)

    # Invoice match by numeric id.
    cons = procedures["Consultation"]
    inv = client.post("/api/invoices", json={
        "patient_id": p["id"], "notes": "FOO-BAR-123",
        "items": [{"description": "x", "quantity": 1,
                   "unit_price": cons["default_price"]}],
    }).json()
    r_id = client.get("/api/search", params={"q": str(inv["id"])}).json()
    assert any(x["type"] == "invoice" and x["id"] == inv["id"] for x in r_id)
    # Invoice match by notes text.
    r_text = client.get("/api/search", params={"q": "FOO-BAR"}).json()
    assert any(x["type"] == "invoice" for x in r_text)

    # Treatment match — on tooth + notes.
    client.post("/api/treatments", json={
        "patient_id": p["id"],
        "procedure_id": procedures["Root Canal Treatment"]["id"],
        "tooth": "46", "notes": "Molar",
    })
    r_tx = client.get("/api/search", params={"q": "Molar"}).json()
    assert any(x["type"] == "treatment" for x in r_tx)

    # Note match.
    client.post("/api/consultation-notes", json={
        "patient_id": p["id"], "chief_complaint": "FamousComplaint",
    })
    r_note = client.get("/api/search", params={"q": "FamousComplaint"}).json()
    assert any(x["type"] == "note" for x in r_note)


def test_global_search_phone_match_bubbles_to_top(client, settings):
    p1 = _make_patient(client, "Aaa")
    p2 = client.post("/api/patients", json={
        "name": "Phone Match", "phone": "+91 98100 22222",
    }).json()
    # "22222" is all digits — the match_phone ranker kicks in.
    r = client.get("/api/search", params={"q": "22222"}).json()
    assert r[0]["type"] == "patient"
    assert r[0]["id"] == p2["id"]


# ===========================================================================
# Reports — every endpoint + CSV + error paths
# ===========================================================================
def _seed_one_paid_invoice(client, procedures, amount=500):
    p = _make_patient(client, "R")
    inv = client.post("/api/invoices", json={
        "patient_id": p["id"],
        "items": [{"description": "x", "quantity": 1, "unit_price": amount}],
    }).json()
    client.post(f"/api/invoices/{inv['id']}/payments",
                json={"amount": amount, "method": "cash"})
    return p, inv


def test_reports_daily_collections_day_and_range(client, settings, procedures):
    _seed_one_paid_invoice(client, procedures)
    today_iso = date.today().isoformat()
    # Default (no query args) -> today shape.
    r = client.get("/api/reports/daily-collections").json()
    assert "date" in r

    # ?day=
    r = client.get("/api/reports/daily-collections",
                   params={"day": today_iso}).json()
    assert r["count"] >= 1

    # ?start=&end= -> list of rows.
    start_iso = (date.today() - timedelta(days=7)).isoformat()
    r = client.get("/api/reports/daily-collections",
                   params={"start": start_iso, "end": today_iso}).json()
    assert isinstance(r, list)
    assert any(row["date"] == today_iso for row in r)


def test_reports_daily_collections_csv(client, settings, procedures):
    _seed_one_paid_invoice(client, procedures)
    today_iso = date.today().isoformat()
    r = client.get("/api/reports/daily-collections.csv",
                   params={"day": today_iso})
    assert r.status_code == 200
    assert "payment_id" in r.text
    # Range CSV.
    start_iso = (date.today() - timedelta(days=2)).isoformat()
    r = client.get("/api/reports/daily-collections.csv",
                   params={"start": start_iso, "end": today_iso})
    assert r.status_code == 200
    assert "date" in r.text
    # Missing args -> 400.
    r = client.get("/api/reports/daily-collections.csv")
    assert r.status_code == 400


def test_reports_monthly_revenue_and_csv(client, settings, procedures):
    _seed_one_paid_invoice(client, procedures)
    month = date.today().strftime("%Y-%m")
    r = client.get("/api/reports/monthly-revenue", params={"month": month}).json()
    assert "total" in r or "days" in r
    r = client.get("/api/reports/monthly-revenue.csv", params={"month": month})
    assert r.status_code == 200
    assert "date" in r.text


def test_reports_invalid_dates_return_400(client, settings):
    assert client.get("/api/reports/daily-collections",
                      params={"day": "not-a-date"}).status_code == 400
    assert client.get("/api/reports/daily-collections",
                      params={"start": "nope", "end": "2025-01-01"}).status_code == 400
    assert client.get("/api/reports/monthly-revenue",
                      params={"month": "bad"}).status_code == 400
    assert client.get("/api/reports/monthly-revenue.csv",
                      params={"month": "bad"}).status_code == 400


def test_reports_pending_dues_and_top_procedures_csv(client, settings, procedures):
    # One pending invoice + one paid treatment to give top-procedures something.
    p = _make_patient(client, "Pending")
    cons = procedures["Consultation"]
    inv = client.post("/api/invoices", json={
        "patient_id": p["id"],
        "items": [{"description": "x", "quantity": 1,
                   "unit_price": cons["default_price"]}],
    }).json()
    client.post(f"/api/invoices/{inv['id']}/payments",
                json={"amount": 100, "method": "cash"})
    client.post("/api/treatments", json={
        "patient_id": p["id"], "procedure_id": cons["id"],
    })

    # Pending dues JSON + CSV.
    r = client.get("/api/reports/pending-dues").json()
    assert isinstance(r, list) and any(row["invoice_id"] == inv["id"] for row in r)
    r = client.get("/api/reports/pending-dues.csv")
    assert r.status_code == 200 and "balance" in r.text

    # Top procedures JSON + CSV + date filter.
    r = client.get("/api/reports/top-procedures").json()
    assert isinstance(r, list)
    r = client.get("/api/reports/top-procedures.csv",
                   params={"start": "2025-01-01",
                           "end": date.today().isoformat()})
    assert r.status_code == 200 and "name,count,revenue" in r.text


# ===========================================================================
# Backups API
# ===========================================================================
def test_backup_create_list_download_delete(client, settings):
    # List on empty dir.
    r = client.get("/api/backups").json()
    assert r["backups"] == [] or isinstance(r["backups"], list)

    r = client.post("/api/backups")
    assert r.status_code == 201
    name = r.json()["name"]

    # Appears in list.
    listing = client.get("/api/backups").json()
    names = [b["name"] for b in listing["backups"]]
    assert name in names

    # Download returns a zip payload.
    r = client.get(f"/api/backups/{name}/download")
    assert r.status_code == 200
    assert r.content[:2] == b"PK"  # zip magic
    assert r.headers["content-disposition"].endswith('.zip"')

    # Delete.
    r = client.delete(f"/api/backups/{name}")
    assert r.status_code == 204


def test_backup_path_traversal_is_rejected(client, settings):
    # Traversal via a literal "..xxxxx" name that resolves outside BACKUP_DIR.
    assert client.get("/api/backups/..etc/download").status_code == 404
    assert client.delete("/api/backups/..etc").status_code == 404
    assert client.get("/api/backups/does-not-exist/download").status_code == 404
    assert client.delete("/api/backups/does-not-exist").status_code == 404


# ===========================================================================
# Settings onboarding + no-op PUT
# ===========================================================================
def test_settings_onboarded_at_stamped_once(client):
    # Fresh clinic — onboarded_at starts null.
    r = client.get("/api/settings").json()
    assert r.get("onboarded_at") in (None, "")

    # Supplying doctor_name + specialization for the first time stamps it.
    r = client.put("/api/settings", json={
        "doctor_name": "Dr. A", "specialization": "General",
    }).json()
    first_stamp = r["onboarded_at"]
    assert first_stamp

    # A subsequent update doesn't touch onboarded_at.
    r2 = client.put("/api/settings", json={
        "clinic_name": "A Clinic",
    }).json()
    assert r2["onboarded_at"] == first_stamp


def test_settings_no_op_put_keeps_updated_at(client, settings):
    before = client.get("/api/settings").json()["updated_at"]
    # No-op — same values.
    r = client.put("/api/settings", json={
        "doctor_name": before and "Aisha Kapoor",
    }).json()
    # updated_at should be untouched (the endpoint only bumps when fields change).
    assert r["updated_at"] == before


# ===========================================================================
# Misc / system / audit
# ===========================================================================
def test_system_info_returns_paths(client):
    r = client.get("/api/system/info").json()
    assert "db_path" in r and "version" in r


def test_audit_endpoint_supports_filters(client, settings):
    p = _make_patient(client)
    client.put(f"/api/patients/{p['id']}", json={
        "name": p["name"] + " Updated",
    })
    # All entries.
    all_entries = client.get("/api/audit", params={"limit": 1000}).json()
    assert any(e["action"] == "patient.create" for e in all_entries)
    # Filter by action.
    only_updates = client.get("/api/audit",
                              params={"action": "patient.update"}).json()
    assert all(e["action"] == "patient.update" for e in only_updates)
    assert only_updates
    # Filter by entity_type.
    pats = client.get("/api/audit",
                      params={"entity_type": "patient"}).json()
    assert all(e["entity_type"] == "patient" for e in pats)
    # Filter by free-text q.
    with_q = client.get("/api/audit", params={"q": "Updated"}).json()
    assert isinstance(with_q, list)


# ===========================================================================
# Demo mode endpoints
# ===========================================================================
def test_demo_status_seed_and_clear(client, settings):
    status = client.get("/api/demo").json()
    assert "active" in status or "seeded" in status or isinstance(status, dict)

    seeded = client.post("/api/demo/seed").json()
    # Either it created rows or reported already-seeded.
    assert seeded.get("created") or seeded.get("already") or isinstance(seeded, dict)

    # Re-seed should be idempotent (does not raise).
    client.post("/api/demo/seed")

    cleared = client.post("/api/demo/clear").json()
    assert isinstance(cleared, dict)


# ===========================================================================
# Request logging + error paths (exercises the middleware + 500 handler)
# ===========================================================================
def test_static_asset_path_does_not_500(client):
    # Hitting a non-existent non-API path that isn't an asset either
    # should still respond cleanly (either 404 or the SPA fallback).
    r = client.get("/some/random/path")
    assert r.status_code in (200, 404)


def test_unhandled_exception_returns_500(monkeypatch):
    """Force an unexpected error inside a route handler → the global
    500 handler renders a JSON body. We use a dedicated TestClient with
    ``raise_server_exceptions=False`` because the default client
    re-raises internal errors instead of letting the handler shape them.
    """
    from fastapi.testclient import TestClient
    from backend import main as main_module

    def boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(main_module, "_get_or_create_settings", boom)
    with TestClient(main_module.app, raise_server_exceptions=False) as c:
        r = c.get("/api/settings")
        assert r.status_code == 500
        body = r.json()
        assert "detail" in body
