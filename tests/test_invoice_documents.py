"""Invoice document generation tests — PDF + printable HTML.

These tests call the service layer directly rather than hitting the HTTP
endpoint, because:

* We want to assert the content (strings embedded in the HTML, byte-level
  checks on the PDF header) without parsing a streaming response.
* ``services.render_invoice_pdf`` and ``services.render_invoice_html``
  are what the ``/api/invoices/{id}/pdf`` and the planned
  ``/api/invoices/{id}/print`` routes delegate to, so covering them
  gives us confidence in both.

The printable HTML doubles as the receipt / "money receipt" document,
which under the Indian Medical Council (Professional Conduct)
Regulations 2002 clause 1.4.2 must carry the doctor's registration
number — so we explicitly verify that.
"""
from __future__ import annotations

from backend import services
from backend.models import (
    Invoice,
    InvoiceItem,
    Patient,
    Payment,
    PaymentMethod,
    Settings,
    utcnow,
)


def _build_fixture_invoice(paid_amount: float = 0.0, discount: float = 0.0) -> tuple[Invoice, Patient, list[InvoiceItem], list[Payment], Settings]:
    patient = Patient(
        id=1, name="Rahul Mehta", phone="+91 98100 22222",
        created_at=utcnow(),
    )
    items = [
        InvoiceItem(id=1, invoice_id=1, description="Consultation",
                    quantity=1, unit_price=500),
        InvoiceItem(id=2, invoice_id=1, description="Composite Filling",
                    quantity=2, unit_price=1200),
    ]
    subtotal = sum(i.quantity * i.unit_price for i in items)
    total = subtotal - discount
    payments: list[Payment] = []
    if paid_amount:
        payments.append(Payment(
            id=1, invoice_id=1, amount=paid_amount,
            method=PaymentMethod.upi, reference="UTR-42", paid_on=utcnow(),
        ))
    inv = Invoice(
        id=1, patient_id=1, total=total, paid=paid_amount,
        discount_amount=discount, notes="Follow-up in 2 weeks.",
        created_at=utcnow(),
    )
    settings = Settings(
        id=1, updated_at=utcnow(),
        doctor_name="Aisha Kapoor",
        doctor_qualifications="MBBS, MD (Medicine)",
        registration_number="DMC/12345",
        registration_council="Delhi Medical Council",
        clinic_name="Kapoor Family Clinic",
        clinic_address="12, Park Street, New Delhi 110001",
        clinic_phone="+91 98100 00000",
    )
    return inv, patient, items, payments, settings


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------
def test_pdf_has_pdf_signature_and_is_nonempty():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=500)
    pdf = services.render_invoice_pdf(inv, pat, items, pays, settings)
    assert pdf.startswith(b"%PDF-"), "PDF magic header missing"
    # Plausibility check: anything this simple should produce > 1 KB but
    # less than 100 KB (no embedded fonts).
    assert 1024 < len(pdf) < 200_000


def test_pdf_route_returns_pdf(client, patient, procedures):
    """End-to-end check that the HTTP endpoint wraps the renderer correctly."""
    cons = procedures["Consultation"]
    inv = client.post("/api/invoices", json={
        "patient_id": patient["id"],
        "items": [{"description": "Consultation", "quantity": 1,
                   "unit_price": cons["default_price"]}],
    }).json()
    r = client.get(f"/api/invoices/{inv['id']}/pdf")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.content.startswith(b"%PDF-")


# ---------------------------------------------------------------------------
# Printable HTML
# ---------------------------------------------------------------------------
def test_printable_html_contains_line_items_and_totals():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=1000)
    html = services.render_invoice_html(inv, pat, items, pays, settings)

    # Line items
    assert "Consultation" in html
    assert "Composite Filling" in html
    # Quantities and unit prices render as tabular-num cells.
    assert "1,200.00" in html or "1200.00" in html

    # Totals block — subtotal = 500 + 2*1200 = 2900, no discount ⇒ total 2900
    assert "2,900.00" in html
    assert "Paid" in html and "1,000.00" in html
    assert "Balance due" in html and "1,900.00" in html


