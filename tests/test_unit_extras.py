"""Focused unit tests for the thin helper modules.

Everything that the API-driven tests don't reach: platform branches in
``logging_setup.default_log_dir``, the audit-DB serializer fallback and
its error swallow, the backup scheduler thread, the migration / pragma
paths in ``db.py``, and the prescription HTML renderer in
``services.render_prescription_html``.

These are pure unit tests — no TestClient — so they run fast and don't
interact with the live FastAPI app.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlmodel import Session

from backend import audit_db, backup as backup_svc, db as db_mod, logging_setup, services
from backend.db import engine
from backend.models import AuditLog, Patient, Settings


# ===========================================================================
# logging_setup.default_log_dir platform branches
# ===========================================================================
def test_default_log_dir_env_override(monkeypatch):
    monkeypatch.setenv("CLINIKORE_LOG_DIR", "/tmp/clinikore-override")
    assert logging_setup.default_log_dir() == Path("/tmp/clinikore-override")


def test_default_log_dir_darwin(monkeypatch):
    monkeypatch.delenv("CLINIKORE_LOG_DIR", raising=False)
    with patch.object(logging_setup, "sys") as fake_sys:
        fake_sys.platform = "darwin"
        result = logging_setup.default_log_dir()
    assert "Library/Logs/Clinikore" in str(result)


def test_default_log_dir_win32_with_localappdata(monkeypatch):
    monkeypatch.delenv("CLINIKORE_LOG_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", "C:\\Users\\test\\AppData\\Local")
    with patch.object(logging_setup, "sys") as fake_sys:
        fake_sys.platform = "win32"
        result = logging_setup.default_log_dir()
    assert "Clinikore" in str(result)


def test_default_log_dir_win32_without_env(monkeypatch):
    monkeypatch.delenv("CLINIKORE_LOG_DIR", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("APPDATA", raising=False)
    with patch.object(logging_setup, "sys") as fake_sys:
        fake_sys.platform = "win32"
        result = logging_setup.default_log_dir()
    assert str(result).endswith("AppData/Local/Clinikore/Logs") or \
        "Clinikore" in str(result)


def test_default_log_dir_linux_with_xdg(monkeypatch):
    monkeypatch.delenv("CLINIKORE_LOG_DIR", raising=False)
    monkeypatch.setenv("XDG_STATE_HOME", "/tmp/xdg-state")
    with patch.object(logging_setup, "sys") as fake_sys:
        fake_sys.platform = "linux"
        result = logging_setup.default_log_dir()
    assert result == Path("/tmp/xdg-state/clinikore/logs")


def test_default_log_dir_linux_without_xdg(monkeypatch):
    monkeypatch.delenv("CLINIKORE_LOG_DIR", raising=False)
    monkeypatch.delenv("XDG_STATE_HOME", raising=False)
    with patch.object(logging_setup, "sys") as fake_sys:
        fake_sys.platform = "linux"
        result = logging_setup.default_log_dir()
    assert ".local/state/clinikore/logs" in str(result)


def test_configure_logging_is_idempotent():
    first = logging_setup.configure_logging()
    second = logging_setup.configure_logging()
    assert first == second


# ===========================================================================
# audit_db: _json_default fallback + exception branch
# ===========================================================================
def test_audit_json_default_serializes_datetime():
    ts = datetime(2024, 1, 2, 3, 4, 5)
    assert audit_db._json_default(ts) == "2024-01-02T03:04:05"


def test_audit_json_default_falls_back_to_str():
    class Custom:
        def __str__(self):
            return "custom-repr"

    assert audit_db._json_default(Custom()) == "custom-repr"


def test_audit_record_swallows_exception(caplog):
    """Passing a broken Session should NOT raise — audit is best-effort."""

    class BrokenSession:
        def get(self, *a, **kw):
            raise RuntimeError("db offline")

        def add(self, *a, **kw):
            raise RuntimeError("db offline")

        def flush(self):
            raise RuntimeError("db offline")

    # Must not raise even though the session is broken.
    audit_db.record(BrokenSession(), "test.action", foo="bar")


def test_audit_record_serializes_nested_datetimes():
    with Session(engine) as s:
        audit_db.record(
            s, "unit.test",
            entity_type="unit", entity_id=1,
            when=datetime(2025, 6, 1, 12, 0, 0),
        )
        s.commit()
        row = s.exec(
            # Most-recent entry.
            __import__("sqlmodel").select(AuditLog)
            .order_by(AuditLog.id.desc())
            .limit(1)
        ).first()
    assert row is not None
    details = json.loads(row.details_json)
    assert details["when"] == "2025-06-01T12:00:00"


# ===========================================================================
# backup module: prune_backups + list_backups + scheduler
# ===========================================================================
def test_prune_backups_on_missing_root(tmp_path):
    assert backup_svc.prune_backups(tmp_path / "does-not-exist") == 0


def test_list_backups_on_missing_root(tmp_path):
    assert backup_svc.list_backups(tmp_path / "does-not-exist") == []


def test_list_backups_reads_manifest_and_falls_back(tmp_path):
    # A valid-looking backup folder with manifest.
    good = tmp_path / "20250101-120000"
    good.mkdir()
    (good / "manifest.json").write_text(json.dumps({"tables": {"patient": 3}}))
    (good / "clinic.sqlite").write_bytes(b"fake")

    # A folder with a broken manifest.
    bad = tmp_path / "20250102-000000"
    bad.mkdir()
    (bad / "manifest.json").write_text("{not-json")
    (bad / "clinic.sqlite").write_bytes(b"fake")

    # A folder whose name can't be parsed as a date.
    weird = tmp_path / "custom-label"
    weird.mkdir()

    # A plain file — should be skipped.
    (tmp_path / "loose.txt").write_text("ignored")

    entries = backup_svc.list_backups(tmp_path)
    names = {e.name for e in entries}
    assert "20250101-120000" in names
    assert "20250102-000000" in names
    assert "custom-label" in names
    assert "loose.txt" not in names
    # The one with a manifest has the table counts parsed through.
    good_entry = next(e for e in entries if e.name == "20250101-120000")
    assert good_entry.tables == {"patient": 3}


def test_prune_backups_removes_oldest(tmp_path):
    for name in ("20240101-000000", "20240102-000000",
                 "20240103-000000", "20240104-000000"):
        (tmp_path / name).mkdir()
    removed = backup_svc.prune_backups(tmp_path, keep=2)
    assert removed == 2
    remaining = [p.name for p in tmp_path.iterdir() if p.is_dir()]
    assert set(remaining) == {"20240103-000000", "20240104-000000"}


def test_backup_scheduler_starts_and_stops(tmp_path, monkeypatch):
    """Start the scheduler with a very-short interval, let it tick once,
    then stop it cleanly. This exercises the _loop, _safe_backup and
    start/stop branches without leaving threads hanging around."""
    db_file = tmp_path / "fake.db"
    db_file.write_bytes(b"SQLite format 3\0")  # minimum marker

    # Bypass the real create_backup — we're just verifying the loop runs.
    hit = {"calls": 0}

    def fake_create_backup(*a, **kw):
        hit["calls"] += 1
        out = tmp_path / "backups" / "fake"
        out.mkdir(parents=True, exist_ok=True)
        (out / "manifest.json").write_text("{}")
        return out

    monkeypatch.setattr(backup_svc, "create_backup", fake_create_backup)
    monkeypatch.setattr(backup_svc, "BACKUP_ON_STARTUP", True)

    sched = backup_svc.BackupScheduler(
        db_path=db_file, backup_root=tmp_path / "backups",
        interval_hours=1 / 3600,  # ~1 second (clamped to 60s by __init__)
    )
    sched.start()
    # start() should be idempotent.
    sched.start()
    assert sched._thread is not None and sched._thread.is_alive()

    # Give the immediate-on-startup tick a moment to run.
    for _ in range(20):
        if hit["calls"] > 0:
            break
        time.sleep(0.05)
    sched.stop()
    assert not sched._thread.is_alive()
    assert hit["calls"] >= 1


def test_backup_scheduler_loop_catches_errors(tmp_path, monkeypatch):
    """Even if create_backup raises, the scheduler must not die."""
    db_file = tmp_path / "fake.db"
    db_file.write_bytes(b"")

    def boom(*a, **kw):
        raise RuntimeError("disk full")

    monkeypatch.setattr(backup_svc, "create_backup", boom)
    monkeypatch.setattr(backup_svc, "BACKUP_ON_STARTUP", True)

    sched = backup_svc.BackupScheduler(
        db_path=db_file, backup_root=tmp_path / "backups",
    )
    # Call the private helper directly; it should swallow the exception.
    sched._safe_backup()


def test_backup_scheduler_prune_log_branch(tmp_path, monkeypatch):
    """Hit the branch that logs "Pruned N old backup(s)" after a tick."""
    db_file = tmp_path / "fake.db"
    db_file.write_bytes(b"SQLite format 3\0")
    # Pre-populate with >retention folders.
    root = tmp_path / "backups"
    for name in ("20240101-000000", "20240102-000000",
                 "20240103-000000", "20240104-000000"):
        (root / name).mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(backup_svc, "create_backup",
                        lambda *a, **kw: root / "20240105-000000")
    # Make a fake newer folder so there's something newer than the pruned ones.
    (root / "20240105-000000").mkdir(parents=True, exist_ok=True)

    sched = backup_svc.BackupScheduler(
        db_path=db_file, backup_root=root,
    )
    sched.keep = 2  # force prune
    sched._safe_backup()


# ===========================================================================
# db.py — migration path coverage
# ===========================================================================
def test_apply_migrations_is_idempotent():
    # Run _apply_migrations twice — the existing-column short-circuit path
    # runs on the second call, covering the 'column in existing' branch.
    db_mod._apply_migrations()
    db_mod._apply_migrations()


def test_apply_migrations_skips_missing_table(monkeypatch):
    # Point the migration list at a non-existent table — exercises the
    # 'table doesn't exist yet' continue branch.
    fake = [("_no_such_table", "_no_col", "_no_col TEXT")]
    monkeypatch.setattr(db_mod, "MIGRATIONS", fake)
    db_mod._apply_migrations()


def test_db_get_session_yields_session():
    s = db_mod.get_session()
    assert isinstance(s, Session)
    s.close()


# ===========================================================================
# services.render_prescription_html
# ===========================================================================
def test_prescription_html_with_list_of_prescriptions():
    p = Patient(id=1, name="Test Patient", age=30, phone="+91 98 000 00000")
    settings = Settings(
        id=1,
        doctor_name="Dr Smith",
        doctor_qualifications="MBBS, MD",
        registration_number="DMC/99999",
        registration_council="Delhi Medical Council",
        clinic_name="Test Clinic",
    )
    html = services.render_prescription_html(
        p,
        note_data={
            "chief_complaint": "Fever",
            "diagnosis": "Viral",
            "prescriptions": [
                "Paracetamol 500mg — 1 tab TDS × 5 days",
                "ORS — as needed",
            ],
            "notes": "Rest, fluids",
            "date": datetime(2025, 1, 1, 9, 30, tzinfo=timezone.utc),
        },
        settings=settings,
    )
    assert "<!doctype html>" in html
    assert "Test Patient" in html
    assert "Paracetamol" in html
    # Header text is "PRESCRIPTION" (uppercase) under the Rx symbol —
    # rendered as a proper table instead of a bulleted list.
    assert "PRESCRIPTION" in html
    assert "DMC/99999" in html


def test_prescription_html_falls_back_to_advised():
    p = Patient(id=2, name="Walk-in")
    html = services.render_prescription_html(
        p,
        note_data={
            "diagnosis": "Acidity",
            "treatment_advised": "Omeprazole 20mg BD × 2 weeks\nAvoid spicy food",
        },
        settings=None,
    )
    # Fallback block's title is "Prescription / Advice" (no Rx symbol
    # since we don't have structured items to justify the Rx table).
    assert "Prescription / Advice" in html
    assert "Omeprazole" in html


def test_prescription_html_no_rx_no_advised():
    """If neither prescriptions nor treatment_advised is supplied the
    template simply doesn't render an Rx block."""
    p = Patient(id=3, name="No Rx")
    html = services.render_prescription_html(
        p, note_data={"chief_complaint": "Just a note"},
    )
    # Neither the Rx table header nor the free-text fallback heading
    # should appear when no prescription data is provided.
    assert "PRESCRIPTION" not in html
    assert "Prescription / Advice" not in html
    assert "No Rx" in html


