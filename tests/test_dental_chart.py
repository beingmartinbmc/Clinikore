"""Dental chart (odontogram) API tests.

We added ``ToothRecord`` + ``/api/patients/{pid}/dental-chart`` so a dentist
can persist per-tooth status, conditions and notes. These tests cover:

* Empty chart returns [] for a fresh patient.
* Upsert creates a record, subsequent PUT updates in place (no duplicate row).
* Invalid FDI codes are rejected with 422 so typos don't silently corrupt data.
* DELETE soft-deletes so the tooth reads as healthy again on next fetch.
* 404 on unknown patient.
"""
from __future__ import annotations


def _pid(client) -> int:
    r = client.post("/api/patients", json={"name": "Neha Gupta", "age": 29})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_empty_chart_for_new_patient(client):
    pid = _pid(client)
    r = client.get(f"/api/patients/{pid}/dental-chart")
    assert r.status_code == 200, r.text
    # New patients have no annotated teeth; frontend fills the 32 healthy
    # slots locally so the API only ships what was actually entered.
    assert r.json() == []


def test_upsert_tooth_creates_then_updates_in_place(client):
    pid = _pid(client)
    r = client.put(
        f"/api/patients/{pid}/dental-chart/16",
        json={"status": "caries", "conditions": "Deep mesial", "notes": "Plan RCT"},
    )
    assert r.status_code == 200, r.text
    first = r.json()
    assert first["tooth_number"] == "16"
    assert first["status"] == "caries"

    # Second PUT should mutate the same row (no duplicates).
    r = client.put(
        f"/api/patients/{pid}/dental-chart/16",
        json={"status": "root_canal"},
    )
    assert r.status_code == 200, r.text
    second = r.json()
    assert second["id"] == first["id"], "second PUT must update the same row"
    assert second["status"] == "root_canal"
    # Conditions should remain untouched when we only pass a new status.
    assert second["conditions"] == "Deep mesial"

    r = client.get(f"/api/patients/{pid}/dental-chart")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["tooth_number"] == "16"


def test_invalid_tooth_number_is_rejected(client):
    pid = _pid(client)
    # '99' is not a valid FDI code. Universal numbering users will also run
    # into this (e.g. sending "3"); the error message names the allowed
    # quadrants so the mistake is obvious.
    r = client.put(
        f"/api/patients/{pid}/dental-chart/99",
        json={"status": "caries"},
    )
    assert r.status_code == 422, r.text


def test_delete_tooth_soft_deletes_record(client):
    pid = _pid(client)
    client.put(f"/api/patients/{pid}/dental-chart/26", json={"status": "filled"})
    r = client.delete(f"/api/patients/{pid}/dental-chart/26")
    assert r.status_code == 204
    r = client.get(f"/api/patients/{pid}/dental-chart")
    assert r.json() == []


def test_chart_404_for_unknown_patient(client):
    r = client.get("/api/patients/999999/dental-chart")
    assert r.status_code == 404
    r = client.put(
        "/api/patients/999999/dental-chart/16", json={"status": "caries"}
    )
    assert r.status_code == 404


def test_deciduous_tooth_numbers_are_accepted(client):
    """Paediatric dentistry uses 51..85; make sure those are valid too."""
    pid = _pid(client)
    r = client.put(
        f"/api/patients/{pid}/dental-chart/51",
        json={"status": "caries", "notes": "child, age 4"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["tooth_number"] == "51"