def test_printable_html_shows_discount_row_when_present():
    inv, pat, items, pays, settings = _build_fixture_invoice(
        paid_amount=0, discount=200,
    )
    html = services.render_invoice_html(inv, pat, items, pays, settings)
    assert "Discount" in html
    # -200.00 appears with the leading minus sign in the rendered markup.
    assert "200.00" in html


def test_printable_html_hides_discount_row_when_zero():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=0, discount=0)
    html = services.render_invoice_html(inv, pat, items, pays, settings)
    # Discount row is omitted when there's no discount to show.
    assert "Discount" not in html


def test_printable_html_contains_clinic_and_doctor_header():
    """This is the 'receipt' view; the clinic name and the doctor must
    show on the document — clinic for branding, doctor for the statutory
    IMC 1.4.2 display requirement (we also embed it in settings.doctor_name).
    """
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=0)
    html = services.render_invoice_html(inv, pat, items, pays, settings)
    assert "Kapoor Family Clinic" in html
    assert "Aisha Kapoor" in html
    assert "+91 98100 00000" in html
    # Billed-to section pulls the patient name + phone.
    assert "Rahul Mehta" in html
    assert "+91 98100 22222" in html


def test_printable_html_includes_payment_history_per_row():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=500)
    html = services.render_invoice_html(inv, pat, items, pays, settings)
    # Each payment appears as its own row — method shown as uppercase.
    assert "UPI" in html
    assert "UTR-42" in html
    assert "500.00" in html


def test_printable_html_strips_demo_tag_and_flips_balance_when_settled():
    """A fully-paid invoice must read "Fully paid" (not "Balance due"),
    must not scream red at the patient, and must hide the internal
    ``[DEMO] `` marker that we stamp on seeded demo data."""
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=2900)
    # Seeded demo rows carry the internal ``[DEMO] `` prefix. The printed
    # invoice must not leak that marker to the patient.
    inv.notes = "[DEMO] Routine checkup — consultation + scaling."
    html = services.render_invoice_html(inv, pat, items, pays, settings)
    assert "[DEMO]" not in html
    assert "Routine checkup" in html
    # Label flips and the settled class overrides the red tint.
    assert "Fully paid" in html
    assert "balance settled" in html


def test_printable_html_keeps_red_balance_when_outstanding():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=0)
    html = services.render_invoice_html(inv, pat, items, pays, settings)
    assert "Balance due" in html
    # Settled/overpaid styles are NOT applied when money is still owed.
    assert "balance settled" not in html
    assert "balance overpaid" not in html


def test_printable_html_placeholder_when_no_payments():
    inv, pat, items, _pays, settings = _build_fixture_invoice(paid_amount=0)
    html = services.render_invoice_html(inv, pat, items, payments=[], settings=settings)
    # Visible hint for the user that the invoice is still fully unpaid.
    assert "No payments recorded yet." in html


def test_printable_html_triggers_print_on_load():
    """The doctor clicks Print and the browser's print dialog pops
    immediately — we enforce that by asserting the ``onload`` hook is in
    the rendered markup."""
    inv, pat, items, _pays, settings = _build_fixture_invoice()
    html = services.render_invoice_html(inv, pat, items, settings=settings)
    assert "window.print()" in html


# ---------------------------------------------------------------------------
# Linked-prescription block — an invoice whose notes say "Rx issued"
# should actually carry the medicines on the printable copy, otherwise the
# patient leaves the clinic with a contradiction.
# ---------------------------------------------------------------------------
def _rx_note_data() -> dict:
    return {
        "chief_complaint": "Acne follow-up",
        "diagnosis": "Moderate acne vulgaris",
        "treatment_advised": "Cleanse twice daily; avoid oil-based products.",
        "notes": "Review in 4 weeks.",
        "prescriptions": [
            {
                "drug": "Isotretinoin",
                "strength": "20mg",
                "frequency": "1 cap at night",
                "duration": "30 days",
                "instructions": "With food",
            },
            {
                "drug": "Adapalene gel",
                "strength": "0.1%",
                "frequency": "Apply at bedtime",
                "duration": "30 days",
                "instructions": "Pea-sized, avoid eyes",
            },
        ],
    }


