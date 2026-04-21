"""FastAPI app with all routes. Single file — small app, easier to grok."""
from __future__ import annotations

import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import (
    Depends, FastAPI, File, Form, HTTPException, Query, Request, Response,
    UploadFile, status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from sqlmodel import Session, select

from backend import backup as backup_svc
from backend import demo as demo_svc
from backend import logging_setup

# Configure logging on module import so `uvicorn backend.main:app` (dev mode)
# also gets proper file logging. In the desktop launcher we've already called
# this — the function is idempotent.
logging_setup.configure_logging()

from backend.db import APP_DIR, ATTACHMENTS_DIR, DB_PATH, engine, init_db
from backend.models import (
    Appointment,
    AppointmentCreate,
    AppointmentRead,
    AppointmentReschedule,
    AppointmentStatus,
    AttachmentKind,
    AuditLog,
    AuditLogRead,
    ConsultationAttachment,
    ConsultationAttachmentRead,
    ConsultationNote,
    ConsultationNoteCreate,
    ConsultationNoteRead,
    ConsultationNoteUpdate,
    DoctorAvailability,
    DoctorAvailabilityRead,
    Invoice,
    InvoiceCreate,
    InvoiceItem,
    InvoiceRead,
    InvoiceStatus,
    InvoiceUpdate,
    Patient,
    PatientCreate,
    PatientLifecycle,
    PatientRead,
    Payment,
    PaymentCreate,
    PaymentRead,
    Procedure,
    ProcedureCreate,
    ProcedureRead,
    Room,
    RoomCreate,
    RoomRead,
    Settings,
    SettingsRead,
    SettingsUpdate,
    ToothRecord,
    ToothRecordRead,
    ToothRecordUpsert,
    ToothStatus,
    Treatment,
    TreatmentCreate,
    TreatmentPlan,
    TreatmentPlanCreate,
    TreatmentPlanRead,
    TreatmentPlanStatus,
    TreatmentPlanStep,
    TreatmentPlanStepCreate,
    TreatmentPlanStepRead,
    TreatmentPlanStepUpdate,
    TreatmentPlanUpdate,
    TreatmentRead,
    TreatmentStepStatus,
    utcnow,
)
from backend import services
from backend import reports as reports_svc
from backend import audit_db
from backend.undo import buffer as undo_buffer


BACKUP_DIR = APP_DIR / "backups"
APP_VERSION = "0.3.0"
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


# Common categories suggested to the doctor in the UI. Kept as a constant so
# /api/procedures/categories can return them even on a brand-new DB.
SUGGESTED_CATEGORIES: list[str] = [
    "General",
    "Dental",
    "Gastroenterology",
    "Cardiology",
    "Dermatology",
    "ENT",
    "Gynaecology",
    "Orthopaedics",
    "Paediatrics",
    "Ophthalmology",
    "Psychiatry",
    "Neurology",
    "Physiotherapy",
]


#: Canonical catalog of starter procedures. Tuple shape:
#:   (name, default_price, category, duration_minutes, description)
#: The name is also the primary key we use for the one-time re-classify
#: pass below — if a user's DB has a procedure with a matching name whose
#: category is still "General" (from the old blanket backfill) or blank,
#: we correct it to the canonical category.
_DEFAULT_PROCEDURES: list[tuple[str, float, str, int, str]] = [
    # General / family practice
    ("Consultation", 500, "General", 15,
     "Standard out-patient consultation with history and examination."),
    ("Follow-up Visit", 300, "General", 10,
     "Short follow-up to review progress or adjust treatment."),
    ("Dressing / Minor Procedure", 500, "General", 20,
     "Wound dressing, suture removal or other minor in-chair procedure."),
    ("Vaccination", 600, "General", 10,
     "Age-appropriate vaccine administration, counselling included."),
    # Dental -- biggest chunk because the app started as a dental tool.
    ("Scaling & Polishing", 1500, "Dental", 45,
     "Ultrasonic scaling of calculus + rubber-cup polish, both arches."),
    ("Tooth Extraction", 2000, "Dental", 30,
     "Simple extraction under local anaesthesia."),
    ("Root Canal Treatment", 6000, "Dental", 60,
     "Single-visit endodontic treatment (RCT) with rotary instrumentation."),
    ("Composite Filling", 1200, "Dental", 30,
     "Tooth-coloured composite restoration, per surface."),
    ("Crown (PFM)", 5000, "Dental", 45,
     "Porcelain-fused-to-metal crown, including prep and cementation."),
    ("Crown (Zirconia)", 12000, "Dental", 45,
     "Full-contour zirconia crown, lab-milled and cemented."),
    ("Teeth Whitening", 4000, "Dental", 60,
     "In-chair bleaching session with custom isolation."),
    ("Dental Implant", 25000, "Dental", 90,
     "Endosseous implant placement, healing abutment included."),
    ("Orthodontic Consult", 700, "Dental", 20,
     "Ortho screening, records discussion, treatment-plan briefing."),
    ("Braces Adjustment", 1500, "Dental", 30,
     "Monthly activation / wire change for fixed appliance therapy."),
    ("Pediatric Cleaning", 1000, "Dental", 30,
     "Child dental cleaning with fluoride varnish application."),
    # Gastro
    ("Endoscopy", 4500, "Gastroenterology", 45,
     "Upper GI endoscopy, diagnostic, with conscious sedation."),
    ("Colonoscopy", 6500, "Gastroenterology", 60,
     "Full colonoscopy with polypectomy if indicated."),
    ("Liver Function Consult", 800, "Gastroenterology", 20,
     "Targeted consult for deranged LFTs or suspected hepatitis."),
    # ENT
    ("Ear Wax Removal", 800, "ENT", 15,
     "Micro-suction / syringing for impacted cerumen."),
    ("Tonsillitis Consult", 600, "ENT", 15,
     "Acute sore-throat evaluation, swab if indicated."),
    ("Audiometry", 1500, "ENT", 30,
     "Pure-tone audiometry with tympanometry."),
    # Dermatology
    ("Skin Consultation", 700, "Dermatology", 15,
     "General dermatology visit for rashes, acne or pigmentation."),
    ("Acne Treatment", 1200, "Dermatology", 20,
     "Comedone extraction or chemical lightening for acne scars."),
    ("Chemical Peel", 3500, "Dermatology", 45,
     "Superficial glycolic / salicylic peel for photodamage and acne."),
    # Cardiology
    ("ECG", 500, "Cardiology", 15,
     "12-lead resting electrocardiogram with interpretation."),
    ("2D Echo", 2000, "Cardiology", 30,
     "Trans-thoracic echocardiography, resting."),
    ("Cardiac Consultation", 1000, "Cardiology", 20,
     "Out-patient cardiology review including BP and risk assessment."),
    # Paediatrics / Ortho — round out the catalog so the demo
    # shows breadth across specialties.
    ("Child Wellness Visit", 600, "Paediatrics", 20,
     "Growth, immunisation review and developmental screening."),
    ("Sprain Evaluation", 800, "Orthopaedics", 20,
     "Clinical exam for joint sprain with X-ray review."),
    ("Plaster Cast", 1500, "Orthopaedics", 30,
     "Plaster-of-Paris / fibreglass cast application."),
]

#: Keyword → category heuristic for user-created procedures that predate
#: the mandatory-category rule. Applied ONLY when a row's current category
#: is missing/blank -- never overwrites a user-set category.
_CATEGORY_KEYWORDS: list[tuple[tuple[str, ...], str]] = [
    ((
        "dental", "tooth", "teeth", "rct", "root canal", "filling", "scaling",
        "crown", "bridge", "implant", "whitening", "braces", "orthodont",
        "pediatric cleaning", "pulp", "extraction", "gingiv", "denture",
    ), "Dental"),
    ((
        "endoscopy", "colonoscopy", "gastr", "liver", "hepatitis", "ibs",
    ), "Gastroenterology"),
    ((
        "ear", "audiomet", "tonsil", "adenoid", "sinus",
    ), "ENT"),
    ((
        "skin", "acne", "derm", "peel", "eczema",
    ), "Dermatology"),
    ((
        "ecg", "echo", "cardiac", "bp ", "hypertens",
    ), "Cardiology"),
    ((
        "pediatric", "paediatric", "child ", "infant",
    ), "Paediatrics"),
    ((
        "sprain", "cast", "ortho", "fracture", "plaster",
    ), "Orthopaedics"),
]


def _guess_category(name: str, description: str = "") -> Optional[str]:
    """Return a best-guess category from the procedure name, or None if we
    aren't confident. Used only as a fallback for legacy rows that have no
    explicit category set."""
    hay = f"{name} {description}".lower()
    for keywords, cat in _CATEGORY_KEYWORDS:
        if any(kw in hay for kw in keywords):
            return cat
    return None


def _seed_if_empty() -> None:
    """Seed a few starter procedures and default doctor availability so the
    app works out of the box. Idempotent — skips whatever already exists."""
    with Session(engine) as s:
        if s.exec(select(Procedure)).first() is None:
            for name, price, category, duration, desc in _DEFAULT_PROCEDURES:
                s.add(Procedure(
                    name=name,
                    description=desc,
                    default_price=float(price),
                    category=category,
                    default_duration_minutes=duration,
                ))
            s.commit()
            log.info("Seeded %d default procedures", len(_DEFAULT_PROCEDURES))

    # Ensure the singleton settings row always exists so GET never 404s.
    with Session(engine) as s:
        if s.get(Settings, 1) is None:
            s.add(Settings(id=1))
            s.commit()
            log.info("Created empty settings row")

    # --- Category backfill ------------------------------------------------
    # Two passes, both idempotent and safe to run on every boot:
    #   1. Any procedure whose **canonical name** matches _DEFAULT_PROCEDURES
    #      and whose current category is blank OR "General" (the old blanket
    #      backfill value) is rewritten to the canonical category. This
    #      rescues installs that seeded before categories were mandatory.
    #   2. Anything still uncategorised falls back to the keyword heuristic,
    #      and finally to "General" if nothing matches.
    # A row that the user has explicitly assigned to a non-General category
    # (e.g. they renamed "Consultation" to sit under "Cardiology") is left
    # untouched by pass #1.
    canonical_by_name = {
        name: (cat, desc) for name, _p, cat, _d, desc in _DEFAULT_PROCEDURES
    }
    with Session(engine) as s:
        reclassified = 0
        desc_filled = 0
        generalised = 0
        rows = s.exec(select(Procedure)).all()
        for p in rows:
            canonical = canonical_by_name.get(p.name)
            current = (p.category or "").strip()
            # Pass 1: known-name correction.
            if canonical and current in ("", "General") and canonical[0] != current:
                p.category = canonical[0]
                reclassified += 1
            # Backfill description from the canonical catalog if still empty.
            if canonical and not (p.description or "").strip():
                p.description = canonical[1]
                desc_filled += 1
            # Pass 2: keyword fallback for rows that still lack a category.
            if not (p.category or "").strip():
                p.category = _guess_category(p.name, p.description or "") or "General"
                generalised += 1
            s.add(p)
        if reclassified or desc_filled or generalised:
            s.commit()
            log.info(
                "Procedure backfill: %d re-categorised, %d descriptions filled, "
                "%d defaulted to General",
                reclassified, desc_filled, generalised,
            )

    # Default weekly availability — Mon–Sat 9:00–18:00 with a 13:00–14:00 break.
    with Session(engine) as s:
        if s.exec(select(DoctorAvailability)).first() is None:
            for wd in range(7):
                s.add(DoctorAvailability(
                    weekday=wd,
                    is_working=(wd != 6),  # Sunday off by default
                    start_time="09:00",
                    end_time="18:00",
                    break_start="13:00",
                    break_end="14:00",
                ))
            s.commit()
            log.info("Seeded default doctor availability")


# ---------- helpers ----------
def _soft_delete_response(session: Session, entity_type: str, entity, label: str = "") -> dict:
    """Soft-delete an entity, push an undo token, and return the token
    payload the frontend wires to its Undo toast."""
    audit_db.mark_deleted(session, entity)
    session.commit()
    entry = undo_buffer.push(entity_type, entity.id, label or f"{entity_type} #{entity.id}")
    return {
        "ok": True,
        "undo_token": entry.token,
        "expires_in": int(entry.expires_at - time.time()),
        "entity_type": entity_type,
        "entity_id": entity.id,
        "label": entry.label,
    }


# ==========================================================================
# Patients
# ==========================================================================
def _patient_read(session: Session, p: Patient) -> PatientRead:
    lifecycle, last_visit, pending = services.compute_patient_lifecycle(session, p.id)
    return PatientRead(
        id=p.id,
        name=p.name,
        age=p.age,
        phone=p.phone,
        email=p.email,
        medical_history=p.medical_history,
        dental_history=p.dental_history,
        allergies=p.allergies,
        notes=p.notes,
        created_at=p.created_at,
        lifecycle=PatientLifecycle(lifecycle),
        last_visit=last_visit,
        pending_steps=pending,
    )


@app.get("/api/patients", response_model=List[PatientRead])
def list_patients(
    q: Optional[str] = None,
    lifecycle: Optional[str] = None,
    include_deleted: bool = False,
    s: Session = Depends(get_session),
):
    stmt = select(Patient).order_by(Patient.created_at.desc())
    if not include_deleted:
        stmt = stmt.where(Patient.deleted_at.is_(None))
    if q:
        like = f"%{q}%"
        stmt = stmt.where((Patient.name.ilike(like)) | (Patient.phone.ilike(like)))
    rows = s.exec(stmt).all()
    results = [_patient_read(s, p) for p in rows]
    if lifecycle:
        results = [r for r in results if r.lifecycle and r.lifecycle.value == lifecycle]
    return results


@app.post("/api/patients", response_model=PatientRead, status_code=201)
def create_patient(payload: PatientCreate, s: Session = Depends(get_session)):
    p = Patient.model_validate(payload)
    s.add(p)
    s.commit()
    s.refresh(p)
    audit_db.record(
        s, "patient.create", entity_type="patient", entity_id=p.id,
        summary=p.name, name=p.name, phone=p.phone or "",
    )
    s.commit()
    return _patient_read(s, p)


@app.get("/api/patients/{pid}", response_model=PatientRead)
def get_patient(pid: int, s: Session = Depends(get_session)):
    p = s.get(Patient, pid)
    if not p or p.deleted_at is not None:
        raise HTTPException(404, "Patient not found")
    return _patient_read(s, p)


@app.put("/api/patients/{pid}", response_model=PatientRead)
def update_patient(pid: int, payload: PatientCreate, s: Session = Depends(get_session)):
    p = s.get(Patient, pid)
    if not p or p.deleted_at is not None:
        raise HTTPException(404, "Patient not found")
    changed = list(payload.model_dump(exclude_unset=True).keys())
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    s.add(p)
    s.commit()
    s.refresh(p)
    audit_db.record(
        s, "patient.update", entity_type="patient", entity_id=p.id,
        summary=p.name, fields=",".join(changed),
    )
    s.commit()
    return _patient_read(s, p)


@app.delete("/api/patients/{pid}")
def delete_patient(pid: int, hard: bool = False, s: Session = Depends(get_session)):
    p = s.get(Patient, pid)
    if not p:
        raise HTTPException(404, "Patient not found")
    name = p.name
    if hard:
        s.delete(p)
        s.commit()
        audit_db.record(s, "patient.delete_hard", entity_type="patient", entity_id=pid,
                        summary=name, name=name)
        s.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    audit_db.record(s, "patient.delete", entity_type="patient", entity_id=pid,
                    summary=name, name=name)
    return _soft_delete_response(s, "patient", p, label=f"Patient {name}")


# ==========================================================================
# Procedures
# ==========================================================================
@app.get("/api/procedures", response_model=List[ProcedureRead])
def list_procedures(s: Session = Depends(get_session)):
    return s.exec(select(Procedure).order_by(Procedure.name)).all()


@app.post("/api/procedures", response_model=ProcedureRead, status_code=201)
def create_procedure(payload: ProcedureCreate, s: Session = Depends(get_session)):
    # Category is mandatory so reports/filters don't end up with "(blank)"
    # buckets. The UI enforces this too, but the backend is the source of
    # truth: reject empty/whitespace values here.
    if not (payload.category or "").strip():
        raise HTTPException(422, "Category is required for every procedure")
    payload.category = payload.category.strip()
    p = Procedure.model_validate(payload)
    s.add(p)
    s.commit()
    s.refresh(p)
    audit_db.record(s, "procedure.create", entity_type="procedure", entity_id=p.id,
                    summary=p.name, name=p.name, price=p.default_price)
    s.commit()
    return p


@app.get("/api/procedures/categories", response_model=List[str])
def list_procedure_categories(s: Session = Depends(get_session)):
    """Return the union of categories in use (from the DB) and our suggested
    list, sorted with the doctor's current picks first. Registered BEFORE
    /api/procedures/{pid} so FastAPI doesn't try to parse 'categories' as a
    procedure id."""
    # ``s.exec(select(SingleColumn))`` returns scalars in SQLModel; iterate
    # directly rather than trying to tuple-unpack.
    used = {
        c for c in s.exec(
            select(Procedure.category).where(Procedure.category.is_not(None))
        ).all()
        if c
    }
    combined = list(dict.fromkeys(list(used) + SUGGESTED_CATEGORIES))
    return combined


@app.put("/api/procedures/{pid}", response_model=ProcedureRead)
def update_procedure(pid: int, payload: ProcedureCreate, s: Session = Depends(get_session)):
    p = s.get(Procedure, pid)
    if not p:
        raise HTTPException(404, "Procedure not found")
    patch = payload.model_dump(exclude_unset=True)
    # Guard against blanking the category on an existing row.
    if "category" in patch and not (patch.get("category") or "").strip():
        raise HTTPException(422, "Category is required for every procedure")
    if "category" in patch:
        patch["category"] = patch["category"].strip()
    for k, v in patch.items():
        setattr(p, k, v)
    s.add(p)
    s.commit()
    s.refresh(p)
    audit_db.record(s, "procedure.update", entity_type="procedure", entity_id=p.id, summary=p.name)
    s.commit()
    return p


@app.delete("/api/procedures/{pid}", status_code=204)
def delete_procedure(pid: int, s: Session = Depends(get_session)):
    p = s.get(Procedure, pid)
    if not p:
        raise HTTPException(404, "Procedure not found")
    name = p.name
    s.delete(p)
    s.commit()
    audit_db.record(s, "procedure.delete", entity_type="procedure", entity_id=pid,
                    summary=name, name=name)
    s.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Rooms (chairs / consultation rooms)
# ==========================================================================
@app.get("/api/rooms", response_model=List[RoomRead])
def list_rooms(active_only: bool = False, s: Session = Depends(get_session)):
    stmt = select(Room).order_by(Room.name)
    if active_only:
        stmt = stmt.where(Room.active.is_(True))
    return s.exec(stmt).all()


@app.post("/api/rooms", response_model=RoomRead, status_code=201)
def create_room(payload: RoomCreate, s: Session = Depends(get_session)):
    r = Room.model_validate(payload)
    s.add(r)
    s.commit()
    s.refresh(r)
    audit_db.record(s, "room.create", entity_type="room", entity_id=r.id, summary=r.name)
    s.commit()
    return r


@app.put("/api/rooms/{rid}", response_model=RoomRead)
def update_room(rid: int, payload: RoomCreate, s: Session = Depends(get_session)):
    r = s.get(Room, rid)
    if not r:
        raise HTTPException(404, "Room not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(r, k, v)
    s.add(r)
    s.commit()
    s.refresh(r)
    audit_db.record(s, "room.update", entity_type="room", entity_id=r.id, summary=r.name)
    s.commit()
    return r


@app.delete("/api/rooms/{rid}", status_code=204)
def delete_room(rid: int, s: Session = Depends(get_session)):
    r = s.get(Room, rid)
    if not r:
        raise HTTPException(404, "Room not found")
    name = r.name
    s.delete(r)
    s.commit()
    audit_db.record(s, "room.delete", entity_type="room", entity_id=rid, summary=name)
    s.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Doctor availability
# ==========================================================================
@app.get("/api/availability", response_model=List[DoctorAvailabilityRead])
def list_availability(s: Session = Depends(get_session)):
    rows = s.exec(select(DoctorAvailability).order_by(DoctorAvailability.weekday)).all()
    return rows


@app.put("/api/availability", response_model=List[DoctorAvailabilityRead])
def upsert_availability(
    payload: List[DoctorAvailabilityRead],
    s: Session = Depends(get_session),
):
    """Replace the entire weekly schedule. Accepts the same shape as GET
    returns (id field is ignored)."""
    by_weekday: dict[int, DoctorAvailability] = {
        r.weekday: r for r in s.exec(select(DoctorAvailability)).all()
    }
    for item in payload:
        existing = by_weekday.get(item.weekday)
        if existing is None:
            existing = DoctorAvailability(weekday=item.weekday)
        existing.is_working = item.is_working
        existing.start_time = item.start_time
        existing.end_time = item.end_time
        existing.break_start = item.break_start
        existing.break_end = item.break_end
        s.add(existing)
    s.commit()
    audit_db.record(s, "availability.update", entity_type="availability", summary="weekly schedule")
    s.commit()
    return list(s.exec(select(DoctorAvailability).order_by(DoctorAvailability.weekday)).all())


# ==========================================================================
# Appointments
# ==========================================================================
def _appt_read(s: Session, a: Appointment) -> AppointmentRead:
    patient = s.get(Patient, a.patient_id) if a.patient_id else None
    procedure = s.get(Procedure, a.procedure_id) if a.procedure_id else None
    room = s.get(Room, a.room_id) if a.room_id else None
    return AppointmentRead(
        id=a.id, patient_id=a.patient_id, start=a.start, end=a.end,
        status=a.status, chief_complaint=a.chief_complaint, notes=a.notes,
        reminder_sent=a.reminder_sent, created_at=a.created_at,
        patient_name=patient.name if patient else None,
        procedure_id=a.procedure_id,
        procedure_name=procedure.name if procedure else None,
        room_id=a.room_id,
        room_name=room.name if room else None,
    )


@app.get("/api/appointments", response_model=List[AppointmentRead])
def list_appointments(
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    patient_id: Optional[int] = None,
    room_id: Optional[int] = None,
    s: Session = Depends(get_session),
):
    stmt = (
        select(Appointment)
        .where(Appointment.deleted_at.is_(None))
        .order_by(Appointment.start)
    )
    if start:
        stmt = stmt.where(Appointment.start >= start)
    if end:
        stmt = stmt.where(Appointment.start <= end)
    if patient_id:
        stmt = stmt.where(Appointment.patient_id == patient_id)
    if room_id:
        stmt = stmt.where(Appointment.room_id == room_id)
    return [_appt_read(s, a) for a in s.exec(stmt).all()]


@app.post("/api/appointments", response_model=AppointmentRead, status_code=201)
def create_appointment(payload: AppointmentCreate, s: Session = Depends(get_session)):
    if not s.get(Patient, payload.patient_id):
        raise HTTPException(400, "Invalid patient_id")
    a = Appointment.model_validate(payload)
    s.add(a)
    s.commit()
    s.refresh(a)
    p = s.get(Patient, a.patient_id)
    audit_db.record(
        s, "appointment.create", entity_type="appointment", entity_id=a.id,
        summary=p.name if p else f"#{a.id}",
        patient_id=a.patient_id, start=a.start.isoformat(),
    )
    s.commit()
    return _appt_read(s, a)


@app.put("/api/appointments/{aid}", response_model=AppointmentRead)
def update_appointment(aid: int, payload: AppointmentCreate, s: Session = Depends(get_session)):
    a = s.get(Appointment, aid)
    if not a or a.deleted_at is not None:
        raise HTTPException(404, "Appointment not found")
    data = payload.model_dump(exclude_unset=True)
    # `reminder_sent` is a server-managed field; ignore client attempts to set it.
    data.pop("reminder_sent", None)
    for k, v in data.items():
        setattr(a, k, v)
    s.add(a)
    s.commit()
    s.refresh(a)
    audit_db.record(s, "appointment.update", entity_type="appointment", entity_id=a.id)
    s.commit()
    return _appt_read(s, a)


@app.patch("/api/appointments/{aid}/reschedule", response_model=AppointmentRead)
def reschedule_appointment(
    aid: int,
    payload: AppointmentReschedule,
    s: Session = Depends(get_session),
):
    a = s.get(Appointment, aid)
    if not a or a.deleted_at is not None:
        raise HTTPException(404, "Appointment not found")
    old_start = a.start.isoformat() if a.start else ""
    a.start = payload.start
    a.end = payload.end
    if payload.room_id is not None:
        a.room_id = payload.room_id
    s.add(a)
    s.commit()
    s.refresh(a)
    audit_db.record(
        s, "appointment.reschedule", entity_type="appointment", entity_id=a.id,
        old_start=old_start, new_start=a.start.isoformat(),
    )
    s.commit()
    return _appt_read(s, a)


@app.patch("/api/appointments/{aid}/status", response_model=AppointmentRead)
def set_appointment_status(aid: int, new_status: AppointmentStatus, s: Session = Depends(get_session)):
    a = s.get(Appointment, aid)
    if not a or a.deleted_at is not None:
        raise HTTPException(404, "Appointment not found")
    old = a.status.value if hasattr(a.status, "value") else a.status
    a.status = new_status
    s.add(a)
    s.commit()
    s.refresh(a)
    audit_db.record(s, "appointment.status", entity_type="appointment", entity_id=aid,
                    old=old, new=new_status.value)
    s.commit()
    # A completed visit always gets a consultation-note stub so the doctor
    # can jump straight to writing the prescription. Safe to call multiple
    # times -- it's a find-or-create.
    if new_status == AppointmentStatus.completed:
        _ensure_consult_note(s, a.patient_id, aid)
    return _appt_read(s, a)


@app.delete("/api/appointments/{aid}")
def delete_appointment(aid: int, hard: bool = False, s: Session = Depends(get_session)):
    a = s.get(Appointment, aid)
    if not a:
        raise HTTPException(404, "Appointment not found")
    pid = a.patient_id
    if hard:
        s.delete(a)
        s.commit()
        audit_db.record(s, "appointment.delete_hard", entity_type="appointment", entity_id=aid, patient_id=pid)
        s.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    audit_db.record(s, "appointment.delete", entity_type="appointment", entity_id=aid, patient_id=pid)
    return _soft_delete_response(s, "appointment", a, label=f"Appointment #{aid}")


@app.post("/api/appointments/{aid}/remind")
def send_reminder(aid: int, channel: str = "sms", s: Session = Depends(get_session)):
    a = s.get(Appointment, aid)
    if not a or a.deleted_at is not None:
        raise HTTPException(404, "Appointment not found")
    p = s.get(Patient, a.patient_id)
    if not p:
        raise HTTPException(400, "Patient not found")
    ok = services.send_appointment_reminder(p, a.start, channel=channel)
    if ok:
        a.reminder_sent = True
        s.add(a)
        s.commit()
        audit_db.record(s, "reminder.sent", entity_type="appointment", entity_id=aid,
                        patient_id=p.id, channel=channel)
        s.commit()
    else:
        log.warning("Reminder failed for appointment %s (channel=%s)", aid, channel)
    return {"ok": ok, "channel": channel}


# ==========================================================================
# Consultation notes (one per appointment)
# ==========================================================================
def _note_read(s: Session, n: ConsultationNote) -> ConsultationNoteRead:
    appt = s.get(Appointment, n.appointment_id) if n.appointment_id else None
    return ConsultationNoteRead(
        id=n.id,
        patient_id=n.patient_id,
        appointment_id=n.appointment_id,
        chief_complaint=n.chief_complaint,
        diagnosis=n.diagnosis,
        treatment_advised=n.treatment_advised,
        notes=n.notes,
        prescription_items=n.prescription_items,
        prescription_notes=n.prescription_notes,
        invoice_id=n.invoice_id,
        created_at=n.created_at,
        updated_at=n.updated_at,
        appointment_start=appt.start if appt else None,
    )


@app.get("/api/appointments/{aid}/note", response_model=Optional[ConsultationNoteRead])
def get_appointment_note(aid: int, s: Session = Depends(get_session)):
    a = s.get(Appointment, aid)
    if not a:
        raise HTTPException(404, "Appointment not found")
    n = s.exec(
        select(ConsultationNote)
        .where(ConsultationNote.appointment_id == aid)
        .where(ConsultationNote.deleted_at.is_(None))
    ).first()
    if not n:
        return None
    return _note_read(s, n)


@app.put("/api/appointments/{aid}/note", response_model=ConsultationNoteRead)
def upsert_appointment_note(
    aid: int,
    payload: ConsultationNoteUpdate,
    s: Session = Depends(get_session),
):
    a = s.get(Appointment, aid)
    if not a or a.deleted_at is not None:
        raise HTTPException(404, "Appointment not found")
    n = s.exec(
        select(ConsultationNote)
        .where(ConsultationNote.appointment_id == aid)
        .where(ConsultationNote.deleted_at.is_(None))
    ).first()
    data = payload.model_dump(exclude_unset=True)
    if n is None:
        n = ConsultationNote(
            patient_id=a.patient_id,
            appointment_id=aid,
            **data,
        )
        action = "note.create"
    else:
        for k, v in data.items():
            setattr(n, k, v)
        n.updated_at = utcnow()
        action = "note.update"
    s.add(n)
    s.commit()
    s.refresh(n)
    audit_db.record(s, action, entity_type="consultation_note", entity_id=n.id,
                    appointment_id=aid, patient_id=n.patient_id)
    s.commit()
    return _note_read(s, n)


@app.delete("/api/appointments/{aid}/note", status_code=204)
def delete_appointment_note(aid: int, s: Session = Depends(get_session)):
    n = s.exec(
        select(ConsultationNote)
        .where(ConsultationNote.appointment_id == aid)
        .where(ConsultationNote.deleted_at.is_(None))
    ).first()
    if not n:
        raise HTTPException(404, "Note not found")
    audit_db.mark_deleted(s, n)
    s.commit()
    audit_db.record(s, "note.delete", entity_type="consultation_note", entity_id=n.id)
    s.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/api/patients/{pid}/notes", response_model=List[ConsultationNoteRead])
def list_patient_notes(pid: int, s: Session = Depends(get_session)):
    rows = s.exec(
        select(ConsultationNote)
        .where(ConsultationNote.patient_id == pid)
        .where(ConsultationNote.deleted_at.is_(None))
        .order_by(ConsultationNote.created_at.desc())
    ).all()
    return [_note_read(s, n) for n in rows]


@app.get(
    "/api/patients/{pid}/consultation-notes",
    response_model=List[ConsultationNoteRead],
)
def list_patient_consult_notes(pid: int, s: Session = Depends(get_session)):
    return list_patient_notes(pid, s)


@app.get("/api/consultation-notes", response_model=List[ConsultationNoteRead])
def list_all_consult_notes(
    q: Optional[str] = None,
    patient_id: Optional[int] = None,
    has_prescription: Optional[bool] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = Query(200, ge=1, le=1000),
    s: Session = Depends(get_session),
):
    """Clinic-wide list of consultation notes for the top-level
    /consultations page. Supports text search across chief complaint /
    diagnosis / treatment advice plus optional filters by patient,
    "has prescription", and date range so the doctor can quickly jump
    to visits from a specific week or month.

    Dates may be ISO date strings (``YYYY-MM-DD``) or full ISO datetimes;
    the range is applied against the appointment start when available,
    otherwise against the note's ``created_at``.
    """
    stmt = (
        select(ConsultationNote, Patient)
        .join(Patient, ConsultationNote.patient_id == Patient.id)
        .where(ConsultationNote.deleted_at.is_(None))
        .order_by(ConsultationNote.created_at.desc())
        .limit(limit)
    )
    if patient_id is not None:
        stmt = stmt.where(ConsultationNote.patient_id == patient_id)
    if q:
        needle = f"%{q.strip()}%"
        # Patient name OR any of the three main SOAP fields — covers the
        # common "find that hypertension visit from last month" query.
        stmt = stmt.where(
            (Patient.name.ilike(needle))
            | (ConsultationNote.chief_complaint.ilike(needle))
            | (ConsultationNote.diagnosis.ilike(needle))
            | (ConsultationNote.treatment_advised.ilike(needle))
        )
    if has_prescription is True:
        stmt = stmt.where(ConsultationNote.prescription_items.is_not(None))
        stmt = stmt.where(ConsultationNote.prescription_items != "")
    elif has_prescription is False:
        stmt = stmt.where(
            (ConsultationNote.prescription_items.is_(None))
            | (ConsultationNote.prescription_items == "")
        )

    def _parse_bound(raw: str, end_of_day: bool) -> Optional[datetime]:
        """Accept either ``YYYY-MM-DD`` or a full ISO timestamp. Date-only
        strings snap to start-of-day for ``date_from`` and to end-of-day
        for ``date_to`` so the inclusive semantics match the UI."""
        try:
            if "T" in raw or " " in raw:
                return datetime.fromisoformat(raw.replace("Z", "+00:00"))
            d = date.fromisoformat(raw)
            return datetime.combine(
                d,
                datetime.max.time() if end_of_day else datetime.min.time(),
            )
        except (TypeError, ValueError):
            return None

    lower = _parse_bound(date_from, end_of_day=False) if date_from else None
    upper = _parse_bound(date_to, end_of_day=True) if date_to else None
    if lower is not None:
        stmt = stmt.where(ConsultationNote.created_at >= lower)
    if upper is not None:
        stmt = stmt.where(ConsultationNote.created_at <= upper)

    rows = s.exec(stmt).all()
    out: List[ConsultationNoteRead] = []
    for n, p in rows:
        r = _note_read(s, n)
        r.patient_name = p.name
        out.append(r)
    return out


@app.post(
    "/api/consultation-notes",
    response_model=ConsultationNoteRead,
    status_code=201,
)
def create_consult_note(
    payload: ConsultationNoteCreate, s: Session = Depends(get_session),
):
    if not s.get(Patient, payload.patient_id):
        raise HTTPException(400, "Invalid patient_id")
    if payload.appointment_id:
        a = s.get(Appointment, payload.appointment_id)
        if not a or a.deleted_at is not None:
            raise HTTPException(400, "Invalid appointment_id")
    n = ConsultationNote.model_validate(payload)
    s.add(n)
    s.commit()
    s.refresh(n)
    audit_db.record(s, "note.create", entity_type="consultation_note",
                    entity_id=n.id, patient_id=n.patient_id,
                    appointment_id=n.appointment_id)
    s.commit()
    return _note_read(s, n)


@app.get("/api/consultation-notes/{nid}", response_model=ConsultationNoteRead)
def get_consult_note(nid: int, s: Session = Depends(get_session)):
    """Fetch a single consultation note by id. Powers deep-links from
    invoices and external bookmarks into the Consultations page."""
    n = s.get(ConsultationNote, nid)
    if not n or n.deleted_at is not None:
        raise HTTPException(404, "Note not found")
    patient = s.get(Patient, n.patient_id)
    read = _note_read(s, n)
    if patient:
        read.patient_name = patient.name
    return read


@app.put("/api/consultation-notes/{nid}", response_model=ConsultationNoteRead)
def update_consult_note(
    nid: int,
    payload: ConsultationNoteUpdate,
    s: Session = Depends(get_session),
):
    n = s.get(ConsultationNote, nid)
    if not n or n.deleted_at is not None:
        raise HTTPException(404, "Note not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(n, k, v)
    n.updated_at = utcnow()
    s.add(n)
    s.commit()
    s.refresh(n)
    audit_db.record(s, "note.update", entity_type="consultation_note", entity_id=n.id)
    s.commit()
    return _note_read(s, n)


@app.delete("/api/consultation-notes/{nid}")
def delete_consult_note(
    nid: int, hard: bool = False, s: Session = Depends(get_session),
):
    n = s.get(ConsultationNote, nid)
    if not n:
        raise HTTPException(404, "Note not found")
    if hard:
        s.delete(n)
        s.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    audit_db.record(s, "note.delete", entity_type="consultation_note", entity_id=nid)
    return _soft_delete_response(s, "consultation_note", n, label="Consultation note")


# ---------- Prescriptions ---------------------------------------------------
# Prescriptions are stored inline on the consultation note (see
# ``prescription_items``) so every visit can produce a printable Rx without
# a separate entity. This route renders the note into the shared print
# template so the doctor can hit "Print" from the invoice or the visit.
def _parse_rx_items(raw: Optional[str]) -> list:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        # Tolerate legacy free-text — one line per row — so a migrated
        # value doesn't 500 the render route.
        return [l for l in str(raw).splitlines() if l.strip()]
    return parsed if isinstance(parsed, list) else []


@app.get(
    "/api/consultation-notes/{nid}/prescription",
    response_class=HTMLResponse,
)
def render_note_prescription(nid: int, s: Session = Depends(get_session)):
    n = s.get(ConsultationNote, nid)
    if not n or n.deleted_at is not None:
        raise HTTPException(404, "Note not found")
    patient = s.get(Patient, n.patient_id)
    if not patient:
        raise HTTPException(404, "Patient not found")
    settings = s.get(Settings, 1)
    appt = s.get(Appointment, n.appointment_id) if n.appointment_id else None
    html_doc = services.render_prescription_html(
        patient,
        {
            "chief_complaint": n.chief_complaint,
            "diagnosis": n.diagnosis,
            "treatment_advised": n.treatment_advised,
            "notes": n.prescription_notes or n.notes,
            "prescriptions": _parse_rx_items(n.prescription_items),
            "appointment_date": appt.start if appt else None,
            "date": n.updated_at or n.created_at,
        },
        settings=settings,
    )
    return HTMLResponse(content=html_doc)


@app.get(
    "/api/consultation-notes/{nid}/prescription.pdf",
    response_class=Response,
)
def render_note_prescription_pdf(nid: int, s: Session = Depends(get_session)):
    """Downloadable/emailable PDF version of the printable prescription.

    Mirrors the HTML endpoint so the doctor can attach a proper PDF to a
    WhatsApp/email message without asking the patient to "Save as PDF"
    from the print dialog.
    """
    n = s.get(ConsultationNote, nid)
    if not n or n.deleted_at is not None:
        raise HTTPException(404, "Note not found")
    patient = s.get(Patient, n.patient_id)
    if not patient:
        raise HTTPException(404, "Patient not found")
    settings = s.get(Settings, 1)
    appt = s.get(Appointment, n.appointment_id) if n.appointment_id else None
    pdf_bytes = services.render_prescription_pdf(
        patient,
        {
            "chief_complaint": n.chief_complaint,
            "diagnosis": n.diagnosis,
            "treatment_advised": n.treatment_advised,
            "notes": n.prescription_notes or n.notes,
            "prescriptions": _parse_rx_items(n.prescription_items),
            "appointment_date": appt.start if appt else None,
            "date": n.updated_at or n.created_at,
        },
        settings=settings,
    )
    safe_name = "".join(
        c if c.isalnum() or c in ("-", "_") else "_"
        for c in (patient.name or "patient").strip()
    )[:40] or "patient"
    filename = f"Rx_{safe_name}_{nid:05d}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


def _ensure_consult_note(
    s: Session,
    patient_id: int,
    appointment_id: Optional[int],
    invoice_id: Optional[int] = None,
) -> ConsultationNote:
    """Look up the note for this appointment (or create an empty stub) so
    every consultation has a prescription ready to fill in. Also stamps
    ``invoice_id`` if we were called from the invoice-creation path, so
    the invoice detail page can deep-link to the printable Rx."""
    n: Optional[ConsultationNote] = None
    if appointment_id:
        n = s.exec(
            select(ConsultationNote)
            .where(ConsultationNote.appointment_id == appointment_id)
            .where(ConsultationNote.deleted_at.is_(None))
        ).first()
    if n is None:
        n = ConsultationNote(
            patient_id=patient_id,
            appointment_id=appointment_id,
            invoice_id=invoice_id,
        )
        s.add(n)
        s.commit()
        s.refresh(n)
        audit_db.record(
            s, "note.auto_create", entity_type="consultation_note",
            entity_id=n.id, patient_id=patient_id,
            appointment_id=appointment_id, invoice_id=invoice_id,
        )
        s.commit()
    elif invoice_id and n.invoice_id != invoice_id:
        n.invoice_id = invoice_id
        s.add(n)
        s.commit()
        s.refresh(n)
    return n


# ==========================================================================
# Dental chart (odontogram) -------------------------------------------------
# Shown only when the doctor's specialization is dental (the frontend hides
# the tab otherwise), but the API accepts chart data for any patient so that
# a clinic can still record findings if the specialization string is tweaked.
# ==========================================================================
# FDI numbering: permanent 11-18, 21-28, 31-38, 41-48;
# deciduous 51-55, 61-65, 71-75, 81-85.
_PERMANENT_TEETH: List[str] = (
    [f"1{i}" for i in range(1, 9)]
    + [f"2{i}" for i in range(1, 9)]
    + [f"3{i}" for i in range(1, 9)]
    + [f"4{i}" for i in range(1, 9)]
)
_DECIDUOUS_TEETH: List[str] = (
    [f"5{i}" for i in range(1, 6)]
    + [f"6{i}" for i in range(1, 6)]
    + [f"7{i}" for i in range(1, 6)]
    + [f"8{i}" for i in range(1, 6)]
)
_VALID_TEETH = set(_PERMANENT_TEETH) | set(_DECIDUOUS_TEETH)


def _tooth_read(t: ToothRecord) -> ToothRecordRead:
    return ToothRecordRead(
        id=t.id, patient_id=t.patient_id, tooth_number=t.tooth_number,
        status=t.status, conditions=t.conditions, notes=t.notes,
        created_at=t.created_at, updated_at=t.updated_at,
    )


@app.get(
    "/api/patients/{pid}/dental-chart",
    response_model=List[ToothRecordRead],
)
def get_dental_chart(pid: int, s: Session = Depends(get_session)):
    """Return every tooth row we have for this patient. The frontend fills
    in the missing (healthy) slots client-side from the FDI chart so we
    only persist teeth the doctor has actually annotated."""
    if not s.get(Patient, pid):
        raise HTTPException(404, "Patient not found")
    rows = s.exec(
        select(ToothRecord)
        .where(ToothRecord.patient_id == pid)
        .where(ToothRecord.deleted_at.is_(None))
    ).all()
    return [_tooth_read(t) for t in rows]


@app.put(
    "/api/patients/{pid}/dental-chart/{tooth}",
    response_model=ToothRecordRead,
)
def upsert_tooth(
    pid: int,
    tooth: str,
    payload: ToothRecordUpsert,
    s: Session = Depends(get_session),
):
    """Upsert a single tooth record. ``tooth`` is the FDI two-digit code."""
    if not s.get(Patient, pid):
        raise HTTPException(404, "Patient not found")
    if tooth not in _VALID_TEETH:
        raise HTTPException(
            422,
            f"Invalid FDI tooth number '{tooth}'. "
            "Expected one of 11-18, 21-28, 31-38, 41-48 (adult) or "
            "51-55, 61-65, 71-75, 81-85 (deciduous).",
        )
    existing = s.exec(
        select(ToothRecord)
        .where(ToothRecord.patient_id == pid)
        .where(ToothRecord.tooth_number == tooth)
        .where(ToothRecord.deleted_at.is_(None))
    ).first()
    if existing is None:
        t = ToothRecord(
            patient_id=pid,
            tooth_number=tooth,
            status=payload.status or ToothStatus.healthy,
            conditions=payload.conditions,
            notes=payload.notes,
        )
        s.add(t)
        s.commit()
        s.refresh(t)
        audit_db.record(
            s, "dental.tooth_create", entity_type="tooth_record",
            entity_id=t.id, patient_id=pid, tooth=tooth, status=str(t.status),
        )
    else:
        if payload.status is not None:
            existing.status = payload.status
        if payload.conditions is not None:
            existing.conditions = payload.conditions
        if payload.notes is not None:
            existing.notes = payload.notes
        existing.updated_at = utcnow()
        t = existing
        s.add(t)
        s.commit()
        s.refresh(t)
        audit_db.record(
            s, "dental.tooth_update", entity_type="tooth_record",
            entity_id=t.id, patient_id=pid, tooth=tooth, status=str(t.status),
        )
    s.commit()
    return _tooth_read(t)


@app.delete("/api/patients/{pid}/dental-chart/{tooth}")
def clear_tooth(pid: int, tooth: str, s: Session = Depends(get_session)):
    """Reset a tooth to the implicit 'healthy' state by soft-deleting its row."""
    existing = s.exec(
        select(ToothRecord)
        .where(ToothRecord.patient_id == pid)
        .where(ToothRecord.tooth_number == tooth)
        .where(ToothRecord.deleted_at.is_(None))
    ).first()
    if not existing:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    existing.deleted_at = utcnow()
    s.add(existing)
    audit_db.record(
        s, "dental.tooth_clear", entity_type="tooth_record",
        entity_id=existing.id, patient_id=pid, tooth=tooth,
    )
    s.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Consultation attachments --------------------------------------------------
# Reports / scans / photos pinned to a specific note. Files are written to
# ``APP_DIR/attachments/<note_id>/<uuid><ext>``; the DB only stores metadata
# so backups stay small and files are trivially inspectable from the OS.
# ==========================================================================
# Max size is deliberately generous (25 MB) so typical DICOM JPEG stacks and
# multi-page PDFs fit, but small enough that a typo won't nuke the disk.
_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

# Explicit image allow-list. ``image/*`` would be simpler but we want to
# (a) document the supported formats on the UI, and (b) keep SVG out because
# it's basically HTML and can carry scripts.
_ALLOWED_IMAGE_MIMES = {
    "image/png",
    "image/jpeg",
    "image/jpg",            # non-standard but some browsers send it
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
    "image/heic",
    "image/heif",
    "image/heic-sequence",
    "image/heif-sequence",
}

# Some browsers (esp. Windows Chromium) don't know HEIC / HEIF and upload
# them as ``application/octet-stream``. We rescue those by sniffing the
# file extension and rewriting the mime_type so the frontend knows it's
# an image. Key = lowercase extension incl. dot, Value = canonical MIME.
_EXTENSION_MIME_OVERRIDE = {
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".pdf": "application/pdf",
}

_ALLOWED_MIME_EXACT = _ALLOWED_IMAGE_MIMES | {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
}


def _resolve_mime(declared: str, filename: Optional[str]) -> str:
    """Return the effective MIME type for this upload.

    The browser's ``content_type`` is used first, but if it's missing or
    obviously generic (``application/octet-stream``) we fall back to the
    filename extension. This fixes HEIC uploads on browsers that don't
    recognise the type natively and would otherwise send octet-stream.
    """
    declared = (declared or "").lower()
    if declared and declared != "application/octet-stream":
        return declared
    if filename:
        ext = Path(filename).suffix.lower()
        if ext in _EXTENSION_MIME_OVERRIDE:
            return _EXTENSION_MIME_OVERRIDE[ext]
    return declared or "application/octet-stream"


def _classify_mime(mime: str) -> AttachmentKind:
    if mime in _ALLOWED_IMAGE_MIMES or mime.startswith("image/"):
        return AttachmentKind.image
    if mime == "application/pdf":
        return AttachmentKind.pdf
    if mime.startswith("application/") or mime.startswith("text/"):
        return AttachmentKind.document
    return AttachmentKind.other


def _attachment_read(a: ConsultationAttachment) -> ConsultationAttachmentRead:
    return ConsultationAttachmentRead(
        id=a.id, note_id=a.note_id, patient_id=a.patient_id,
        filename=a.filename, mime_type=a.mime_type,
        size_bytes=a.size_bytes, kind=a.kind, caption=a.caption,
        uploaded_at=a.uploaded_at,
        download_url=f"/api/attachments/{a.id}/file",
    )


@app.get(
    "/api/consultation-notes/{nid}/attachments",
    response_model=List[ConsultationAttachmentRead],
)
def list_attachments(nid: int, s: Session = Depends(get_session)):
    n = s.get(ConsultationNote, nid)
    if not n or n.deleted_at is not None:
        raise HTTPException(404, "Note not found")
    rows = s.exec(
        select(ConsultationAttachment)
        .where(ConsultationAttachment.note_id == nid)
        .where(ConsultationAttachment.deleted_at.is_(None))
        .order_by(ConsultationAttachment.uploaded_at.asc())
    ).all()
    return [_attachment_read(a) for a in rows]


@app.post(
    "/api/consultation-notes/{nid}/attachments",
    response_model=ConsultationAttachmentRead,
    status_code=201,
)
def upload_attachment(
    nid: int,
    file: UploadFile = File(...),
    caption: Optional[str] = Form(None),
    s: Session = Depends(get_session),
):
    n = s.get(ConsultationNote, nid)
    if not n or n.deleted_at is not None:
        raise HTTPException(404, "Note not found")

    mime = _resolve_mime(file.content_type or "", file.filename)
    if mime not in _ALLOWED_MIME_EXACT:
        raise HTTPException(
            415,
            f"Unsupported file type '{mime}'. Allowed: images "
            "(PNG, JPEG, HEIC/HEIF, GIF, WebP, BMP, TIFF), PDF, "
            "Word/Excel, plain text / CSV.",
        )

    # Stream to disk with a hard size cap so a runaway upload can't fill the
    # disk. We write under a unique filename so two files with the same name
    # never collide, and keep the original filename in the DB for display.
    note_dir = ATTACHMENTS_DIR / str(nid)
    note_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or "").suffix[:16]  # keep extension for preview
    stored_name = f"{uuid.uuid4().hex}{suffix}"
    target_path = note_dir / stored_name

    size = 0
    try:
        with target_path.open("wb") as out:
            while True:
                chunk = file.file.read(1024 * 64)
                if not chunk:
                    break
                size += len(chunk)
                if size > _MAX_ATTACHMENT_BYTES:
                    out.close()
                    target_path.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"File too large (>{_MAX_ATTACHMENT_BYTES // (1024*1024)} MB).",
                    )
                out.write(chunk)
    except HTTPException:
        raise
    except Exception:
        target_path.unlink(missing_ok=True)
        raise

    # Relative path so backups / home-dir moves stay portable.
    rel_path = target_path.relative_to(APP_DIR).as_posix()
    filename = (file.filename or stored_name).strip() or stored_name
    # Strip any path components the browser might have included.
    filename = Path(filename).name

    att = ConsultationAttachment(
        note_id=nid,
        patient_id=n.patient_id,
        filename=filename,
        mime_type=mime,
        size_bytes=size,
        kind=_classify_mime(mime),
        storage_path=rel_path,
        caption=caption,
    )
    s.add(att)
    s.commit()
    s.refresh(att)
    audit_db.record(
        s, "attachment.upload", entity_type="consultation_attachment",
        entity_id=att.id, note_id=nid, patient_id=n.patient_id,
        filename=filename, size=size,
    )
    s.commit()
    return _attachment_read(att)


@app.get("/api/attachments/{aid}/file")
def download_attachment(aid: int, s: Session = Depends(get_session)):
    a = s.get(ConsultationAttachment, aid)
    if not a or a.deleted_at is not None:
        raise HTTPException(404, "Attachment not found")
    full_path = APP_DIR / a.storage_path
    # Defence in depth: make sure a tampered storage_path can't escape APP_DIR.
    try:
        full_path.resolve().relative_to(APP_DIR.resolve())
    except ValueError:
        raise HTTPException(404, "Attachment not found")
    if not full_path.is_file():
        raise HTTPException(404, "Attachment file missing on disk")
    return FileResponse(
        str(full_path),
        media_type=a.mime_type,
        filename=a.filename,
    )


@app.delete("/api/attachments/{aid}")
def delete_attachment(aid: int, s: Session = Depends(get_session)):
    a = s.get(ConsultationAttachment, aid)
    if not a or a.deleted_at is not None:
        raise HTTPException(404, "Attachment not found")
    a.deleted_at = utcnow()
    s.add(a)
    audit_db.record(
        s, "attachment.delete", entity_type="consultation_attachment",
        entity_id=a.id, note_id=a.note_id, patient_id=a.patient_id,
    )
    s.commit()
    # Best-effort remove from disk. Soft-delete is the source of truth for
    # undo / audit, so if the file is already gone we still 204.
    try:
        (APP_DIR / a.storage_path).unlink(missing_ok=True)
    except Exception:
        log.warning("Could not unlink attachment file %s", a.storage_path)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Treatments (flat list, either standalone or auto-created from a plan step)
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
        .where(Treatment.deleted_at.is_(None))
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
    audit_db.record(
        s, "treatment.create", entity_type="treatment", entity_id=t.id,
        summary=proc.name, patient_id=t.patient_id, procedure=proc.name, price=t.price,
    )
    s.commit()
    return _tx_read(t, proc.name)


@app.delete("/api/treatments/{tid}")
def delete_treatment(tid: int, hard: bool = False, s: Session = Depends(get_session)):
    t = s.get(Treatment, tid)
    if not t:
        raise HTTPException(404, "Treatment not found")
    pid = t.patient_id
    if hard:
        s.delete(t)
        s.commit()
        audit_db.record(s, "treatment.delete_hard", entity_type="treatment", entity_id=tid, patient_id=pid)
        s.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    audit_db.record(s, "treatment.delete", entity_type="treatment", entity_id=tid, patient_id=pid)
    return _soft_delete_response(s, "treatment", t, label=f"Treatment #{tid}")


# ==========================================================================
# Treatment plans (multi-step; e.g. RCT -> Crown)
# ==========================================================================
def _plan_read(s: Session, plan: TreatmentPlan) -> TreatmentPlanRead:
    steps_sorted = sorted(plan.steps, key=lambda x: (x.sequence, x.id or 0))
    step_reads: list[TreatmentPlanStepRead] = []
    est_total = 0.0
    act_total = 0.0
    completed = 0
    for st in steps_sorted:
        proc = s.get(Procedure, st.procedure_id) if st.procedure_id else None
        est_total += st.estimated_cost or 0
        act_total += st.actual_cost or 0
        if st.status == TreatmentStepStatus.completed:
            completed += 1
        step_reads.append(TreatmentPlanStepRead(
            id=st.id, plan_id=st.plan_id, sequence=st.sequence, title=st.title,
            procedure_id=st.procedure_id, tooth=st.tooth, status=st.status,
            estimated_cost=st.estimated_cost, actual_cost=st.actual_cost,
            planned_date=st.planned_date, completed_date=st.completed_date,
            notes=st.notes, treatment_id=st.treatment_id,
            procedure_name=proc.name if proc else None,
        ))
    return TreatmentPlanRead(
        id=plan.id, patient_id=plan.patient_id, title=plan.title,
        status=plan.status, notes=plan.notes,
        created_at=plan.created_at, updated_at=plan.updated_at,
        steps=step_reads,
        estimate_total=round(est_total, 2),
        actual_total=round(act_total, 2),
        completed_steps=completed,
        total_steps=len(step_reads),
    )


def _recompute_plan_status(plan: TreatmentPlan) -> None:
    if not plan.steps:
        return
    statuses = [st.status for st in plan.steps]
    if all(st == TreatmentStepStatus.completed for st in statuses):
        plan.status = TreatmentPlanStatus.completed
    elif any(st == TreatmentStepStatus.completed or st == TreatmentStepStatus.in_progress for st in statuses):
        if plan.status != TreatmentPlanStatus.cancelled:
            plan.status = TreatmentPlanStatus.in_progress
    else:
        if plan.status != TreatmentPlanStatus.cancelled:
            plan.status = TreatmentPlanStatus.planned
    plan.updated_at = utcnow()


@app.get("/api/patients/{pid}/treatment-plans", response_model=List[TreatmentPlanRead])
def list_treatment_plans(pid: int, s: Session = Depends(get_session)):
    rows = s.exec(
        select(TreatmentPlan)
        .where(TreatmentPlan.patient_id == pid)
        .where(TreatmentPlan.deleted_at.is_(None))
        .order_by(TreatmentPlan.created_at.desc())
    ).all()
    return [_plan_read(s, p) for p in rows]


@app.post("/api/treatment-plans", response_model=TreatmentPlanRead, status_code=201)
def create_treatment_plan(payload: TreatmentPlanCreate, s: Session = Depends(get_session)):
    if not s.get(Patient, payload.patient_id):
        raise HTTPException(400, "Invalid patient_id")
    plan = TreatmentPlan(
        patient_id=payload.patient_id,
        title=payload.title,
        notes=payload.notes,
        status=payload.status or TreatmentPlanStatus.planned,
    )
    s.add(plan)
    s.flush()
    for idx, step in enumerate(payload.steps):
        s.add(TreatmentPlanStep(
            plan_id=plan.id,
            sequence=step.sequence if step.sequence else idx,
            title=step.title,
            procedure_id=step.procedure_id,
            tooth=step.tooth,
            status=step.status or TreatmentStepStatus.planned,
            estimated_cost=step.estimated_cost or 0,
            actual_cost=step.actual_cost or 0,
            planned_date=step.planned_date,
            notes=step.notes,
        ))
    s.commit()
    s.refresh(plan)
    audit_db.record(
        s, "plan.create", entity_type="treatment_plan", entity_id=plan.id,
        summary=plan.title, patient_id=plan.patient_id, steps=len(payload.steps),
    )
    s.commit()
    return _plan_read(s, plan)


@app.get("/api/treatment-plans/{plan_id}", response_model=TreatmentPlanRead)
def get_treatment_plan(plan_id: int, s: Session = Depends(get_session)):
    plan = s.get(TreatmentPlan, plan_id)
    if not plan or plan.deleted_at is not None:
        raise HTTPException(404, "Plan not found")
    return _plan_read(s, plan)


@app.put("/api/treatment-plans/{plan_id}", response_model=TreatmentPlanRead)
def update_treatment_plan(
    plan_id: int,
    payload: TreatmentPlanUpdate,
    s: Session = Depends(get_session),
):
    plan = s.get(TreatmentPlan, plan_id)
    if not plan or plan.deleted_at is not None:
        raise HTTPException(404, "Plan not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(plan, k, v)
    plan.updated_at = utcnow()
    s.add(plan)
    s.commit()
    s.refresh(plan)
    audit_db.record(s, "plan.update", entity_type="treatment_plan", entity_id=plan.id, summary=plan.title)
    s.commit()
    return _plan_read(s, plan)


@app.delete("/api/treatment-plans/{plan_id}")
def delete_treatment_plan(plan_id: int, hard: bool = False, s: Session = Depends(get_session)):
    plan = s.get(TreatmentPlan, plan_id)
    if not plan:
        raise HTTPException(404, "Plan not found")
    if hard:
        s.delete(plan)
        s.commit()
        audit_db.record(s, "plan.delete_hard", entity_type="treatment_plan", entity_id=plan_id)
        s.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    audit_db.record(s, "plan.delete", entity_type="treatment_plan", entity_id=plan_id, summary=plan.title)
    return _soft_delete_response(s, "treatment_plan", plan, label=f"Plan {plan.title}")


@app.post("/api/treatment-plans/{plan_id}/steps", response_model=TreatmentPlanStepRead, status_code=201)
def add_plan_step(
    plan_id: int,
    payload: TreatmentPlanStepCreate,
    s: Session = Depends(get_session),
):
    plan = s.get(TreatmentPlan, plan_id)
    if not plan or plan.deleted_at is not None:
        raise HTTPException(404, "Plan not found")
    next_seq = (max((st.sequence for st in plan.steps), default=-1) + 1)
    step = TreatmentPlanStep(
        plan_id=plan_id,
        sequence=payload.sequence if payload.sequence is not None else next_seq,
        title=payload.title,
        procedure_id=payload.procedure_id,
        tooth=payload.tooth,
        estimated_cost=payload.estimated_cost or 0,
        actual_cost=payload.actual_cost or 0,
        planned_date=payload.planned_date,
        notes=payload.notes,
        status=payload.status or TreatmentStepStatus.planned,
    )
    s.add(step)
    _recompute_plan_status(plan)
    s.add(plan)
    s.commit()
    s.refresh(step)
    proc = s.get(Procedure, step.procedure_id) if step.procedure_id else None
    audit_db.record(s, "plan.step.add", entity_type="treatment_plan", entity_id=plan_id,
                    step_id=step.id, title=step.title)
    s.commit()
    return TreatmentPlanStepRead(
        id=step.id, plan_id=step.plan_id, sequence=step.sequence, title=step.title,
        procedure_id=step.procedure_id, tooth=step.tooth, status=step.status,
        estimated_cost=step.estimated_cost, actual_cost=step.actual_cost,
        planned_date=step.planned_date, completed_date=step.completed_date,
        notes=step.notes, treatment_id=step.treatment_id,
        procedure_name=proc.name if proc else None,
    )


@app.put(
    "/api/treatment-plans/{plan_id}/steps/{step_id}",
    response_model=TreatmentPlanStepRead,
)
def update_plan_step_nested(
    plan_id: int,
    step_id: int,
    payload: TreatmentPlanStepUpdate,
    s: Session = Depends(get_session),
):
    return update_plan_step(step_id, payload, s)


@app.delete(
    "/api/treatment-plans/{plan_id}/steps/{step_id}", status_code=204,
)
def delete_plan_step_nested(
    plan_id: int, step_id: int, s: Session = Depends(get_session),
):
    return delete_plan_step(step_id, s)


@app.post(
    "/api/treatment-plans/{plan_id}/steps/{step_id}/complete",
    response_model=TreatmentPlanStepRead,
)
def complete_plan_step_nested(
    plan_id: int, step_id: int, s: Session = Depends(get_session),
):
    return complete_plan_step(step_id, s)


@app.put("/api/plan-steps/{step_id}", response_model=TreatmentPlanStepRead)
def update_plan_step(
    step_id: int,
    payload: TreatmentPlanStepUpdate,
    s: Session = Depends(get_session),
):
    step = s.get(TreatmentPlanStep, step_id)
    if not step:
        raise HTTPException(404, "Step not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(step, k, v)
    s.add(step)
    plan = s.get(TreatmentPlan, step.plan_id)
    if plan:
        _recompute_plan_status(plan)
        s.add(plan)
    s.commit()
    s.refresh(step)
    proc = s.get(Procedure, step.procedure_id) if step.procedure_id else None
    audit_db.record(s, "plan.step.update", entity_type="treatment_plan",
                    entity_id=step.plan_id, step_id=step.id)
    s.commit()
    return TreatmentPlanStepRead(
        id=step.id, plan_id=step.plan_id, sequence=step.sequence, title=step.title,
        procedure_id=step.procedure_id, tooth=step.tooth, status=step.status,
        estimated_cost=step.estimated_cost, actual_cost=step.actual_cost,
        planned_date=step.planned_date, completed_date=step.completed_date,
        notes=step.notes, treatment_id=step.treatment_id,
        procedure_name=proc.name if proc else None,
    )


@app.delete("/api/plan-steps/{step_id}", status_code=204)
def delete_plan_step(step_id: int, s: Session = Depends(get_session)):
    step = s.get(TreatmentPlanStep, step_id)
    if not step:
        raise HTTPException(404, "Step not found")
    plan_id = step.plan_id
    s.delete(step)
    plan = s.get(TreatmentPlan, plan_id)
    if plan:
        _recompute_plan_status(plan)
        s.add(plan)
    s.commit()
    audit_db.record(s, "plan.step.delete", entity_type="treatment_plan",
                    entity_id=plan_id, step_id=step_id)
    s.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/plan-steps/{step_id}/complete", response_model=TreatmentPlanStepRead)
def complete_plan_step(step_id: int, s: Session = Depends(get_session)):
    """Mark a step completed and create the corresponding Treatment row."""
    step = s.get(TreatmentPlanStep, step_id)
    if not step:
        raise HTTPException(404, "Step not found")
    plan = s.get(TreatmentPlan, step.plan_id)
    if not plan:
        raise HTTPException(404, "Plan not found")

    if step.status != TreatmentStepStatus.completed:
        step.status = TreatmentStepStatus.completed
        step.completed_date = date.today()
        # Create a Treatment row only if one isn't linked yet and a procedure
        # is known — treatments power the "top procedures" report.
        if not step.treatment_id and step.procedure_id:
            tx = Treatment(
                patient_id=plan.patient_id,
                procedure_id=step.procedure_id,
                tooth=step.tooth,
                notes=f"Plan: {plan.title} / Step: {step.title}",
                price=step.actual_cost or step.estimated_cost or 0,
                performed_on=date.today(),
            )
            s.add(tx)
            s.flush()
            step.treatment_id = tx.id
            if not step.actual_cost:
                step.actual_cost = tx.price
        s.add(step)
        _recompute_plan_status(plan)
        s.add(plan)
        s.commit()
        s.refresh(step)
        audit_db.record(s, "plan.step.complete", entity_type="treatment_plan",
                        entity_id=plan.id, step_id=step.id)
        s.commit()

    proc = s.get(Procedure, step.procedure_id) if step.procedure_id else None
    return TreatmentPlanStepRead(
        id=step.id, plan_id=step.plan_id, sequence=step.sequence, title=step.title,
        procedure_id=step.procedure_id, tooth=step.tooth, status=step.status,
        estimated_cost=step.estimated_cost, actual_cost=step.actual_cost,
        planned_date=step.planned_date, completed_date=step.completed_date,
        notes=step.notes, treatment_id=step.treatment_id,
        procedure_name=proc.name if proc else None,
    )


# ==========================================================================
# Invoices
# ==========================================================================
def _invoice_to_read(inv: Invoice, patient_name: Optional[str]) -> InvoiceRead:
    subtotal = sum(i.quantity * i.unit_price for i in inv.items)
    return InvoiceRead(
        id=inv.id, patient_id=inv.patient_id, appointment_id=inv.appointment_id,
        total=inv.total, paid=inv.paid, discount_amount=inv.discount_amount or 0,
        status=inv.status, notes=inv.notes,
        created_at=inv.created_at, patient_name=patient_name,
        items=list(inv.items),
        payments=[p for p in inv.payments if getattr(p, "deleted_at", None) is None],
        subtotal=round(subtotal, 2),
        balance=round((inv.total or 0) - (inv.paid or 0), 2),
    )


def _recompute_invoice(inv: Invoice) -> None:
    subtotal = sum(i.quantity * i.unit_price for i in inv.items)
    discount = float(inv.discount_amount or 0.0)
    inv.total = round(max(subtotal - discount, 0.0), 2)
    inv.paid = round(
        sum(p.amount for p in inv.payments if getattr(p, "deleted_at", None) is None),
        2,
    )
    if inv.paid <= 0:
        inv.status = InvoiceStatus.unpaid
    elif inv.paid + 1e-6 < inv.total:
        inv.status = InvoiceStatus.partial
    else:
        inv.status = InvoiceStatus.paid


@app.get("/api/invoices", response_model=List[InvoiceRead])
def list_invoices(
    pending_only: bool = False,
    patient_id: Optional[int] = None,
    s: Session = Depends(get_session),
):
    stmt = (
        select(Invoice, Patient)
        .join(Patient, isouter=True)
        .where(Invoice.deleted_at.is_(None))
        .order_by(Invoice.created_at.desc())
    )
    if pending_only:
        stmt = stmt.where(Invoice.status != InvoiceStatus.paid)
    if patient_id:
        stmt = stmt.where(Invoice.patient_id == patient_id)
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
        discount_amount=payload.discount_amount or 0,
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
    # Every consultation must have a prescription attached to it — this is
    # the standard doctor workflow ("consultation -> bill -> Rx"). Only
    # applies when the invoice is tied to an appointment; walk-in /
    # standalone bills skip the Rx stub (no visit to prescribe against).
    if inv.appointment_id:
        _ensure_consult_note(
            s, inv.patient_id, inv.appointment_id, invoice_id=inv.id,
        )
    audit_db.record(
        s, "invoice.create", entity_type="invoice", entity_id=inv.id,
        summary=f"#{inv.id:05d}" + (f" · {p.name}" if p else ""),
        patient_id=inv.patient_id, items=len(inv.items), total=inv.total,
    )
    s.commit()
    return _invoice_to_read(inv, p.name if p else None)


@app.put("/api/invoices/{iid}", response_model=InvoiceRead)
def update_invoice(iid: int, payload: InvoiceUpdate, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv or inv.deleted_at is not None:
        raise HTTPException(404, "Invoice not found")
    data = payload.model_dump(exclude_unset=True)
    if "notes" in data:
        inv.notes = data["notes"]
    if "discount_amount" in data:
        inv.discount_amount = data["discount_amount"] or 0
    if "items" in data and data["items"] is not None:
        # Replace line items wholesale — simpler than diffing.
        for existing in list(inv.items):
            s.delete(existing)
        s.flush()
        inv.items = []
        for it in data["items"]:
            inv.items.append(InvoiceItem(
                procedure_id=it.get("procedure_id"),
                description=it["description"],
                quantity=it.get("quantity", 1),
                unit_price=it.get("unit_price", 0),
            ))
    _recompute_invoice(inv)
    s.add(inv)
    s.commit()
    s.refresh(inv)
    p = s.get(Patient, inv.patient_id)
    audit_db.record(s, "invoice.update", entity_type="invoice", entity_id=inv.id)
    s.commit()
    return _invoice_to_read(inv, p.name if p else None)


@app.get("/api/invoices/{iid}", response_model=InvoiceRead)
def get_invoice(iid: int, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv or inv.deleted_at is not None:
        raise HTTPException(404, "Invoice not found")
    p = s.get(Patient, inv.patient_id)
    return _invoice_to_read(inv, p.name if p else None)


def _find_invoice_note(s: Session, inv: Invoice) -> Optional[ConsultationNote]:
    """Return the consultation note linked to ``inv`` via either the
    direct ``invoice_id`` back-reference or the shared appointment id.
    Soft-deleted notes are ignored. Shared by the JSON endpoint and the
    printable invoice renderers so both surface the same Rx."""
    n = s.exec(
        select(ConsultationNote)
        .where(ConsultationNote.invoice_id == inv.id)
        .where(ConsultationNote.deleted_at.is_(None))
    ).first()
    if not n and inv.appointment_id:
        n = s.exec(
            select(ConsultationNote)
            .where(ConsultationNote.appointment_id == inv.appointment_id)
            .where(ConsultationNote.deleted_at.is_(None))
        ).first()
    return n


def _note_to_render_data(n: ConsultationNote) -> dict:
    """Flatten a ``ConsultationNote`` row into the plain dict expected by
    ``services.render_prescription_*`` and the invoice render helpers."""
    return {
        "chief_complaint": n.chief_complaint,
        "diagnosis": n.diagnosis,
        "treatment_advised": n.treatment_advised,
        "notes": n.prescription_notes or n.notes,
        "prescriptions": _parse_rx_items(n.prescription_items),
        "date": n.updated_at or n.created_at,
    }


@app.get(
    "/api/invoices/{iid}/note",
    response_model=Optional[ConsultationNoteRead],
)
def get_invoice_note(iid: int, s: Session = Depends(get_session)):
    """Return the consultation note linked to this invoice, if any.

    Matches either direction of the relationship so the invoice page can
    deep-link to the printable Rx regardless of how the link was made:
      - note.invoice_id == iid (standalone Rx linked directly), OR
      - note.appointment_id == inv.appointment_id (walk-up visit + bill).
    """
    inv = s.get(Invoice, iid)
    if not inv or inv.deleted_at is not None:
        raise HTTPException(404, "Invoice not found")
    n = _find_invoice_note(s, inv)
    if not n:
        return None
    patient = s.get(Patient, n.patient_id)
    read = _note_read(s, n)
    if patient:
        read.patient_name = patient.name
    return read


@app.delete("/api/invoices/{iid}")
def delete_invoice(iid: int, hard: bool = False, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv:
        raise HTTPException(404, "Invoice not found")
    pid = inv.patient_id
    total = inv.total
    if hard:
        s.delete(inv)
        s.commit()
        audit_db.record(s, "invoice.delete_hard", entity_type="invoice", entity_id=iid,
                        patient_id=pid, total=total)
        s.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    audit_db.record(s, "invoice.delete", entity_type="invoice", entity_id=iid,
                    patient_id=pid, total=total)
    return _soft_delete_response(s, "invoice", inv, label=f"Invoice #{iid:05d}")


@app.get("/api/invoices/{iid}/pdf")
def invoice_pdf(iid: int, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv or inv.deleted_at is not None:
        raise HTTPException(404, "Invoice not found")
    patient = s.get(Patient, inv.patient_id)
    settings = s.get(Settings, 1)
    # Pull the linked consultation note (if any) so the printed invoice
    # can include the prescription the patient takes home. Mirrors the
    # logic of /api/invoices/{iid}/note so doctors aren't surprised by
    # which Rx shows up on which invoice.
    note = _find_invoice_note(s, inv)
    note_data = _note_to_render_data(note) if note else None
    pdf = services.render_invoice_pdf(
        inv, patient, inv.items,
        payments=inv.payments, settings=settings,
        note_data=note_data,
    )
    log.info("Generated invoice PDF id=%d size=%dB", iid, len(pdf))
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="invoice-{inv.id:05d}.pdf"'},
    )


@app.get("/api/invoices/{iid}/print", response_class=HTMLResponse)
def invoice_print(iid: int, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv or inv.deleted_at is not None:
        raise HTTPException(404, "Invoice not found")
    patient = s.get(Patient, inv.patient_id)
    settings = s.get(Settings, 1)
    note = _find_invoice_note(s, inv)
    note_data = _note_to_render_data(note) if note else None
    html_doc = services.render_invoice_html(
        inv, patient, inv.items,
        payments=inv.payments, settings=settings,
        note_data=note_data,
    )
    return HTMLResponse(content=html_doc)


# ==========================================================================
# Payments
# ==========================================================================
@app.post("/api/invoices/{iid}/payments", response_model=PaymentRead, status_code=201)
def add_payment(iid: int, payload: PaymentCreate, s: Session = Depends(get_session)):
    inv = s.get(Invoice, iid)
    if not inv or inv.deleted_at is not None:
        raise HTTPException(404, "Invoice not found")
    pay = Payment(
        invoice_id=iid,
        amount=payload.amount,
        method=payload.method,
        reference=payload.reference,
        paid_on=payload.paid_on or utcnow(),
    )
    # Let SQLModel's back-populate handle the relationship — adding via both
    # ``session.add`` *and* ``inv.payments.append`` double-counted the payment.
    s.add(pay)
    s.flush()
    s.refresh(inv)
    _recompute_invoice(inv)
    s.add(inv)
    s.commit()
    s.refresh(pay)
    audit_db.record(
        s, "payment.add", entity_type="payment", entity_id=pay.id,
        summary=f"Invoice #{iid:05d}",
        invoice_id=iid, amount=pay.amount,
        method=pay.method.value if hasattr(pay.method, "value") else pay.method,
        paid_on=pay.paid_on.isoformat() if pay.paid_on else None,
        new_status=inv.status.value if hasattr(inv.status, "value") else inv.status,
    )
    s.commit()
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
    audit_db.record(s, "payment.delete", entity_type="payment", entity_id=pid,
                    invoice_id=iid, amount=amount)
    s.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Undo (soft-deleted entities)
# ==========================================================================
_UNDOABLE_MODELS = {
    "patient": Patient,
    "appointment": Appointment,
    "treatment": Treatment,
    "invoice": Invoice,
    "treatment_plan": TreatmentPlan,
    "consultation_note": ConsultationNote,
}


@app.post("/api/undo/{token}")
def undo(token: str, s: Session = Depends(get_session)):
    entry = undo_buffer.pop(token)
    if not entry:
        raise HTTPException(410, "Undo expired or unknown token")
    model = _UNDOABLE_MODELS.get(entry.entity_type)
    if not model:
        raise HTTPException(400, f"Cannot undo {entry.entity_type}")
    row = s.get(model, entry.entity_id)
    if not row:
        raise HTTPException(404, "Entity no longer exists")
    row.deleted_at = None
    s.add(row)
    s.commit()
    audit_db.record(s, "undo", entity_type=entry.entity_type, entity_id=entry.entity_id,
                    summary=entry.label)
    s.commit()
    return {"ok": True, "entity_type": entry.entity_type, "entity_id": entry.entity_id}


# ==========================================================================
# Audit log
# ==========================================================================
@app.get("/api/audit", response_model=List[AuditLogRead])
def list_audit(
    entity_type: Optional[str] = None,
    action: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(default=200, le=1000),
    offset: int = 0,
    s: Session = Depends(get_session),
):
    rows = audit_db.query(
        s, entity_type=entity_type, action=action, q=q,
        limit=limit, offset=offset,
    )
    return [
        AuditLogRead(
            id=r.id, action=r.action, entity_type=r.entity_type,
            entity_id=r.entity_id, summary=r.summary, details_json=r.details_json,
            actor=r.actor, created_at=r.created_at,
        )
        for r in rows
    ]


# ==========================================================================
# Search
# ==========================================================================
@app.get("/api/search")
def global_search(
    q: str = Query(..., min_length=1),
    limit: int = 10,
    s: Session = Depends(get_session),
):
    """Search across patients, invoices, treatments, and consult notes.
    Phone matches bubble to the top when the query is mostly digits."""
    like = f"%{q}%"
    digits = "".join(ch for ch in q if ch.isdigit())
    mostly_digits = len(digits) >= 3 and len(digits) >= len(q) - 2

    patients = s.exec(
        select(Patient)
        .where(Patient.deleted_at.is_(None))
        .where((Patient.name.ilike(like)) | (Patient.phone.ilike(like)))
        .limit(limit)
    ).all()
    p_results = [
        {
            "type": "patient", "id": p.id, "title": p.name,
            "subtitle": p.phone or p.email or "",
            "match_phone": bool(p.phone and digits and digits in p.phone),
        }
        for p in patients
    ]

    # Invoice: match on invoice id (zero-padded), notes, patient name.
    inv_q = (
        select(Invoice, Patient)
        .join(Patient, isouter=True)
        .where(Invoice.deleted_at.is_(None))
        .limit(limit)
    )
    try:
        iid = int(q)
        inv_q_id = inv_q.where(Invoice.id == iid)
        inv_rows = list(s.exec(inv_q_id).all())
    except ValueError:
        inv_rows = []
    inv_rows += list(s.exec(
        inv_q.where(
            (Invoice.notes.ilike(like))
            | (Patient.name.ilike(like))
        )
    ).all())
    # De-dup by invoice id.
    seen: set[int] = set()
    inv_results = []
    for inv, p in inv_rows:
        if inv.id in seen:
            continue
        seen.add(inv.id)
        inv_results.append({
            "type": "invoice",
            "id": inv.id,
            "title": f"Invoice #{inv.id:05d}",
            "subtitle": f"{p.name if p else '—'} · ₹ {inv.total:,.2f}",
            "match_phone": False,
        })

    tx_rows = s.exec(
        select(Treatment, Procedure, Patient)
        .join(Procedure, isouter=True)
        .join(Patient, isouter=True)
        .where(Treatment.deleted_at.is_(None))
        .where(
            (Procedure.name.ilike(like))
            | (Treatment.notes.ilike(like))
            | (Treatment.tooth.ilike(like))
            | (Patient.name.ilike(like))
        )
        .limit(limit)
    ).all()
    tx_results = [
        {
            "type": "treatment", "id": t.id,
            "title": (pr.name if pr else "Treatment") + (f" · Tooth {t.tooth}" if t.tooth else ""),
            "subtitle": pa.name if pa else "",
            "match_phone": False,
            "patient_id": t.patient_id,
        }
        for t, pr, pa in tx_rows
    ]

    note_rows = s.exec(
        select(ConsultationNote, Patient)
        .join(Patient, isouter=True)
        .where(ConsultationNote.deleted_at.is_(None))
        .where(
            (ConsultationNote.chief_complaint.ilike(like))
            | (ConsultationNote.diagnosis.ilike(like))
            | (ConsultationNote.notes.ilike(like))
        )
        .limit(limit)
    ).all()
    note_results = [
        {
            "type": "note", "id": n.id,
            "title": (n.chief_complaint or n.diagnosis or "Consult note")[:80],
            "subtitle": pa.name if pa else "",
            "match_phone": False,
            "patient_id": n.patient_id,
            "appointment_id": n.appointment_id,
        }
        for n, pa in note_rows
    ]

    all_results = p_results + inv_results + tx_results + note_results
    if mostly_digits:
        all_results.sort(key=lambda r: (0 if r.get("match_phone") else 1))

    return all_results


# ==========================================================================
# Reports
# ==========================================================================
def _csv_response(csv_text: str, filename: str) -> Response:
    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _parse_date(s: str, field: str) -> date:
    from datetime import date as _date
    try:
        return _date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"Invalid {field} — use YYYY-MM-DD")


def _iterate_days(start_d: _date, end_d: _date):
    cur = start_d
    while cur <= end_d:
        yield cur
        cur = cur + timedelta(days=1)


def _daily_range_rows(
    session: Session, start_d: _date, end_d: _date,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for d in _iterate_days(start_d, end_d):
        res = reports_svc.daily_collections(session, d)
        if res["count"] > 0 or res["total"] > 0:
            rows.append({
                "date": res["date"],
                "amount": res["total"],
                "count": res["count"],
                "by_method": res["by_method"],
            })
    return rows


@app.get("/api/reports/daily-collections")
def report_daily_collections(
    day: Optional[str] = Query(None, description="YYYY-MM-DD"),
    start: Optional[str] = Query(None, description="YYYY-MM-DD"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD"),
    s: Session = Depends(get_session),
):
    if day:
        return reports_svc.daily_collections(s, _parse_date(day, "day"))
    if start and end:
        return _daily_range_rows(
            s, _parse_date(start, "start"), _parse_date(end, "end"),
        )
    # Default: today (single-day shape).
    return reports_svc.daily_collections(s, datetime.utcnow().date())


@app.get("/api/reports/daily-collections.csv")
def report_daily_collections_csv(
    start: Optional[str] = None,
    end: Optional[str] = None,
    day: Optional[str] = None,
    s: Session = Depends(get_session),
):
    if day:
        res = reports_svc.daily_collections(s, _parse_date(day, "day"))
        csv_text = reports_svc.rows_to_csv(
            res["rows"],
            ["payment_id", "invoice_id", "patient", "amount", "method",
             "paid_on", "reference"],
        )
        return _csv_response(csv_text, f"daily-collections-{day}.csv")
    if not (start and end):
        raise HTTPException(400, "Provide ?day= or ?start=&end=")
    rows = _daily_range_rows(s, _parse_date(start, "start"), _parse_date(end, "end"))
    return _csv_response(
        reports_svc.rows_to_csv(rows, ["date", "amount", "count"]),
        f"daily-collections-{start}-to-{end}.csv",
    )


@app.get("/api/reports/monthly-revenue")
def report_monthly_revenue(
    month: str = Query(..., description="YYYY-MM"),
    s: Session = Depends(get_session),
):
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(400, "Invalid month — use YYYY-MM")
    return reports_svc.monthly_revenue(s, month)


@app.get("/api/reports/monthly-revenue.csv")
def report_monthly_revenue_csv(
    month: str = Query(...),
    s: Session = Depends(get_session),
):
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(400, "Invalid month — use YYYY-MM")
    data = reports_svc.monthly_revenue(s, month)
    return _csv_response(
        reports_svc.rows_to_csv(data["days"], ["date", "amount", "count"]),
        f"monthly-revenue-{month}.csv",
    )


@app.get("/api/reports/pending-dues")
def report_pending_dues(s: Session = Depends(get_session)):
    # Return the flat row list for the UI; totals can be derived client-side.
    return reports_svc.pending_dues(s)["rows"]


@app.get("/api/reports/pending-dues.csv")
def report_pending_dues_csv(s: Session = Depends(get_session)):
    data = reports_svc.pending_dues(s)
    return _csv_response(
        reports_svc.rows_to_csv(
            data["rows"],
            ["invoice_id", "patient_name", "phone", "total", "paid", "balance",
             "status", "days_outstanding", "created_at"],
        ),
        "pending-dues.csv",
    )


@app.get("/api/reports/top-procedures")
def report_top_procedures(
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 20,
    s: Session = Depends(get_session),
):
    ds = _parse_date(start, "start") if start else None
    de = _parse_date(end, "end") if end else None
    return reports_svc.top_procedures(
        s, limit=limit, date_from=ds, date_to=de,
    )["rows"]


@app.get("/api/reports/top-procedures.csv")
def report_top_procedures_csv(
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 50,
    s: Session = Depends(get_session),
):
    ds = _parse_date(start, "start") if start else None
    de = _parse_date(end, "end") if end else None
    data = reports_svc.top_procedures(
        s, limit=limit, date_from=ds, date_to=de,
    )
    return _csv_response(
        reports_svc.rows_to_csv(data["rows"], ["name", "count", "revenue"]),
        "top-procedures.csv",
    )


# ==========================================================================
# Dashboard summary
# ==========================================================================
@app.get("/api/dashboard")
def dashboard(s: Session = Depends(get_session)):
    today_start = datetime.combine(datetime.today().date(), datetime.min.time())
    today_end = today_start + timedelta(days=1)

    patients = s.exec(select(Patient).where(Patient.deleted_at.is_(None))).all()
    today_appts = s.exec(
        select(Appointment)
        .where(Appointment.deleted_at.is_(None))
        .where(Appointment.start >= today_start, Appointment.start < today_end)
    ).all()
    invoices = s.exec(select(Invoice).where(Invoice.deleted_at.is_(None))).all()
    pending = [i for i in invoices if i.status != InvoiceStatus.paid]
    dues = sum(i.total - i.paid for i in pending)
    month_start = today_start.replace(day=1)
    month_revenue = sum(
        p.amount for p in s.exec(
            select(Payment)
            .where(Payment.deleted_at.is_(None))
            .where(Payment.paid_on >= month_start)
        ).all()
    )

    # Lifecycle breakdown: how many patients have pending treatment steps?
    pending_treatment_patients = 0
    for p in patients:
        _, _, pend = services.compute_patient_lifecycle(s, p.id)
        if pend > 0:
            pending_treatment_patients += 1

    return {
        "patients": len(patients),
        "today_appointments": len(today_appts),
        "pending_invoices": len(pending),
        "pending_dues": round(dues, 2),
        "month_revenue": round(month_revenue, 2),
        "pending_treatment_patients": pending_treatment_patients,
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
    with Session(engine) as s:
        audit_db.record(s, "backup.manual", entity_type="backup", summary=path.name, name=path.name)
        s.commit()
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
    with Session(engine) as s:
        audit_db.record(s, "backup.delete", entity_type="backup", summary=name, name=name)
        s.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==========================================================================
# Settings (singleton doctor / clinic profile)
# ==========================================================================
def _get_or_create_settings(s: Session) -> Settings:
    row = s.get(Settings, 1)
    if row is None:
        row = Settings(id=1)
        s.add(row)
        s.commit()
        s.refresh(row)
    return row


@app.get("/api/settings", response_model=SettingsRead)
def get_settings(s: Session = Depends(get_session)):
    return _get_or_create_settings(s)


@app.put("/api/settings", response_model=SettingsRead)
def update_settings(payload: SettingsUpdate, s: Session = Depends(get_session)):
    row = _get_or_create_settings(s)
    changed = []
    for k, v in payload.model_dump(exclude_unset=True).items():
        if getattr(row, k, None) != v:
            setattr(row, k, v)
            changed.append(k)
    if changed:
        row.updated_at = utcnow()
        # Stamp onboarded_at the first time the doctor supplies their name+specialty
        # from the onboarding flow.
        if row.doctor_name and row.specialization and not row.onboarded_at:
            row.onboarded_at = utcnow()
        s.add(row)
        s.commit()
        s.refresh(row)
        audit_db.record(s, "settings.update", entity_type="settings",
                        summary=",".join(changed), fields=",".join(changed))
        s.commit()
    return row


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
        "version": APP_VERSION,
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
        audit_db.record(s, "demo.seed", entity_type="demo",
                        **{k: v for k, v in result.items() if k != "created"})
        s.commit()
    return result


@app.post("/api/demo/clear")
def demo_clear(s: Session = Depends(get_session)):
    result = demo_svc.clear_demo(s)
    audit_db.record(s, "demo.clear", entity_type="demo",
                    **{k: v for k, v in result.items() if k != "cleared"})
    s.commit()
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
