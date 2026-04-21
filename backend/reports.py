"""Reporting queries. Deliberately simple and fast — the UI is tables, not
charts. Each function returns plain dicts the route layer can serialize as
JSON or CSV without another model layer.

Shape contract (matched by tests/test_reports.py):

    daily_collections(session, day)      → dict{date, count, total, by_method, rows}
    monthly_revenue(session, "YYYY-MM")  → dict{month, count, total, by_method, days}
    pending_dues(session)                → dict{rows, total}
    top_procedures(session, limit, date_from, date_to) → dict{rows}
    rows_to_csv(rows, columns=None)      → str   (empty input -> "")
"""
from __future__ import annotations

import csv
import io
from calendar import monthrange
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Iterable, Optional

from sqlmodel import Session, func, select

from backend.models import (
    Invoice,
    InvoiceStatus,
    Patient,
    Payment,
    PaymentMethod,
    Procedure,
    Treatment,
)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _day_bounds(day: date) -> tuple[datetime, datetime]:
    """Half-open [start, end) datetime range for one calendar day, UTC."""
    start = datetime.combine(day, time.min, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return start, end


def _month_bounds(month: str) -> tuple[datetime, datetime, int, int]:
    """Parse ``"YYYY-MM"`` into (start, end, year, month)."""
    y, m = month.split("-")
    year, mo = int(y), int(m)
    start = datetime(year, mo, 1, tzinfo=timezone.utc)
    if mo == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, mo + 1, 1, tzinfo=timezone.utc)
    return start, end, year, mo


def _as_aware(ts: datetime) -> datetime:
    """SQLite strips tz; treat naive values as UTC."""
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def _empty_by_method() -> dict[str, float]:
    return {m.value: 0.0 for m in PaymentMethod}


def _payments_in_range(
    session: Session, start: datetime, end: datetime,
) -> list[Payment]:
    # SQLite stores naive datetimes; normalise both sides for safe comparison.
    s = start.replace(tzinfo=None) if start.tzinfo else start
    e = end.replace(tzinfo=None) if end.tzinfo else end
    stmt = (
        select(Payment)
        .where(Payment.paid_on >= s, Payment.paid_on < e)
        .order_by(Payment.paid_on)
    )
    if hasattr(Payment, "deleted_at"):
        stmt = stmt.where(Payment.deleted_at.is_(None))  # type: ignore[attr-defined]
    return session.exec(stmt).all()


