"""Demo data seeding.

Creates a realistic, representative slice of clinic data so a doctor trying
out Clinikore for the first time has something to poke at. The data is
tagged via a dedicated `notes` marker so we can remove it later without
touching real patient data.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, date
from typing import List

from sqlmodel import Session, select

log = logging.getLogger("clinikore.demo")

from backend.models import (
    Appointment,
    AppointmentStatus,
    Invoice,
    InvoiceItem,
    InvoiceStatus,
    Patient,
    Payment,
    PaymentMethod,
    Procedure,
    Treatment,
)

DEMO_TAG = "[DEMO]"  # prefix on notes so we can safely purge demo rows


def _today_at(hour: int, minute: int = 0, offset_days: int = 0) -> datetime:
    d = datetime.now().replace(hour=hour, minute=minute, second=0, microsecond=0)
    return d + timedelta(days=offset_days)


def seed_demo(session: Session) -> dict:
    """Insert demo patients, treatments, appointments, invoices, payments.

    Idempotent: if demo patients already exist we skip to avoid duplicates.
    """
    existing = session.exec(
        select(Patient).where(Patient.notes.like(f"{DEMO_TAG}%"))
    ).first()
    if existing:
        log.info("Demo seed skipped — demo data already present")
        return {"created": False, "reason": "demo data already present"}
    log.info("Seeding demo data...")

    # --- Patients -------------------------------------------------------
    patients = [
        Patient(
            name="Priya Sharma", age=34, phone="+91 98100 11111",
            email="priya.sharma@example.com",
            medical_history="Mild asthma, uses inhaler as needed.",
            dental_history="Previous scaling 1 year ago.",
            allergies="Penicillin",
            notes=f"{DEMO_TAG} Sample patient — feel free to edit.",
        ),
        Patient(
            name="Rahul Mehta", age=52, phone="+91 98100 22222",
            email="rahul.m@example.com",
            medical_history="Type 2 diabetes, on Metformin.",
            dental_history="Root canal on 36 two years ago.",
            allergies="None known",
            notes=f"{DEMO_TAG} Sample patient.",
        ),
        Patient(
            name="Ananya Patel", age=8, phone="+91 98100 33333",
            medical_history="Healthy child, regular pediatric checkups.",
            dental_history="First dental visit.",
            allergies="None",
            notes=f"{DEMO_TAG} Sample pediatric patient.",
        ),
        Patient(
            name="Vikram Singh", age=67, phone="+91 98100 44444",
            email="vikram.singh@example.com",
            medical_history="Hypertension, on Amlodipine. Post-CABG 2019.",
            dental_history="Multiple fillings, due for crown on 46.",
            allergies="Aspirin",
            notes=f"{DEMO_TAG} Sample patient.",
        ),
        Patient(
            name="Neha Kapoor", age=28, phone="+91 98100 55555",
            email="neha.k@example.com",
            medical_history="No significant medical history.",
            dental_history="Orthodontic treatment completed 2022.",
            allergies="None",
            notes=f"{DEMO_TAG} Sample patient.",
        ),
    ]
    for p in patients:
        session.add(p)
    session.commit()
    for p in patients:
        session.refresh(p)

    # --- Find procedure ids (seeded on first boot) ---------------------
    procs = {p.name: p for p in session.exec(select(Procedure)).all()}

    def proc(name: str) -> Procedure:
        # Fall back to consultation if a specific procedure isn't present.
        return procs.get(name) or next(iter(procs.values()))

    # --- Past treatments -----------------------------------------------
    treatments = [
        Treatment(
            patient_id=patients[1].id,  # Rahul
            procedure_id=proc("Root Canal Treatment").id,
            tooth="36", notes=f"{DEMO_TAG} Completed RCT two years ago.",
            price=proc("Root Canal Treatment").default_price,
            performed_on=date.today() - timedelta(days=720),
        ),
        Treatment(
            patient_id=patients[0].id,  # Priya
            procedure_id=proc("Scaling & Polishing").id,
            tooth=None, notes=f"{DEMO_TAG} Routine cleaning.",
            price=proc("Scaling & Polishing").default_price,
            performed_on=date.today() - timedelta(days=365),
        ),
        Treatment(
            patient_id=patients[3].id,  # Vikram
            procedure_id=proc("Composite Filling").id,
            tooth="27", notes=f"{DEMO_TAG} Class II composite.",
            price=proc("Composite Filling").default_price,
            performed_on=date.today() - timedelta(days=90),
        ),
    ]
    for t in treatments:
        session.add(t)

    # --- Appointments: mix of today / upcoming / past ------------------
    appts = [
        Appointment(
            patient_id=patients[0].id,
            start=_today_at(10, 0), end=_today_at(10, 30),
            status=AppointmentStatus.scheduled,
            chief_complaint="Toothache on upper-right",
            notes=f"{DEMO_TAG} New complaint — check 17 & 18.",
        ),
        Appointment(
            patient_id=patients[2].id,
            start=_today_at(11, 0), end=_today_at(11, 20),
            status=AppointmentStatus.scheduled,
            chief_complaint="First dental visit",
            notes=f"{DEMO_TAG} Be gentle — pediatric patient.",
        ),
        Appointment(
            patient_id=patients[3].id,
            start=_today_at(15, 30, offset_days=1),
            end=_today_at(16, 30, offset_days=1),
            status=AppointmentStatus.scheduled,
            chief_complaint="Crown fitting on 46",
            notes=f"{DEMO_TAG} Tomorrow's long appointment.",
        ),
        Appointment(
            patient_id=patients[1].id,
            start=_today_at(9, 0, offset_days=-3),
            end=_today_at(9, 45, offset_days=-3),
            status=AppointmentStatus.completed,
            chief_complaint="Routine checkup",
            notes=f"{DEMO_TAG} Completed last week.",
        ),
        Appointment(
            patient_id=patients[4].id,
            start=_today_at(17, 0, offset_days=2),
            end=_today_at(17, 30, offset_days=2),
            status=AppointmentStatus.scheduled,
            chief_complaint="Whitening consultation",
            notes=f"{DEMO_TAG} Upcoming.",
        ),
    ]
    for a in appts:
        session.add(a)
    session.commit()

    # --- Invoices + payments -------------------------------------------
    # Invoice 1 — Rahul, fully paid (checkup)
    inv1 = Invoice(
        patient_id=patients[1].id,
        notes=f"{DEMO_TAG} Routine checkup — fully paid.",
    )
    inv1.items.append(InvoiceItem(
        procedure_id=proc("Consultation").id,
        description="Consultation",
        quantity=1, unit_price=proc("Consultation").default_price,
    ))
    inv1.items.append(InvoiceItem(
        procedure_id=proc("Scaling & Polishing").id,
        description="Scaling & Polishing",
        quantity=1, unit_price=proc("Scaling & Polishing").default_price,
    ))
    inv1.total = sum(i.quantity * i.unit_price for i in inv1.items)
    inv1.payments.append(Payment(
        amount=inv1.total,
        method=PaymentMethod.upi,
        reference="DEMO-UPI-001",
    ))
    inv1.paid = inv1.total
    inv1.status = InvoiceStatus.paid
    session.add(inv1)

    # Invoice 2 — Vikram, partial payment (pending dues demo)
    inv2 = Invoice(
        patient_id=patients[3].id,
        notes=f"{DEMO_TAG} Partial payment \u2014 balance pending.",
    )
    inv2.items.append(InvoiceItem(
        procedure_id=proc("Crown (PFM)").id,
        description="Crown (PFM) — tooth 46",
        quantity=1, unit_price=proc("Crown (PFM)").default_price,
    ))
    inv2.items.append(InvoiceItem(
        procedure_id=proc("Composite Filling").id,
        description="Composite Filling — tooth 27",
        quantity=1, unit_price=proc("Composite Filling").default_price,
    ))
    inv2.total = sum(i.quantity * i.unit_price for i in inv2.items)
    inv2.payments.append(Payment(
        amount=inv2.total * 0.5,
        method=PaymentMethod.cash,
        reference="DEMO-CASH-002",
    ))
    inv2.paid = inv2.total * 0.5
    inv2.status = InvoiceStatus.partial
    session.add(inv2)

    session.commit()
    result = {
        "created": True,
        "patients": len(patients),
        "appointments": len(appts),
        "treatments": len(treatments),
        "invoices": 2,
    }
    log.info(
        "Demo data seeded: %d patients, %d appointments, %d treatments, %d invoices",
        result["patients"], result["appointments"], result["treatments"], result["invoices"],
    )
    return result


def clear_demo(session: Session) -> dict:
    """Remove everything tagged with DEMO_TAG. Real data is untouched."""
    demo_patients = session.exec(
        select(Patient).where(Patient.notes.like(f"{DEMO_TAG}%"))
    ).all()
    pids = [p.id for p in demo_patients]

    removed = {"patients": 0, "appointments": 0, "treatments": 0, "invoices": 0}

    if pids:
        for inv in session.exec(
            select(Invoice).where(Invoice.patient_id.in_(pids))  # type: ignore[arg-type]
        ).all():
            session.delete(inv)
            removed["invoices"] += 1
        for t in session.exec(
            select(Treatment).where(Treatment.patient_id.in_(pids))  # type: ignore[arg-type]
        ).all():
            session.delete(t)
            removed["treatments"] += 1
        for a in session.exec(
            select(Appointment).where(Appointment.patient_id.in_(pids))  # type: ignore[arg-type]
        ).all():
            session.delete(a)
            removed["appointments"] += 1
        for p in demo_patients:
            session.delete(p)
            removed["patients"] += 1

    session.commit()
    log.info(
        "Demo data cleared: %(patients)d patients, %(appointments)d appointments, "
        "%(treatments)d treatments, %(invoices)d invoices removed",
        removed,
    )
    return {"cleared": True, **removed}


def demo_status(session: Session) -> dict:
    count = len(session.exec(
        select(Patient).where(Patient.notes.like(f"{DEMO_TAG}%"))
    ).all())
    return {"active": count > 0, "demo_patients": count}
