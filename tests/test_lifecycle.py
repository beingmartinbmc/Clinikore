"""Patient-lifecycle computation tests.

`services.compute_patient_lifecycle(session, patient_id)` returns a
tuple ``(lifecycle, last_visit_dt, pending_step_count)`` where lifecycle
is one of:

  * ``new``            — no appointments
  * ``consulted``      — had appointments, no treatment plan yet
  * ``planned``        — has a plan but zero completed steps
  * ``in_progress``    — some steps completed, some not
  * ``completed``      — all plan steps completed
  * ``no_show``        — last appointment was cancelled / no_show

The dashboard and patient-list pages branch on this value, so regressions
here are highly visible.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from backend.services import compute_patient_lifecycle
from backend.models import (
    Appointment, AppointmentStatus,
    Patient, Procedure,
    PatientLifecycle,
    TreatmentPlan, TreatmentPlanStep, TreatmentPlanStatus, TreatmentStepStatus,
)


def _mk_patient(s, name="P"):
    p = Patient(name=name)
    s.add(p)
    s.commit()
    s.refresh(p)
    return p


def _mk_appt(s, patient_id, status=AppointmentStatus.scheduled, offset=0):
    when = datetime.now(timezone.utc) + timedelta(days=offset)
    a = Appointment(
        patient_id=patient_id,
        start=when, end=when + timedelta(minutes=30),
        status=status,
    )
    s.add(a)
    s.commit()
    s.refresh(a)
    return a


def _mk_plan(s, patient_id, step_statuses):
    plan = TreatmentPlan(patient_id=patient_id, title="Plan",
                         status=TreatmentPlanStatus.planned)
    s.add(plan)
    s.commit()
    s.refresh(plan)
    for i, st in enumerate(step_statuses):
        step = TreatmentPlanStep(
            plan_id=plan.id, sequence=i, title=f"Step {i}",
            status=st, estimated_cost=500, actual_cost=0,
        )
        s.add(step)
    s.commit()
    s.refresh(plan)
    return plan


def test_lifecycle_new_when_no_appointments(session):
    p = _mk_patient(session)
    lifecycle, last_visit, pending = compute_patient_lifecycle(session, p.id)
    assert lifecycle == PatientLifecycle.new.value
    assert last_visit is None
    assert pending == 0


def test_lifecycle_consulted_with_appointments_and_no_plan(session):
    p = _mk_patient(session)
    _mk_appt(session, p.id, offset=-1)
    lifecycle, last_visit, pending = compute_patient_lifecycle(session, p.id)
    assert lifecycle == PatientLifecycle.consulted.value
    assert last_visit is not None
    assert pending == 0


def test_lifecycle_noshow_when_last_appt_cancelled(session):
    p = _mk_patient(session)
    _mk_appt(session, p.id, status=AppointmentStatus.completed, offset=-5)
    # Most recent appointment is cancelled, and lifecycle should report that.
    _mk_appt(session, p.id, status=AppointmentStatus.cancelled, offset=-1)
    lifecycle, _, _ = compute_patient_lifecycle(session, p.id)
    assert lifecycle == PatientLifecycle.no_show.value


def test_lifecycle_planned_with_zero_completed_steps(session):
    p = _mk_patient(session)
    _mk_appt(session, p.id, offset=-1)
    _mk_plan(session, p.id, [
        TreatmentStepStatus.planned,
        TreatmentStepStatus.planned,
    ])
    lifecycle, _, pending = compute_patient_lifecycle(session, p.id)
    assert lifecycle == PatientLifecycle.planned.value
    assert pending == 2


def test_lifecycle_in_progress_when_some_steps_completed(session):
    p = _mk_patient(session)
    _mk_appt(session, p.id, offset=-1)
    _mk_plan(session, p.id, [
        TreatmentStepStatus.completed,
        TreatmentStepStatus.in_progress,
        TreatmentStepStatus.planned,
    ])
    lifecycle, _, pending = compute_patient_lifecycle(session, p.id)
    assert lifecycle == PatientLifecycle.in_progress.value
    assert pending == 2  # in_progress + planned count as pending


def test_lifecycle_completed_when_all_steps_done(session):
    p = _mk_patient(session)
    _mk_appt(session, p.id, offset=-1)
    _mk_plan(session, p.id, [
        TreatmentStepStatus.completed,
        TreatmentStepStatus.completed,
        TreatmentStepStatus.skipped,  # skipped counts as 'done' for lifecycle
    ])
    lifecycle, _, _ = compute_patient_lifecycle(session, p.id)
    assert lifecycle == PatientLifecycle.completed.value


def test_lifecycle_consulted_when_plan_has_zero_steps(session):
    """Edge case: empty treatment plan (doctor drafted it but hasn't added
    steps yet) should count as ``consulted``, not ``planned``."""
    p = _mk_patient(session)
    _mk_appt(session, p.id, offset=-1)
    _mk_plan(session, p.id, [])
    lifecycle, _, pending = compute_patient_lifecycle(session, p.id)
    assert lifecycle == PatientLifecycle.consulted.value
    assert pending == 0
