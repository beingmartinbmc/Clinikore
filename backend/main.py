"""FastAPI app with all routes. Single file — small app, easier to grok."""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from sqlmodel import Session, select

from backend import backup as backup_svc
from backend import demo as demo_svc
from backend import logging_setup

# Configure logging on module import so `uvicorn backend.main:app` (dev mode)
# also gets proper file logging. In the desktop launcher we've already called
# this — the function is idempotent.
logging_setup.configure_logging()

from backend.db import APP_DIR, DB_PATH, engine, init_db
from backend.models import (
    Appointment,
    AppointmentCreate,
    AppointmentRead,
    AppointmentStatus,
    Invoice,
    InvoiceCreate,
    InvoiceItem,
    InvoiceRead,
    InvoiceStatus,
    Patient,
    PatientCreate,
    PatientRead,
    Payment,
    PaymentCreate,
    PaymentRead,
    Procedure,
    ProcedureCreate,
    ProcedureRead,
    Treatment,
    TreatmentCreate,
    TreatmentRead,
)
from backend import services


BACKUP_DIR = APP_DIR / "backups"
APP_VERSION = "0.1.0"
_scheduler: Optional[backup_svc.BackupScheduler] = None

log = logging.getLogger("clinikore")
audit = logging_setup.audit


# ---------- app + lifespan ----------
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _scheduler
    logging_setup.log_startup_banner(
        "Clinikore", APP_VERSION,
        {"DB": DB_PATH, "Backups": BACKUP_DIR, "Data": APP_DIR},
    )
    init_db()
    log.info("Database initialized at %s", DB_PATH)
    _seed_if_empty()
    _scheduler = backup_svc.BackupScheduler(
        db_path=DB_PATH,
        backup_root=BACKUP_DIR,
    )
    _scheduler.start()
    try:
        yield
    finally:
        log.info("Application shutting down...")
        if _scheduler:
            _scheduler.stop()
            log.info("Backup scheduler stopped")


app = FastAPI(title="Clinikore", version=APP_VERSION, lifespan=lifespan)

