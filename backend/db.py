"""Database setup. SQLite file lives in the user's home dir so the app is
portable and data survives reinstalls, laptop restarts, and shutdowns."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from sqlmodel import SQLModel, Session, create_engine

log = logging.getLogger("clinikore.db")

# `CLINIKORE_HOME` overrides the data directory; falls back to the legacy
# `DOCTOR_HELPER_HOME` for anyone migrating from the old name.
_DEFAULT_HOME = Path.home() / ".clinikore"
APP_DIR = Path(
    os.environ.get("CLINIKORE_HOME")
    or os.environ.get("DOCTOR_HELPER_HOME")
    or _DEFAULT_HOME
)
APP_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = APP_DIR / "clinic.db"
DATABASE_URL = f"sqlite:///{DB_PATH}"

# Where consultation attachments (lab reports, scans, photos) are stored on
# disk. Keeping binaries out of SQLite means the DB stays small and
# backup-friendly, and the files remain trivially browsable from the OS.
ATTACHMENTS_DIR = APP_DIR / "attachments"
ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)

# check_same_thread=False because FastAPI + background threads share the engine.
engine = create_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)


# ---------------------------------------------------------------------------
# Durability: SQLite's default rollback journal is safe, but WAL is better
# for a desktop app because it survives mid-write power cuts more gracefully
# and allows readers during a write (our backup thread runs concurrently
# with the API). synchronous=NORMAL is the sweet spot — full fsync on every
# COMMIT costs ~10x latency for no real benefit on consumer laptops.
# ---------------------------------------------------------------------------
def _apply_pragmas() -> None:
    with engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA journal_mode=WAL")
        conn.exec_driver_sql("PRAGMA synchronous=NORMAL")
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")


# ---------------------------------------------------------------------------
# Lightweight forward-compatible schema migrations.
#
# SQLModel.metadata.create_all() only creates MISSING tables — it never
# adds a new column to an existing table. For a shipped app we need to
# evolve the schema without losing user data. SQLite supports
# `ALTER TABLE ADD COLUMN`; we detect missing columns via PRAGMA
# table_info and apply them idempotently on startup.
#
# Add a new `(table, column, ddl)` tuple to MIGRATIONS whenever you add
# a column to an existing table model. Safe to run many times.
# ---------------------------------------------------------------------------
MIGRATIONS: list[tuple[str, str, str]] = [
    # Added in v0.2: clinical specialization on procedures.
    ("procedure", "category", "category TEXT"),

    # ---- v0.3: clinical v2 upgrade -------------------------------------
    # Soft delete on every user-owned row so DELETE becomes reversible.
    ("patient", "deleted_at", "deleted_at DATETIME"),
    ("appointment", "deleted_at", "deleted_at DATETIME"),
    ("treatment", "deleted_at", "deleted_at DATETIME"),
    ("invoice", "deleted_at", "deleted_at DATETIME"),
    ("payment", "deleted_at", "deleted_at DATETIME"),

    # Scheduling upgrades.
    ("procedure", "default_duration_minutes", "default_duration_minutes INTEGER NOT NULL DEFAULT 30"),
    ("appointment", "procedure_id", "procedure_id INTEGER"),
    ("appointment", "room_id", "room_id INTEGER"),

    # Billing upgrades.
    ("invoice", "discount_amount", "discount_amount REAL NOT NULL DEFAULT 0"),

    # Settings — onboarding completion stamp so we know when to stop
    # nagging the user with the welcome flow.
    ("settings", "onboarded_at", "onboarded_at DATETIME"),

    # Settings — doctor's statutory registration details (required on every
    # invoice / prescription under the Indian Medical Council regulations)
    # and expanded clinic profile fields surfaced on the invoice header.
    ("settings", "doctor_qualifications", "doctor_qualifications TEXT"),
    ("settings", "registration_number", "registration_number TEXT"),
    ("settings", "registration_council", "registration_council TEXT"),
    ("settings", "clinic_email", "clinic_email TEXT"),
    ("settings", "clinic_gstin", "clinic_gstin TEXT"),

    # Prescriptions live on the consultation note so every visit has a
    # printable Rx without a separate top-level entity. Items are stored
    # as a JSON array of {drug, strength, frequency, duration, instructions}.
    ("consultationnote", "prescription_items", "prescription_items TEXT"),
    ("consultationnote", "prescription_notes", "prescription_notes TEXT"),
    ("consultationnote", "invoice_id", "invoice_id INTEGER"),

    # Patient demographics — DOB is the source of truth for age, enables
    # pediatric/geriatric relevance filtering. Gender powers speciality
    # filters (gynaecology/andrology).
    ("patient", "date_of_birth", "date_of_birth DATE"),
    ("patient", "gender", "gender TEXT"),

    # Doctor's structured specialty category, captured during onboarding.
    # Used to filter the patient list to clinically relevant patients only.
    ("settings", "doctor_category", "doctor_category TEXT"),
]


def _apply_migrations() -> None:
    with engine.begin() as conn:
        for table, column, ddl in MIGRATIONS:
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").all()
            existing = {r[1] for r in rows}
            if not rows:
                # Table doesn't exist yet — create_all will make it with the
                # column already present. Skip.
                continue
            if column in existing:
                continue
            log.info("Adding column %s.%s", table, column)
            conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def init_db() -> None:
    # Import models so SQLModel registers their metadata before create_all.
    from backend import models  # noqa: F401

    SQLModel.metadata.create_all(engine)
    _apply_pragmas()
    _apply_migrations()


def get_session() -> Session:
    return Session(engine)
