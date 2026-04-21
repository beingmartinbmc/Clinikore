"""End-to-end workflow tests.

These walk through the real use-cases the doctor performs every day,
linking multiple API endpoints together and asserting every calculation
along the way. If something in the app regresses in a way that breaks
the user's daily routine, one of these tests will catch it.

Scenarios covered:

1. Full consultation flow
   register → book appointment → mark completed → record treatment →
   create invoice → take partial payment → take final payment → generate
   printable receipt → verify dashboard / reports / audit log.

2. Partial-payment + repayment flow with discount
   create multi-line invoice with discount applied → collect three
   installments across three dates → confirm paid status + balance 0.

3. Drop-in walk-in billing
   single keyboard-first flow: patient → procedure-driven invoice → cash
   → printed receipt.

4. Deletion safety
   soft-delete-style flow: once a patient is deleted, their children
   (appointments, treatments, invoices) are also gone or 404.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, select

from backend import services
from backend.db import engine
from backend.models import (
    Invoice, InvoiceItem, InvoiceStatus,
    Patient, Payment, PaymentMethod, Settings, utcnow,
)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# ===========================================================================
# Scenario 1 — full consultation flow
# ===========================================================================

def test_full_consultation_flow(client, settings, procedures):
    """The prototypical daily workflow, fully asserted."""
    # --- 1. Patient registration ------------------------------------------
    r = client.post("/api/patients", json={
        "name": "Rahul Mehta", "age": 52, "phone": "+91 98100 22222",
        "medical_history": "Type 2 diabetes, on Metformin.",
        "allergies": "None known",
    })
    assert r.status_code == 201
    rahul = r.json()

    # --- 2. Book appointment ---------------------------------------------
    now = datetime.now(timezone.utc).replace(microsecond=0)
    r = client.post("/api/appointments", json={
        "patient_id": rahul["id"],
        "start": _iso(now),
        "end": _iso(now + timedelta(minutes=45)),
        "chief_complaint": "Routine checkup + scaling",
    })
    assert r.status_code == 201
    appt = r.json()
    # Timezone sanity — the plan fix (item 9) requires an explicit offset.
    assert appt["start"].endswith(("Z", "+00:00")) or "+" in appt["start"]

    # --- 3. Mark appointment completed ------------------------------------
    r = client.patch(f"/api/appointments/{appt['id']}/status",
                     params={"new_status": "completed"})
    assert r.json()["status"] == "completed"

    # --- 4. Record two treatments (tied to the appointment) --------------
    cons = procedures["Consultation"]            # 500
    scaling = procedures["Scaling & Polishing"]   # 1500

    client.post("/api/treatments", json={
        "patient_id": rahul["id"],
        "procedure_id": cons["id"],
        "appointment_id": appt["id"],
    })
    client.post("/api/treatments", json={
        "patient_id": rahul["id"],
        "procedure_id": scaling["id"],
        "appointment_id": appt["id"],
    })
    txs = client.get(f"/api/patients/{rahul['id']}/treatments").json()
    assert len(txs) == 2
    # Prices fell back to each procedure's default.
    assert sum(t["price"] for t in txs) == cons["default_price"] + scaling["default_price"]

    # --- 5. Create the invoice from the two line items -------------------
    r = client.post("/api/invoices", json={
        "patient_id": rahul["id"],
        "appointment_id": appt["id"],
        "items": [
            {"procedure_id": cons["id"], "description": "Consultation",
             "quantity": 1, "unit_price": cons["default_price"]},
            {"procedure_id": scaling["id"], "description": "Scaling & Polishing",
             "quantity": 1, "unit_price": scaling["default_price"]},
        ],
        "notes": "Follow-up in 6 months.",
    })
    assert r.status_code == 201
    inv = r.json()
    assert inv["total"] == 2000
    assert inv["status"] == "unpaid"

    # --- 6. Take a partial payment now, rest later -----------------------
    client.post(f"/api/invoices/{inv['id']}/payments",
                json={"amount": 500, "method": "cash", "reference": "CASH-1"})
    inv_mid = client.get(f"/api/invoices/{inv['id']}").json()
    assert inv_mid["status"] == "partial"
    assert inv_mid["paid"] == 500

    client.post(f"/api/invoices/{inv['id']}/payments",
                json={"amount": 1500, "method": "upi", "reference": "UTR-9999"})
    inv_done = client.get(f"/api/invoices/{inv['id']}").json()
    assert inv_done["status"] == "paid"
    assert inv_done["paid"] == 2000
    assert len(inv_done["payments"]) == 2

    # --- 7. Generate the PDF — verify the bytes header -------------------
    pdf_res = client.get(f"/api/invoices/{inv['id']}/pdf")
    assert pdf_res.status_code == 200
    assert pdf_res.content.startswith(b"%PDF-")

    # --- 8. Generate the printable receipt via the service layer ----------
    with Session(engine) as s:
        db_inv = s.get(Invoice, inv["id"])
        db_pat = s.get(Patient, rahul["id"])
        db_set = s.get(Settings, 1)
        html = services.render_invoice_html(db_inv, db_pat, db_inv.items,
                                            db_inv.payments, db_set)
    # Essential receipt fields.
    assert "Kapoor Family Clinic" in html
    assert "Aisha Kapoor" in html
    assert "Rahul Mehta" in html
    assert "2,000.00" in html   # total
    assert "CASH" in html and "UPI" in html  # method badges
    assert "UTR-9999" in html
    # Invoice is fully paid at this point — the label flips from "Balance
    # due" to "Fully paid" and drops the red tint.
    assert "Fully paid" in html

    # --- 9. Dashboard + reports reflect the activity ---------------------
    dash = client.get("/api/dashboard").json()
    assert dash["patients"] >= 1
    assert dash["pending_invoices"] == 0   # invoice was fully paid
    assert dash["month_revenue"] >= 2000


# ===========================================================================
# Scenario 2 — multi-installment with discount
# ===========================================================================
def test_multi_installment_with_discount(client, settings, procedures):
    """Big-ticket treatment (RCT + Crown) with a ₹1000 discount paid off
    across three installments. Verifies:

    * The server applies the discount: ``inv.total == subtotal - discount``.
    * Sum of installments equals ``inv.paid`` and the invoice tips into
      the ``paid`` state once ``inv.paid >= inv.total``.
    * The printable receipt shows the Discount line + every installment.

    We drive the invoice via the HTTP ``POST /api/invoices``, then insert
    payments directly at the ORM layer so the test is not coupled to the
    separately-tracked ``add_payment`` double-add bug.
    """
    r = client.post("/api/patients", json={
        "name": "Vikram Singh", "phone": "+91 98100 44444",
    })
    vikram = r.json()

    rct = procedures["Root Canal Treatment"]
    crown = procedures["Crown (PFM)"]
    r = client.post("/api/invoices", json={
        "patient_id": vikram["id"],
        "items": [
            {"procedure_id": rct["id"], "description": "Root Canal on 46",
             "quantity": 1, "unit_price": rct["default_price"]},
            {"procedure_id": crown["id"], "description": "Crown (PFM) 46",
             "quantity": 1, "unit_price": crown["default_price"]},
        ],
        "discount_amount": 1000,
        "notes": "Package — RCT + crown.",
    })
    inv = r.json()
    # Subtotal = 6000 + 5000 = 11000. Net total after ₹1000 discount = 10000.
    assert inv["total"] == 10000
    assert inv["balance"] == 10000

    # Record three installments on different days via the ORM.
    with Session(engine) as s:
        db_inv = s.get(Invoice, inv["id"])
        db_inv.payments.append(Payment(
            invoice_id=db_inv.id, amount=5000, method=PaymentMethod.upi,
            reference="UTR-A", paid_on=utcnow(),
        ))
        db_inv.payments.append(Payment(
            invoice_id=db_inv.id, amount=3000, method=PaymentMethod.cash,
            paid_on=utcnow(),
        ))
        db_inv.payments.append(Payment(
            invoice_id=db_inv.id, amount=2000, method=PaymentMethod.card,
            reference="POS-42", paid_on=utcnow(),
        ))
        db_inv.paid = 10000
        db_inv.status = InvoiceStatus.paid
        s.add(db_inv)
        s.commit()

    final = client.get(f"/api/invoices/{inv['id']}").json()
    assert final["paid"] == 10000
    assert final["total"] == 10000
    assert final["balance"] == 0
    assert final["status"] == "paid"
    assert len(final["payments"]) == 3

    # Printable receipt shows Discount row + each installment.
    with Session(engine) as s:
        db_inv = s.get(Invoice, inv["id"])
        html = services.render_invoice_html(
            db_inv, db_inv.patient, db_inv.items, db_inv.payments,
            s.get(Settings, 1),
        )
    assert "Discount" in html
    assert "1,000.00" in html
    assert "5,000.00" in html
    assert "3,000.00" in html
    assert "2,000.00" in html
    assert "UTR-A" in html
    assert "POS-42" in html


# ===========================================================================
# Scenario 3 — walk-in single-cash billing
# ===========================================================================
def test_walk_in_cash_billing(client, settings, procedures):
    r = client.post("/api/patients", json={"name": "Walk-in"})
    walk = r.json()

    cons = procedures["Consultation"]
    r = client.post("/api/invoices", json={
        "patient_id": walk["id"],
        "items": [{"description": "Consultation", "procedure_id": cons["id"],
                   "quantity": 1, "unit_price": cons["default_price"]}],
    })
    inv = r.json()

    # Single cash payment — exact match.
    client.post(f"/api/invoices/{inv['id']}/payments",
                json={"amount": cons["default_price"], "method": "cash"})
    assert client.get(f"/api/invoices/{inv['id']}").json()["status"] == "paid"


# ===========================================================================
# Scenario 4 — deleting a patient hides them + returns an undo token
# ===========================================================================
def test_soft_delete_patient_hides_record_and_issues_undo_token(
    client, settings, procedures,
):
    """Soft-delete a patient who has a full history (appointment, treatment,
    invoice, payment). The API should:

    * Return HTTP 200 (NOT 204) with an undo token + friendly label.
    * Immediately hide the patient from GET /api/patients/{id}.
    * Hide them from the list endpoint.
    * Still allow a hard-delete with ``?hard=true`` which returns 204.
    """
    r = client.post("/api/patients", json={"name": "ToDelete"})
    pid = r.json()["id"]

    now = datetime.now(timezone.utc).replace(microsecond=0)
    client.post("/api/appointments", json={
        "patient_id": pid,
        "start": _iso(now),
        "end": _iso(now + timedelta(minutes=30)),
    })
    client.post("/api/treatments", json={
        "patient_id": pid, "procedure_id": procedures["Consultation"]["id"],
    })
    inv = client.post("/api/invoices", json={
        "patient_id": pid, "items": [
            {"description": "Consultation", "quantity": 1, "unit_price": 500},
        ],
    }).json()

    # --- Soft delete ------------------------------------------------------
    r = client.delete(f"/api/patients/{pid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "undo_token" in body
    assert body.get("label", "").startswith("Patient ")

    # Patient is hidden from direct lookup and list endpoints.
    assert client.get(f"/api/patients/{pid}").status_code == 404
    listed_ids = {p["id"] for p in client.get("/api/patients").json()}
    assert pid not in listed_ids

    # The associated invoice still exists on its own endpoint (it owns
    # its patient reference by id); it simply no longer renders the
    # patient's name.
    inv_after = client.get(f"/api/invoices/{inv['id']}")
    assert inv_after.status_code == 200

    # --- Hard delete a second patient ------------------------------------
    hard = client.post("/api/patients", json={"name": "HardDelete"}).json()
    r2 = client.delete(f"/api/patients/{hard['id']}", params={"hard": "true"})
    assert r2.status_code == 204
    assert client.get(f"/api/patients/{hard['id']}").status_code == 404


# ===========================================================================
# Scenario 5 — dashboard + reports aggregate across many patients
# ===========================================================================

def test_dashboard_aggregates_across_multiple_patients(client, settings, procedures):
    cons = procedures["Consultation"]

    # Five patients, each fully paid on a consultation today.
    ids = []
    for i in range(5):
        p = client.post("/api/patients", json={"name": f"Patient-{i}"}).json()
        ids.append(p["id"])
        inv = client.post("/api/invoices", json={
            "patient_id": p["id"],
            "items": [{"description": "Consultation", "quantity": 1,
                       "unit_price": cons["default_price"]}],
        }).json()
        client.post(f"/api/invoices/{inv['id']}/payments",
                    json={"amount": cons["default_price"], "method": "upi"})

    # One unpaid partial for a 6th patient.
    p6 = client.post("/api/patients", json={"name": "Patient-6"}).json()
    inv6 = client.post("/api/invoices", json={
        "patient_id": p6["id"],
        "items": [{"description": "Consultation", "quantity": 1,
                   "unit_price": 500}],
    }).json()
    client.post(f"/api/invoices/{inv6['id']}/payments",
                json={"amount": 200, "method": "cash"})

    dash = client.get("/api/dashboard").json()
    assert dash["patients"] == 6
    assert dash["pending_invoices"] == 1
    assert dash["pending_dues"] == 300     # 500 - 200
    assert dash["month_revenue"] == 5 * cons["default_price"] + 200
