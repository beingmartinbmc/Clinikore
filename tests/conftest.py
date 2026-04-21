"""Shared pytest fixtures for the Clinikore end-to-end test suite.

Why this file exists
--------------------
`backend.db` reads the data directory from `CLINIKORE_HOME` at **import
time** and creates the SQLite engine immediately. That means we have to
redirect the app to a throwaway directory *before* any part of the
`backend.*` package gets imported. We do that here, then expose three
standard fixtures:

* ``client``   -- a ``fastapi.testclient.TestClient`` whose lifespan has
  already run (so ``init_db`` + default procedure seeding are done), with
  a completely empty user-owned dataset.
* ``session``  -- a live SQLModel ``Session`` bound to the same engine the
  app uses, for tests that want to assert DB state directly.
* ``settings`` -- a fully populated ``Settings`` singleton so PDF / HTML
  / prescription rendering code paths have clinic + doctor details.

Every test gets a fresh DB (tables truncated between tests) so ordering
can never cause flakes.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# --- 1. Redirect the app's data dir BEFORE importing backend.* --------------
_TMP_HOME = Path(tempfile.mkdtemp(prefix="clinikore-tests-"))
os.environ["CLINIKORE_HOME"] = str(_TMP_HOME)
os.environ["CLINIKORE_LOG_DIR"] = str(_TMP_HOME / "logs")

# Remove any cached imports so a previous test run in the same process
# can't keep a stale engine pointing at a different tmp dir.
for mod in list(sys.modules):
    if mod.startswith("backend"):
        del sys.modules[mod]

# Now it is safe to import. Order matters: db first, then models, then app.
from backend.db import engine, init_db  # noqa: E402
from backend import models  # noqa: E402  -- registers SQLModel metadata
from backend import main as main_module  # noqa: E402
from sqlmodel import Session, SQLModel, select  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


# --- 2. One-time schema setup ----------------------------------------------
@pytest.fixture(scope="session", autouse=True)
def _init_schema():
    """Run migrations + create_all exactly once for the whole test session."""
    init_db()
    yield


# --- 3. Per-test DB reset --------------------------------------------------
def _truncate_all():
    """Delete every row from every user-owned table. We keep the schema
    intact and let ``_seed_if_empty`` repopulate the procedure catalog from
    the TestClient lifespan."""
    with engine.begin() as conn:
        # Order matters for FKs, but since we disabled FKs in pragmas only
        # at the SQLAlchemy level, we turn them off per-connection here too.
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        # Pull table names dynamically so this keeps working as the schema
        # grows (rooms, doctoravailability, consultationnote, ...).
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).all()
        for (name,) in rows:
            conn.exec_driver_sql(f"DELETE FROM {name}")
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")


@pytest.fixture()
def client():
    """FastAPI TestClient with lifespan run. Each test starts empty."""
    _truncate_all()
    with TestClient(main_module.app) as c:
        yield c
    _truncate_all()


@pytest.fixture()
def session():
    """Raw DB session. Use only for assertions or setup the API can't do."""
    _truncate_all()
    with Session(engine) as s:
        yield s
    _truncate_all()


# --- 4. Helper fixtures ----------------------------------------------------
@pytest.fixture()
def settings(client):
    """Populate the Settings singleton with a clinic + doctor profile.

    This is what printed invoices / prescriptions / receipts need. All IMC
    1.4.2 required fields (doctor_name, qualifications, registration_number,
    registration_council) are present.
    """
    payload = {
        "doctor_name": "Aisha Kapoor",
        "doctor_qualifications": "MBBS, MD (Medicine)",
        "registration_number": "DMC/12345",
        "registration_council": "Delhi Medical Council",
        "clinic_name": "Kapoor Family Clinic",
        "clinic_address": "12, Park Street\nNew Delhi 110001",
        "clinic_phone": "+91 98100 00000",
        "clinic_email": "contact@kapoorclinic.example",
        "clinic_gstin": "07AAAAA0000A1Z5",
        "specialization": "General",
        "locale": "en",
    }
    r = client.put("/api/settings", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture()
def patient(client):
    """Create a single standard patient and return the API response."""
    r = client.post(
        "/api/patients",
        json={
            "name": "Priya Sharma",
            "age": 34,
            "phone": "+91 98100 11111",
            "email": "priya@example.com",
            "allergies": "Penicillin",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture()
def procedures(client):
    """Return the catalog of seeded procedures keyed by name.

    The lifespan handler seeds ~12 default procedures on boot whenever the
    procedure table is empty. We use them so the tests stay close to what
    the doctor actually sees in the UI.
    """
    r = client.get("/api/procedures")
    assert r.status_code == 200, r.text
    catalog = {p["name"]: p for p in r.json()}
    assert "Consultation" in catalog, "seed data missing — did _seed_if_empty run?"
    return catalog
