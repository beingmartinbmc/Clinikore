"""Side-effectful services: PDF invoice/prescription generation, printable
HTML, and reminder sending.

The printable templates (invoice + prescription) prominently display the
doctor's statutory registration number. Under the Indian Medical Council
(Professional Conduct, Etiquette and Ethics) Regulations 2002 — Clause
1.4.2 — every doctor MUST display their State Medical Council / NMC
registration number on prescriptions, money receipts (invoices), lab
reports, and certificates. We render it in the header of every outgoing
document alongside the doctor's name, qualifications, and clinic info.
"""
from __future__ import annotations

import html
import io
import logging
import os
from datetime import date, datetime
from typing import Iterable, Optional

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT  # noqa: F401
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    HRFlowable,
)

from backend.models import Invoice, InvoiceItem, Patient, Payment, Settings

log = logging.getLogger("clinikore.services")

# Matches the internal "[DEMO] " marker used by backend.demo so we can safely
# purge demo rows without showing that marker to the doctor or the patient on
# a printable invoice / prescription.
_DEMO_NOTE_PREFIX = "[DEMO] "


def _clean_note(text: Optional[str]) -> str:
    """Strip internal markers (e.g. ``[DEMO] ``) from free-text notes before
    rendering them in user-facing documents."""
    if not text:
        return ""
    t = text.strip()
    if t.startswith(_DEMO_NOTE_PREFIX):
        t = t[len(_DEMO_NOTE_PREFIX):]
    return t


def _age_from_dob(dob: date, today: Optional[date] = None) -> int:
    """Whole-years age from a DOB. Accounts for "hasn't had a birthday yet
    this year" so a patient born 2 Jan 1990 is 34 on 1 Jan 2024, not 35."""
    ref = today or date.today()
    years = ref.year - dob.year
    if (ref.month, ref.day) < (dob.month, dob.day):
        years -= 1
    return max(0, years)


def _patient_identity_bits(patient: Patient) -> list[str]:
    """Build the patient identity meta-line shown on prescriptions and
    invoices. Prefers DOB over the legacy ``age`` field so dated
    printouts remain accurate as time passes; falls back to the stored
    integer age for records predating DOB capture.

    Returns an ordered list of already-formatted strings that the caller
    can join with a separator (` · ` in HTML, the same in PDF)."""
    bits: list[str] = []
    dob = getattr(patient, "date_of_birth", None)
    if dob:
        try:
            age = _age_from_dob(dob)
            bits.append(f"DOB: {dob.strftime('%d %b %Y')} ({age}y)")
        except Exception:
            bits.append(f"DOB: {dob}")
    elif getattr(patient, "age", None):
        bits.append(f"Age: {patient.age}")
    if getattr(patient, "gender", None):
        gender = patient.gender
        # Gender is an Enum in the DB layer but may arrive as a raw
        # string in ad-hoc callers — handle both.
        label = gender.value if hasattr(gender, "value") else gender
        bits.append(str(label).title())
    if patient.phone:
        bits.append(f"Phone: {patient.phone}")
    return bits

# Env-var fallbacks (kept for back-compat); the Settings row wins when present.
CLINIC_NAME_FALLBACK = os.environ.get("CLINIC_NAME", "Clinikore Clinic")
CLINIC_ADDRESS_FALLBACK = os.environ.get("CLINIC_ADDRESS", "")
CLINIC_PHONE_FALLBACK = os.environ.get("CLINIC_PHONE", "")


class ClinicHeader:
    """Resolved header details used by every printable document.

    Centralizes the Settings → display-string mapping so the invoice PDF,
    invoice HTML, and prescription HTML stay in sync. Any new header field
    (e.g. logo, GSTIN) only needs to be added here once.
    """

    __slots__ = (
        "clinic_name",
        "clinic_address",
        "clinic_phone",
        "clinic_email",
        "clinic_gstin",
        "doctor_name",
        "doctor_qualifications",
        "doctor_title",         # "Dr. Priya Sharma, MBBS, MD"
        "registration_line",    # "Reg. No. 12345 (Delhi Medical Council)"
        "registration_number",
        "registration_council",
        "specialization",
    )

    def __init__(self, settings: Optional[Settings]) -> None:
        self.clinic_name = (
            (settings.clinic_name if settings and settings.clinic_name else CLINIC_NAME_FALLBACK)
        )
        self.clinic_address = (
            (settings.clinic_address if settings and settings.clinic_address else CLINIC_ADDRESS_FALLBACK)
            or ""
        )
        self.clinic_phone = (
            (settings.clinic_phone if settings and settings.clinic_phone else CLINIC_PHONE_FALLBACK)
            or ""
        )
        self.clinic_email = (settings.clinic_email if settings else "") or ""
        self.clinic_gstin = (settings.clinic_gstin if settings else "") or ""
        self.doctor_name = (settings.doctor_name if settings else "") or ""
        self.doctor_qualifications = (
            (settings.doctor_qualifications if settings else "") or ""
        )
        self.specialization = (settings.specialization if settings else "") or ""
        self.registration_number = (
            (settings.registration_number if settings else "") or ""
        )
        self.registration_council = (
            (settings.registration_council if settings else "") or ""
        )

        name = self.doctor_name
        parts = []
        if name:
            parts.append(f"Dr. {name}")
        if self.doctor_qualifications:
            parts.append(self.doctor_qualifications)
        self.doctor_title = ", ".join(parts)

        if self.registration_number and self.registration_council:
            self.registration_line = (
                f"Reg. No. {self.registration_number} "
                f"({self.registration_council})"
            )
        elif self.registration_number:
            self.registration_line = f"Reg. No. {self.registration_number}"
        else:
            self.registration_line = ""


# Back-compat thin wrapper (still used by older callers in tests).
def _clinic_header(settings: Optional[Settings]) -> tuple[str, str, str, str]:
    h = ClinicHeader(settings)
    return h.clinic_name, h.clinic_address, h.clinic_phone, h.doctor_name