def test_prescription_html_shows_dob_in_patient_banner():
    from datetime import date
    p = Patient(
        id=4, name="DOB Patient",
        date_of_birth=date(1985, 6, 10),
        phone="+91 90000 00000",
    )
    html = services.render_prescription_html(
        p, note_data={"chief_complaint": "Checkup"},
    )
    assert "DOB: 10 Jun 1985" in html
    # Age is computed from DOB on render so we don't hard-code a year.
    import re
    assert re.search(r"DOB: 10 Jun 1985 \(\d{2}y\)", html)


def test_prescription_pdf_metadata_has_title_and_author():
    p = Patient(id=5, name="Meta Patient", age=40)
    settings = Settings(
        id=1, doctor_name="Dr Anon", registration_number="DMC/77777",
        clinic_name="Meta Clinic",
    )
    pdf = services.render_prescription_pdf(
        p, note_data={"chief_complaint": "Headache"}, settings=settings,
    )
    assert pdf.startswith(b"%PDF-")
    # Title + Author are the two fields PDF viewers surface as the
    # tab/window title and the "Author" field in Properties. Without
    # these the viewer falls back to "(anonymous)".
    assert b"/Title" in pdf
    assert b"/Author" in pdf
    assert b"Prescription" in pdf
    assert b"Meta Patient" in pdf


