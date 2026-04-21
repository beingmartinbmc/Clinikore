"""Side-effectful services: PDF invoice generation and reminder sending.

The reminder service is a pluggable stub — by default it just logs. To enable
SMS/WhatsApp, drop in Twilio credentials via env vars and implement the
`_send_sms` / `_send_whatsapp` functions.
"""
from __future__ import annotations

import io
import logging
import os
from datetime import datetime
from typing import Iterable

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from backend.models import Invoice, InvoiceItem, Patient

log = logging.getLogger("clinikore.services")

CLINIC_NAME = os.environ.get("CLINIC_NAME", "Clinikore Clinic")
CLINIC_ADDRESS = os.environ.get("CLINIC_ADDRESS", "")
CLINIC_PHONE = os.environ.get("CLINIC_PHONE", "")


# ---------- Invoice PDF ----------
def render_invoice_pdf(invoice: Invoice, patient: Patient, items: Iterable[InvoiceItem]) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=1.8 * cm, rightMargin=1.8 * cm,
        topMargin=1.8 * cm, bottomMargin=1.8 * cm,
    )
    styles = getSampleStyleSheet()
    story = []

    story.append(Paragraph(f"<b>{CLINIC_NAME}</b>", styles["Title"]))
    if CLINIC_ADDRESS:
        story.append(Paragraph(CLINIC_ADDRESS, styles["Normal"]))
    if CLINIC_PHONE:
        story.append(Paragraph(f"Phone: {CLINIC_PHONE}", styles["Normal"]))
    story.append(Spacer(1, 0.6 * cm))

    story.append(Paragraph(f"<b>Invoice #{invoice.id:05d}</b>", styles["Heading2"]))
    story.append(Paragraph(
        f"Date: {invoice.created_at.strftime('%d %b %Y')}",
        styles["Normal"],
    ))
    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph(f"<b>Billed to:</b> {patient.name}", styles["Normal"]))
    if patient.phone:
        story.append(Paragraph(f"Phone: {patient.phone}", styles["Normal"]))
    story.append(Spacer(1, 0.6 * cm))

    data = [["#", "Description", "Qty", "Unit Price", "Amount"]]
    for idx, it in enumerate(items, 1):
        amt = it.quantity * it.unit_price
        data.append([
            str(idx),
            it.description,
            str(it.quantity),
            f"{it.unit_price:,.2f}",
            f"{amt:,.2f}",
        ])
    data.append(["", "", "", "Total", f"{invoice.total:,.2f}"])
    data.append(["", "", "", "Paid", f"{invoice.paid:,.2f}"])
    data.append(["", "", "", "Balance", f"{invoice.total - invoice.paid:,.2f}"])

    table = Table(data, colWidths=[1 * cm, 9 * cm, 1.5 * cm, 3 * cm, 3 * cm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f766e")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -4), 0.25, colors.grey),
        ("FONTNAME", (-2, -3), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (-2, -3), (-1, -3), 0.5, colors.black),
    ]))
    story.append(table)
    story.append(Spacer(1, 0.8 * cm))
    if invoice.notes:
        story.append(Paragraph(f"<b>Notes:</b> {invoice.notes}", styles["Normal"]))

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
        f"{CLINIC_NAME} on {when.strftime('%d %b %Y, %I:%M %p')}. "
        f"Call {CLINIC_PHONE} to reschedule."
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
    # TODO: plug in Twilio / MSG91 / similar.
    log.info("[SMS stub -> %s] %s", phone, message)
    return True


def _send_whatsapp(phone: str, message: str) -> bool:
    # TODO: plug in WhatsApp Cloud API or Twilio WhatsApp.
    log.info("[WhatsApp stub -> %s] %s", phone, message)
    return True