# ---------- Invoice PDF ----------
def render_invoice_pdf(
    invoice: Invoice,
    patient: Patient,
    items: Iterable[InvoiceItem],
    payments: Optional[Iterable[Payment]] = None,
    settings: Optional[Settings] = None,
    note_data: Optional[dict] = None,
) -> bytes:
    h = ClinicHeader(settings)

    buf = io.BytesIO()
    # ``title`` + ``author`` populate the PDF's Document Info dictionary
    # — Preview, Acrobat and Chrome's PDF viewer all read from here when
    # showing the tab/window title. Without it the PDF shows up as
    # "(anonymous)" in the viewer chrome.
    pdf_title = f"Invoice #{invoice.id:05d} — {patient.name}"
    pdf_author = h.doctor_title or h.clinic_name
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=1.6 * cm, rightMargin=1.6 * cm,
        topMargin=1.6 * cm, bottomMargin=1.6 * cm,
        title=pdf_title, author=pdf_author,
        subject="Clinic invoice", creator="Clinikore",
    )
    styles = getSampleStyleSheet()
    brand = colors.HexColor("#0f766e")
    muted = colors.HexColor("#64748b")
    accent_bg = colors.HexColor("#f0fdfa")

    # NB: reportlab's built-in "Title" style is centered. Force-left so the
    # clinic name, doctor name, and registration number all align on the
    # same (left) edge of the header column — matches the HTML invoice.
    clinic_style = ParagraphStyle(
        "ClinicName", parent=styles["Title"], fontSize=20,
        leading=24, textColor=brand, spaceAfter=2, alignment=TA_LEFT,
    )
    small = ParagraphStyle(
        "Small", parent=styles["Normal"], fontSize=9, leading=12,
        textColor=muted, alignment=TA_LEFT,
    )
    reg_style = ParagraphStyle(
        "Reg", parent=styles["Normal"], fontSize=9, leading=12,
        textColor=colors.HexColor("#334155"), fontName="Helvetica-Bold",
        alignment=TA_LEFT,
    )
    doctor_style = ParagraphStyle(
        "DoctorName", parent=styles["Normal"], alignment=TA_LEFT,
    )
    right_small = ParagraphStyle(
        "RightSmall", parent=small, alignment=TA_RIGHT,
    )
    inv_title = ParagraphStyle(
        "InvoiceTitle", parent=styles["Heading1"], fontSize=18, leading=22,
        alignment=TA_RIGHT, spaceAfter=0, textColor=colors.HexColor("#0f172a"),
    )

    # ---- Header row: clinic/doctor on the left, invoice meta on the right
    left_bits = [Paragraph(html.escape(h.clinic_name), clinic_style)]
    if h.doctor_title:
        left_bits.append(Paragraph(html.escape(h.doctor_title), doctor_style))
    if h.specialization:
        left_bits.append(Paragraph(html.escape(h.specialization), small))
    if h.registration_line:
        left_bits.append(Paragraph(html.escape(h.registration_line), reg_style))
    if h.clinic_address:
        left_bits.append(Paragraph(
            html.escape(h.clinic_address).replace("\n", "<br/>"), small,
        ))
    contact_line = " · ".join(x for x in [
        (f"Phone: {html.escape(h.clinic_phone)}" if h.clinic_phone else ""),
        (f"Email: {html.escape(h.clinic_email)}" if h.clinic_email else ""),
    ] if x)
    if contact_line:
        left_bits.append(Paragraph(contact_line, small))
    if h.clinic_gstin:
        left_bits.append(Paragraph(f"GSTIN: {html.escape(h.clinic_gstin)}", small))

    right_bits = [
        Paragraph("INVOICE", inv_title),
        Paragraph(f"<b>#{invoice.id:05d}</b>", right_small),
        Paragraph(
            f"Date: {invoice.created_at.strftime('%d %b %Y')}",
            right_small,
        ),
        Paragraph(
            f"Status: <b>{(invoice.status.value if hasattr(invoice.status, 'value') else invoice.status).upper()}</b>",
            right_small,
        ),
    ]

    header_table = Table(
        [[left_bits, right_bits]],
        colWidths=[11 * cm, 6.4 * cm],
    )
    header_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    story: list = [header_table, Spacer(1, 0.3 * cm),
                   HRFlowable(width="100%", thickness=1.2, color=brand),
                   Spacer(1, 0.4 * cm)]

    # ---- Billed-to block
    billed_bits = [Paragraph("<b>BILLED TO</b>", small),
                   Paragraph(f"<b>{html.escape(patient.name)}</b>",
                             styles["Normal"])]
    if patient.phone:
        billed_bits.append(Paragraph(f"Phone: {html.escape(patient.phone)}", small))
    if getattr(patient, "age", None):
        billed_bits.append(Paragraph(f"Age: {patient.age}", small))
    billed_table = Table(
        [[billed_bits]],
        colWidths=[17.4 * cm],
    )
    billed_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), accent_bg),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#99f6e4")),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(billed_table)
    story.append(Spacer(1, 0.5 * cm))

    # ---- Line items
    items_list = list(items)
    data = [["#", "Description", "Qty", "Unit Price (INR)", "Amount (INR)"]]
    subtotal = 0.0
    for idx, it in enumerate(items_list, 1):
        amt = it.quantity * it.unit_price
        subtotal += amt
        data.append([
            str(idx),
            it.description,
            str(it.quantity),
            f"{it.unit_price:,.2f}",
            f"{amt:,.2f}",
        ])

    discount = float(getattr(invoice, "discount_amount", 0.0) or 0.0)
    data.append(["", "", "", "Subtotal", f"{subtotal:,.2f}"])
    if discount:
        data.append(["", "", "", "Discount", f"-{discount:,.2f}"])
    data.append(["", "", "", "Total", f"{invoice.total:,.2f}"])
    data.append(["", "", "", "Paid", f"{invoice.paid:,.2f}"])
    balance_due = invoice.total - invoice.paid
    balance_label = (
        "Balance Due" if balance_due > 0
        else ("Overpaid" if balance_due < 0 else "Fully Paid")
    )
    data.append(["", "", "", balance_label, f"{abs(balance_due):,.2f}"])

    table = Table(data, colWidths=[0.9 * cm, 9 * cm, 1.5 * cm, 3 * cm, 3 * cm])
    footer_rows = 3 + (1 if discount else 0) + 1  # subtotal [+discount] total paid balance
    grid_end = -(footer_rows + 1)
    # Colour the balance row by outstanding amount: red only when the
    # patient still owes money; green when settled; amber when overpaid.
    if balance_due > 0.0001:
        balance_color = colors.HexColor("#dc2626")  # rose-600
    elif balance_due < -0.0001:
        balance_color = colors.HexColor("#b45309")  # amber-700
    else:
        balance_color = colors.HexColor("#047857")  # emerald-700
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), brand),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 10),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, grid_end), [colors.white, colors.HexColor("#f8fafc")]),
        ("GRID", (0, 0), (-1, grid_end), 0.25, colors.HexColor("#e2e8f0")),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("FONTNAME", (-2, -3), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (-2, -footer_rows), (-1, -footer_rows), 0.6, colors.HexColor("#334155")),
        ("TEXTCOLOR", (-2, -1), (-1, -1), balance_color),
    ]))
    story.append(table)
    story.append(Spacer(1, 0.5 * cm))

    # ---- Payment history (important for partial payments)
    payments_list = [p for p in (payments or []) if getattr(p, "deleted_at", None) is None]
    if payments_list:
        story.append(Paragraph("<b>Payment history</b>", styles["Heading4"]))
        pay_data = [["Date", "Method", "Reference", "Amount (INR)"]]
        for p in payments_list:
            method = p.method.value if hasattr(p.method, "value") else str(p.method)
            pay_data.append([
                p.paid_on.strftime("%d %b %Y, %I:%M %p") if p.paid_on else "—",
                method.upper(),
                p.reference or "—",
                f"{p.amount:,.2f}",
            ])
        ptable = Table(pay_data, colWidths=[4.6 * cm, 2.4 * cm, 7.4 * cm, 3 * cm])
        ptable.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("ALIGN", (-1, 0), (-1, -1), "RIGHT"),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
        ]))
        story.append(ptable)
        story.append(Spacer(1, 0.5 * cm))

    clean_notes = _clean_note(invoice.notes)
    if clean_notes:
        story.append(Paragraph(
            f"<b>Notes:</b> {html.escape(clean_notes)}",
            styles["Normal"],
        ))
        story.append(Spacer(1, 0.3 * cm))

    # ---- Optional compact Rx block (when the invoice is linked to a
    # consultation note that actually contains medicines). Kept short so
    # the invoice stays primarily about billing; the standalone
    # prescription remains the authoritative dispensing document.
    rx_rows = _rx_rows_from_note(note_data)
    if rx_rows:
        story.append(Spacer(1, 0.25 * cm))
        story.append(Paragraph("<b>Prescription (Rx)</b>", styles["Heading4"]))
        rx_data = [["#", "Medicine", "Dosage", "Duration"]]
        for i, r in enumerate(rx_rows, start=1):
            med_cell = f"<b>{html.escape(r['medicine'])}</b>"
            if r["instructions"]:
                med_cell += (
                    f'<br/><font size="8" color="#64748b">'
                    f"{html.escape(r['instructions'])}</font>"
                )
            rx_data.append([
                str(i),
                Paragraph(med_cell, styles["Normal"]),
                r["dose"] or "—",
                r["duration"] or "—",
            ])
        rx_table = Table(
            rx_data, colWidths=[0.9 * cm, 8.5 * cm, 4 * cm, 4 * cm],
        )
        rx_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f766e")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, 0), 9),
            ("FONTSIZE", (0, 1), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [colors.white, colors.HexColor("#f8fafc")]),
        ]))
        story.append(rx_table)
        story.append(Spacer(1, 0.2 * cm))
        story.append(Paragraph(
            "Refer to the standalone prescription for complete "
            "instructions and advice.",
            small,
        ))
        story.append(Spacer(1, 0.3 * cm))

    # ---- Footer: signature + statutory reminder
    story.append(Spacer(1, 0.6 * cm))
    sig_line = "_______________________"
    sig_cell = [
        Paragraph(sig_line, small),
        Paragraph(
            f"<b>{html.escape(h.doctor_title or 'Doctor')}</b>",
            styles["Normal"],
        ),
    ]
    if h.registration_line:
        sig_cell.append(Paragraph(html.escape(h.registration_line), small))

    footer_msg = Paragraph(
        "Thank you for choosing "
        f"{html.escape(h.clinic_name)}. For queries regarding this "
        "invoice please retain this copy.",
        small,
    )
    footer_table = Table(
        [[footer_msg, sig_cell]],
        colWidths=[10 * cm, 7.4 * cm],
    )
    footer_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(footer_table)

    doc.build(story)
    return buf.getvalue()


