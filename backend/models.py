"""SQLModel models. Each class is both an ORM table and a Pydantic schema,
with small `*Create` / `*Read` variants where the shape differs from the table.

NOTE: We intentionally do NOT use `from __future__ import annotations` here.
SQLModel 0.0.22's relationship-detection code inspects runtime types, and
PEP 563 string annotations break its `List["X"]` unwrapping — you'd get
"seems to be using a generic class as the argument to relationship()".
"""
from datetime import datetime, date, timezone
from enum import Enum
from typing import Optional, List

from sqlmodel import SQLModel, Field, Relationship

from backend.pydantic_compat import field_validator, model_rebuild


def utcnow() -> datetime:
    """UTC "now" as a tz-aware datetime. Using tz-aware datetimes means
    FastAPI serializes them as ISO strings with a `+00:00` / `Z` suffix so the
    browser parses them unambiguously — fixes the calendar event-shift bug."""
    return datetime.now(timezone.utc)


def _as_utc(v):
    """Attach UTC tzinfo to naive datetimes. SQLite strips timezone on
    round-trip, so `start`/`end` come back naive even though they were sent
    from the browser in UTC. Without this, FastAPI serializes them without a
    `Z` suffix and the browser re-parses them as *local* time, shifting every
    appointment by the user's UTC offset."""
    if isinstance(v, datetime) and v.tzinfo is None:
        return v.replace(tzinfo=timezone.utc)
    return v


# ---------- Enums ----------
class AppointmentStatus(str, Enum):
    scheduled = "scheduled"
    completed = "completed"
    cancelled = "cancelled"
    no_show = "no_show"


class InvoiceStatus(str, Enum):
    unpaid = "unpaid"
    partial = "partial"
    paid = "paid"


class PaymentMethod(str, Enum):
    cash = "cash"
    upi = "upi"
    card = "card"


class TreatmentPlanStatus(str, Enum):
    planned = "planned"
    in_progress = "in_progress"
    completed = "completed"
    cancelled = "cancelled"


class TreatmentStepStatus(str, Enum):
    planned = "planned"
    in_progress = "in_progress"
    completed = "completed"
    skipped = "skipped"


class PatientLifecycle(str, Enum):
    new = "new"
    consulted = "consulted"
    planned = "planned"
    in_progress = "in_progress"
    completed = "completed"
    no_show = "no_show"


# ---------- Patient ----------
class Gender(str, Enum):
    """Patient gender. Kept optional so existing records without it still work.
    Used by specialty-aware patient filtering (e.g. a Gynaecologist only sees
    female patients, an Andrologist only male)."""
    male = "male"
    female = "female"
    other = "other"


class PatientBase(SQLModel):
    name: str
    # Legacy `age` kept for back-compat with records entered before DOB was a
    # field. New records should prefer `date_of_birth` and let the UI compute
    # the current age from it — ages change, birth dates don't.
    age: Optional[int] = None
    # ISO date (YYYY-MM-DD). Source of truth for age / pediatric / geriatric
    # relevance filters.
    date_of_birth: Optional[date] = None
    gender: Optional[Gender] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    medical_history: Optional[str] = None
    dental_history: Optional[str] = None
    allergies: Optional[str] = None
    notes: Optional[str] = None


class Patient(PatientBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)
    deleted_at: Optional[datetime] = Field(default=None, index=True)

    appointments: List["Appointment"] = Relationship(back_populates="patient")
    treatments: List["Treatment"] = Relationship(back_populates="patient")
    invoices: List["Invoice"] = Relationship(back_populates="patient")


class PatientCreate(PatientBase):
    pass


class PatientRead(PatientBase):
    id: int
    created_at: datetime
    lifecycle: Optional[PatientLifecycle] = None
    last_visit: Optional[datetime] = None
    pending_steps: int = 0


# ---------- Procedure (catalog item with default price) ----------
class ProcedureBase(SQLModel):
    name: str
    description: Optional[str] = None
    default_price: float = 0.0
    # Clinical specialization. Kept free-text so we don't lock the doctor
    # into a hard-coded list, but the frontend suggests common values
    # (Dental, Gastroenterology, General, ENT, ...).
    category: Optional[str] = None
    # Typical chair/room time for scheduling auto-fill. Default 30 min.
    default_duration_minutes: int = 30