# Permissive CORS — the app only runs on localhost.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- HTTP request logging ----------
@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log every request with method, path, status, and duration.

    Static-asset noise is skipped so the log stays readable.
    """
    path = request.url.path
    is_api = path.startswith("/api/")
    is_static = path.startswith("/assets/") or path.endswith((".js", ".css", ".svg", ".ico", ".png"))

    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        # Will also be caught by the exception handler; log here for duration.
        duration_ms = (time.perf_counter() - start) * 1000
        log.exception("%s %s -> ERROR (%.1fms)", request.method, path, duration_ms)
        raise
    duration_ms = (time.perf_counter() - start) * 1000

    if is_api:
        # 4xx/5xx get warning/error level so they stand out in the log.
        if response.status_code >= 500:
            level = logging.ERROR
        elif response.status_code >= 400:
            level = logging.WARNING
        else:
            level = logging.INFO
        log.log(
            level,
            "%s %s -> %d (%.1fms)",
            request.method, path, response.status_code, duration_ms,
        )
    elif not is_static and path != "/favicon.ico":
        log.debug("%s %s -> %d (%.1fms)", request.method, path, response.status_code, duration_ms)

    response.headers["X-Response-Time-ms"] = f"{duration_ms:.1f}"
    return response


# ---------- Global exception handler ----------
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # HTTPException is handled by FastAPI's default handler; this catches everything else.
    if isinstance(exc, HTTPException):
        raise exc
    log.exception(
        "Unhandled exception on %s %s", request.method, request.url.path,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error. Check the log for details."},
    )


def get_session():
    with Session(engine) as session:
        yield session


def _seed_if_empty() -> None:
    with Session(engine) as s:
        if s.exec(select(Procedure)).first() is None:
            defaults = [
                ("Consultation", 500),
                ("Scaling & Polishing", 1500),
                ("Tooth Extraction", 2000),
                ("Root Canal Treatment", 6000),
                ("Composite Filling", 1200),
                ("Crown (PFM)", 5000),
                ("Teeth Whitening", 4000),
            ]
            for name, price in defaults:
                s.add(Procedure(name=name, default_price=float(price)))
            s.commit()
            log.info("Seeded %d default procedures", len(defaults))


# ==========================================================================
# Patients
# ==========================================================================
@app.get("/api/patients", response_model=List[PatientRead])
def list_patients(q: Optional[str] = None, s: Session = Depends(get_session)):
    stmt = select(Patient).order_by(Patient.created_at.desc())
    if q:
        like = f"%{q}%"
        stmt = stmt.where((Patient.name.ilike(like)) | (Patient.phone.ilike(like)))
    return s.exec(stmt).all()


@app.post("/api/patients", response_model=PatientRead, status_code=201)
def create_patient(payload: PatientCreate, s: Session = Depends(get_session)):
    p = Patient.model_validate(payload)
    s.add(p)
    s.commit()
    s.refresh(p)
    audit("patient.create", id=p.id, name=p.name, phone=p.phone or "")
    return p


@app.get("/api/patients/{pid}", response_model=PatientRead)
def get_patient(pid: int, s: Session = Depends(get_session)):
    p = s.get(Patient, pid)
    if not p:
        raise HTTPException(404, "Patient not found")
    return p


@app.put("/api/patients/{pid}", response_model=PatientRead)
def update_patient(pid: int, payload: PatientCreate, s: Session = Depends(get_session)):
    p = s.get(Patient, pid)
    if not p:
        raise HTTPException(404, "Patient not found")
    changed = list(payload.model_dump(exclude_unset=True).keys())
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    s.add(p)
    s.commit()
    s.refresh(p)
    audit("patient.update", id=p.id, name=p.name, fields=",".join(changed))
    return p


@app.delete("/api/patients/{pid}", status_code=204)
def delete_patient(pid: int, s: Session = Depends(get_session)):
    p = s.get(Patient, pid)
    if not p:
        raise HTTPException(404, "Patient not found")
    name = p.name
    s.delete(p)
    s.commit()
    audit("patient.delete", id=pid, name=name)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Procedures
# ==========================================================================
@app.get("/api/procedures", response_model=List[ProcedureRead])
def list_procedures(s: Session = Depends(get_session)):
    return s.exec(select(Procedure).order_by(Procedure.name)).all()


@app.post("/api/procedures", response_model=ProcedureRead, status_code=201)
def create_procedure(payload: ProcedureCreate, s: Session = Depends(get_session)):
    p = Procedure.model_validate(payload)
    s.add(p)
    s.commit()
    s.refresh(p)
    audit("procedure.create", id=p.id, name=p.name, price=p.default_price)
    return p


@app.put("/api/procedures/{pid}", response_model=ProcedureRead)
def update_procedure(pid: int, payload: ProcedureCreate, s: Session = Depends(get_session)):
    p = s.get(Procedure, pid)
    if not p:
        raise HTTPException(404, "Procedure not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    s.add(p)
    s.commit()
    s.refresh(p)
    return p


@app.delete("/api/procedures/{pid}", status_code=204)
def delete_procedure(pid: int, s: Session = Depends(get_session)):
    p = s.get(Procedure, pid)
    if not p:
        raise HTTPException(404, "Procedure not found")
    name = p.name
    s.delete(p)
    s.commit()
    audit("procedure.delete", id=pid, name=name)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Appointments
# ==========================================================================
def _appt_read(a: Appointment, patient_name: Optional[str]) -> AppointmentRead:
    return AppointmentRead(
        id=a.id, patient_id=a.patient_id, start=a.start, end=a.end,
        status=a.status, chief_complaint=a.chief_complaint, notes=a.notes,
        reminder_sent=a.reminder_sent, created_at=a.created_at,
        patient_name=patient_name,
    )


@app.get("/api/appointments", response_model=List[AppointmentRead])
def list_appointments(
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    patient_id: Optional[int] = None,
    s: Session = Depends(get_session),
):
    stmt = select(Appointment, Patient).join(Patient, isouter=True).order_by(Appointment.start)
    if start:
        stmt = stmt.where(Appointment.start >= start)
    if end:
        stmt = stmt.where(Appointment.start <= end)
    if patient_id:
        stmt = stmt.where(Appointment.patient_id == patient_id)
    rows = s.exec(stmt).all()
    return [_appt_read(a, p.name if p else None) for a, p in rows]


@app.post("/api/appointments", response_model=AppointmentRead, status_code=201)
def create_appointment(payload: AppointmentCreate, s: Session = Depends(get_session)):
    if not s.get(Patient, payload.patient_id):
        raise HTTPException(400, "Invalid patient_id")
    a = Appointment.model_validate(payload)
    s.add(a)
    s.commit()
    s.refresh(a)
    p = s.get(Patient, a.patient_id)
    audit(
        "appointment.create",
        id=a.id, patient_id=a.patient_id,
        patient=p.name if p else "?",
        start=a.start.isoformat(),
    )
    return _appt_read(a, p.name if p else None)


@app.put("/api/appointments/{aid}", response_model=AppointmentRead)
def update_appointment(aid: int, payload: AppointmentCreate, s: Session = Depends(get_session)):
    a = s.get(Appointment, aid)
    if not a:
        raise HTTPException(404, "Appointment not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(a, k, v)
    s.add(a)
    s.commit()
    s.refresh(a)
    p = s.get(Patient, a.patient_id)
    return _appt_read(a, p.name if p else None)


@app.patch("/api/appointments/{aid}/status", response_model=AppointmentRead)
def set_appointment_status(aid: int, new_status: AppointmentStatus, s: Session = Depends(get_session)):
    a = s.get(Appointment, aid)
    if not a:
        raise HTTPException(404, "Appointment not found")
    old = a.status.value if hasattr(a.status, "value") else a.status
    a.status = new_status
    s.add(a)
    s.commit()
    s.refresh(a)
    p = s.get(Patient, a.patient_id)
    audit("appointment.status", id=aid, old=old, new=new_status.value)
    return _appt_read(a, p.name if p else None)


@app.delete("/api/appointments/{aid}", status_code=204)
def delete_appointment(aid: int, s: Session = Depends(get_session)):
    a = s.get(Appointment, aid)
    if not a:
        raise HTTPException(404, "Appointment not found")
    pid = a.patient_id
    s.delete(a)
    s.commit()
    audit("appointment.delete", id=aid, patient_id=pid)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/appointments/{aid}/remind")
def send_reminder(aid: int, channel: str = "sms", s: Session = Depends(get_session)):
    a = s.get(Appointment, aid)
    if not a:
        raise HTTPException(404, "Appointment not found")
    p = s.get(Patient, a.patient_id)
    if not p:
        raise HTTPException(400, "Patient not found")
    ok = services.send_appointment_reminder(p, a.start, channel=channel)
    if ok:
        a.reminder_sent = True
        s.add(a)
        s.commit()
        audit("reminder.sent", appointment_id=aid, patient_id=p.id, channel=channel)
    else:
        log.warning("Reminder failed for appointment %s (channel=%s)", aid, channel)
    return {"ok": ok, "channel": channel}


# ==========================================================================
# Treatments
# ==========================================================================
def _tx_read(t: Treatment, proc_name: Optional[str]) -> TreatmentRead:
    return TreatmentRead(
        id=t.id, patient_id=t.patient_id, appointment_id=t.appointment_id,
        procedure_id=t.procedure_id, tooth=t.tooth, notes=t.notes,
        price=t.price, performed_on=t.performed_on, procedure_name=proc_name,
    )


@app.get("/api/patients/{pid}/treatments", response_model=List[TreatmentRead])
def list_patient_treatments(pid: int, s: Session = Depends(get_session)):
    stmt = (
        select(Treatment, Procedure)
        .join(Procedure, isouter=True)
        .where(Treatment.patient_id == pid)
        .order_by(Treatment.performed_on.desc())
    )
    rows = s.exec(stmt).all()
    return [_tx_read(t, p.name if p else None) for t, p in rows]


@app.post("/api/treatments", response_model=TreatmentRead, status_code=201)
def create_treatment(payload: TreatmentCreate, s: Session = Depends(get_session)):
    if not s.get(Patient, payload.patient_id):
        raise HTTPException(400, "Invalid patient_id")
    proc = s.get(Procedure, payload.procedure_id)
    if not proc:
        raise HTTPException(400, "Invalid procedure_id")
    t = Treatment.model_validate(payload)
    if not t.price:
        t.price = proc.default_price
    s.add(t)
    s.commit()
    s.refresh(t)
    audit(
        "treatment.create",
        id=t.id, patient_id=t.patient_id,
        procedure=proc.name, price=t.price,
    )
    return _tx_read(t, proc.name)


@app.delete("/api/treatments/{tid}", status_code=204)
def delete_treatment(tid: int, s: Session = Depends(get_session)):
    t = s.get(Treatment, tid)
    if not t:
        raise HTTPException(404, "Treatment not found")
    pid = t.patient_id
    s.delete(t)
    s.commit()
    audit("treatment.delete", id=tid, patient_id=pid)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Invoices
# ==========================================================================
def _invoice_to_read(inv: Invoice, patient_name: Optional[str]) -> InvoiceRead:
    return InvoiceRead(
        id=inv.id, patient_id=inv.patient_id, appointment_id=inv.appointment_id,
        total=inv.total, paid=inv.paid, status=inv.status, notes=inv.notes,
        created_at=inv.created_at, patient_name=patient_name,
        items=list(inv.items), payments=list(inv.payments),
    )


def _recompute_invoice(inv: Invoice) -> None:
    inv.total = sum(i.quantity * i.unit_price for i in inv.items)
    inv.paid = sum(p.amount for p in inv.payments)
    if inv.paid <= 0:
        inv.status = InvoiceStatus.unpaid
    elif inv.paid + 1e-6 < inv.total:
        inv.status = InvoiceStatus.partial
    else:
        inv.status = InvoiceStatus.paid


@app.get("/api/invoices", response_model=List[InvoiceRead])
def list_invoices(pending_only: bool = False, s: Session = Depends(get_session)):
    stmt = select(Invoice, Patient).join(Patient, isouter=True).order_by(Invoice.created_at.desc())
    if pending_only:
        stmt = stmt.where(Invoice.status != InvoiceStatus.paid)
    rows = s.exec(stmt).all()
    return [_invoice_to_read(inv, p.name if p else None) for inv, p in rows]


@app.post("/api/invoices", response_model=InvoiceRead, status_code=201)
def create_invoice(payload: InvoiceCreate, s: Session = Depends(get_session)):
    if not s.get(Patient, payload.patient_id):
        raise HTTPException(400, "Invalid patient_id")
    inv = Invoice(
        patient_id=payload.patient_id,
        appointment_id=payload.appointment_id,
        notes=payload.notes,
    )
    for it in payload.items:
        inv.items.append(InvoiceItem(
            procedure_id=it.procedure_id,
            description=it.description,
            quantity=it.quantity,
            unit_price=it.unit_price,
        ))
    _recompute_invoice(inv)
    s.add(inv)
    s.commit()
    s.refresh(inv)
    p = s.get(Patient, inv.patient_id)
    audit(
        "invoice.create",
        id=inv.id, patient_id=inv.patient_id,
        items=len(inv.items), total=inv.total,
    )
    return _invoice_to_read(inv, p.name if p else None)


@app.get("/api/invoices/{iid}", response_model=InvoiceRead)
def get_invoice(iid: int, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv:
        raise HTTPException(404, "Invoice not found")
    p = s.get(Patient, inv.patient_id)
    return _invoice_to_read(inv, p.name if p else None)


@app.delete("/api/invoices/{iid}", status_code=204)
def delete_invoice(iid: int, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv:
        raise HTTPException(404, "Invoice not found")
    pid = inv.patient_id
    total = inv.total
    s.delete(inv)
    s.commit()
    audit("invoice.delete", id=iid, patient_id=pid, total=total)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/api/invoices/{iid}/pdf")
def invoice_pdf(iid: int, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv:
        raise HTTPException(404, "Invoice not found")
    patient = s.get(Patient, inv.patient_id)
    pdf = services.render_invoice_pdf(inv, patient, inv.items)
    log.info("Generated invoice PDF id=%d size=%dB", iid, len(pdf))
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="invoice-{inv.id:05d}.pdf"'},
    )


# ==========================================================================
# Payments
# ==========================================================================
@app.post("/api/invoices/{iid}/payments", response_model=PaymentRead, status_code=201)
def add_payment(iid: int, payload: PaymentCreate, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv:
        raise HTTPException(404, "Invoice not found")
    pay = Payment(
        invoice_id=iid,
        amount=payload.amount,
        method=payload.method,
        reference=payload.reference,
    )
    s.add(pay)
    inv.payments.append(pay)
    _recompute_invoice(inv)
    s.add(inv)
    s.commit()
    s.refresh(pay)
    audit(
        "payment.add",
        id=pay.id, invoice_id=iid,
        amount=pay.amount, method=pay.method.value if hasattr(pay.method, "value") else pay.method,
        new_status=inv.status.value if hasattr(inv.status, "value") else inv.status,
    )
    return pay


@app.delete("/api/payments/{pid}", status_code=204)
def delete_payment(pid: int, s: Session = Depends(get_session)):
    pay = s.get(Payment, pid)
    if not pay:
        raise HTTPException(404, "Payment not found")
    inv = s.get(Invoice, pay.invoice_id)
    amount = pay.amount
    iid = pay.invoice_id
    s.delete(pay)
    if inv:
        s.refresh(inv)
        _recompute_invoice(inv)
        s.add(inv)
    s.commit()
    audit("payment.delete", id=pid, invoice_id=iid, amount=amount)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Dashboard summary
# ==========================================================================
@app.get("/api/dashboard")
def dashboard(s: Session = Depends(get_session)):
    today_start = datetime.combine(datetime.today().date(), datetime.min.time())
    today_end = today_start + timedelta(days=1)

    patients = s.exec(select(Patient)).all()
    today_appts = s.exec(
        select(Appointment).where(Appointment.start >= today_start, Appointment.start < today_end)
    ).all()
    invoices = s.exec(select(Invoice)).all()
    pending = [i for i in invoices if i.status != InvoiceStatus.paid]
    dues = sum(i.total - i.paid for i in pending)
    month_start = today_start.replace(day=1)
    month_revenue = sum(
        p.amount for p in s.exec(select(Payment).where(Payment.paid_on >= month_start)).all()
    )
    return {
        "patients": len(patients),
        "today_appointments": len(today_appts),
        "pending_invoices": len(pending),
        "pending_dues": round(dues, 2),
        "month_revenue": round(month_revenue, 2),
    }


# ==========================================================================
# Backups
# ==========================================================================
@app.get("/api/backups")
def api_list_backups():
    entries = backup_svc.list_backups(BACKUP_DIR)
    return {
        "dir": str(BACKUP_DIR),
        "interval_hours": backup_svc.BACKUP_INTERVAL_HOURS,
        "keep": backup_svc.BACKUP_KEEP,
        "backups": [b.as_dict() for b in entries],
    }


@app.post("/api/backups", status_code=201)
def api_create_backup():
    path = backup_svc.create_backup(DB_PATH, BACKUP_DIR)
    backup_svc.prune_backups(BACKUP_DIR)
    audit("backup.manual", name=path.name)
    return {"name": path.name, "path": str(path)}


@app.get("/api/backups/{name}/download")
def api_download_backup(name: str):
    target = BACKUP_DIR / name
    # Prevent path traversal: ensure the resolved path is inside BACKUP_DIR.
    try:
        target.resolve().relative_to(BACKUP_DIR.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid backup name")
    if not target.is_dir():
        raise HTTPException(404, "Backup not found")
    data = backup_svc.zip_backup(target)
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}.zip"'},
    )


@app.delete("/api/backups/{name}", status_code=204)
def api_delete_backup(name: str):
    import shutil as _sh
    target = BACKUP_DIR / name
    try:
        target.resolve().relative_to(BACKUP_DIR.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid backup name")
    if not target.is_dir():
        raise HTTPException(404, "Backup not found")
    _sh.rmtree(target, ignore_errors=True)
    audit("backup.delete", name=name)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# System info
# ==========================================================================
@app.get("/api/system/info")
def system_info():
    log_dir = logging_setup.current_log_dir() or logging_setup.default_log_dir()
    return {
        "app_dir": str(APP_DIR),
        "db_path": str(DB_PATH),
        "backup_dir": str(BACKUP_DIR),
        "log_dir": str(log_dir),
    }


# ==========================================================================
# Demo mode
# ==========================================================================
@app.get("/api/demo")
def demo_status(s: Session = Depends(get_session)):
    return demo_svc.demo_status(s)


@app.post("/api/demo/seed")
def demo_seed(s: Session = Depends(get_session)):
    result = demo_svc.seed_demo(s)
    if result.get("created"):
        audit("demo.seed", **{k: v for k, v in result.items() if k != "created"})
    return result


@app.post("/api/demo/clear")
def demo_clear(s: Session = Depends(get_session)):
    result = demo_svc.clear_demo(s)
    audit("demo.clear", **{k: v for k, v in result.items() if k != "cleared"})
    return result


# ==========================================================================
# Frontend static files (built React bundle)
# ==========================================================================
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

if FRONTEND_DIST.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str):
        # Anything that isn't /api/* falls back to index.html so React Router works.
        if full_path.startswith("api/"):
            raise HTTPException(404)
        target = FRONTEND_DIST / full_path
        if target.is_file():
            return FileResponse(target)
        return FileResponse(FRONTEND_DIST / "index.html")
else:
    @app.get("/")
    def _no_frontend():
        return {
            "message": "Frontend bundle not found. Run `npm install && npm run build` in /frontend.",
        }