# ---------- Printable HTML helpers ----------
_PRINT_CSS = """
  :root {
    --brand: #0f766e;
    --brand-dark: #115e59;
    --ink: #0f172a;
    --muted: #64748b;
    --line: #e2e8f0;
    --bg-soft: #f0fdfa;
  }
  * { box-sizing: border-box; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                 "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    margin: 0;
    background: #f8fafc;
  }
  .page {
    background: #ffffff;
    max-width: 820px;
    margin: 1.5rem auto;
    padding: 2.25rem 2.5rem 2rem;
    border-radius: 10px;
    box-shadow: 0 2px 12px rgba(15, 23, 42, 0.06);
    border: 1px solid var(--line);
    position: relative;
  }
  .page::before {
    content: "";
    position: absolute; top: 0; left: 0; right: 0;
    height: 6px; background: linear-gradient(90deg, var(--brand), #14b8a6);
    border-top-left-radius: 10px; border-top-right-radius: 10px;
  }
  h1.clinic {
    margin: 0 0 0.1rem; font-size: 1.55rem; color: var(--brand);
    letter-spacing: 0.2px;
  }
  .muted { color: var(--muted); }
  .doctor-line { font-weight: 600; color: #334155; }
  .reg-badge {
    display: inline-block;
    background: #ecfeff;
    border: 1px solid #a5f3fc;
    color: #0e7490;
    font-weight: 600;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 0.78rem;
    margin-top: 0.3rem;
    letter-spacing: 0.2px;
  }
  .row {
    display: flex; justify-content: space-between;
    align-items: flex-start; gap: 2rem;
  }
  .doc-title {
    text-transform: uppercase; letter-spacing: 2px; color: var(--muted);
    font-size: 0.78rem;
  }
  .doc-number { font-size: 1.35rem; font-weight: 700; color: var(--brand-dark); }
  .status-pill {
    display: inline-block; padding: 3px 10px; border-radius: 999px;
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.3px;
    text-transform: uppercase;
  }
  .status-pill.paid { background: #dcfce7; color: #166534; }
  .status-pill.unpaid { background: #fee2e2; color: #991b1b; }
  .status-pill.partial { background: #fef3c7; color: #92400e; }
  .divider {
    height: 1px; background: var(--line); margin: 1.25rem 0;
  }
  .billed {
    background: var(--bg-soft); border: 1px solid #99f6e4;
    padding: 0.9rem 1rem; border-radius: 8px; margin: 0.5rem 0 1.25rem;
  }
  .billed .label {
    font-size: 0.7rem; color: var(--muted);
    letter-spacing: 1.3px; text-transform: uppercase;
  }
  .billed .name { font-weight: 700; font-size: 1.05rem; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 10px 12px; text-align: left; }
  thead th {
    background: var(--brand); color: #ffffff;
    font-weight: 600; font-size: 0.82rem;
    letter-spacing: 0.4px; text-transform: uppercase;
  }
  tbody tr:nth-child(even) td { background: #f8fafc; }
  tbody td { border-bottom: 1px solid var(--line); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals {
    margin: 1rem 0 0 auto; width: 320px; border: 1px solid var(--line);
    border-radius: 8px; overflow: hidden;
  }
  .totals td { border: none; padding: 7px 12px; font-size: 13.5px; }
  .totals tr.sub td { background: #f8fafc; }
  .totals tr.total td { font-weight: 700; border-top: 1px solid #94a3b8; }
  .totals tr.balance td { background: #fff1f2; color: #b91c1c; font-weight: 700; }
  .totals tr.balance.settled td { background: #ecfdf5; color: #047857; }
  .totals tr.balance.overpaid td { background: #fffbeb; color: #b45309; }
  .card {
    border: 1px solid var(--line); border-radius: 8px;
    padding: 1rem 1.1rem; margin-top: 1.25rem;
  }
  .card h3 {
    margin: 0 0 0.6rem; font-size: 0.95rem;
    color: #334155; letter-spacing: 0.2px;
  }
  .rx-list {
    margin: 0; padding-left: 1.2rem; line-height: 1.7;
  }
  .rx-card h3.rx-title {
    font-size: 1.05rem; color: var(--brand); letter-spacing: 0.3px;
    text-transform: uppercase; margin-bottom: 0.8rem;
  }
  .rx-table {
    width: 100%; border-collapse: collapse; font-size: 0.92rem;
    border: 1px solid var(--line); border-radius: 6px; overflow: hidden;
  }
  .rx-table thead th {
    background: var(--brand); color: #ffffff; text-align: left;
    font-weight: 600; font-size: 0.72rem; letter-spacing: 0.5px;
    text-transform: uppercase; padding: 8px 10px;
  }
  .rx-table tbody td {
    padding: 9px 10px; border-top: 1px solid #e2e8f0;
    vertical-align: top; color: var(--ink);
  }
  .rx-table tbody tr:nth-child(even) td { background: #f8fafc; }
  .rx-table .rx-num {
    width: 2.2rem; text-align: center;
    color: var(--muted); font-variant-numeric: tabular-nums;
  }
  .rx-table .rx-med { width: 28%; }
  .rx-dash { color: #94a3b8; }
  .section-title {
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.6px;
    color: var(--brand); text-transform: uppercase; margin-bottom: 4px;
  }
  .footer {
    display: flex; justify-content: space-between;
    align-items: flex-end; gap: 2rem; margin-top: 2.5rem;
  }
  .sig {
    text-align: center; min-width: 220px;
  }
  .sig .line {
    border-top: 1px solid #334155; margin-bottom: 4px;
    padding-top: 26px;
  }
  .sig .name { font-weight: 700; }
  .legal {
    font-size: 0.72rem; color: var(--muted); text-align: center;
    margin-top: 1.5rem; border-top: 1px dashed var(--line); padding-top: 0.7rem;
  }
  .actions {
    display: flex; gap: 0.6rem; justify-content: center;
    margin: 1.2rem 0 2rem;
  }
  button {
    padding: 9px 18px; font-size: 14px; cursor: pointer;
    border-radius: 8px; border: 1px solid var(--line);
    background: white; color: var(--ink); font-weight: 500;
  }
  button.primary {
    background: var(--brand); color: white; border-color: var(--brand);
  }
  button:hover { filter: brightness(1.04); }
  @media print {
    body { background: white; }
    .actions { display: none; }
    .page {
      box-shadow: none; border: none; margin: 0; max-width: none;
      border-radius: 0; padding: 1cm 1.4cm;
    }
    .page::before { border-radius: 0; }
  }
"""


