"""Automatic database backup system.

Why each design choice:

* We use SQLite's **online backup API** (`sqlite3.Connection.backup`) instead of
  `shutil.copy(db_file)`. A plain copy can catch the WAL mid-write and produce
  a corrupt backup — the online API guarantees a consistent snapshot even while
  the main app is writing.
* Alongside every snapshot we dump **every table to CSV**. SQLite format can
  theoretically change across major versions; the CSVs are a last-resort
  human-readable escape hatch that can be opened in Excel or re-imported
  anywhere. This is the "never lose the data" tier.
* The scheduler runs **in-process on a daemon thread** — no OS-level cron, so
  it works identically on macOS, Windows and Linux and only runs while the
  app is running (which is the only time writes happen).
* Backups **rotate** (default: keep last 30 snapshots) to bound disk usage.

Default layout inside `~/.clinikore/backups/`:

    backups/
        20260421-153012/
            clinic.db           <- SQLite snapshot (primary restore target)
            csv/
                patient.csv
                appointment.csv
                ...
            manifest.json       <- metadata (row counts, schema, app version)
        20260421-213012/
            ...
"""
from __future__ import annotations

import csv
import json
import logging
import os
import shutil
import sqlite3
import threading
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import List, Optional

log = logging.getLogger("clinikore.backup")

# --- Config (env-overridable) ---------------------------------------------
BACKUP_INTERVAL_HOURS = float(os.environ.get("BACKUP_INTERVAL_HOURS", "6"))
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "30"))
BACKUP_ON_STARTUP = os.environ.get("BACKUP_ON_STARTUP", "1") != "0"


# --- Data class for listing ------------------------------------------------
@dataclass
class BackupEntry:
    name: str
    created_at: datetime
    size_bytes: int
    tables: dict
    path: Path

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "created_at": self.created_at.isoformat(),
            "size_bytes": self.size_bytes,
            "tables": self.tables,
        }


# --- Core functions --------------------------------------------------------
def _snapshot_sqlite(src: Path, dst: Path) -> None:
    """Consistent snapshot using SQLite's backup API."""
    src_conn = sqlite3.connect(str(src))
    dst_conn = sqlite3.connect(str(dst))
    try:
        with dst_conn:
            src_conn.backup(dst_conn)
    finally:
        src_conn.close()
        dst_conn.close()


def _list_tables(conn: sqlite3.Connection) -> List[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return [r[0] for r in rows]


def _export_csvs(db_path: Path, out_dir: Path) -> dict:
    """Dump every user table to CSV. Returns row counts per table."""
    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict = {}
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        for table in _list_tables(conn):
            cols = [c[1] for c in conn.execute(f'PRAGMA table_info("{table}")')]
            rows = conn.execute(f'SELECT * FROM "{table}"').fetchall()
            csv_path = out_dir / f"{table}.csv"
            with csv_path.open("w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(cols)
                for r in rows:
                    w.writerow([r[c] for c in cols])
            counts[table] = len(rows)
    finally:
        conn.close()
    return counts


def create_backup(db_path: Path, backup_root: Path) -> Path:
    """Create a timestamped snapshot and return its directory."""
    backup_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = backup_root / stamp
    target.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()

    log.debug("Backup: snapshotting SQLite to %s", target / "clinic.db")
    snapshot_db = target / "clinic.db"
    _snapshot_sqlite(db_path, snapshot_db)

    log.debug("Backup: exporting CSVs")
    counts = _export_csvs(snapshot_db, target / "csv")

    manifest = {
        "created_at": datetime.now().isoformat(),
        "source_db": str(db_path),
        "tables": counts,
        "sqlite_version": sqlite3.sqlite_version,
    }
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2))

    size = sum(f.stat().st_size for f in target.rglob("*") if f.is_file())
    elapsed_ms = (time.perf_counter() - t0) * 1000
    total_rows = sum(counts.values())
    log.info(
        "Backup created: %s (%d tables, %d rows, %.1f KB, %.0f ms)",
        target.name, len(counts), total_rows, size / 1024, elapsed_ms,
    )
    return target


def prune_backups(backup_root: Path, keep: int = BACKUP_KEEP) -> int:
    """Delete oldest backups beyond `keep`. Returns number removed."""
    if not backup_root.exists():
        return 0
    entries = sorted(
        [p for p in backup_root.iterdir() if p.is_dir()],
        key=lambda p: p.name,
    )
    to_remove = entries[:-keep] if len(entries) > keep else []
    for p in to_remove:
        shutil.rmtree(p, ignore_errors=True)
        log.info("Pruned old backup: %s", p.name)
    return len(to_remove)


def list_backups(backup_root: Path) -> List[BackupEntry]:
    if not backup_root.exists():
        return []
    out: List[BackupEntry] = []
    for p in sorted(backup_root.iterdir(), reverse=True):
        if not p.is_dir():
            continue
        manifest = p / "manifest.json"
        try:
            data = json.loads(manifest.read_text()) if manifest.exists() else {}
        except Exception:
            data = {}
        size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
        try:
            created = datetime.strptime(p.name, "%Y%m%d-%H%M%S")
        except ValueError:
            created = datetime.fromtimestamp(p.stat().st_mtime)
        out.append(BackupEntry(
            name=p.name,
            created_at=created,
            size_bytes=size,
            tables=data.get("tables", {}),
            path=p,
        ))
    return out


def zip_backup(backup_dir: Path) -> bytes:
    """Zip a backup folder into an in-memory archive for download."""
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in backup_dir.rglob("*"):
            if f.is_file():
                zf.write(f, arcname=f.relative_to(backup_dir.parent))
    return buf.getvalue()


# --- Scheduler -------------------------------------------------------------
class BackupScheduler:
    """Lightweight in-process scheduler. Runs on a daemon thread."""

    def __init__(
        self,
        db_path: Path,
        backup_root: Path,
        interval_hours: float = BACKUP_INTERVAL_HOURS,
        keep: int = BACKUP_KEEP,
    ) -> None:
        self.db_path = db_path
        self.backup_root = backup_root
        self.interval_seconds = max(60.0, interval_hours * 3600.0)
        self.keep = keep
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def _loop(self) -> None:
        # One immediate backup on startup if configured.
        if BACKUP_ON_STARTUP:
            self._safe_backup()
        while not self._stop.wait(self.interval_seconds):
            self._safe_backup()

    def _safe_backup(self) -> None:
        try:
            log.debug("Scheduler tick: creating scheduled backup")
            create_backup(self.db_path, self.backup_root)
            removed = prune_backups(self.backup_root, keep=self.keep)
            if removed:
                log.info("Pruned %d old backup(s) beyond retention of %d",
                         removed, self.keep)
        except Exception:
            # Never let a backup failure crash the app.
            log.exception("Scheduled backup failed")

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="backup-scheduler", daemon=True,
        )
        self._thread.start()
        log.info(
            "Backup scheduler started: every %.1fh, keep %d, dir=%s",
            self.interval_seconds / 3600, self.keep, self.backup_root,
        )

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
