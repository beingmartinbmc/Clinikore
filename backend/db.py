"""Database setup. SQLite file lives in the user's home dir so the app is
portable and data survives reinstalls."""
from __future__ import annotations

import os
from pathlib import Path
from sqlmodel import SQLModel, Session, create_engine

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

# check_same_thread=False because FastAPI + background threads share the engine.
engine = create_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)


def init_db() -> None:
    # Import models so SQLModel registers their metadata before create_all.
    from backend import models  # noqa: F401

    SQLModel.metadata.create_all(engine)


def get_session() -> Session:
    return Session(engine)