def _render_header_block(h: ClinicHeader) -> str:
    """Shared top-of-page clinic + doctor + registration block."""
    def esc(v: object) -> str:
        return html.escape(str(v) if v is not None else "")

    # Under MCI 1.4.2 the registration number is MANDATORY on invoices &
    # prescriptions — render a visible placeholder if unset so the doctor
    # fixes Settings before using the doc.
    if h.registration_line:
        reg_html = f'<div class="reg-badge">{esc(h.registration_line)}</div>'
    else:
        reg_html = (
            '<div class="reg-badge" style="background:#fef3c7;'
            'border-color:#fde68a;color:#92400e">'
            "Registration number missing — update in Settings</div>"
        )

    contact_bits = []
    if h.clinic_phone:
        contact_bits.append(f"Phone: {esc(h.clinic_phone)}")
    if h.clinic_email:
        contact_bits.append(f"Email: {esc(h.clinic_email)}")
    contact_line = " · ".join(contact_bits)

    # Clinic name, doctor name, specialization and registration badge all
    # flush-left against the same edge — keeps the printable header tidy
    # and matches the PDF layout.
    return f"""
      <div style="text-align:left">
        <h1 class="clinic">{esc(h.clinic_name)}</h1>
        {f'<div class="doctor-line">{esc(h.doctor_title)}</div>' if h.doctor_title else ''}
        {f'<div class="muted" style="font-size:0.9rem">{esc(h.specialization)}</div>' if h.specialization else ''}
        {reg_html}
        {f'<div class="muted" style="margin-top:0.5rem;white-space:pre-wrap">{esc(h.clinic_address)}</div>' if h.clinic_address else ''}
        {f'<div class="muted">{contact_line}</div>' if contact_line else ''}
        {f'<div class="muted">GSTIN: {esc(h.clinic_gstin)}</div>' if h.clinic_gstin else ''}
      </div>
    """


# ---------- Printable invoice HTML ----------
def _rx_rows_from_note(note_data: Optional[dict]) -> list[dict]:
    """Normalise structured prescription rows from a note dict. Shared by
    the invoice renderers (compact Rx block at the end of the invoice)
    and the standalone prescription renderers so both stay in sync."""
    if not note_data:
        return []
    rows: list[dict] = []
    for item in note_data.get("prescriptions") or []:
        if isinstance(item, str):
            text = item.strip()
            if text:
                rows.append({
                    "medicine": text, "dose": "",
                    "duration": "", "instructions": "",
                })
            continue
        if not isinstance(item, dict):
            continue
        drug = (item.get("drug") or "").strip()
        strength = (item.get("strength") or "").strip()
        medicine = f"{drug} {strength}".strip()
        if not medicine:
            continue
        rows.append({
            "medicine": medicine,
            "dose": (item.get("frequency") or "").strip(),
            "duration": (item.get("duration") or "").strip(),
            "instructions": (item.get("instructions") or "").strip(),
        })
    return rows


def _invoice_rx_block_html(note_data: Optional[dict], esc) -> str:
    """Compact Rx card rendered at the bottom of the printable invoice.
    Kept short — no SOAP sections — so the invoice stays about billing
    and the standalone Rx remains the authoritative dispensing document.
    Returns '' when the linked note has no medicines."""
    rows = _rx_rows_from_note(note_data)
    if not rows:
        return ""
    def _rx_row_html(i: int, r: dict) -> str:
        instr = r["instructions"]
        instr_html = (
            f'<div class="muted" style="font-size:0.8rem">{esc(instr)}</div>'
            if instr else ""
        )
        return (
            f"<tr><td style='width:26px'>{i + 1}</td>"
            f"<td><b>{esc(r['medicine'])}</b>{instr_html}</td>"
            f"<td>{esc(r['dose'] or '—')}</td>"
            f"<td>{esc(r['duration'] or '—')}</td></tr>"
        )

    body = "".join(_rx_row_html(i, r) for i, r in enumerate(rows))
    return (
        "<div class='card'>"
        "<h3>Prescription (Rx)</h3>"
        "<table>"
        "<thead><tr><th style='width:26px'>#</th><th>Medicine</th>"
        "<th style='width:160px'>Dosage</th>"
        "<th style='width:120px'>Duration</th></tr></thead>"
        f"<tbody>{body}</tbody>"
        "</table>"
        "<div class='muted' style='font-size:0.78rem; margin-top:0.4rem'>"
        "Refer to the standalone prescription for complete instructions and advice."
        "</div>"
        "</div>"
    )


def render_invoice_html(
    invoice: Invoice,
    patient: Patient,
    items: Iterable[InvoiceItem],
    payments: Optional[Iterable[Payment]] = None,
    settings: Optional[Settings] = None,
    note_data: Optional[dict] = None,
) -> str:
    """Print-friendly HTML page for the invoice. Opens the browser print
    dialog automatically — clicking "Print" from the UI gives the doctor a
    native PDF / hard copy without a server round-trip."""
    h = ClinicHeader(settings)
    items_list = list(items)
    payments_list = [p for p in (payments or []) if getattr(p, "deleted_at", None) is None]

    subtotal = sum(i.quantity * i.unit_price for i in items_list)
    discount = float(getattr(invoice, "discount_amount", 0.0) or 0.0)
    balance = invoice.total - invoice.paid
    status_val = invoice.status.value if hasattr(invoice.status, "value") else str(invoice.status)
    # Tone the balance-due row based on the current outstanding amount so
    # a fully-paid invoice doesn't scream red at the patient.
    if balance > 0.0001:
        balance_class = "balance"
        balance_label = "Balance due"
    elif balance < -0.0001:
        balance_class = "balance overpaid"
        balance_label = "Overpaid"
    else:
        balance_class = "balance settled"
        balance_label = "Fully paid"
    clean_notes = _clean_note(invoice.notes)

    def esc(v: object) -> str:
        return html.escape(str(v) if v is not None else "")

    item_rows = "".join(
        f"<tr><td>{i+1}</td><td>{esc(it.description)}</td>"
        f"<td class='num'>{it.quantity}</td>"
        f"<td class='num'>{it.unit_price:,.2f}</td>"
        f"<td class='num'>{it.quantity * it.unit_price:,.2f}</td></tr>"
        for i, it in enumerate(items_list)
    ) or "<tr><td colspan='5' class='muted'>No line items.</td></tr>"

    payment_rows = "".join(
        f"<tr><td>{esc(p.paid_on.strftime('%d %b %Y, %I:%M %p') if p.paid_on else '—')}</td>"
        f"<td>{esc((p.method.value if hasattr(p.method, 'value') else p.method)).upper()}</td>"
        f"<td>{esc(p.reference or '—')}</td>"
        f"<td class='num'>{p.amount:,.2f}</td></tr>"
        for p in payments_list
    ) or "<tr><td colspan='4' class='muted'>No payments recorded yet.</td></tr>"

    header_block = _render_header_block(h)

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Invoice #{invoice.id:05d} — {esc(h.clinic_name)}</title>
  <style>{_PRINT_CSS}</style>