# ---------------------------------------------------------------------------
# daily_collections
# ---------------------------------------------------------------------------
def daily_collections(session: Session, day: date) -> dict[str, Any]:
    """All payments received on ``day``. Includes per-method breakdown and
    per-payment rows enriched with patient/invoice info for a readable table."""
    start, end = _day_bounds(day)
    payments = _payments_in_range(session, start, end)

    by_method = _empty_by_method()
    rows: list[dict[str, Any]] = []
    total = 0.0
    for p in payments:
        amt = float(p.amount or 0.0)
        total += amt
        method = p.method.value if hasattr(p.method, "value") else str(p.method)
        by_method[method] = by_method.get(method, 0.0) + amt
        inv = session.get(Invoice, p.invoice_id) if p.invoice_id else None
        patient = session.get(Patient, inv.patient_id) if inv else None
        rows.append({
            "payment_id": p.id,
            "invoice_id": p.invoice_id,
            "patient": patient.name if patient else None,
            "patient_id": patient.id if patient else None,
            "amount": round(amt, 2),
            "method": method,
            "paid_on": _as_aware(p.paid_on).isoformat() if p.paid_on else None,
            "reference": p.reference,
        })
    return {
        "date": day.isoformat(),
        "count": len(rows),
        "total": round(total, 2),
        "by_method": {k: round(v, 2) for k, v in by_method.items()},
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# monthly_revenue
# ---------------------------------------------------------------------------
def monthly_revenue(session: Session, month: str) -> dict[str, Any]:
    """Sum payments across the whole month plus a zero-filled day-by-day
    breakdown (always ``ndays`` entries, handy for charts and CSV)."""
    start, end, year, mo = _month_bounds(month)
    ndays = monthrange(year, mo)[1]

    payments = _payments_in_range(session, start, end)

    days: list[dict[str, Any]] = [
        {"date": date(year, mo, d).isoformat(), "amount": 0.0, "count": 0}
        for d in range(1, ndays + 1)
    ]
    day_index = {d["date"]: d for d in days}

    by_method = _empty_by_method()
    total = 0.0
    for p in payments:
        amt = float(p.amount or 0.0)
        total += amt
        method = p.method.value if hasattr(p.method, "value") else str(p.method)
        by_method[method] = by_method.get(method, 0.0) + amt
        key = _as_aware(p.paid_on).date().isoformat() if p.paid_on else None
        if key and key in day_index:
            day_index[key]["amount"] += amt
            day_index[key]["count"] += 1

    for d in days:
        d["amount"] = round(d["amount"], 2)

    return {
        "month": month,
        "count": len(payments),
        "total": round(total, 2),
        "by_method": {k: round(v, 2) for k, v in by_method.items()},
        "days": days,
    }


# ---------------------------------------------------------------------------
# pending_dues
# ---------------------------------------------------------------------------
def pending_dues(session: Session) -> dict[str, Any]:
    """Invoices with non-zero balance. ``status != paid`` would miss invoices
    whose status was never transitioned correctly, so we compute from totals."""
    stmt = select(Invoice)
    if hasattr(Invoice, "deleted_at"):
        stmt = stmt.where(Invoice.deleted_at.is_(None))  # type: ignore[attr-defined]
    invoices = session.exec(stmt.order_by(Invoice.created_at.asc())).all()

    rows: list[dict[str, Any]] = []
    total = 0.0
    now = datetime.now(timezone.utc)
    for inv in invoices:
        balance = round(float(inv.total or 0.0) - float(inv.paid or 0.0), 2)
        if balance <= 0:
            continue
        patient = session.get(Patient, inv.patient_id)
        created = _as_aware(inv.created_at) if inv.created_at else None
        age_days = max(0, (now - created).days) if created else 0
        status_val = inv.status.value if hasattr(inv.status, "value") else str(inv.status)
        rows.append({
            "invoice_id": inv.id,
            "patient_id": inv.patient_id,
            "patient_name": patient.name if patient else None,
            "phone": patient.phone if patient else None,
            "total": round(float(inv.total or 0), 2),
            "paid": round(float(inv.paid or 0), 2),
            "balance": balance,
            "status": status_val,
            "created_at": created.isoformat() if created else None,
            "days_outstanding": age_days,
        })
        total += balance

    return {"rows": rows, "total": round(total, 2), "count": len(rows)}


# ---------------------------------------------------------------------------
# top_procedures
# ---------------------------------------------------------------------------
def top_procedures(
    session: Session,
    limit: int = 20,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
) -> dict[str, Any]:
    """Procedures ranked by completed-treatment count, with total revenue."""
    stmt = (
        select(
            Procedure.id,
            Procedure.name,
            func.count(Treatment.id).label("count"),
            func.coalesce(func.sum(Treatment.price), 0.0).label("revenue"),
        )
        .join(Treatment, Treatment.procedure_id == Procedure.id)
        .group_by(Procedure.id, Procedure.name)
        .order_by(func.count(Treatment.id).desc())
        .limit(limit)
    )
    if hasattr(Treatment, "deleted_at"):
        stmt = stmt.where(Treatment.deleted_at.is_(None))  # type: ignore[attr-defined]
    if date_from:
        stmt = stmt.where(Treatment.performed_on >= date_from)
    if date_to:
        stmt = stmt.where(Treatment.performed_on <= date_to)

    rows: list[dict[str, Any]] = []
    for pid, name, cnt, rev in session.exec(stmt).all():
        if not cnt:
            continue
        rows.append({
            "procedure_id": pid,
            "name": name,
            "count": int(cnt),
            "revenue": round(float(rev or 0.0), 2),
        })
    return {"rows": rows, "count": len(rows)}


# ---------------------------------------------------------------------------
# CSV helper
# ---------------------------------------------------------------------------
def rows_to_csv(
    rows: Iterable[dict[str, Any]],
    columns: Optional[list[str]] = None,
) -> str:
    """Return CSV text. Empty input returns ``""`` (tests rely on this)."""
    rows = list(rows)
    if not rows and not columns:
        return ""
    if columns is None:
        columns = list(rows[0].keys())
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow(r)
    return out.getvalue()
