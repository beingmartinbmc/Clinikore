"""Centralized logging configuration.

Writes rotating log files to the OS-appropriate location:

* macOS:   ~/Library/Logs/Clinikore/clinikore.log
* Windows: %LOCALAPPDATA%\\Clinikore\\Logs\\clinikore.log
* Linux:   $XDG_STATE_HOME/clinikore/logs/clinikore.log
           (defaults to ~/.local/state/clinikore/logs/)

Override with env var `CLINIKORE_LOG_DIR=/some/path`.
Set `CLINIKORE_DEBUG=1` for DEBUG level instead of INFO.

All calls to `logging.getLogger("clinikore...")`, uvicorn and FastAPI end
up in the same file + stderr. Files rotate at 5 MB, keeping 10 backups.
"""
from __future__ import annotations

import logging
import logging.handlers
import os
import sys
from pathlib import Path
from typing import Optional

_LOG_FORMAT = "%(asctime)s [%(levelname)-7s] %(name)s: %(message)s"
_AUDIT_FORMAT = "%(asctime)s %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
_MAX_BYTES = 5 * 1024 * 1024   # 5 MB
_BACKUP_COUNT = 10

# The audit logger is intentionally separate: it writes to a dedicated file
# that captures every create/update/delete on patient data. Keeping it
# separate from the noisy app log makes it easy to inspect for compliance.
AUDIT_LOGGER_NAME = "clinikore.audit"

_configured = False
_log_dir: Optional[Path] = None


def default_log_dir() -> Path:
    """Return the OS-appropriate log directory. Does not create it."""
    override = os.environ.get("CLINIKORE_LOG_DIR")
    if override:
        return Path(override)

    if sys.platform == "darwin":
        return Path.home() / "Library" / "Logs" / "Clinikore"
    if sys.platform == "win32":
        # LOCALAPPDATA is per-machine and not roamed — appropriate for logs.
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if base:
            return Path(base) / "Clinikore" / "Logs"
        return Path.home() / "AppData" / "Local" / "Clinikore" / "Logs"
    # Linux / *BSD — follow XDG Base Directory spec for state/log data.
    xdg_state = os.environ.get("XDG_STATE_HOME")
    if xdg_state:
        return Path(xdg_state) / "clinikore" / "logs"
    return Path.home() / ".local" / "state" / "clinikore" / "logs"


def configure_logging() -> Path:
    """Install handlers once and return the log directory path.

    Safe to call multiple times — subsequent calls are no-ops.
    """
    global _configured, _log_dir
    if _configured and _log_dir:
        return _log_dir

    log_dir = default_log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "clinikore.log"

    level = logging.DEBUG if os.environ.get("CLINIKORE_DEBUG") == "1" else logging.INFO

    formatter = logging.Formatter(_LOG_FORMAT, _DATE_FORMAT)

    file_handler = logging.handlers.RotatingFileHandler(
        log_file,
        maxBytes=_MAX_BYTES,
        backupCount=_BACKUP_COUNT,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    file_handler.setLevel(level)

    stream_handler = logging.StreamHandler(stream=sys.stderr)
    stream_handler.setFormatter(formatter)
    stream_handler.setLevel(level)

    # Configure the root logger so every logger propagates here.
    root = logging.getLogger()
    # Remove existing handlers so re-launches don't duplicate lines.
    for h in list(root.handlers):
        root.removeHandler(h)
    root.setLevel(level)
    root.addHandler(file_handler)
    root.addHandler(stream_handler)

    # Keep uvicorn/fastapi logs flowing through the same pipeline.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi", "sqlalchemy"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
        # Quiet down SQLAlchemy's engine chatter unless debugging.
        if name == "sqlalchemy" and level > logging.DEBUG:
            lg.setLevel(logging.WARNING)

    # --- Dedicated audit log -------------------------------------------
    audit_file = log_dir / "audit.log"
    audit_handler = logging.handlers.RotatingFileHandler(
        audit_file,
        maxBytes=_MAX_BYTES,
        backupCount=_BACKUP_COUNT * 2,   # keep more history for compliance
        encoding="utf-8",
    )
    audit_handler.setFormatter(logging.Formatter(_AUDIT_FORMAT, _DATE_FORMAT))
    audit_handler.setLevel(logging.INFO)

    audit_logger = logging.getLogger(AUDIT_LOGGER_NAME)
    audit_logger.handlers = [audit_handler]
    audit_logger.setLevel(logging.INFO)
    # Also keep audit events in the main app log so a single tail shows both.
    audit_logger.propagate = True

    _configured = True
    _log_dir = log_dir

    logging.getLogger("clinikore").info(
        "Logging to %s (level=%s, rotate=%dMB x %d)",
        log_file, logging.getLevelName(level), _MAX_BYTES // (1024 * 1024), _BACKUP_COUNT,
    )
    logging.getLogger("clinikore").info("Audit log: %s", audit_file)
    return log_dir


def log_startup_banner(app_name: str, version: str, extras: dict) -> None:
    """Log a clean multi-line startup banner with environment info."""
    lg = logging.getLogger("clinikore")
    lg.info("=" * 60)
    lg.info("Starting %s %s", app_name, version)
    lg.info("  Python:   %s (%s)", sys.version.split()[0], sys.platform)
    lg.info("  Log dir:  %s", _log_dir or default_log_dir())
    for k, v in extras.items():
        lg.info("  %-8s  %s", k + ":", v)
    lg.info("=" * 60)


def audit(event: str, **fields) -> None:
    """Structured audit log helper.

    Example:
        audit("patient.create", id=42, name="Priya Sharma")

    Produces a line like:
        2026-04-21 16:20:00 patient.create id=42 name="Priya Sharma"
    """
    parts = [event]
    for k, v in fields.items():
        if isinstance(v, str) and (" " in v or "=" in v):
            parts.append(f'{k}="{v}"')
        else:
            parts.append(f"{k}={v}")
    logging.getLogger(AUDIT_LOGGER_NAME).info(" ".join(parts))


def current_log_dir() -> Optional[Path]:
    return _log_dir
