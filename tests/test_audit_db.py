"""Persisted audit-log tests.

`backend.audit_db` stores a structured row for every create/update/delete
so the future Activity tab can render a filterable history. The file log
is separate (see `logging_setup.audit`) and is covered implicitly by the
other tests.
"""
from __future__ import annotations

from backend import audit_db
from backend.models import AuditLog, Patient


def test_record_persists_json_details(session):
    audit_db.record(
        session, "patient.create",
        entity_type="patient", entity_id=1,
        summary="New patient: Priya", name="Priya", phone="+91 98100 11111",
    )
    session.commit()

    rows = audit_db.query(session)
    assert len(rows) == 1
    row = rows[0]
    assert row.action == "patient.create"
    assert row.entity_type == "patient"
    assert row.entity_id == 1
    assert row.summary == "New patient: Priya"
    assert "Priya" in row.details_json
    assert "+91 98100 11111" in row.details_json


def test_query_filters_by_entity_type(session):
    audit_db.record(session, "patient.create", entity_type="patient", entity_id=1)
    audit_db.record(session, "invoice.create", entity_type="invoice", entity_id=10)
    audit_db.record(session, "invoice.delete", entity_type="invoice", entity_id=10)
    session.commit()

    invoices = audit_db.query(session, entity_type="invoice")
    assert len(invoices) == 2
    assert all(r.entity_type == "invoice" for r in invoices)


def test_query_text_search_matches_action_or_details(session):
    audit_db.record(session, "patient.create", entity_type="patient",
                    name="Priya Sharma")
    audit_db.record(session, "patient.create", entity_type="patient",
                    name="Rahul Mehta")
    session.commit()

    priya_hits = audit_db.query(session, q="Priya")
    assert len(priya_hits) == 1
    assert "Priya" in priya_hits[0].details_json


def test_mark_deleted_stamps_timestamp(session):
    p = Patient(name="Test")
    session.add(p)
    session.commit()
    session.refresh(p)
    assert p.deleted_at is None

    ts = audit_db.mark_deleted(session, p)
    session.commit()
    session.refresh(p)
    # SQLite round-trips datetimes as naive; compare replaced tzinfo.
    assert p.deleted_at is not None
    assert p.deleted_at.replace(tzinfo=None) == ts.replace(tzinfo=None)


def test_actor_pulled_from_settings_row(session, client, settings):
    """The DB audit record tags who did the action with the current
    doctor's name from Settings.doctor_name."""
    # `settings` fixture has pre-populated the Settings row; but `session`
    # is a separate fixture on the same engine, so we can read across.
    from sqlmodel import Session
    from backend.db import engine
    with Session(engine) as s:
        audit_db.record(s, "test.event", entity_type="test", entity_id=1,
                        summary="sanity check")
        s.commit()
        rows = audit_db.query(s)
        assert rows[0].actor == "Aisha Kapoor"
