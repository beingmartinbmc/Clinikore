"""Dashboard aggregation tests.

The /api/dashboard endpoint is the front page of the app. It aggregates:
  * total patients
  * today's appointment count
  * pending invoice count and total dues
  * this month's collected revenue
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def test_dashboard_empty_state(client):
    r = client.get("/api/dashboard")
    assert r.status_code == 200
    body = r.json()
    assert body["patients"] == 0
    assert body["today_appointments"] == 0
    assert body["pending_invoices"] == 0
    assert body["pending_dues"] == 0
    assert body["month_revenue"] == 0


def test_dashboard_counts_patients_and_today_appointments(client, patient):
    # Two extra patients + an appointment today and one for tomorrow.
    client.post("/api/patients", json={"name": "Test 2"})
    client.post("/api/patients", json={"name": "Test 3"})

    now = datetime.now(timezone.utc)
    client.post("/api/appointments", json={
        "patient_id": patient["id"],
        "start": _iso(now),
        "end": _iso(now + timedelta(minutes=30)),
    })
    client.post("/api/appointments", json={
        "patient_id": patient["id"],
        "start": _iso(now + timedelta(days=1)),
        "end": _iso(now + timedelta(days=1, minutes=30)),
    })

    body = client.get("/api/dashboard").json()
    assert body["patients"] == 3
    assert body["today_appointments"] == 1


def test_dashboard_dues_and_month_revenue(client, patient, procedures):
    """Dashboard: pending_invoices, pending_dues, month_revenue.

    We seed state at the ORM layer so this test is not coupled to the
    POST /payments double-counting bug (tracked separately in
    test_invoices_payments).
    """
    from sqlmodel import Session
    from backend.db import engine
    from backend.models import (
        Invoice, InvoiceItem, InvoiceStatus,
        Payment, PaymentMethod, utcnow,
    )

    with Session(engine) as s:
        # Fully paid invoice: ₹500 -> contributes ₹500 to month_revenue,
        # zero to pending_dues.
        paid = Invoice(
            patient_id=patient["id"], total=500, paid=500,
            status=InvoiceStatus.paid,
        )
        paid.items.append(InvoiceItem(description="Consultation",
                                      quantity=1, unit_price=500))
        paid.payments.append(Payment(amount=500, method=PaymentMethod.upi,
                                     paid_on=utcnow()))
        s.add(paid)

        # Partial invoice: ₹1200 billed, ₹400 paid -> ₹800 pending_dues,
        # ₹400 contributes to month_revenue.
        partial = Invoice(
            patient_id=patient["id"], total=1200, paid=400,
            status=InvoiceStatus.partial,
        )
        partial.items.append(InvoiceItem(description="Filling",
                                         quantity=1, unit_price=1200))
        partial.payments.append(Payment(amount=400, method=PaymentMethod.cash,
                                        paid_on=utcnow()))
        s.add(partial)
        s.commit()

    body = client.get("/api/dashboard").json()
    assert body["pending_invoices"] == 1
    assert body["pending_dues"] == 800       # 1200 - 400
    assert body["month_revenue"] == 900      # 500 + 400
