"""SQLModel models. Each class is both an ORM table and a Pydantic schema,
with small `*Create` / `*Read` variants where the shape differs from the table.

NOTE: We intentionally do NOT use `from __future__ import annotations` here.
SQLModel 0.0.22's relationship-detection code inspects runtime types, and
PEP 563 string annotations break its `List["X"]` unwrapping — you'd get
"seems to be using a generic class as the argument to relationship()".
"""
from datetime import datetime, date
from enum import Enum
from typing import Optional, List

from sqlmodel import SQLModel, Field, Relationship


# ---------- Enums ----------
class AppointmentStatus(str, Enum):
    scheduled = "scheduled"
    completed = "completed"
    cancelled = "cancelled"


class InvoiceStatus(str, Enum):
    unpaid = "unpaid"
    partial = "partial"
    paid = "paid"


class PaymentMethod(str, Enum):
    cash = "cash"
    upi = "upi"
    card = "card"


# ---------- Patient ----------
class PatientBase(SQLModel):
    name: str
    age: Optional[int] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    medical_history: Optional[str] = None
    dental_history: Optional[str] = None
    allergies: Optional[str] = None
    notes: Optional[str] = None


class Patient(PatientBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)

    appointments: List["Appointment"] = Relationship(back_populates="patient")
    treatments: List["Treatment"] = Relationship(back_populates="patient")
    invoices: List["Invoice"] = Relationship(back_populates="patient")


class PatientCreate(PatientBase):
    pass


class PatientRead(PatientBase):
    id: int
    created_at: datetime


# ---------- Procedure (catalog item with default price) ----------
class ProcedureBase(SQLModel):
    name: str
    description: Optional[str] = None
    default_price: float = 0.0


class Procedure(ProcedureBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class ProcedureCreate(ProcedureBase):
    pass


class ProcedureRead(ProcedureBase):
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


class Appointment(AppointmentBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)

    patient: Optional[Patient] = Relationship(back_populates="appointments")
    treatments: List["Treatment"] = Relationship(back_populates="appointment")


class AppointmentCreate(AppointmentBase):
    pass


class AppointmentRead(AppointmentBase):
    id: int
    created_at: datetime
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

    patient: Optional[Patient] = Relationship(back_populates="treatments")
    appointment: Optional[Appointment] = Relationship(back_populates="treatments")
    procedure: Optional[Procedure] = Relationship()


class TreatmentCreate(TreatmentBase):
    pass


class TreatmentRead(TreatmentBase):
    id: int
    procedure_name: Optional[str] = None


# ---------- Invoice ----------
class InvoiceBase(SQLModel):
    patient_id: int = Field(foreign_key="patient.id")
    appointment_id: Optional[int] = Field(default=None, foreign_key="appointment.id")
    total: float = 0.0
    paid: float = 0.0
    status: InvoiceStatus = InvoiceStatus.unpaid
    notes: Optional[str] = None


class Invoice(InvoiceBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)

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
    items: List[InvoiceItemCreate] = []


class InvoiceRead(InvoiceBase):
    id: int
    created_at: datetime
    patient_name: Optional[str] = None
    items: List[InvoiceItem] = []
    payments: List["Payment"] = []


# ---------- Payment ----------
class PaymentBase(SQLModel):
    invoice_id: int = Field(foreign_key="invoice.id")
    amount: float
    method: PaymentMethod = PaymentMethod.cash
    reference: Optional[str] = None
    paid_on: datetime = Field(default_factory=datetime.utcnow)


class Payment(PaymentBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    invoice: Optional[Invoice] = Relationship(back_populates="payments")


class PaymentCreate(SQLModel):
    amount: float
    method: PaymentMethod = PaymentMethod.cash
    reference: Optional[str] = None


class PaymentRead(PaymentBase):
    id: int


InvoiceRead.model_rebuild()
