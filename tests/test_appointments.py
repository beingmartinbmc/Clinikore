"""Appointment scheduling tests.

These cover:
  * create/update/delete through the API
  * the status lifecycle (scheduled -> completed / cancelled / no_show)
  * the tz-aware serialization fix (plan item 9 — the root cause of the
    calendar "events appear on the wrong day" bug)
  * date-window filtering used by the calendar view
  * the reminder stub toggling the `reminder_sent` flag
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def test_create_appointment_requires_known_patient(client):
    r = client.post(
        "/api/appointments",
        json={
            "patient_id": 9999,
            "start": _iso(datetime.now(timezone.utc)),
            "end": _iso(datetime.now(timezone.utc) + timedelta(minutes=30)),
        },
    )
    assert r.status_code == 400


def test_create_list_filter_by_date_window(client, patient):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    today = client.post(
        "/api/appointments",
        json={
            "patient_id": patient["id"],
            "start": _iso(now + timedelta(hours=1)),
            "end": _iso(now + timedelta(hours=1, minutes=30)),
            "chief_complaint": "Check-up",
        },
    ).json()
    yesterday = client.post(
        "/api/appointments",
        json={
            "patient_id": patient["id"],
            "start": _iso(now - timedelta(days=1)),
            "end": _iso(now - timedelta(days=1) + timedelta(minutes=20)),
        },
    ).json()

    # Full list returns both, newest... we don't care about order, just IDs.
    r = client.get("/api/appointments")
    assert r.status_code == 200
    ids = {a["id"] for a in r.json()}
    assert {today["id"], yesterday["id"]}.issubset(ids)

    # Filter to today-only window.
    start = (now - timedelta(hours=1)).isoformat()
    end = (now + timedelta(days=1)).isoformat()
    r = client.get("/api/appointments", params={"start": start, "end": end})
    assert r.status_code == 200
    ids = {a["id"] for a in r.json()}
    assert today["id"] in ids
    assert yesterday["id"] not in ids


def test_appointment_serialized_with_timezone(client, patient):
    """Root cause check for the calendar-day-shift bug: the server must
    emit datetimes with an explicit offset so the browser doesn't assume
    local time."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    r = client.post(
        "/api/appointments",
        json={
            "patient_id": patient["id"],
            "start": _iso(now),
            "end": _iso(now + timedelta(minutes=30)),
        },
    )
    assert r.status_code == 201
    body = r.json()
    for key in ("start", "end", "created_at"):
        val = body[key]
        assert val.endswith(("Z", "+00:00")) or "+" in val, (
            f"{key}={val!r} is tz-naive — will render on the wrong day on the frontend"
        )


def test_status_transitions(client, patient):
    now = datetime.now(timezone.utc)
    r = client.post(
        "/api/appointments",
        json={
            "patient_id": patient["id"],
            "start": _iso(now),
            "end": _iso(now + timedelta(minutes=30)),
        },
    )
    aid = r.json()["id"]
    assert r.json()["status"] == "scheduled"

    # Move through each terminal state.
    for new in ("completed", "cancelled", "no_show"):
        r = client.patch(f"/api/appointments/{aid}/status", params={"new_status": new})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == new


def test_update_chief_complaint_and_notes(client, patient):
    now = datetime.now(timezone.utc)
    r = client.post(
        "/api/appointments",
        json={
            "patient_id": patient["id"],
            "start": _iso(now),
            "end": _iso(now + timedelta(minutes=30)),
            "chief_complaint": "Toothache",
        },
    )
    aid = r.json()["id"]
    r = client.put(
        f"/api/appointments/{aid}",
        json={
            "patient_id": patient["id"],
            "start": _iso(now),
            "end": _iso(now + timedelta(minutes=45)),
            "chief_complaint": "Toothache + swelling",
            "notes": "Prescribed antibiotics",
        },
    )
    assert r.status_code == 200
    assert r.json()["chief_complaint"] == "Toothache + swelling"
    assert r.json()["notes"] == "Prescribed antibiotics"


def test_reminder_sets_flag(client, patient):
    now = datetime.now(timezone.utc)
    r = client.post(
        "/api/appointments",
        json={
            "patient_id": patient["id"],
            "start": _iso(now + timedelta(days=1)),
            "end": _iso(now + timedelta(days=1, minutes=30)),
        },
    )
    aid = r.json()["id"]
    assert r.json()["reminder_sent"] is False

    r = client.post(f"/api/appointments/{aid}/remind", params={"channel": "sms"})
    assert r.status_code == 200
    assert r.json()["ok"] is True

    # The flag is toggled server-side.
    r = client.get("/api/appointments")
    a = next(x for x in r.json() if x["id"] == aid)
    assert a["reminder_sent"] is True


def test_reminder_fails_without_phone(client):
    r = client.post("/api/patients", json={"name": "No Phone"})
    pid = r.json()["id"]
    now = datetime.now(timezone.utc)
    r = client.post(
        "/api/appointments",
        json={
            "patient_id": pid,
            "start": _iso(now),
            "end": _iso(now + timedelta(minutes=30)),
        },
    )
    aid = r.json()["id"]
    r = client.post(f"/api/appointments/{aid}/remind")
    assert r.status_code == 200
    # Stub returns ok=False when there's no phone to send to.
    assert r.json()["ok"] is False
