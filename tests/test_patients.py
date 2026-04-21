"""Patient CRUD — the most fundamental resource. Everything else (appts,
treatments, invoices) foreign-keys to a patient, so regressions here break
the whole app."""
from __future__ import annotations


def test_create_and_fetch_patient(client):
    r = client.post(
        "/api/patients",
        json={"name": "Rahul Mehta", "age": 52, "phone": "+91 98100 22222"},
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["id"] > 0
    assert created["name"] == "Rahul Mehta"
    assert created["age"] == 52

    # Fetch it back by id.
    r = client.get(f"/api/patients/{created['id']}")
    assert r.status_code == 200
    fetched = r.json()
    assert fetched["phone"] == "+91 98100 22222"
    # ISO-8601 shape. Note: SQLite does not preserve tzinfo on round-trip,
    # so `created_at` comes back tz-naive. The calendar event-shift fix
    # (plan item 9) is applied to Appointment.start/.end specifically —
    # see test_appointments.test_appointment_serialized_with_timezone.
    assert "T" in fetched["created_at"]


def test_list_filters_by_name_and_phone(client, patient):
    client.post("/api/patients", json={"name": "Vikram Singh", "phone": "+91 98100 44444"})
    client.post("/api/patients", json={"name": "Ananya Patel", "phone": "+91 98100 33333"})

    r = client.get("/api/patients", params={"q": "Vikram"})
    assert r.status_code == 200
    names = [p["name"] for p in r.json()]
    assert names == ["Vikram Singh"]

    # Phone search works on partial matches too.
    r = client.get("/api/patients", params={"q": "33333"})
    assert [p["name"] for p in r.json()] == ["Ananya Patel"]


def test_update_patient(client, patient):
    r = client.put(
        f"/api/patients/{patient['id']}",
        json={"name": patient["name"], "age": 35, "notes": "Updated"},
    )
    assert r.status_code == 200
    assert r.json()["age"] == 35
    assert r.json()["notes"] == "Updated"


def test_get_missing_patient_404(client):
    r = client.get("/api/patients/99999")
    assert r.status_code == 404


def test_soft_delete_returns_undo_token(client, patient):
    """Soft-delete keeps the row (with ``deleted_at`` set) and returns an
    undo token the UI wires up to the "Undo" toast button."""
    r = client.delete(f"/api/patients/{patient['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["undo_token"]
    assert body["entity_type"] == "patient"
    assert body["entity_id"] == patient["id"]
    # After soft-delete the patient is hidden from GET.
    assert client.get(f"/api/patients/{patient['id']}").status_code == 404


def test_undo_soft_delete_restores(client, patient):
    """POST /api/undo/{token} must clear `deleted_at` so the row
    re-appears in list/get."""
    del_res = client.delete(f"/api/patients/{patient['id']}").json()
    token = del_res["undo_token"]

    r = client.post(f"/api/undo/{token}")
    assert r.status_code == 200
    # Row is back.
    assert client.get(f"/api/patients/{patient['id']}").status_code == 200


def test_hard_delete_removes_row(client, patient):
    r = client.delete(f"/api/patients/{patient['id']}", params={"hard": "true"})
    assert r.status_code == 204
    assert client.get(f"/api/patients/{patient['id']}").status_code == 404
