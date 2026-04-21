"""DB-backed audit log.

We already have a file-based `audit()` helper in :mod:`backend.logging_setup`
that writes to a rotating `audit.log`. For the in-app "Activity" UI we also
persist every event to a DB table so it can be queried/filtered.

Keep the write side best-effort: a failing audit insert must never break the
primary action, so we catch and log rather than raise.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Session, select

from backend.models import AuditLog, Settings, utcnow
from backend.logging_setup import audit as file_audit

log = logging.getLogger("clinikore.audit_db")


def _actor(session: Session) -> Optional[str]:
    row = session.get(Settings, 1)
    return (row.doctor_name if row else None) or None


def record(
    session: Session,
    action: str,
    *,
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    summary: Optional[str] = None,
    **fields: Any,
) -> None:
    """Record a single audit event.

    The file-based `audit()` is also called so `audit.log` stays the source of
    truth for compliance-style reading. Fields are stored as JSON in
    `details_json` so the UI can render structured diffs.
    """
    # File log — keeps parity with existing behavior.
    file_audit(action, **fields)

    try:
        row = AuditLog(
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            summary=summary,
            details_json=json.dumps(fields, default=_json_default) if fields else None,
            actor=_actor(session),
        )
        session.add(row)
        # Flush immediately so the audit row lands even if the surrounding
        # transaction is committed by the caller's Depends(get_session).
        session.flush()
    except Exception:
        log.exception("Failed to persist audit log (action=%s)", action)


def _json_default(o: Any) -> Any:
    if isinstance(o, datetime):
        return o.isoformat()
    return str(o)


def query(
    session: Session,
    *,
    entity_type: Optional[str] = None,
    action: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[AuditLog]:
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc())
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if action:
        stmt = stmt.where(AuditLog.action.ilike(f"%{action}%"))
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            (AuditLog.action.ilike(like))
            | (AuditLog.summary.ilike(like))
            | (AuditLog.details_json.ilike(like))
        )
    stmt = stmt.limit(limit).offset(offset)
    return list(session.exec(stmt).all())


def mark_deleted(
    session: Session,
    entity: Any,
) -> datetime:
    """Helper for soft-delete: set `deleted_at=utcnow()` on an entity that has
    that column and return the timestamp. Caller still commits."""
    ts = utcnow()
    entity.deleted_at = ts
    session.add(entity)
    return ts