def test_prescription_pdf_with_dob_differs_from_plain_pdf():
    """reportlab compresses page streams so we can't grep for the DOB
    string in the raw bytes. Instead we verify the helper is wired in
    by rendering the same note twice — once with DOB, once without —
    and asserting the outputs differ.

    The HTML test above already proves the DOB string appears verbatim
    in the patient banner; the two renderers share the same helper
    (``_patient_identity_bits``), so if the HTML is right the PDF
    patient banner must be too."""
    from datetime import date
    base = Patient(id=6, name="DOB PDF")
    with_dob = Patient(
        id=6, name="DOB PDF", date_of_birth=date(2001, 12, 1),
    )
    plain = services.render_prescription_pdf(
        base, note_data={"chief_complaint": "Cough"},
    )
    with_banner = services.render_prescription_pdf(
        with_dob, note_data={"chief_complaint": "Cough"},
    )
    assert plain.startswith(b"%PDF-")
    assert with_banner.startswith(b"%PDF-")
    assert plain != with_banner


def test_clinic_header_registration_number_only():
    """A doctor who supplies a registration number but not a council
    (edge case) still gets a Reg. No. line."""
    settings = Settings(id=1, registration_number="DMC/1234")
    h = services.ClinicHeader(settings)
    assert "Reg. No. DMC/1234" == h.registration_line


