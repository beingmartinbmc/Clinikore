"""Report calculations — called directly on ``backend.reports`` so we
don't depend on whether the HTTP routes are wired up yet.

Coverage:
  * ``daily_collections`` — per-day total, breakdown by payment method,
    row-level details.
  * ``monthly_revenue`` — per-day totals within a month, zero-fills
    missing days, totals match the sum.
  * ``pending_dues`` — only unpaid/partial invoices, balance computed.
  * ``top_procedures`` — counts + revenue, date-range filter, ``limit``.
  * ``rows_to_csv`` — header row + shape preserved, safe on empty input.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlmodel import Session

from backend import reports
from backend.db import engine
from backend.models import (
    Invoice,
    InvoiceItem,
    InvoiceStatus,
    Patient,
    Payment,
    PaymentMethod,
    Procedure,
    Treatment,
    utcnow,
)


def _mk_patient(s: Session, name: str) -> Patient:
    p = Patient(name=name)
    s.add(p)
    s.commit()
    s.refresh(p)
    return p


def _mk_procedure(s: Session, name: str, price: float) -> Procedure:
    proc = Procedure(name=name, default_price=price)
    s.add(proc)
    s.commit()
    s.refresh(proc)
    return proc


def _mk_invoice(s: Session, patient: Patient, items: list[tuple[str, int, float]]) -> Invoice:
    inv = Invoice(patient_id=patient.id, total=0.0, paid=0.0)
    s.add(inv)
    s.commit()
    s.refresh(inv)
    for desc, qty, unit in items:
        it = InvoiceItem(invoice_id=inv.id, description=desc, quantity=qty, unit_price=unit)
        s.add(it)
    inv.total = sum(q * u for _, q, u in items)
    s.add(inv)
    s.commit()
    s.refresh(inv)
    return inv


def _mk_payment(s: Session, invoice: Invoice, amount: float, method: PaymentMethod,
                paid_on: datetime, reference: str | None = None) -> Payment:
    p = Payment(invoice_id=invoice.id, amount=amount, method=method,
                paid_on=paid_on, reference=reference)
    s.add(p)
    invoice.paid = (invoice.paid or 0) + amount
    if invoice.paid + 1e-6 < invoice.total:
        invoice.status = InvoiceStatus.partial
    elif invoice.paid > 0:
        invoice.status = InvoiceStatus.paid
    s.add(invoice)
    s.commit()
    s.refresh(p)
    return p


# ---------------------------------------------------------------------------
# daily_collections
# ---------------------------------------------------------------------------
def test_daily_collections_sums_and_breakdown(session):
    today = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0, microsecond=0)
    patient = _mk_patient(session, "Rahul")
    inv = _mk_invoice(session, patient, [("Consultation", 1, 500)])

    _mk_payment(session, inv, 300, PaymentMethod.cash, today)
    _mk_payment(session, inv, 200, PaymentMethod.upi,
                today.replace(hour=14), reference="UPI-1")

    # Noise: a payment on a different day — must be excluded.
    other = _mk_invoice(session, patient, [("Followup", 1, 100)])
    _mk_payment(session, other, 100, PaymentMethod.card,
                today - timedelta(days=2))

    out = reports.daily_collections(session, today.date())
    assert out["date"] == today.date().isoformat()
    assert out["count"] == 2
    assert out["total"] == 500
    assert out["by_method"]["cash"] == 300
    assert out["by_method"]["upi"] == 200
    assert out["by_method"]["card"] == 0
    # Rows carry patient names so the report is readable.
    assert all(r["patient"] == "Rahul" for r in out["rows"])


def test_daily_collections_empty_day(session):
    out = reports.daily_collections(session, date(2020, 1, 1))
    assert out["total"] == 0
    assert out["count"] == 0
    assert out["rows"] == []
    assert set(out["by_method"].keys()) >= {"cash", "upi", "card"}


# ---------------------------------------------------------------------------
# monthly_revenue
# ---------------------------------------------------------------------------
def test_monthly_revenue_fills_every_day_and_totals_match(session):
    patient = _mk_patient(session, "Neha")
    inv = _mk_invoice(session, patient, [("Whitening", 1, 4000)])

    # Payments across three different days in July 2025.
    _mk_payment(session, inv, 1000, PaymentMethod.cash, datetime(2025, 7, 3, 10, 0))
    _mk_payment(session, inv, 1500, PaymentMethod.upi, datetime(2025, 7, 15, 12, 0))
    _mk_payment(session, inv, 500, PaymentMethod.card, datetime(2025, 7, 15, 17, 0))

    out = reports.monthly_revenue(session, "2025-07")
    assert out["month"] == "2025-07"
    assert out["total"] == 3000
    assert out["count"] == 3
    assert out["by_method"]["cash"] == 1000
    assert out["by_method"]["upi"] == 1500
    assert out["by_method"]["card"] == 500

    # Every day of July is present (31 entries) — zero-filled for quiet days.
    assert len(out["days"]) == 31
    # Two rows on July 15 (upi + card) should aggregate to 2000.
    day15 = next(d for d in out["days"] if d["date"] == "2025-07-15")
    assert day15["amount"] == 2000
    assert sum(d["amount"] for d in out["days"]) == 3000


def test_monthly_revenue_december_crosses_year_boundary(session):
    patient = _mk_patient(session, "Rahul")
    inv = _mk_invoice(session, patient, [("Consultation", 1, 500)])
    _mk_payment(session, inv, 500, PaymentMethod.cash, datetime(2024, 12, 31, 23, 30))
    out = reports.monthly_revenue(session, "2024-12")
    assert out["total"] == 500
    assert len(out["days"]) == 31


# ---------------------------------------------------------------------------
# pending_dues
# ---------------------------------------------------------------------------
def test_pending_dues_excludes_paid_invoices(session):
    patient = _mk_patient(session, "Vikram")
    paid = _mk_invoice(session, patient, [("Crown", 1, 5000)])
    _mk_payment(session, paid, 5000, PaymentMethod.upi, utcnow())

    partial = _mk_invoice(session, patient, [("Filling", 1, 1200), ("Scaling", 1, 1500)])
    _mk_payment(session, partial, 1000, PaymentMethod.cash, utcnow())

    unpaid = _mk_invoice(session, patient, [("Consultation", 1, 500)])

    out = reports.pending_dues(session)
    ids = {r["invoice_id"] for r in out["rows"]}
    assert partial.id in ids
    assert unpaid.id in ids
    assert paid.id not in ids
    assert out["total"] == (2700 - 1000) + 500  # 1700 + 500 = 2200
    # Balance computed correctly per row.
    partial_row = next(r for r in out["rows"] if r["invoice_id"] == partial.id)
    assert partial_row["balance"] == 1700


# ---------------------------------------------------------------------------
# top_procedures
# ---------------------------------------------------------------------------
def test_top_procedures_counts_and_revenue(session):
    patient = _mk_patient(session, "Priya")
    cons = _mk_procedure(session, "Consultation", 500)
    fill = _mk_procedure(session, "Filling", 1200)

    for _ in range(3):
        session.add(Treatment(patient_id=patient.id, procedure_id=cons.id,
                              price=500, performed_on=date.today()))
    session.add(Treatment(patient_id=patient.id, procedure_id=fill.id,
                          price=1200, performed_on=date.today()))
    session.commit()

    out = reports.top_procedures(session, limit=10)
    by_name = {r["name"]: r for r in out["rows"]}
    assert by_name["Consultation"]["count"] == 3
    assert by_name["Consultation"]["revenue"] == 1500
    assert by_name["Filling"]["count"] == 1
    assert by_name["Filling"]["revenue"] == 1200
    # Ordered by count desc.
    assert out["rows"][0]["name"] == "Consultation"


def test_top_procedures_date_range_filter(session):
    patient = _mk_patient(session, "Priya")
    cons = _mk_procedure(session, "Consultation", 500)
    old_day = date.today() - timedelta(days=365)
    session.add(Treatment(patient_id=patient.id, procedure_id=cons.id,
                          price=500, performed_on=old_day))
    session.add(Treatment(patient_id=patient.id, procedure_id=cons.id,
                          price=500, performed_on=date.today()))
    session.commit()

    # Only the recent one.
    out = reports.top_procedures(
        session,
        date_from=date.today() - timedelta(days=30),
        date_to=date.today(),
    )
    row = next(r for r in out["rows"] if r["name"] == "Consultation")
    assert row["count"] == 1


def test_top_procedures_limit(session):
    patient = _mk_patient(session, "Priya")
    for i in range(5):
        proc = _mk_procedure(session, f"Proc-{i}", 100)
        session.add(Treatment(patient_id=patient.id, procedure_id=proc.id,
                              price=100, performed_on=date.today()))
    session.commit()
    out = reports.top_procedures(session, limit=2)
    assert len(out["rows"]) == 2


# ---------------------------------------------------------------------------
# CSV helper
# ---------------------------------------------------------------------------
def test_rows_to_csv_emits_header_and_rows():
    rows = [
        {"date": "2025-07-01", "amount": 500},
        {"date": "2025-07-02", "amount": 1500},
    ]
    csv = reports.rows_to_csv(rows)
    lines = csv.strip().splitlines()
    assert lines[0] == "date,amount"
    assert lines[1] == "2025-07-01,500"
    assert lines[2] == "2025-07-02,1500"


def test_rows_to_csv_handles_empty_input():
    assert reports.rows_to_csv([]) == ""


def test_rows_to_csv_honors_explicit_columns():
    rows = [{"a": 1, "b": 2, "c": 3}]
    csv = reports.rows_to_csv(rows, columns=["b", "a"])
    lines = csv.strip().splitlines()
    assert lines[0] == "b,a"
    assert lines[1] == "2,1"  # c is dropped
