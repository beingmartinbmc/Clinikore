"""Treatment plan tests (multi-step plans, e.g. RCT -> Crown).

Like consultation notes, the HTTP routes are planned but not all wired
up yet, so we exercise the ORM directly.

Key invariants the plan in the spec establishes:

* ``TreatmentPlanRead.estimate_total`` = sum of ``step.estimated_cost``
* ``TreatmentPlanRead.actual_total`` = sum of ``step.actual_cost``
  across **completed** steps.
* ``completed_steps`` / ``total_steps`` counts match the step list.
* Steps are ordered by ``sequence`` so the UI can drag-reorder.
"""
from __future__ import annotations

from datetime import date, timedelta

from backend.models import (
    Patient,
    TreatmentPlan,
    TreatmentPlanStep,
    TreatmentPlanStatus,
    TreatmentStepStatus,
)


def _plan_with_steps(s, patient_id, step_rows):
    plan = TreatmentPlan(patient_id=patient_id, title="RCT + Crown")
    s.add(plan)
    s.commit()
    s.refresh(plan)
    for i, (status, est, actual) in enumerate(step_rows):
        s.add(TreatmentPlanStep(
            plan_id=plan.id, sequence=i, title=f"Step {i}",
            status=status, estimated_cost=est, actual_cost=actual,
        ))
    s.commit()
    s.refresh(plan)
    return plan


def test_estimate_total_sums_step_estimates(session):
    p = Patient(name="Rahul")
    session.add(p)
    session.commit()
    session.refresh(p)

    plan = _plan_with_steps(session, p.id, [
        (TreatmentStepStatus.planned, 6000, 0),     # RCT
        (TreatmentStepStatus.planned, 5000, 0),     # Crown
        (TreatmentStepStatus.planned, 1200, 0),     # Filling
    ])
    total = sum(step.estimated_cost for step in plan.steps)
    assert total == 12200


def test_actual_total_sums_only_completed_steps(session):
    p = Patient(name="Rahul")
    session.add(p)
    session.commit()
    session.refresh(p)

    plan = _plan_with_steps(session, p.id, [
        (TreatmentStepStatus.completed, 6000, 5500),
        (TreatmentStepStatus.completed, 5000, 5000),
        (TreatmentStepStatus.planned, 1200, 0),
    ])
    actual = sum(step.actual_cost for step in plan.steps
                 if step.status == TreatmentStepStatus.completed)
    assert actual == 10500


def test_completed_and_total_counts(session):
    p = Patient(name="Rahul")
    session.add(p)
    session.commit()
    session.refresh(p)

    plan = _plan_with_steps(session, p.id, [
        (TreatmentStepStatus.completed, 100, 100),
        (TreatmentStepStatus.completed, 100, 100),
        (TreatmentStepStatus.in_progress, 100, 0),
        (TreatmentStepStatus.planned, 100, 0),
        (TreatmentStepStatus.skipped, 100, 0),
    ])
    completed = sum(1 for s in plan.steps
                    if s.status == TreatmentStepStatus.completed)
    assert completed == 2
    assert len(plan.steps) == 5


def test_steps_ordered_by_sequence(session):
    p = Patient(name="Rahul")
    session.add(p)
    session.commit()
    session.refresh(p)

    plan = TreatmentPlan(patient_id=p.id, title="Ordered")
    session.add(plan)
    session.commit()
    session.refresh(plan)
    # Deliberately insert out of order.
    for seq in [2, 0, 1]:
        session.add(TreatmentPlanStep(
            plan_id=plan.id, sequence=seq, title=f"seq-{seq}",
        ))
    session.commit()
    session.refresh(plan)
    # Relationship ``order_by=TreatmentPlanStep.sequence`` guarantees this.
    assert [s.sequence for s in plan.steps] == [0, 1, 2]


def test_plan_status_transitions(session):
    p = Patient(name="Rahul")
    session.add(p)
    session.commit()
    session.refresh(p)

    plan = TreatmentPlan(patient_id=p.id, title="X")
    session.add(plan)
    session.commit()
    session.refresh(plan)
    assert plan.status == TreatmentPlanStatus.planned

    plan.status = TreatmentPlanStatus.in_progress
    session.add(plan)
    session.commit()
    session.refresh(plan)
    assert plan.status == TreatmentPlanStatus.in_progress

    plan.status = TreatmentPlanStatus.completed
    session.add(plan)
    session.commit()
    session.refresh(plan)
    assert plan.status == TreatmentPlanStatus.completed


def test_planned_and_completed_dates_round_trip(session):
    p = Patient(name="Rahul")
    session.add(p)
    session.commit()
    session.refresh(p)

    plan = TreatmentPlan(patient_id=p.id, title="Dated")
    session.add(plan)
    session.commit()
    session.refresh(plan)
    s = TreatmentPlanStep(
        plan_id=plan.id, title="RCT", sequence=0,
        planned_date=date.today() + timedelta(days=7),
        completed_date=date.today(),
        status=TreatmentStepStatus.completed,
    )
    session.add(s)
    session.commit()
    session.refresh(s)

    assert s.planned_date == date.today() + timedelta(days=7)
    assert s.completed_date == date.today()