def test_clinic_header_no_registration_gives_empty_line():
    settings = Settings(id=1)
    h = services.ClinicHeader(settings)
    assert h.registration_line == ""


# ===========================================================================
# services.send_appointment_reminder — success + no-phone branch
# ===========================================================================
def test_reminder_without_phone_returns_false(caplog):
    p = Patient(id=1, name="No Phone")
    ok = services.send_appointment_reminder(p, datetime.now(timezone.utc))
    assert ok is False


def test_reminder_whatsapp_channel_calls_whatsapp(monkeypatch):
    p = Patient(id=1, name="X", phone="+91 98 000 00000")
    called = {"path": None}

    def fake_whatsapp(phone, msg):
        called["path"] = "whatsapp"
        return True

    def fake_sms(phone, msg):
        called["path"] = "sms"
        return True

    monkeypatch.setattr(services, "_send_whatsapp", fake_whatsapp)
    monkeypatch.setattr(services, "_send_sms", fake_sms)
    assert services.send_appointment_reminder(p, datetime.now(timezone.utc),
                                              channel="whatsapp") is True
    assert called["path"] == "whatsapp"


def test_reminder_swallows_send_exception(monkeypatch):
    p = Patient(id=1, name="X", phone="+91 98 000 00000")

    def boom(phone, msg):
        raise RuntimeError("network down")

    monkeypatch.setattr(services, "_send_sms", boom)
    assert services.send_appointment_reminder(p, datetime.now(timezone.utc)) is False


def test_reminder_stubs_return_true():
    """The stubs themselves should return True to keep the UI green."""
    assert services._send_sms("+91 98 000 00000", "test") is True
    assert services._send_whatsapp("+91 98 000 00000", "test") is True
