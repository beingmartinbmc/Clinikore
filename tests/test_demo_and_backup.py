"""Demo-seeding and backup tests.

Demo mode must be idempotent and its teardown must only remove rows that
it created. Backups must produce a physical copy of the SQLite DB file
on disk and leave the list endpoint reporting it.
"""
from __future__ import annotations

import os
from pathlib import Path

from backend.db import APP_DIR


def test_demo_status_initially_inactive(client):
    r = client.get("/api/demo")
    assert r.status_code == 200
    assert r.json()["active"] is False
    assert r.json()["demo_patients"] == 0


def test_demo_seed_creates_patients_idempotently(client):
    r = client.post("/api/demo/seed")
    assert r.status_code == 200
    body = r.json()
    assert body["created"] is True
    assert body["patients"] >= 5
    # Richer seed now includes more invoices and pre-filled consultation
    # notes with prescriptions so the Consultations page has content out
    # of the box.
    assert body["invoices"] >= 4
    assert body["notes"] >= 3

    # Second call is a no-op.
    again = client.post("/api/demo/seed").json()
    assert again["created"] is False

    status = client.get("/api/demo").json()
    assert status["active"] is True
    assert status["demo_patients"] >= 5


def test_demo_seed_produces_prescriptions_visible_in_listing(client):
    """The global /api/consultation-notes endpoint should return the seeded
    notes, at least some of which carry structured prescriptions so the
    Consultations page can render 'Print Rx' buttons."""
    client.post("/api/demo/seed")
    notes = client.get("/api/consultation-notes").json()
    assert len(notes) >= 3, notes
    with_rx = [n for n in notes if n.get("prescription_items")]
    assert len(with_rx) >= 2, "expected demo seed to include multiple Rx notes"
    # The filter flag on the list endpoint should narrow to those.
    only_rx = client.get(
        "/api/consultation-notes", params={"has_prescription": True},
    ).json()
    assert len(only_rx) == len(with_rx)
    # Text search should find the dermatology note via its diagnosis text
    # (search covers patient name + the three SOAP fields, not the Rx JSON).
    hits = client.get(
        "/api/consultation-notes", params={"q": "acne"},
    ).json()
    assert len(hits) >= 1


def test_demo_clear_removes_only_demo_rows(client, patient):
    # `patient` is a real (non-demo) row. Seed demo, clear it, confirm
    # the real patient is still there.
    client.post("/api/demo/seed")

    before = {p["id"] for p in client.get("/api/patients").json()}
    assert patient["id"] in before
    assert len(before) > 1  # real + demo rows

    r = client.post("/api/demo/clear")
    assert r.status_code == 200
    after = {p["id"] for p in client.get("/api/patients").json()}
    assert patient["id"] in after
    assert after == {patient["id"]}


def test_backup_create_and_list(client):
    r = client.post("/api/backups")
    assert r.status_code == 201
    name = r.json()["name"]
    # Backup dir must contain the new entry on disk.
    bdir = APP_DIR / "backups" / name
    assert bdir.exists() and bdir.is_dir()

    listing = client.get("/api/backups").json()
    assert any(b["name"] == name for b in listing["backups"])


def test_system_info(client):
    r = client.get("/api/system/info")
    assert r.status_code == 200
    info = r.json()
    # Paths must reflect the tmp CLINIKORE_HOME set up in conftest.
    assert os.environ["CLINIKORE_HOME"] in info["db_path"]
    assert os.environ["CLINIKORE_HOME"] in info["backup_dir"]
