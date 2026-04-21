"""Procedure catalog tests.

Procedures drive the default price + default duration used downstream by
invoice lines, treatment records, and calendar auto-fill. Regressions here
cascade into wrong invoice totals, so we're strict.
"""
from __future__ import annotations


def test_seeded_catalog_is_non_empty(client, procedures):
    # The lifespan seeder inserts ~12 items; assert a handful by name.
    for expected in (
        "Consultation",
        "Follow-up Visit",
        "Root Canal Treatment",
        "Crown (PFM)",
        "Endoscopy",
        "Ear Wax Removal",
    ):
        assert expected in procedures, f"seeded procedure missing: {expected}"


def test_default_price_and_duration_used_for_new_rows(client):
    r = client.post(
        "/api/procedures",
        json={
            "name": "Specialist Opinion",
            "default_price": 1500,
            "category": "General",
            # Rely on schema default for duration (30 mins).
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["default_price"] == 1500
    assert body["default_duration_minutes"] == 30


def test_custom_duration_is_persisted(client):
    r = client.post(
        "/api/procedures",
        json={
            "name": "Long surgery",
            "default_price": 20000,
            "default_duration_minutes": 90,
            "category": "General",
        },
    )
    assert r.status_code == 201
    assert r.json()["default_duration_minutes"] == 90


def test_create_procedure_rejects_missing_category(client):
    """Every procedure needs a category so reports don't end up with
    unlabelled rows."""
    r = client.post(
        "/api/procedures",
        json={"name": "Rogue entry", "default_price": 500},
    )
    assert r.status_code == 422
    assert "category" in r.json()["detail"].lower()


def test_categories_endpoint_includes_in_use_and_suggestions(client):
    client.post(
        "/api/procedures",
        json={"name": "Acupuncture", "default_price": 800, "category": "Alternative"},
    )
    r = client.get("/api/procedures/categories")
    assert r.status_code == 200
    cats = r.json()
    assert "Alternative" in cats  # user-defined
    assert "Dental" in cats       # suggested


def test_update_procedure_price(client, procedures):
    pid = procedures["Consultation"]["id"]
    r = client.put(
        f"/api/procedures/{pid}",
        json={"name": "Consultation", "default_price": 600},
    )
    assert r.status_code == 200
    assert r.json()["default_price"] == 600


def test_delete_procedure(client):
    r = client.post("/api/procedures", json={
        "name": "Ad hoc", "default_price": 10, "category": "General",
    })
    pid = r.json()["id"]
    assert client.delete(f"/api/procedures/{pid}").status_code == 204


# ---------------------------------------------------------------------------
# Seed data: categories and descriptions
# ---------------------------------------------------------------------------
def test_seeded_procedures_have_proper_categories(procedures):
    """The seed catalog is split across multiple specialties — blanket
    "General" on everything was a bug that made dental filters blank."""
    dental = {
        "Scaling & Polishing", "Tooth Extraction", "Root Canal Treatment",
        "Crown (PFM)", "Teeth Whitening",
    }
    for name in dental:
        assert procedures[name]["category"] == "Dental", (
            f"{name} should be categorised as Dental, got "
            f"{procedures[name]['category']!r}"
        )
    assert procedures["Endoscopy"]["category"] == "Gastroenterology"
    assert procedures["Ear Wax Removal"]["category"] == "ENT"
    assert procedures["ECG"]["category"] == "Cardiology"
    assert procedures["Consultation"]["category"] == "General"


def test_seeded_procedures_have_descriptions(procedures):
    """Every seeded procedure ships with a short description so the
    Procedures page isn't all em-dashes and so reports can use the text."""
    blank = [
        name for name, p in procedures.items()
        if not (p.get("description") or "").strip()
    ]
    assert not blank, f"seeded procedures with no description: {blank}"


def test_dental_filter_returns_dental_procedures(client, procedures):
    """Selecting the Dental category in the UI filters the list
    client-side, but we also need the data to support that — at least a
    handful of rows must carry the Dental label."""
    dental_rows = [p for p in procedures.values() if p["category"] == "Dental"]
    assert len(dental_rows) >= 5, (
        f"expected at least 5 dental procedures, got {len(dental_rows)}"
    )


# ---------------------------------------------------------------------------
# Legacy backfill: old installs had every row tagged "General"
# ---------------------------------------------------------------------------
def test_backfill_reclassifies_known_procedures_tagged_general(client, session):
    """Simulate an install that seeded before categories existed and then
    got blanket-tagged "General". On next boot we re-classify known names
    back to their canonical category — but user-renamed rows are left
    alone."""
    from sqlmodel import select, delete
    from backend.models import Procedure

    # Wipe the seeded catalog and insert a "legacy" layout where every
    # known-name procedure is mis-tagged as "General" and missing its
    # description.
    session.exec(delete(Procedure))
    session.commit()
    session.add_all([
        Procedure(name="Root Canal Treatment", default_price=6000,
                  category="General", default_duration_minutes=60),
        Procedure(name="Endoscopy", default_price=4500,
                  category="General", default_duration_minutes=45),
        Procedure(name="Ear Wax Removal", default_price=800,
                  category="General", default_duration_minutes=15),
        # User-renamed custom row — we must NOT overwrite this even though
        # it's categorised as General.
        Procedure(name="Custom Handshake", default_price=1,
                  category="General", default_duration_minutes=5),
        # Missing category entirely — should fall back via keyword guess.
        Procedure(name="Dental Polishing", default_price=1000,
                  category="", default_duration_minutes=30),
    ])
    session.commit()

    # Re-run the boot-time backfill path directly.
    from backend.main import _seed_if_empty
    _seed_if_empty()

    session.expire_all()
    rows = {p.name: p for p in session.exec(select(Procedure)).all()}
    assert rows["Root Canal Treatment"].category == "Dental"
    assert rows["Root Canal Treatment"].description  # description backfilled
    assert rows["Endoscopy"].category == "Gastroenterology"
    assert rows["Ear Wax Removal"].category == "ENT"
    # User-defined row untouched.
    assert rows["Custom Handshake"].category == "General"
    # Keyword fallback picked up "dental" in the name.
    assert rows["Dental Polishing"].category == "Dental"