class Procedure(ProcedureBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class ProcedureCreate(ProcedureBase):
    pass


class ProcedureRead(ProcedureBase):
    id: int


# ---------- Room (chair / consultation room) ----------
class RoomBase(SQLModel):
    name: str
    active: bool = True


class Room(RoomBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class RoomCreate(RoomBase):
    pass


class RoomRead(RoomBase):
    id: int


# ---------- Doctor availability (one row per weekday, 0=Mon..6=Sun) ----------
class DoctorAvailabilityBase(SQLModel):
    weekday: int = Field(ge=0, le=6)
    is_working: bool = True
    # HH:MM strings — easier to reason about than time objects over JSON.
    start_time: str = "09:00"
    end_time: str = "18:00"
    break_start: Optional[str] = None
    break_end: Optional[str] = None


class DoctorAvailability(DoctorAvailabilityBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class DoctorAvailabilityRead(DoctorAvailabilityBase):
    id: int


# ---------- Appointment ----------
class AppointmentBase(SQLModel):
    patient_id: int = Field(foreign_key="patient.id")
    start: datetime
    end: datetime
    status: AppointmentStatus = AppointmentStatus.scheduled
    chief_complaint: Optional[str] = None
    notes: Optional[str] = None
    reminder_sent: bool = False
    procedure_id: Optional[int] = Field(default=None, foreign_key="procedure.id")
    room_id: Optional[int] = Field(default=None, foreign_key="room.id")

    @field_validator("start", "end", mode="after")
    @classmethod
    def _coerce_start_end_utc(cls, v: datetime) -> datetime:
        return _as_utc(v)


class Appointment(AppointmentBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)
    deleted_at: Optional[datetime] = Field(default=None, index=True)

    patient: Optional[Patient] = Relationship(back_populates="appointments")
    treatments: List["Treatment"] = Relationship(back_populates="appointment")


class AppointmentCreate(AppointmentBase):
    pass


class AppointmentRead(AppointmentBase):
    id: int
    created_at: datetime
    patient_name: Optional[str] = None
    procedure_name: Optional[str] = None
    room_name: Optional[str] = None

    # Ensure datetimes are always tz-aware before serialization so the browser
    # renders them at the correct hour regardless of its local timezone.
    @field_validator("created_at", "start", "end", mode="before")
    @classmethod
    def _coerce_dt_utc(cls, v):
        return _as_utc(v)


class AppointmentReschedule(SQLModel):
    start: datetime
    end: datetime
    room_id: Optional[int] = None


# ---------- ConsultationNote (structured, per-visit) ----------
class ConsultationNoteBase(SQLModel):
    patient_id: int = Field(foreign_key="patient.id")
    appointment_id: Optional[int] = Field(
        default=None, foreign_key="appointment.id", unique=True
    )
    chief_complaint: Optional[str] = None
    diagnosis: Optional[str] = None
    treatment_advised: Optional[str] = None
    notes: Optional[str] = None
    # Structured prescription -- stored as a JSON-encoded list of rows
    # ``[{drug, strength, frequency, duration, instructions}]``. Kept as a
    # TEXT blob so SQLite stays portable and we don't force a separate
    # prescription_item table for what is logically an ordered list. A
    # free-text ``prescription_notes`` captures Rx-specific advice that
    # shouldn't pollute the general "notes" field (e.g. "avoid dairy for
    # 48 hours").
    prescription_items: Optional[str] = None
    prescription_notes: Optional[str] = None
    # Link to the invoice generated for this visit so the Rx can be
    # reached one click away from the bill. Deliberately a loose int
    # (no FK) so hard-deleting the invoice doesn't cascade-block the note
    # — the UI already tolerates a dangling ID by falling back to the
    # "create Rx" affordance.
    invoice_id: Optional[int] = None


class ConsultationNote(ConsultationNoteBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    deleted_at: Optional[datetime] = Field(default=None, index=True)


class ConsultationNoteCreate(ConsultationNoteBase):
    pass


class ConsultationNoteUpdate(SQLModel):
    chief_complaint: Optional[str] = None
    diagnosis: Optional[str] = None
    treatment_advised: Optional[str] = None
    notes: Optional[str] = None
    prescription_items: Optional[str] = None
    prescription_notes: Optional[str] = None
    invoice_id: Optional[int] = None


class ConsultationNoteRead(ConsultationNoteBase):
    id: int
    created_at: datetime
    updated_at: datetime
    appointment_start: Optional[datetime] = None
    # Populated by the global listing endpoint so the UI can show the
    # patient name without an N+1 fetch. Per-patient endpoints leave this
    # empty since the page already knows the patient.
    patient_name: Optional[str] = None


# ---------- Treatment (procedure performed on a patient) ----------
class TreatmentBase(SQLModel):
    patient_id: int = Field(foreign_key="patient.id")
    appointment_id: Optional[int] = Field(default=None, foreign_key="appointment.id")
    procedure_id: int = Field(foreign_key="procedure.id")
    tooth: Optional[str] = None
    notes: Optional[str] = None
    price: float = 0.0
    performed_on: date = Field(default_factory=date.today)


class Treatment(TreatmentBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    deleted_at: Optional[datetime] = Field(default=None, index=True)

    patient: Optional[Patient] = Relationship(back_populates="treatments")
    appointment: Optional[Appointment] = Relationship(back_populates="treatments")
    procedure: Optional[Procedure] = Relationship()


class TreatmentCreate(TreatmentBase):
    pass


class TreatmentRead(TreatmentBase):
    id: int
    procedure_name: Optional[str] = None


# ---------- Treatment Plan (multi-step, e.g. RCT -> crown) ----------
class TreatmentPlanBase(SQLModel):
    patient_id: int = Field(foreign_key="patient.id")
    title: str
    status: TreatmentPlanStatus = TreatmentPlanStatus.planned
    notes: Optional[str] = None


class TreatmentPlan(TreatmentPlanBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    deleted_at: Optional[datetime] = Field(default=None, index=True)

    steps: List["TreatmentPlanStep"] = Relationship(
        back_populates="plan",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "TreatmentPlanStep.sequence"},
    )


class TreatmentPlanStepBase(SQLModel):
    plan_id: int = Field(foreign_key="treatmentplan.id")
    sequence: int = 0
    title: str
    procedure_id: Optional[int] = Field(default=None, foreign_key="procedure.id")
    tooth: Optional[str] = None
    status: TreatmentStepStatus = TreatmentStepStatus.planned
    estimated_cost: float = 0.0
    actual_cost: float = 0.0
    planned_date: Optional[date] = None
    completed_date: Optional[date] = None
    notes: Optional[str] = None
    treatment_id: Optional[int] = Field(default=None, foreign_key="treatment.id")


class TreatmentPlanStep(TreatmentPlanStepBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    plan: Optional[TreatmentPlan] = Relationship(back_populates="steps")


class TreatmentPlanStepCreate(SQLModel):
    title: str
    sequence: int = 0
    procedure_id: Optional[int] = None
    tooth: Optional[str] = None
    estimated_cost: float = 0.0
    actual_cost: float = 0.0
    planned_date: Optional[date] = None
    notes: Optional[str] = None
    status: TreatmentStepStatus = TreatmentStepStatus.planned


class TreatmentPlanStepUpdate(SQLModel):
    title: Optional[str] = None
    sequence: Optional[int] = None
    procedure_id: Optional[int] = None
    tooth: Optional[str] = None
    estimated_cost: Optional[float] = None
    actual_cost: Optional[float] = None
    planned_date: Optional[date] = None
    completed_date: Optional[date] = None
    notes: Optional[str] = None
    status: Optional[TreatmentStepStatus] = None


class TreatmentPlanStepRead(TreatmentPlanStepBase):
    id: int
    procedure_name: Optional[str] = None


class TreatmentPlanCreate(SQLModel):
    patient_id: int
    title: str
    notes: Optional[str] = None
    status: TreatmentPlanStatus = TreatmentPlanStatus.planned
    steps: List[TreatmentPlanStepCreate] = []


class TreatmentPlanUpdate(SQLModel):
    title: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[TreatmentPlanStatus] = None


class TreatmentPlanRead(TreatmentPlanBase):
    id: int
    created_at: datetime
    updated_at: datetime
    steps: List[TreatmentPlanStepRead] = []
    estimate_total: float = 0.0
    actual_total: float = 0.0
    completed_steps: int = 0
    total_steps: int = 0


# ---------- Invoice ----------
class InvoiceBase(SQLModel):
    patient_id: int = Field(foreign_key="patient.id")
    appointment_id: Optional[int] = Field(default=None, foreign_key="appointment.id")
    total: float = 0.0
    paid: float = 0.0
    discount_amount: float = 0.0
    status: InvoiceStatus = InvoiceStatus.unpaid
    notes: Optional[str] = None


class Invoice(InvoiceBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)
    deleted_at: Optional[datetime] = Field(default=None, index=True)

    patient: Optional[Patient] = Relationship(back_populates="invoices")
    items: List["InvoiceItem"] = Relationship(
        back_populates="invoice",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    payments: List["Payment"] = Relationship(
        back_populates="invoice",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class InvoiceItemBase(SQLModel):
    invoice_id: Optional[int] = Field(default=None, foreign_key="invoice.id")
    procedure_id: Optional[int] = Field(default=None, foreign_key="procedure.id")
    description: str
    quantity: int = 1
    unit_price: float = 0.0


class InvoiceItem(InvoiceItemBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    invoice: Optional[Invoice] = Relationship(back_populates="items")


class InvoiceItemCreate(SQLModel):
    procedure_id: Optional[int] = None
    description: str
    quantity: int = 1
    unit_price: float = 0.0


class InvoiceCreate(SQLModel):
    patient_id: int
    appointment_id: Optional[int] = None
    notes: Optional[str] = None
    discount_amount: float = 0.0
    items: List[InvoiceItemCreate] = []


class InvoiceUpdate(SQLModel):
    notes: Optional[str] = None
    discount_amount: Optional[float] = None
    items: Optional[List[InvoiceItemCreate]] = None


class InvoiceRead(InvoiceBase):
    id: int
    created_at: datetime
    patient_name: Optional[str] = None
    items: List[InvoiceItem] = []
    payments: List["Payment"] = []
    subtotal: float = 0.0
    balance: float = 0.0


# ---------- Payment ----------
class PaymentBase(SQLModel):
    invoice_id: int = Field(foreign_key="invoice.id")
    amount: float
    method: PaymentMethod = PaymentMethod.cash
    reference: Optional[str] = None
    paid_on: datetime = Field(default_factory=utcnow)


class Payment(PaymentBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    deleted_at: Optional[datetime] = Field(default=None, index=True)
    invoice: Optional[Invoice] = Relationship(back_populates="payments")


class PaymentCreate(SQLModel):
    amount: float
    method: PaymentMethod = PaymentMethod.cash
    reference: Optional[str] = None
    # Optional so existing callers keep working; falls back to utcnow server-side.
    paid_on: Optional[datetime] = None


class PaymentRead(PaymentBase):
    id: int


model_rebuild(InvoiceRead)


# ---------- Audit log ----------
class AuditLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    action: str = Field(index=True)
    entity_type: Optional[str] = Field(default=None, index=True)
    entity_id: Optional[int] = Field(default=None, index=True)
    summary: Optional[str] = None
    details_json: Optional[str] = None
    actor: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow, index=True)


class AuditLogRead(SQLModel):
    id: int
    action: str
    entity_type: Optional[str] = None
    entity_id: Optional[int] = None
    summary: Optional[str] = None
    details_json: Optional[str] = None
    actor: Optional[str] = None
    created_at: datetime


# ---------- Settings (singleton doctor/clinic profile) ----------
# Stored as a single row with id=1. GET creates it if missing, PUT updates it.
class SettingsBase(SQLModel):
    doctor_name: Optional[str] = None
    doctor_qualifications: Optional[str] = None  # e.g. "MBBS, MD (Medicine)"
    # Medical Council registration details — MANDATORY under Indian Medical
    # Council (Professional Conduct) Regulations 2002, clause 1.4.2:
    # every doctor must display their registration number on prescriptions,
    # lab reports, money receipts (invoices), and certificates. We split it
    # into the number itself and the issuing council (State Medical Council
    # / NMC) so it prints like "Reg. No. 12345 (Delhi Medical Council)".
    registration_number: Optional[str] = None
    registration_council: Optional[str] = None
    clinic_name: Optional[str] = None
    clinic_address: Optional[str] = None
    clinic_phone: Optional[str] = None
    clinic_email: Optional[str] = None
    clinic_gstin: Optional[str] = None           # optional for tax-invoice setups
    specialization: Optional[str] = None  # default category for new procedures
    # Structured clinical category — a short, known enum-like value captured
    # during onboarding. Drives "only show patients relevant to my practice"
    # filtering on the patient list and the Dashboard. Free-text for forward
    # compatibility but the UI exposes a fixed set:
    #   general | dental | pediatric | geriatric | gynecology | andrology
    #   | cardiology | dermatology | ent | orthopedic | psychiatry | ophthalmology
    doctor_category: Optional[str] = None
    locale: Optional[str] = None           # "en" / "hi" — persisted preference
    onboarded_at: Optional[datetime] = None


class Settings(SettingsBase, table=True):
    id: Optional[int] = Field(default=1, primary_key=True)
    updated_at: datetime = Field(default_factory=utcnow)


class SettingsRead(SettingsBase):
    id: int
    updated_at: datetime


class SettingsUpdate(SettingsBase):
    """All fields optional — PATCH-style semantics even though we use PUT."""
    pass


# ---------- Dental chart (odontogram) ---------------------------------------
# One row per (patient, tooth) storing the current state of that tooth.
# Tooth numbers use the FDI (ISO 3950) two-digit notation that's standard
# in India: quadrant (1-4 permanent, 5-8 primary) + position (1-8).
# Adult permanent = 11..18, 21..28, 31..38, 41..48.
# Deciduous / primary = 51..55, 61..65, 71..75, 81..85.
class ToothStatus(str, Enum):
    healthy = "healthy"      # default / nothing noted
    caries = "caries"        # decay present
    filled = "filled"        # filling / restoration in place
    root_canal = "root_canal"  # RCT done (endo)
    crown = "crown"          # crown / cap
    bridge = "bridge"        # bridge pontic or retainer
    implant = "implant"      # implant
    missing = "missing"      # extracted / never erupted
    impacted = "impacted"    # unerupted, partially erupted
    fractured = "fractured"  # trauma / fracture
    mobile = "mobile"        # grade I-III mobility
    watch = "watch"          # keep an eye on it


class ToothRecordBase(SQLModel):
    patient_id: int = Field(foreign_key="patient.id", index=True)
    # FDI two-digit code stored as text so primary / deciduous (e.g. "51")
    # fits alongside permanent ("16") without leading-zero gymnastics.
    tooth_number: str = Field(index=True, max_length=2)
    status: ToothStatus = Field(default=ToothStatus.healthy)
    # Ordered free-text list of conditions (caries, filling, RCT, perio…)
    # stored as a JSON array so multiple findings per tooth are possible.
    conditions: Optional[str] = None
    notes: Optional[str] = None


class ToothRecord(ToothRecordBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    deleted_at: Optional[datetime] = Field(default=None, index=True)


class ToothRecordUpsert(SQLModel):
    status: Optional[ToothStatus] = None
    conditions: Optional[str] = None
    notes: Optional[str] = None


class ToothRecordRead(ToothRecordBase):
    id: int
    created_at: datetime
    updated_at: datetime


# ---------- Consultation attachments ----------------------------------------
# Lab reports, scans, images, medication boxes -- anything the doctor wants
# pinned to a specific visit. Files live on disk under
# ``APP_DIR/attachments`` so the DB stays slim; we only store metadata.
class AttachmentKind(str, Enum):
    image = "image"
    pdf = "pdf"
    document = "document"
    other = "other"


class ConsultationAttachmentBase(SQLModel):
    note_id: int = Field(foreign_key="consultationnote.id", index=True)
    patient_id: int = Field(foreign_key="patient.id", index=True)
    filename: str
    mime_type: str
    size_bytes: int = 0
    kind: AttachmentKind = Field(default=AttachmentKind.other)
    # Server-controlled path relative to ``APP_DIR``. Never sent from the
    # client (prevents path traversal) -- see ``/api/.../attachments`` in
    # ``backend/main.py`` for the sanitised storage layout.
    storage_path: str
    caption: Optional[str] = None


class ConsultationAttachment(ConsultationAttachmentBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    uploaded_at: datetime = Field(default_factory=utcnow)
    deleted_at: Optional[datetime] = Field(default=None, index=True)


class ConsultationAttachmentRead(SQLModel):
    id: int
    note_id: int
    patient_id: int
    filename: str
    mime_type: str
    size_bytes: int
    kind: AttachmentKind
    caption: Optional[str] = None
    uploaded_at: datetime
    # URL the frontend can hit to download the file -- populated by the API
    # layer so we don't hard-code the route in the model.
    download_url: Optional[str] = None