</head>
<body>
  <div class="page">
    <div class="row">
      <div style="flex:1">
        {header_block}
      </div>
      <div style="text-align:right">
        <div class="doc-title">Invoice</div>
        <div class="doc-number">#{invoice.id:05d}</div>
        <div class="muted">{esc(invoice.created_at.strftime('%d %b %Y'))}</div>
        <div style="margin-top:0.4rem">
          <span class="status-pill {esc(status_val)}">{esc(status_val)}</span>
        </div>
      </div>
    </div>

    <div class="billed">
      <div class="label">Billed to</div>
      <div class="name">{esc(patient.name)}</div>
      <div class="muted" style="font-size:0.88rem">
        {esc(" · ".join(_patient_identity_bits(patient)))}
      </div>
    </div>

    <table>
      <thead>
        <tr><th style="width:40px">#</th><th>Description</th>
            <th class="num" style="width:70px">Qty</th>
            <th class="num" style="width:120px">Unit Price</th>
            <th class="num" style="width:130px">Amount</th></tr>
      </thead>
      <tbody>{item_rows}</tbody>
    </table>

    <table class="totals">
      <tr class="sub"><td>Subtotal</td><td class="num">INR {subtotal:,.2f}</td></tr>
      {f'<tr class="sub"><td>Discount</td><td class="num">- INR {discount:,.2f}</td></tr>' if discount else ''}
      <tr class="total"><td>Total</td><td class="num">INR {invoice.total:,.2f}</td></tr>
      <tr class="sub"><td>Paid</td><td class="num">INR {invoice.paid:,.2f}</td></tr>
      <tr class="{balance_class}"><td>{balance_label}</td><td class="num">INR {abs(balance):,.2f}</td></tr>
    </table>

    <div class="card">
      <h3>Payment history</h3>
      <table>
        <thead>
          <tr><th>Date</th><th style="width:90px">Method</th>
              <th>Reference</th><th class="num" style="width:130px">Amount</th></tr>
        </thead>
        <tbody>{payment_rows}</tbody>
      </table>
    </div>

    {f'<div class="card"><h3>Notes</h3><div style="white-space:pre-wrap">{esc(clean_notes)}</div></div>' if clean_notes else ''}

    {_invoice_rx_block_html(note_data, esc)}

    <div class="footer">
      <div class="muted" style="font-size:0.8rem; max-width:55%">
        Thank you for choosing <b>{esc(h.clinic_name)}</b>. Please retain
        this invoice as proof of payment. For any queries, contact us on the
        details above.
      </div>
      <div class="sig">
        <div class="line"></div>
        <div class="name">{esc(h.doctor_title or 'Doctor')}</div>
        {f'<div class="muted" style="font-size:0.78rem">{esc(h.registration_line)}</div>' if h.registration_line else ''}
      </div>
    </div>

    <div class="legal">
      This invoice is computer-generated. Registration number is displayed
      as required under the Indian Medical Council (Professional Conduct)
      Regulations, 2002.
    </div>
  </div>

  <div class="actions">
    <button class="primary" onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
  </div>

  <script>
    // Auto-open the browser print dialog — one click from "Print" in the app.
    window.addEventListener('load', function () {{ setTimeout(window.print, 250); }});
  </script>
</body>
</html>"""


# ---------- Printable prescription HTML ----------
def render_prescription_html(
    patient: Patient,
    note_data: dict,
    settings: Optional[Settings] = None,
) -> str:
    """Printable Rx / consultation note. Mirrors the invoice header so the
    doctor's name, qualifications, specialization, and (MANDATORY) State
    Medical Council / NMC registration number are printed on every script.

    `note_data` is a plain dict (decoupled from the SQLModel class so this
    helper can also be used for ad-hoc printouts that aren't stored in the
    DB — for example, a walk-in patient where the doctor just wants a
    clean Rx to hand over).

    Expected keys (all optional):
      - chief_complaint, diagnosis, treatment_advised, notes: strings
      - date: datetime
      - appointment_date: datetime
      - prescriptions: list[str]  (each already formatted, e.g.
        "Paracetamol 500mg — 1 tab, TDS × 5 days")
    """
    h = ClinicHeader(settings)

    def esc(v: object) -> str:
        return html.escape(str(v) if v is not None else "")

    chief = note_data.get("chief_complaint") or ""
    diagnosis = note_data.get("diagnosis") or ""
    advised = note_data.get("treatment_advised") or ""
    notes = note_data.get("notes") or ""
    rx_items = note_data.get("prescriptions") or []
    when: datetime = (
        note_data.get("appointment_date")
        or note_data.get("date")
        or datetime.utcnow()
    )

    def _rx_row(item) -> Optional[dict]:
        """Normalise a prescription row so the HTML and PDF renderers can
        share the same four-column layout (medicine / dose / duration /
        instructions)."""
        if isinstance(item, str):
            text = item.strip()
            if not text:
                return None
            return {
                "medicine": text, "dose": "",
                "duration": "", "instructions": "",
            }
        if not isinstance(item, dict):
            text = str(item).strip()
            return {
                "medicine": text, "dose": "",
                "duration": "", "instructions": "",
            } if text else None
        drug = (item.get("drug") or "").strip()
        strength = (item.get("strength") or "").strip()
        medicine = f"{drug} {strength}".strip()
        if not medicine:
            return None
        return {
            "medicine": medicine,
            "dose": (item.get("frequency") or "").strip(),
            "duration": (item.get("duration") or "").strip(),
            "instructions": (item.get("instructions") or "").strip(),
        }

    rx_rows = [r for r in (_rx_row(x) for x in rx_items) if r]

    rx_block = ""
    if rx_rows:
        def _cell(v: str) -> str:
            return esc(v) if v else '<span class="rx-dash">—</span>'
        rows_html = "".join(
            f"<tr>"
            f"<td class='rx-num'>{i}</td>"
            f"<td class='rx-med'><b>{esc(r['medicine'])}</b></td>"
            f"<td>{_cell(r['dose'])}</td>"
            f"<td>{_cell(r['duration'])}</td>"
            f"<td>{_cell(r['instructions'])}</td>"
            f"</tr>"
            for i, r in enumerate(rx_rows, 1)
        )
        rx_block = f"""
        <div class="card rx-card">
          <h3 class="rx-title">&#8478; &nbsp; PRESCRIPTION</h3>
          <table class="rx-table">
            <thead>
              <tr>
                <th class="rx-num">#</th>
                <th>Medicine</th>
                <th>Dosage / When to take</th>
                <th>Duration</th>
                <th>Instructions</th>
              </tr>
            </thead>
            <tbody>{rows_html}</tbody>
          </table>
        </div>
        """
    elif advised:
        # No structured Rx — fall back to treatment_advised as a free-text
        # block, preserving the doctor's own formatting (line breaks).
        rx_block = (
            '<div class="card"><h3>Prescription / Advice</h3>'
            f'<div style="white-space:pre-wrap;line-height:1.6">{esc(advised)}</div>'
            "</div>"
        )

    header_block = _render_header_block(h)

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Prescription — {esc(patient.name)} — {esc(h.clinic_name)}</title>
  <style>{_PRINT_CSS}</style>
</head>
<body>
  <div class="page">
    <div class="row">
      <div style="flex:1">
        {header_block}
      </div>
      <div style="text-align:right">
        <div class="doc-title">Prescription</div>
        <div class="muted">{esc(when.strftime('%d %b %Y'))}</div>
      </div>
    </div>

    <div class="billed">
      <div class="row">
        <div>
          <div class="label">Patient</div>
          <div class="name">{esc(patient.name)}</div>
          <div class="muted" style="font-size:0.88rem">
            {esc(" · ".join(_patient_identity_bits(patient)))}
          </div>
        </div>
        <div style="text-align:right">
          <div class="label">Date</div>
          <div class="muted">{esc(when.strftime('%d %b %Y, %I:%M %p'))}</div>
        </div>
      </div>
    </div>

    {f'<div class="card"><div class="section-title">Chief complaint</div><div style="white-space:pre-wrap">{esc(chief)}</div></div>' if chief else ''}
    {f'<div class="card"><div class="section-title">Diagnosis</div><div style="white-space:pre-wrap">{esc(diagnosis)}</div></div>' if diagnosis else ''}
    {rx_block}
    {f'<div class="card"><div class="section-title">Advice</div><div style="white-space:pre-wrap">{esc(advised)}</div></div>' if advised and rx_rows else ''}
    {f'<div class="card"><div class="section-title">Notes / Follow-up</div><div style="white-space:pre-wrap">{esc(notes)}</div></div>' if notes else ''}

    <div class="footer">
      <div class="muted" style="font-size:0.8rem; max-width:55%">
        Please take medication as prescribed. Contact the clinic immediately
        if symptoms worsen or you experience any adverse reaction.
      </div>
      <div class="sig">
        <div class="line"></div>
        <div class="name">{esc(h.doctor_title or 'Doctor')}</div>
        {f'<div class="muted" style="font-size:0.78rem">{esc(h.registration_line)}</div>' if h.registration_line else ''}
      </div>
    </div>

    <div class="legal">
      This prescription is computer-generated. Registration number is
      displayed as required under the Indian Medical Council (Professional
      Conduct) Regulations, 2002 — Clause 1.4.2. Not valid without the
      doctor's signature.
    </div>
  </div>

  <div class="actions">
    <button class="primary" onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
  </div>

  <script>
    window.addEventListener('load', function () {{ setTimeout(window.print, 250); }});
  </script>
</body>
</html>"""