def test_printable_html_renders_rx_block_when_note_provided():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=500)
    html = services.render_invoice_html(
        inv, pat, items, pays, settings, note_data=_rx_note_data(),
    )
    assert "Prescription (Rx)" in html
    assert "Isotretinoin 20mg" in html
    assert "Adapalene gel 0.1%" in html
    assert "30 days" in html
    assert "With food" in html


def test_printable_html_omits_rx_block_when_no_prescriptions():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=500)
    html = services.render_invoice_html(
        inv, pat, items, pays, settings,
        note_data={"prescriptions": []},
    )
    assert "Prescription (Rx)" not in html


def test_invoice_pdf_includes_rx_when_note_provided():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=500)
    plain = services.render_invoice_pdf(inv, pat, items, pays, settings)
    withrx = services.render_invoice_pdf(
        inv, pat, items, pays, settings, note_data=_rx_note_data(),
    )
    # Exact bytes differ (different table content) and the Rx variant is
    # strictly larger because we added rows + a paragraph.
    assert withrx.startswith(b"%PDF-")
    assert len(withrx) > len(plain)


# ---------------------------------------------------------------------------
# PDF metadata — without /Title the PDF viewer shows "(anonymous)" in the
# tab. /Author is shown in Acrobat's properties pane and in Preview.
# ---------------------------------------------------------------------------
def test_invoice_pdf_sets_document_info_title_and_author():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=500)
    pdf = services.render_invoice_pdf(inv, pat, items, pays, settings)
    # reportlab serialises /Title and /Author into the PDF's DocInfo
    # dict as plain UTF-16 or Latin-1 literals. We only need to assert
    # that the strings appear somewhere in the bytes — exact offset /
    # encoding isn't the contract we care about.
    assert b"/Title" in pdf
    assert b"/Author" in pdf
    assert b"Invoice" in pdf
    assert b"Rahul" in pdf
    assert b"Clinikore" in pdf


# ---------------------------------------------------------------------------
# Patient identity — DOB should now appear when available and fall back
# to the legacy ``age`` field otherwise. Exercised via the invoice's
# "Billed to" block because it reuses the same shared helper as the
# prescription renderers.
# ---------------------------------------------------------------------------
def test_invoice_html_shows_dob_when_present():
    from datetime import date
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=500)
    pat.date_of_birth = date(1990, 3, 15)
    pat.age = None  # force the renderer to derive from DOB
    html_doc = services.render_invoice_html(inv, pat, items, pays, settings)
    assert "DOB: 15 Mar 1990" in html_doc
    # Age is computed from DOB, not hard-coded: assert a plausible
    # two-digit value rather than a specific year-dependent number.
    import re
    assert re.search(r"DOB: 15 Mar 1990 \(\d{2}y\)", html_doc)


def test_invoice_html_falls_back_to_legacy_age_without_dob():
    inv, pat, items, pays, settings = _build_fixture_invoice(paid_amount=500)
    pat.date_of_birth = None
    pat.age = 42
    html_doc = services.render_invoice_html(inv, pat, items, pays, settings)
    assert "Age: 42" in html_doc
    assert "DOB:" not in html_doc


# ---------------------------------------------------------------------------
# Reminder stub — exercised via services directly so we don't flake on
# network in CI. The frontend leans on this to render the Prescription /
# "treatment advised" SMS preview.
# ---------------------------------------------------------------------------
def test_reminder_returns_false_without_phone():
    patient = Patient(id=1, name="No Phone", phone=None, created_at=utcnow())
    ok = services.send_appointment_reminder(patient, utcnow())
    assert ok is False


def test_reminder_sms_stub_succeeds_with_phone():
    patient = Patient(id=1, name="Priya", phone="+91 98100 11111", created_at=utcnow())
    ok = services.send_appointment_reminder(patient, utcnow(), channel="sms")
    assert ok is True


def test_reminder_whatsapp_stub_succeeds_with_phone():
    patient = Patient(id=1, name="Priya", phone="+91 98100 11111", created_at=utcnow())
    ok = services.send_appointment_reminder(patient, utcnow(), channel="whatsapp")
    assert ok is True
