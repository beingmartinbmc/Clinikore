"""Tests for the v2 patient-demographics additions.

Covers:
 * Storing and reading back ``date_of_birth`` and ``gender`` on patients.
 * Deriving the current ``age`` from DOB on the read path (the DB column is
   kept in sync but the computed value is the source of truth).
 * The new ``doctor_category`` field on Settings, exposed via the
   ``/api/doctor-categories`` endpoint.
 * The specialty-aware relevance filter applied by ``GET /api/patients``.
 * ``relevance=false`` bypasses the filter (needed for admin / global search).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from backend import services


# ---------------------------------------------------------------------------
# Pure helpers — test without any DB
# ---------------------------------------------------------------------------
class _FakePatient:
    def __init__(self, *, age=None, date_of_birth=None, gender=None):
        self.age = age
        self.date_of_birth = date_of_birth
        self.gender = gender


def test_compute_patient_age_prefers_dob_over_stale_age_column():
    # DOB 10 years ago — age column says 2 (stale). DOB wins.
    dob = date.today().replace(year=date.today().year - 10)
    p = _FakePatient(age=2, date_of_birth=dob)
    assert services.compute_patient_age(p) == 10


def test_compute_patient_age_falls_back_to_age_column_without_dob():
    p = _FakePatient(age=45, date_of_birth=None)
    assert services.compute_patient_age(p) == 45


def test_compute_patient_age_before_birthday_this_year():
    # Pick a DOB whose anniversary is definitely in the future this year.
    today = date.today()
    future = today + timedelta(days=7)
    dob = date(today.year - 30, future.month, future.day)
    p = _FakePatient(date_of_birth=dob)
    # Birthday hasn't happened yet → 29, not 30.
    assert services.compute_patient_age(p) == 29


def test_compute_patient_age_returns_none_when_nothing_known():
    assert services.compute_patient_age(_FakePatient()) is None


def test_doctor_categories_constant_has_the_onboarding_set():
    # Guards the contract between backend relevance logic and the frontend
    # onboarding UI — if this list drifts the onboarding cards will mismatch
    # the backend filter.
    for cat in (
        "general", "dental", "pediatric", "geriatric",
        "gynecology", "andrology",
    ):
        assert cat in services.DOCTOR_CATEGORIES


# ---------------------------------------------------------------------------
# is_patient_relevant — each category branch
# ---------------------------------------------------------------------------
def test_relevance_general_or_empty_includes_everyone():
    p = _FakePatient(age=80, gender="male")
    assert services.is_patient_relevant(p, None) is True
    assert services.is_patient_relevant(p, "") is True
    assert services.is_patient_relevant(p, "general") is True
    assert services.is_patient_relevant(p, "  GENERAL  ") is True


def test_relevance_pediatric_filters_out_adults():
    kid = _FakePatient(age=5)
    adult = _FakePatient(age=40)
    unknown = _FakePatient()  # no DOB, no age — kept by design
    assert services.is_patient_relevant(kid, "pediatric") is True
    assert services.is_patient_relevant(adult, "pediatric") is False
    assert services.is_patient_relevant(unknown, "pediatric") is True


def test_relevance_geriatric_filters_out_non_seniors():
    senior = _FakePatient(age=72)
    adult = _FakePatient(age=40)
    assert services.is_patient_relevant(senior, "geriatric") is True
    assert services.is_patient_relevant(adult, "geriatric") is False


def test_relevance_gynecology_drops_male_patients():
    male = _FakePatient(gender="male")
    female = _FakePatient(gender="female")
    unknown = _FakePatient()
    assert services.is_patient_relevant(male, "gynecology") is False
    assert services.is_patient_relevant(female, "gynecology") is True
    assert services.is_patient_relevant(unknown, "gynecology") is True


def test_relevance_andrology_drops_female_patients():
    male = _FakePatient(gender="male")
    female = _FakePatient(gender="female")
    assert services.is_patient_relevant(male, "andrology") is True
    assert services.is_patient_relevant(female, "andrology") is False


def test_relevance_non_demographic_categories_pass_everyone_through():
    elderly = _FakePatient(age=95, gender="male")
    for cat in ("cardiology", "dental", "dermatology", "ent", "psychiatry"):
        assert services.is_patient_relevant(elderly, cat) is True


def test_filter_patients_by_category_is_stable_order():
    a = _FakePatient(age=5); a.name = "A"       # noqa: E702
    b = _FakePatient(age=40); b.name = "B"      # noqa: E702
    c = _FakePatient(age=8); c.name = "C"       # noqa: E702
    out = services.filter_patients_by_category([a, b, c], "pediatric")
    assert [p.name for p in out] == ["A", "C"]


# ---------------------------------------------------------------------------
# API surface — new fields flow end-to-end
# ---------------------------------------------------------------------------
def _iso_dob_for_age(years: int) -> str:
    today = date.today()
    return today.replace(year=today.year - years).isoformat()


def test_patient_create_round_trips_dob_and_gender(client):
    dob = _iso_dob_for_age(12)
    r = client.post(
        "/api/patients",
        json={
            "name": "Riya",
            "date_of_birth": dob,
            "gender": "female",
            "phone": "+91 98000 00001",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["date_of_birth"] == dob
    assert body["gender"] == "female"
    # Derived age — doesn't matter whether we supplied one.
    assert body["age"] == 12


def test_patient_dob_overrides_stale_age_on_read(client):
    """If the doctor enters DOB + an out-of-date age the list endpoint
    reports the DOB-derived age. Prevents silently stale values."""
    dob = _iso_dob_for_age(25)
    r = client.post(
        "/api/patients",
        json={"name": "Kabir", "age": 2, "date_of_birth": dob},
    )
    assert r.status_code == 201
    listed = client.get("/api/patients").json()
    assert listed[0]["age"] == 25


def test_doctor_categories_endpoint_matches_services_constant(client):
    r = client.get("/api/doctor-categories")
    assert r.status_code == 200
    assert r.json() == list(services.DOCTOR_CATEGORIES)


def test_patients_list_relevance_filter_applies_pediatric_category(client):
    # Three patients of varying ages.
    client.post("/api/patients", json={
        "name": "Tiny", "date_of_birth": _iso_dob_for_age(3),
    })
    client.post("/api/patients", json={
        "name": "Teen", "date_of_birth": _iso_dob_for_age(14),
    })
    client.post("/api/patients", json={
        "name": "Grown", "date_of_birth": _iso_dob_for_age(45),
    })

    # Configure the practice as paediatric.
    r = client.put("/api/settings", json={
        "doctor_name": "Dr P",
        "clinic_name": "Kids First",
        "registration_number": "X",
        "doctor_category": "pediatric",
    })
    assert r.status_code == 200

    names = [p["name"] for p in client.get("/api/patients").json()]
    assert "Grown" not in names
    assert set(names) == {"Tiny", "Teen"}

    # relevance=false bypasses the filter — required for global search.
    names_all = [
        p["name"] for p in client.get("/api/patients?relevance=false").json()
    ]
    assert set(names_all) == {"Tiny", "Teen", "Grown"}


def test_patients_list_relevance_filter_applies_gynecology(client):
    client.post("/api/patients", json={"name": "Male", "gender": "male"})
    client.post("/api/patients", json={"name": "Female", "gender": "female"})
    client.post("/api/patients", json={"name": "Unset"})  # no gender

    client.put("/api/settings", json={
        "doctor_name": "Dr G", "clinic_name": "C",
        "registration_number": "Y", "doctor_category": "gynecology",
    })

    names = {p["name"] for p in client.get("/api/patients").json()}
    # Male is excluded; unknown is kept (opt-in filter).
    assert "Male" not in names
    assert "Female" in names
    assert "Unset" in names


def test_onboarded_at_stamped_by_doctor_category_alone(client):
    """Before v2 the onboarding stamp required `specialization`. We now
    accept either the structured `doctor_category` or the legacy
    free-text `specialization` — both are sufficient evidence that the
    doctor completed the onboarding flow."""
    r = client.put("/api/settings", json={
        "doctor_name": "Dr A", "clinic_name": "C",
        "registration_number": "R", "doctor_category": "cardiology",
    })
    assert r.status_code == 200
    assert r.json()["onboarded_at"] is not None


def test_default_relevance_no_category_is_noop(client):
    # Without a category configured every patient is visible.
    client.post("/api/patients", json={"name": "Someone", "age": 77})
    names = [p["name"] for p in client.get("/api/patients").json()]
    assert names == ["Someone"]