# ---------- Prescription PDF ----------
def render_prescription_pdf(
    patient: Patient,
    note_data: dict,
    settings: Optional[Settings] = None,
) -> bytes:
    """Printable Rx as a proper PDF (reportlab).

    Mirrors the invoice PDF layout so the doctor's clinic, registration
    number and footer disclaimer are identical in both documents. Accepts
    the same ``note_data`` dict as :func:`render_prescription_html` so the
    HTML and PDF outputs stay in sync.
    """
    h = ClinicHeader(settings)

    chief = _clean_note(note_data.get("chief_complaint"))
    diagnosis = _clean_note(note_data.get("diagnosis"))
    advised = _clean_note(note_data.get("treatment_advised"))
    notes = _clean_note(note_data.get("notes"))
    rx_items = note_data.get("prescriptions") or []
    when: datetime = (
        note_data.get("appointment_date")
        or note_data.get("date")
        or datetime.utcnow()
    )

    def _rx_row(item) -> Optional[dict]:
        """Normalise a prescription row into a dict with predictable keys
        so we can render it as a proper table. Returns ``None`` for empty
        rows that should be skipped entirely."""
        if isinstance(item, str):
            text = item.strip()
            if not text:
                return None
            return {
                "medicine": text, "dose": "",
                "duration": "", "instructions": "",
            }
        if not isinstance(item, dict):
            text = str(item).strip()
            return {
                "medicine": text, "dose": "",
                "duration": "", "instructions": "",
            } if text else None
        drug = (item.get("drug") or "").strip()
        strength = (item.get("strength") or "").strip()
        medicine = f"{drug} {strength}".strip()
        if not medicine:
            return None
        return {
            "medicine": medicine,
            "dose": (item.get("frequency") or "").strip(),
            "duration": (item.get("duration") or "").strip(),
            "instructions": (item.get("instructions") or "").strip(),
        }

    rx_rows = [r for r in (_rx_row(x) for x in rx_items) if r]

    buf = io.BytesIO()
    # PDF metadata — without this the viewer shows "(anonymous)" in the
    # titlebar / tab when the file is opened. Use a date-qualified title
    # so the patient has an easy time finding it later.
    date_str = when.strftime("%d %b %Y")
    pdf_title = f"Prescription — {patient.name} ({date_str})"
    pdf_author = h.doctor_title or h.clinic_name
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=1.6 * cm, rightMargin=1.6 * cm,
        topMargin=1.6 * cm, bottomMargin=1.6 * cm,
        title=pdf_title, author=pdf_author,
        subject="Medical prescription", creator="Clinikore",
    )
    styles = getSampleStyleSheet()
    brand = colors.HexColor("#0f766e")
    muted = colors.HexColor("#64748b")
    accent_bg = colors.HexColor("#f0fdfa")
    ink = colors.HexColor("#0f172a")

    clinic_style = ParagraphStyle(
        "ClinicName", parent=styles["Title"], fontSize=20,
        leading=24, textColor=brand, spaceAfter=2, alignment=TA_LEFT,
    )
    small = ParagraphStyle(
        "Small", parent=styles["Normal"], fontSize=9, leading=12,
        textColor=muted, alignment=TA_LEFT,
    )
    reg_style = ParagraphStyle(
        "Reg", parent=styles["Normal"], fontSize=9, leading=12,
        textColor=colors.HexColor("#334155"), fontName="Helvetica-Bold",
        alignment=TA_LEFT,
    )
    doctor_style = ParagraphStyle(
        "DoctorName", parent=styles["Normal"], alignment=TA_LEFT,
    )
    right_small = ParagraphStyle(
        "RightSmall", parent=small, alignment=TA_RIGHT,
    )
    doc_title = ParagraphStyle(
        "DocTitle", parent=styles["Heading1"], fontSize=18, leading=22,
        alignment=TA_RIGHT, spaceAfter=0, textColor=ink,
    )
    section_h = ParagraphStyle(
        "SectionH", parent=styles["Heading3"], fontSize=11, leading=14,
        textColor=brand, spaceAfter=2, spaceBefore=0,
        fontName="Helvetica-Bold",
    )
    body = ParagraphStyle(
        "RxBody", parent=styles["Normal"], fontSize=10.5, leading=14.5,
        textColor=ink,
    )
    cell = ParagraphStyle(
        "RxCell", parent=body, fontSize=10, leading=13,
    )
    cell_muted = ParagraphStyle(
        "RxCellMuted", parent=cell, textColor=muted,
    )
    th_style = ParagraphStyle(
        "RxTH", parent=small, fontName="Helvetica-Bold",
        textColor=colors.white, fontSize=9, leading=11, alignment=TA_LEFT,
    )

    # --- Header block (left: clinic, right: doc title + date) --------------
    left_bits = [Paragraph(html.escape(h.clinic_name), clinic_style)]
    if h.doctor_title:
        left_bits.append(Paragraph(html.escape(h.doctor_title), doctor_style))
    if h.specialization:
        left_bits.append(Paragraph(html.escape(h.specialization), small))
    if h.registration_line:
        left_bits.append(Paragraph(html.escape(h.registration_line), reg_style))
    else:
        left_bits.append(Paragraph(
            "<font color='#92400e'><b>Registration number missing — update in Settings</b></font>",
            small,
        ))
    if h.clinic_address:
        left_bits.append(Paragraph(
            html.escape(h.clinic_address).replace("\n", "<br/>"), small,
        ))
    contact_line = " · ".join(x for x in [
        (f"Phone: {html.escape(h.clinic_phone)}" if h.clinic_phone else ""),
        (f"Email: {html.escape(h.clinic_email)}" if h.clinic_email else ""),
    ] if x)
    if contact_line:
        left_bits.append(Paragraph(contact_line, small))
    if h.clinic_gstin:
        left_bits.append(Paragraph(f"GSTIN: {html.escape(h.clinic_gstin)}", small))

    right_bits = [
        Paragraph("PRESCRIPTION", doc_title),
        Paragraph(when.strftime("%d %b %Y"), right_small),
    ]

    header_table = Table(
        [[left_bits, right_bits]],
        colWidths=[11 * cm, 6.4 * cm],
    )
    header_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    story: list = [
        header_table,
        Spacer(1, 0.3 * cm),
        HRFlowable(width="100%", thickness=1.2, color=brand),
        Spacer(1, 0.4 * cm),
    ]

    # --- Patient banner ----------------------------------------------------
    patient_bits = [
        Paragraph("<b>PATIENT</b>", small),
        Paragraph(f"<b>{html.escape(patient.name)}</b>", styles["Normal"]),
    ]
    meta_bits = [html.escape(b) for b in _patient_identity_bits(patient)]
    if meta_bits:
        patient_bits.append(Paragraph(" · ".join(meta_bits), small))
    patient_bits.append(Paragraph(
        f"Date: {when.strftime('%d %b %Y, %I:%M %p')}", small,
    ))
    patient_table = Table([[patient_bits]], colWidths=[17.4 * cm])
    patient_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), accent_bg),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#99f6e4")),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(patient_table)
    story.append(Spacer(1, 0.45 * cm))

    def _boxed_section(title: str, content_html: str) -> None:
        """Render a titled, lightly-bordered section so each field stands
        out clearly on the page instead of blending into a wall of text."""
        inner = Table(
            [[Paragraph(
                f'<font color="#0f766e" size="9"><b>'
                f'{html.escape(title).upper()}</b></font>',
                small,
            )],
             [Paragraph(content_html, body)]],
            colWidths=[17.4 * cm],
        )
        inner.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
            ("LINEBELOW", (0, 0), (-1, 0), 0.3, colors.HexColor("#e2e8f0")),
        ]))
        story.append(inner)
        story.append(Spacer(1, 0.25 * cm))

    def _pre(text: str) -> str:
        # Preserve line breaks from multi-line note fields.
        return html.escape(text).replace("\n", "<br/>")

    if chief:
        _boxed_section("Chief complaint", _pre(chief))
    if diagnosis:
        _boxed_section("Diagnosis", _pre(diagnosis))

    if rx_rows:
        # Prominent "℞" heading so the patient (and pharmacist) can't miss
        # the medication block. The Unicode Rx symbol renders cleanly in
        # the default Helvetica font that reportlab ships.
        rx_header = Table(
            [[Paragraph(
                '<font color="#0f766e" size="14"><b>℞&nbsp;&nbsp;PRESCRIPTION</b></font>',
                body,
            )]],
            colWidths=[17.4 * cm],
        )
        rx_header.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(rx_header)

        header_row = [
            Paragraph("#", th_style),
            Paragraph("MEDICINE", th_style),
            Paragraph("DOSAGE / WHEN TO TAKE", th_style),
            Paragraph("DURATION", th_style),
            Paragraph("INSTRUCTIONS", th_style),
        ]
        data = [header_row]
        for i, r in enumerate(rx_rows, 1):
            data.append([
                Paragraph(str(i), cell_muted),
                Paragraph(
                    f'<b>{html.escape(r["medicine"])}</b>', cell,
                ),
                Paragraph(
                    html.escape(r["dose"]) or '<font color="#94a3b8">—</font>',
                    cell,
                ),
                Paragraph(
                    html.escape(r["duration"])
                    or '<font color="#94a3b8">—</font>',
                    cell,
                ),
                Paragraph(
                    html.escape(r["instructions"])
                    or '<font color="#94a3b8">—</font>',
                    cell,
                ),
            ])
        rx_table = Table(
            data,
            colWidths=[0.8 * cm, 5.4 * cm, 4.8 * cm, 2.4 * cm, 4.0 * cm],
            repeatRows=1,
        )
        rx_table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BACKGROUND", (0, 0), (-1, 0), brand),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [colors.white, colors.HexColor("#f8fafc")]),
        ]))
        story.append(rx_table)
        story.append(Spacer(1, 0.35 * cm))
    elif advised:
        # No structured Rx — fall back to free-text under a generic title
        # so the doctor's hand-written advice still lands in the expected
        # place on the page.
        _boxed_section("Prescription / Advice", _pre(advised))

    # Treatment advice is its own section whenever structured Rx is present
    # — "advice" (diet, lifestyle, follow-up) and "Rx" (medicines) serve
    # different purposes and patients benefit from seeing them separately.
    if advised and rx_rows:
        _boxed_section("Advice", _pre(advised))

    if notes:
        _boxed_section("Notes / Follow-up", _pre(notes))

    # --- Signature + legal footer -----------------------------------------
    story.append(Spacer(1, 1.2 * cm))
    sig_line = HRFlowable(width=6.5 * cm, thickness=0.6, color=ink)
    sig_bits = [
        sig_line,
        Paragraph(f"<b>{html.escape(h.doctor_title or 'Doctor')}</b>", small),
    ]
    if h.registration_line:
        sig_bits.append(Paragraph(html.escape(h.registration_line), small))
    disclaimer = Paragraph(
        "Please take medication as prescribed. Contact the clinic "
        "immediately if symptoms worsen or you experience any adverse "
        "reaction.",
        small,
    )
    footer_table = Table(
        [[disclaimer, sig_bits]],
        colWidths=[10.9 * cm, 6.5 * cm],
    )
    footer_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(footer_table)
    story.append(Spacer(1, 0.6 * cm))
    story.append(HRFlowable(
        width="100%", thickness=0.4, color=colors.HexColor("#cbd5e1"),
        dash=(2, 2),
    ))
    story.append(Spacer(1, 0.2 * cm))
    story.append(Paragraph(
        "This prescription is computer-generated. Registration number is "
        "displayed as required under the Indian Medical Council "
        "(Professional Conduct) Regulations, 2002 — Clause 1.4.2. "
        "Not valid without the doctor's signature.",
        ParagraphStyle(
            "Legal", parent=small, alignment=TA_CENTER,
            textColor=muted, fontSize=8, leading=10,
        ),
    ))

    doc.build(story)
    return buf.getvalue()


