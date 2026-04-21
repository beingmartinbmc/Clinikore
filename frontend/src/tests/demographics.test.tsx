/**
 * Tests for the v2 demographics & specialty-aware patient filtering.
 *
 * Covers:
 *  - `ageFromDob` / `patientAge` helpers in `api.ts`
 *  - `isDentalSpecialization` now respects `doctor_category: "dental"`
 *  - `doctorCategoryLabel` returns friendly labels for known categories
 *  - The new patient-creation form fields (DOB + gender) reach the API
 *  - The "Practice category" dropdown in Settings persists its value
 *  - The `PatientDetail` page always renders the Dental chart tab
 *    regardless of the clinic's specialization.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import {
  ageFromDob,
  patientAge,
  doctorCategoryLabel,
  isDentalSpecialization,
  DOCTOR_CATEGORIES,
} from "../api";
import Patients from "../pages/Patients";
import SettingsPage from "../pages/Settings";
import PatientDetail from "../pages/PatientDetail";
import { I18nProvider } from "../i18n/I18nContext";
import { TourProvider } from "../tour/TourContext";
import { renderApp, installFetchMock, jsonResponse } from "./helpers";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("ageFromDob / patientAge", () => {
  it("returns null for missing / unparseable inputs", () => {
    expect(ageFromDob(null)).toBeNull();
    expect(ageFromDob(undefined)).toBeNull();
    expect(ageFromDob("")).toBeNull();
    expect(ageFromDob("not-a-date")).toBeNull();
  });

  it("computes the current year difference, accounting for the birthday", () => {
    const today = new Date();
    const elevenYearsAgo = new Date(today);
    elevenYearsAgo.setFullYear(today.getFullYear() - 11);
    // Pick a DOB that's definitely already happened this year.
    elevenYearsAgo.setDate(today.getDate() - 1);
    const iso = elevenYearsAgo.toISOString().slice(0, 10);
    expect(ageFromDob(iso)).toBe(11);
  });

  it("returns 0 (not a negative number) for future-dated DOBs", () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 3);
    const iso = future.toISOString().slice(0, 10);
    expect(ageFromDob(iso)).toBe(0);
  });

  it("patientAge prefers DOB over the stored age column", () => {
    const today = new Date();
    const twentyYearsAgo = new Date(today);
    twentyYearsAgo.setFullYear(today.getFullYear() - 20);
    twentyYearsAgo.setDate(today.getDate() - 1);
    const iso = twentyYearsAgo.toISOString().slice(0, 10);
    expect(patientAge({ age: 2, date_of_birth: iso })).toBe(20);
  });

  it("patientAge falls back to the stored age when DOB is missing", () => {
    expect(patientAge({ age: 42, date_of_birth: null })).toBe(42);
    expect(patientAge({ age: null, date_of_birth: null })).toBeNull();
  });
});

describe("doctorCategoryLabel", () => {
  it("returns friendly labels for known category ids", () => {
    expect(doctorCategoryLabel("pediatric")).toMatch(/pediatrics/i);
    expect(doctorCategoryLabel("dental")).toBe("Dental");
    expect(doctorCategoryLabel("ent")).toBe("ENT");
  });

  it("title-cases unknown categories so custom values still render", () => {
    expect(doctorCategoryLabel("neuro")).toBe("Neuro");
  });

  it("returns the empty string for blank inputs", () => {
    expect(doctorCategoryLabel("")).toBe("");
    expect(doctorCategoryLabel(null)).toBe("");
  });

  it("DOCTOR_CATEGORIES is the documented fixed vocabulary", () => {
    // Guards accidental reordering / renaming that would drift from the
    // backend's `services.DOCTOR_CATEGORIES` tuple.
    expect(DOCTOR_CATEGORIES).toContain("general");
    expect(DOCTOR_CATEGORIES).toContain("pediatric");
    expect(DOCTOR_CATEGORIES).toContain("geriatric");
    expect(DOCTOR_CATEGORIES).toContain("gynecology");
  });
});

describe("isDentalSpecialization", () => {
  it("is true when doctor_category is explicitly dental", () => {
    expect(isDentalSpecialization({ doctor_category: "dental" })).toBe(true);
  });

  it("still supports the legacy free-text specialization", () => {
    expect(isDentalSpecialization({ specialization: "Endodontist" })).toBe(true);
    expect(
      isDentalSpecialization({ specialization: "Cardiologist" }),
    ).toBe(false);
  });

  it("returns false for null / empty input", () => {
    expect(isDentalSpecialization(null)).toBe(false);
    expect(isDentalSpecialization({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Patients page — DOB + gender flow through the "New patient" form
// ---------------------------------------------------------------------------
describe("Patients page — demographics form", () => {
  it("sends date_of_birth, gender and derived age on submit", async () => {
    let postBody: any = null;
    installFetchMock({
      routes: {
        "/api/patients": (init: RequestInit | undefined) => {
          if ((init?.method || "GET").toUpperCase() === "POST") {
            postBody = JSON.parse((init!.body as string) || "{}");
            return jsonResponse({}, 201);
          }
          return jsonResponse([]);
        },
      },
    });

    renderApp(<Patients />);
    // Open "New patient" modal.
    await userEvent.click(
      await screen.findByRole("button", { name: /New patient/i }),
    );

    // Full-name input is the first required text input inside the modal
    // form. The page also has a search textbox at the top, so we pick the
    // one that lives inside a `<form>`.
    const nameInput = document.querySelector<HTMLInputElement>(
      'form input[required]',
    )!;
    expect(nameInput).not.toBeNull();
    await userEvent.type(nameInput, "Asha");

    // Pick a DOB ~ 8 years ago so derived age is deterministic.
    const today = new Date();
    const dob = new Date(today);
    dob.setFullYear(today.getFullYear() - 8);
    dob.setDate(today.getDate() - 1);
    const iso = dob.toISOString().slice(0, 10);
    // Grab the first `<input type="date">` in the form — that's DOB.
    const dobInput = document.querySelector<HTMLInputElement>(
      'input[type="date"]',
    );
    expect(dobInput).not.toBeNull();
    await userEvent.clear(dobInput!);
    await userEvent.type(dobInput!, iso);

    // Gender = female. Grab the only <select> inside the form.
    const genderSelect = document.querySelector<HTMLSelectElement>(
      'form select',
    );
    expect(genderSelect).not.toBeNull();
    await userEvent.selectOptions(genderSelect!, "female");

    await userEvent.click(screen.getByRole("button", { name: /Save patient/i }));

    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody.name).toBe("Asha");
    expect(postBody.date_of_birth).toBe(iso);
    expect(postBody.gender).toBe("female");
    // Derived from DOB — not the free-form age input.
    expect(postBody.age).toBe(8);
  });

  it("disables the age input once a DOB is picked", async () => {
    installFetchMock({ routes: { "/api/patients": [] } });
    renderApp(<Patients />);
    await userEvent.click(
      await screen.findByRole("button", { name: /New patient/i }),
    );
    const ageInput = document.querySelector<HTMLInputElement>(
      'input[type="number"]',
    )!;
    expect(ageInput).not.toBeNull();
    expect(ageInput).not.toBeDisabled();

    const dobInput = document.querySelector<HTMLInputElement>(
      'input[type="date"]',
    )!;
    const today = new Date();
    const dob = new Date(today);
    dob.setFullYear(today.getFullYear() - 20);
    const iso = dob.toISOString().slice(0, 10);
    await userEvent.type(dobInput, iso);
    expect(ageInput).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Settings page — practice category persists
// ---------------------------------------------------------------------------
describe("Settings page — practice category", () => {
  it("saves the selected doctor_category when the profile form is submitted", async () => {
    let putBody: any = null;
    installFetchMock({
      routes: {
        "/api/settings": (init: RequestInit | undefined) => {
          if ((init?.method || "GET").toUpperCase() === "PUT") {
            putBody = JSON.parse((init!.body as string) || "{}");
            return jsonResponse({ id: 1, ...putBody, updated_at: "now" });
          }
          return jsonResponse({
            id: 1,
            doctor_name: "Dr X",
            clinic_name: "C",
            registration_number: "R",
            updated_at: "now",
          });
        },
        "/api/procedures/categories": [],
        "/api/system/info": {
          app_dir: "/tmp",
          db_path: "/tmp/db",
          backup_dir: "/tmp/b",
          log_dir: "/tmp/l",
        },
        "/api/availability": [],
        "/api/rooms": [],
      },
    });

    renderApp(<SettingsPage />);

    await screen.findByLabelText(/Practice category/i);
    await userEvent.selectOptions(
      screen.getByLabelText(/Practice category/i),
      "pediatric",
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: /Save/i })[0],
    );

    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody.doctor_category).toBe("pediatric");
  });
});

// ---------------------------------------------------------------------------
// PatientDetail — Dental chart is always a tab
// ---------------------------------------------------------------------------
describe("PatientDetail — universal Dental chart", () => {
  function renderDetail(extraSettings: Record<string, any> = {}) {
    installFetchMock({
      routes: {
        "/api/patients/1": {
          id: 1, name: "Asha", age: 30,
          created_at: "2026-01-01",
          lifecycle: "new",
        },
        "/api/patients/1/treatments": [],
        "/api/appointments": [],
        "/api/patients/1/consultation-notes": [],
        "/api/patients/1/treatment-plans": [],
        "/api/invoices": [],
        "/api/procedures": [],
        "/api/settings": {
          id: 1, doctor_name: "Dr A", clinic_name: "C",
          registration_number: "R", updated_at: "2026-01-01",
          ...extraSettings,
        },
      },
    });
    return render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/patients/1"]}>
          <TourProvider>
            <Routes>
              <Route path="/patients/:id" element={<PatientDetail />} />
            </Routes>
          </TourProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  }

  it("renders the Dental chart tab for a non-dental practice", async () => {
    renderDetail({ doctor_category: "cardiology" });
    // The tab strip ships with "Dental chart" regardless of speciality.
    const tab = await screen.findByRole("button", { name: /Dental chart/i });
    expect(tab).toBeInTheDocument();
  });

  it("renders the Dental chart tab for a dentist too (unchanged)", async () => {
    renderDetail({ doctor_category: "dental" });
    const tab = await screen.findByRole("button", { name: /Dental chart/i });
    expect(tab).toBeInTheDocument();
  });

  it("shows the patient's DOB and computed age when set", async () => {
    const today = new Date();
    const d = new Date(today);
    d.setFullYear(today.getFullYear() - 25);
    d.setDate(today.getDate() - 1);
    const iso = d.toISOString().slice(0, 10);
    installFetchMock({
      routes: {
        "/api/patients/1": {
          id: 1, name: "Asha",
          date_of_birth: iso,
          age: 25,
          gender: "female",
          created_at: "2026-01-01",
          lifecycle: "new",
        },
        "/api/patients/1/treatments": [],
        "/api/appointments": [],
        "/api/patients/1/consultation-notes": [],
        "/api/patients/1/treatment-plans": [],
        "/api/invoices": [],
        "/api/procedures": [],
        "/api/settings": {
          id: 1, doctor_name: "Dr A", clinic_name: "C",
          registration_number: "R", updated_at: "2026-01-01",
        },
      },
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/patients/1"]}>
          <TourProvider>
            <Routes>
              <Route path="/patients/:id" element={<PatientDetail />} />
            </Routes>
          </TourProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
    await screen.findByText(/Age 25/i);
    // Gender label visible in read-only profile view.
    expect(screen.getAllByText(/female/i).length).toBeGreaterThan(0);
  });
});
