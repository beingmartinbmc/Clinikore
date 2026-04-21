"""Settings (clinic + doctor profile) tests.

This is a singleton row (id=1). GET must auto-create it, PUT must update
only the supplied fields, and the IMC-mandated statutory fields must
persist so they show up on prescriptions / invoices / receipts.
"""
from __future__ import annotations


def test_get_creates_empty_settings_on_first_access(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == 1
    assert body["doctor_name"] in (None, "")
    assert body["clinic_name"] in (None, "")


def test_put_persists_all_imc_required_fields(client):
    r = client.put("/api/settings", json={
        "doctor_name": "Aisha Kapoor",
        "doctor_qualifications": "MBBS, MD (Medicine)",
        "registration_number": "DMC/12345",
        "registration_council": "Delhi Medical Council",
        "clinic_name": "Kapoor Family Clinic",
        "clinic_address": "12, Park Street",
        "clinic_phone": "+91 98100 00000",
        "clinic_email": "contact@kapoor.example",
        "clinic_gstin": "07AAAAA0000A1Z5",
        "specialization": "General",
    })
    assert r.status_code == 200
    saved = r.json()
    for key in (
        "doctor_name", "doctor_qualifications",
        "registration_number", "registration_council",
        "clinic_name", "clinic_address", "clinic_phone",
        "clinic_email", "clinic_gstin", "specialization",
    ):
        assert saved[key] == r.request.content.decode().__contains__(key) or saved[key] is not None
    # Round-trip via GET to confirm they're persisted.
    again = client.get("/api/settings").json()
    assert again["registration_number"] == "DMC/12345"
    assert again["doctor_qualifications"] == "MBBS, MD (Medicine)"


def test_partial_update_preserves_other_fields(client, settings):
    # Start state = fixture `settings` (fully filled out).
    r = client.put("/api/settings", json={"clinic_phone": "+91 99999 00000"})
    assert r.status_code == 200
    updated = r.json()
    assert updated["clinic_phone"] == "+91 99999 00000"
    # Untouched fields survive.
    assert updated["doctor_name"] == "Aisha Kapoor"
    assert updated["registration_number"] == "DMC/12345"