# ---------- Reminders ----------
def send_appointment_reminder(patient: Patient, when: datetime, channel: str = "sms") -> bool:
    """Send a reminder. Returns True if queued/sent, False otherwise.

    This is a stub. Implement Twilio/WhatsApp here when online.
    """
    log.info(
        "Preparing %s reminder for patient id=%s name=%r (appt at %s)",
        channel, patient.id, patient.name, when.isoformat(timespec="minutes"),
    )
    if not patient.phone:
        log.warning(
            "Patient id=%s has no phone number; cannot send reminder", patient.id,
        )
        return False

    message = (
        f"Hi {patient.name}, this is a reminder of your appointment at "
        f"{CLINIC_NAME_FALLBACK} on {when.strftime('%d %b %Y, %I:%M %p')}. "
        f"Call {CLINIC_PHONE_FALLBACK} to reschedule."
    )

    try:
        if channel == "whatsapp":
            ok = _send_whatsapp(patient.phone, message)
        else:
            ok = _send_sms(patient.phone, message)
    except Exception:
        log.exception("Reminder send failed (channel=%s, patient=%s)", channel, patient.id)
        return False

    if ok:
        log.info("Reminder %s OK -> patient id=%s", channel, patient.id)
    else:
        log.warning("Reminder %s returned False -> patient id=%s", channel, patient.id)
    return ok


def _send_sms(phone: str, message: str) -> bool:
    log.info("[SMS stub -> %s] %s", phone, message)
    return True


def _send_whatsapp(phone: str, message: str) -> bool:
    log.info("[WhatsApp stub -> %s] %s", phone, message)
    return True


# ---------- Patient lifecycle ----------
def compute_patient_lifecycle(
    session,
    patient_id: int,
) -> tuple[str, Optional[datetime], int]:
    """Return (lifecycle, last_visit_dt, pending_step_count) for a patient.

    Lifecycle values follow `PatientLifecycle`:
      - new: no appointments
      - consulted: had appointments, no treatment plan yet
      - planned: has a plan but zero completed steps
      - in_progress: some steps completed, some not
      - completed: all plan steps completed
      - no_show: last appointment was cancelled / no_show (overrides "new")
    """
    from sqlmodel import select as _s  # local to avoid cycles at import time
    from backend.models import (
        Appointment as A, AppointmentStatus as AS,
        TreatmentPlan as TP, TreatmentPlanStep as TPS, TreatmentStepStatus as TSS,
        PatientLifecycle as PL,
    )

    appts = list(session.exec(
        _s(A).where(A.patient_id == patient_id).where(A.deleted_at.is_(None))
        .order_by(A.start.desc())
    ).all())
    last_visit = appts[0].start if appts else None

    plans = list(session.exec(
        _s(TP).where(TP.patient_id == patient_id).where(TP.deleted_at.is_(None))
    ).all())

    pending = 0
    total = 0
    completed = 0
    for plan in plans:
        for step in plan.steps:
            total += 1
            if step.status == TSS.completed:
                completed += 1
            elif step.status != TSS.skipped:
                pending += 1

    if not appts and not plans:
        return PL.new.value, None, 0

    if appts and not plans:
        last = appts[0]
        if last.status in (AS.cancelled, AS.no_show):
            return PL.no_show.value, last_visit, 0
        return PL.consulted.value, last_visit, 0

    if total == 0:
        return PL.consulted.value, last_visit, 0
    if completed == 0:
        return PL.planned.value, last_visit, pending
    if completed < total - sum(
        1 for p in plans for s in p.steps if s.status == TSS.skipped
    ):
        return PL.in_progress.value, last_visit, pending
    return PL.completed.value, last_visit, pending


# ---------------------------------------------------------------------------
# Patient demographics & specialty-aware relevance
# ---------------------------------------------------------------------------
# The Settings.doctor_category value captured during onboarding is used to
# hide patients that are clinically irrelevant to the practising doctor. For
# example a Paediatrician running the app should not see 70-year-olds on
# their Dashboard — they're just noise. The mapping below encodes the
# clinically accepted age bands and sex constraints for the categories we
# expose in the onboarding UI. `general` / unknown categories pass every
# patient through (no filter).
# ---------------------------------------------------------------------------
from datetime import date as _date  # local alias, datetime already imported

# Fixed vocabulary the UI shows as onboarding cards. Keep in sync with the
# OnboardingModal / Settings options list on the frontend.
DOCTOR_CATEGORIES: tuple[str, ...] = (
    "general",
    "dental",
    "pediatric",
    "geriatric",
    "gynecology",
    "andrology",
    "cardiology",
    "dermatology",
    "ent",
    "orthopedic",
    "psychiatry",
    "ophthalmology",
)


def _normalize_category(cat: Optional[str]) -> str:
    """Lowercase + strip + collapse whitespace for safe comparisons."""
    if not cat:
        return ""
    return cat.strip().lower()


def compute_patient_age(patient) -> Optional[int]:
    """Return the patient's current age in whole years.

    Prefers `date_of_birth` because birthdays don't lie — the `age` column
    is a snapshot from the day of data entry and silently goes stale. Falls
    back to `age` only when DOB is missing so legacy records without a DOB
    still compute.
    """
    dob = getattr(patient, "date_of_birth", None)
    if dob:
        today = _date.today()
        years = today.year - dob.year
        # Subtract a year when the birthday hasn't happened yet this year.
        if (today.month, today.day) < (dob.month, dob.day):
            years -= 1
        return max(years, 0)
    age = getattr(patient, "age", None)
    if isinstance(age, int):
        return age
    return None


def is_patient_relevant(patient, doctor_category: Optional[str]) -> bool:
    """Return True if a patient matches the doctor's clinical category.

    We deliberately default to *include* the patient whenever we can't make a
    confident "exclude" decision — for example the doctor hasn't picked a
    category yet, or the patient has no DOB/gender recorded. Better to show
    a borderline-relevant patient than to hide a real one.
    """
    cat = _normalize_category(doctor_category)
    if not cat or cat == "general":
        return True

    age = compute_patient_age(patient)
    gender = getattr(patient, "gender", None)
    gender_val = gender.value if hasattr(gender, "value") else (gender or "")
    gender_val = (gender_val or "").lower()

    # Paediatrics: 0–17 inclusive. If age is unknown we *keep* the patient so
    # we don't silently drop records from a partially-populated database.
    if cat == "pediatric":
        return age is None or age < 18

    # Geriatrics: 60+ (WHO threshold used by Indian senior-citizen schemes).
    if cat == "geriatric":
        return age is None or age >= 60

    # Gynaecology — treats women. Unknown gender is kept (opt-in filter).
    if cat == "gynecology":
        return gender_val in ("", "female", "other")

    # Andrology — treats men (incl. male reproductive health / urology).
    if cat == "andrology":
        return gender_val in ("", "male", "other")

    # All other specialties don't have a universally-applicable hard filter.
    return True


def filter_patients_by_category(patients, doctor_category: Optional[str]):
    """Filter an iterable of Patient rows by the doctor's category."""
    return [p for p in patients if is_patient_relevant(p, doctor_category)]
