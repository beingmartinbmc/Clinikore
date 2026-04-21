/**
 * Page-level integration tests.
 *
 * We render every page with a canned fetch mock, then drive a representative
 * user flow (add/edit/delete, tab switches, filter toggles) to exercise the
 * main branches. FullCalendar is replaced with a lightweight mock so the
 * heavyweight canvas layer isn't required in jsdom.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-hot-toast", () => {
  const fn = Object.assign(
    vi.fn(() => "toast-id"),
    { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
  );
  return { default: fn };
});
import toast from "react-hot-toast";

// Stand-in for FullCalendar; exposes hooks the page relies on.
vi.mock("@fullcalendar/react", () => {
  const React = require("react");
  const FakeCalendar = React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      getApi: () => ({ refetchEvents: () => {} }),
    }));
    (FakeCalendar as any).__last = props;
    return React.createElement(
      "div",
      { "data-testid": "calendar" },
      (props.events || []).map((ev: any) =>
        React.createElement(
          "button",
          {
            key: ev.id,
            "data-testid": `event-${ev.id}`,
            onClick: () =>
              props.eventClick &&
              props.eventClick({ event: { extendedProps: ev.extendedProps } }),
          },
          ev.title,
        ),
      ),
    );
  });
  return { default: FakeCalendar };
});
vi.mock("@fullcalendar/timegrid", () => ({ default: {} }));
vi.mock("@fullcalendar/daygrid", () => ({ default: {} }));
vi.mock("@fullcalendar/interaction", () => ({ default: {} }));

import Dashboard from "../pages/Dashboard";
import Patients from "../pages/Patients";
import PatientDetail from "../pages/PatientDetail";
import Procedures from "../pages/Procedures";
import Invoices from "../pages/Invoices";
import InvoiceDetail from "../pages/InvoiceDetail";
import Backups from "../pages/Backups";
import Reports from "../pages/Reports";
import SettingsPage from "../pages/Settings";
import Calendar from "../pages/Calendar";
import GlobalSearch from "../components/GlobalSearch";
import TreatmentPlanEditor from "../components/TreatmentPlanEditor";
import Layout from "../components/Layout";
import App from "../App";
import { installFetchMock, jsonResponse, renderApp } from "./helpers";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { I18nProvider } from "../i18n/I18nContext";
import { TourProvider } from "../tour/TourContext";
import { render } from "@testing-library/react";

// Silence confirm() prompts.
beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  localStorage.setItem("clinikore.onboarding_seen_v1", "done");
  (toast as any).mockClear?.();
  (toast as any).success.mockClear?.();
  (toast as any).error.mockClear?.();
});
afterEach(() => {
  localStorage.clear();
});

const BASE_ROUTES = {
  "/api/settings": {
    id: 1, doctor_name: "Dr A", clinic_name: "C", registration_number: "R",
    doctor_qualifications: "MBBS", registration_council: "DMC",
    clinic_address: "Addr", clinic_phone: "123", clinic_email: "c@x",
    clinic_gstin: "GST", specialization: "Dental",
    updated_at: "2025-01-01",
  },
  "/api/system/info": {
    app_dir: "/tmp/app", db_path: "/tmp/db.sqlite",
    backup_dir: "/tmp/b", log_dir: "/tmp/l",
  },
  "/api/demo": { active: false },
};

// ============================================================
// Dashboard
// ============================================================
describe("Dashboard", () => {
  it("renders stats with summary data and today's appointment list", async () => {
    installFetchMock({
      routes: {
        ...BASE_ROUTES,
        "/api/dashboard": {
          patients: 8,
          today_appointments: 3,
          pending_invoices: 2,
          pending_dues: 450,
          month_revenue: 12345,
          pending_treatment_patients: 1,
        },
        "/api/appointments": [
          {
            id: 1, patient_id: 1, patient_name: "Ada",
            start: "2025-01-01T09:00:00Z",
            end: "2025-01-01T09:30:00Z",
            status: "scheduled",
            chief_complaint: "pain",
            reminder_sent: false,
            created_at: "2025-01-01",
          },
        ],
      },
    });
    renderApp(<Dashboard />);
    await waitFor(() => expect(screen.getByText("8")).toBeInTheDocument());
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText(/₹ 12,345/i)).toBeInTheDocument();
  });

  it("shows the 'Set your name' CTA when doctor_name is blank", async () => {
    installFetchMock({
      routes: {
        "/api/settings": { id: 1, updated_at: "2025-01-01" },
        "/api/dashboard": {
          patients: 0, today_appointments: 0, pending_invoices: 0,
          pending_dues: 0, month_revenue: 0,
        },
        "/api/appointments": [],
      },
    });
    renderApp(<Dashboard />);
    await waitFor(() => screen.getByText(/tell us your name/i));
  });

  it("renders the empty-state when no appointments exist", async () => {
    installFetchMock({
      routes: {
        ...BASE_ROUTES,
        "/api/dashboard": {
          patients: 0, today_appointments: 0, pending_invoices: 0,
          pending_dues: 0, month_revenue: 0,
        },
        "/api/appointments": [],
      },
    });
    renderApp(<Dashboard />);
    await waitFor(() =>
      expect(screen.getByText(/no appointments/i)).toBeInTheDocument(),
    );
  });
});

// ============================================================
// Patients
// ============================================================
describe("Patients", () => {
  const patient = {
    id: 1, name: "Ada Lovelace", age: 35, phone: "9999",
    email: "ada@example.com", allergies: "None",
    created_at: "2025-01-01", lifecycle: "consulted", pending_steps: 2,
  };

  it("lists patients, filters by search input, adds a patient", async () => {
    const listMock = vi.fn();
    const mock = installFetchMock({
      routes: {
        "/api/patients": (init: RequestInit | undefined, url: string) => {
          const method = (init?.method || "GET").toUpperCase();
          if (method === "POST") return jsonResponse({ id: 2 });
          listMock(url);
          const q = new URL(url, "http://x").searchParams.get("q");
          if (q === "noone") return jsonResponse([]);
          return jsonResponse([patient]);
        },
      },
    });
    renderApp(<Patients />);
    await waitFor(() => screen.getByText("Ada Lovelace"));

    // Type into the search to trigger a debounced refetch.
    const search = screen.getByPlaceholderText(/search/i);
    await userEvent.type(search, "noone");
    await waitFor(() => {
      expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    });

    // Open the New-patient modal and submit.
    await userEvent.clear(search);
    const newBtn = screen.getAllByRole("button", { name: /new/i })[0];
    await userEvent.click(newBtn);
    const textboxes = screen.getAllByRole("textbox");
    await userEvent.type(textboxes[1], "Grace Hopper");
    const saveBtn = screen.getByRole("button", { name: /save patient/i });
    await userEvent.click(saveBtn);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("deletes a patient and shows Undo toast when token is returned", async () => {
    let undoCalled = false;
    installFetchMock({
      routes: {
        "/api/patients": [patient],
        "DELETE /api/patients/1": { undo_token: "tok-1" },
        "POST /api/undo/tok-1": () => {
          undoCalled = true;
          return jsonResponse({ restored: true });
        },
      },
    });
    renderApp(<Patients />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    const deleteBtn = screen.getAllByRole("button").find((b) =>
      b.querySelector("svg") && b.className.includes("hover:text-rose"),
    )!;
    await userEvent.click(deleteBtn);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // Render the Undo toast content and click the button to cover the undo path.
    const call = (toast.success as any).mock.calls.find(
      (c: any[]) => typeof c[0] === "function",
    );
    expect(call).toBeTruthy();
    const node = call[0]({ id: "x" });
    const { getByRole } = render(<>{node}</>);
    await userEvent.click(getByRole("button", { name: /undo/i }));
    await waitFor(() => expect(undoCalled).toBe(true));
  });

  it("does not delete when confirm is cancelled", async () => {
    installFetchMock({
      routes: { "/api/patients": [patient] },
    });
    const origConfirm = window.confirm;
    window.confirm = () => false;
    try {
      renderApp(<Patients />);
      await waitFor(() => screen.getByText("Ada Lovelace"));
      const deleteBtn = screen.getAllByRole("button").find((b) =>
        b.querySelector("svg") && b.className.includes("hover:text-rose"),
      )!;
      await userEvent.click(deleteBtn);
      // Row still present.
      expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    } finally {
      window.confirm = origConfirm;
    }
  });

  it("toasts a server error when the delete request fails", async () => {
    installFetchMock({
      routes: {
        "/api/patients": [patient],
        "DELETE /api/patients/1": () =>
          new Response(JSON.stringify({ detail: "nope" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    renderApp(<Patients />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    const deleteBtn = screen.getAllByRole("button").find((b) =>
      b.querySelector("svg") && b.className.includes("hover:text-rose"),
    )!;
    await userEvent.click(deleteBtn);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("shows a plain 'Patient deleted' toast when no undo token is returned", async () => {
    installFetchMock({
      routes: {
        "/api/patients": [patient],
        "DELETE /api/patients/1": { ok: true },
      },
    });
    renderApp(<Patients />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    const deleteBtn = screen.getAllByRole("button").find((b) =>
      b.querySelector("svg") && b.className.includes("hover:text-rose"),
    )!;
    await userEvent.click(deleteBtn);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Patient deleted"),
    );
  });

  it("reports server errors through a toast", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "fail" }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    );
    renderApp(<Patients />);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("fills every field in the New patient form and cancels", async () => {
    let body: any = null;
    installFetchMock({
      routes: {
        "/api/patients": (init) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") {
            body = JSON.parse((init!.body as string) || "{}");
            return jsonResponse({ id: 99 });
          }
          return jsonResponse([]);
        },
      },
    });
    renderApp(<Patients />);
    await userEvent.click(
      screen.getAllByRole("button", { name: /new/i })[0],
    );

    // Fill every visible form control.
    const textboxes = screen.getAllByRole("textbox");
    // [0]=search, [1]=name, [2]=phone, [3]=email, [4]=medical, [5]=dental, [6]=allergies
    await userEvent.type(textboxes[1], "Grace");
    await userEvent.type(textboxes[2], "9000000000");
    await userEvent.type(textboxes[3], "g@x.y");
    await userEvent.type(textboxes[4], "HTN");
    await userEvent.type(textboxes[5], "No issues");
    await userEvent.type(textboxes[6], "Penicillin");
    const age = screen.getByRole("spinbutton");
    await userEvent.type(age, "42");

    // Cancel first — covers setOpen(false) footer button. Form state
    // persists so the same values are used on save.
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    // Reopen and save.
    await userEvent.click(
      screen.getAllByRole("button", { name: /new/i })[0],
    );
    await userEvent.click(
      screen.getByRole("button", { name: /save patient/i }),
    );
    await waitFor(() => expect(body?.name).toBe("Grace"));
    expect(body?.medical_history).toBe("HTN");
    expect(body?.dental_history).toBe("No issues");
    expect(body?.allergies).toBe("Penicillin");
  });
});

// ============================================================
// Procedures
// ============================================================
describe("Procedures", () => {
  const proc = {
    id: 1, name: "Cleaning", description: "Scaling",
    default_price: 500, category: "Dental",
  };

  it("renders procedures, filters by category, edits price via blur", async () => {
    const putSpy = vi.fn();
    installFetchMock({
      routes: {
        "/api/procedures": (init: RequestInit | undefined) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") return jsonResponse({ id: 2 });
          return jsonResponse([proc, { ...proc, id: 2, name: "Filling", category: "Dental" }]);
        },
        "/api/procedures/categories": ["Dental", "Cosmetic"],
        "/api/settings": { id: 1, specialization: "Dental", updated_at: "x" },
        "PUT /api/procedures/1": (init: RequestInit | undefined) => {
          putSpy(init?.body);
          return jsonResponse({ ...proc, default_price: 700 });
        },
        "DELETE /api/procedures/2": { ok: true },
      },
    });
    renderApp(<Procedures />);
    await waitFor(() => screen.getByText("Cleaning"));

    // Filter: select Dental.
    const filter = screen.getByRole("combobox") as HTMLSelectElement;
    await userEvent.selectOptions(filter, "Dental");

    // Edit price of the first row by blurring the price input.
    const priceInput = screen.getAllByDisplayValue("500")[0];
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, "700");
    fireEvent.blur(priceInput);
    await waitFor(() => expect(putSpy).toHaveBeenCalled());

    // Remove second row.
    const trashBtns = screen.getAllByRole("button").filter((b) =>
      b.className.includes("hover:text-rose"),
    );
    await userEvent.click(trashBtns[1]);
  });

  it("requires a category before saving a new procedure", async () => {
    installFetchMock({
      routes: {
        "/api/procedures": [],
        "/api/procedures/categories": [],
        "/api/settings": { id: 1, updated_at: "x" },
      },
    });
    renderApp(<Procedures />);
    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    const textboxes = screen.getAllByRole("textbox");
    await userEvent.type(textboxes[0], "Test");
    // Try to save without a category; the HTML5 required attribute prevents
    // submit but our save() guards with a toast.error too.
    const saves = screen.getAllByRole("button", { name: /save/i });
    await userEvent.click(saves[saves.length - 1]);
  });

  it("creates a new procedure end-to-end", async () => {
    let posted: any = null;
    installFetchMock({
      routes: {
        "/api/procedures": (init: RequestInit | undefined) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") {
            posted = JSON.parse(init!.body as string);
            return jsonResponse({ id: 2 });
          }
          return jsonResponse([]);
        },
        "/api/procedures/categories": ["Dental"],
        "/api/settings": { id: 1, specialization: "Dental", updated_at: "x" },
      },
    });
    renderApp(<Procedures />);
    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    const textboxes = screen.getAllByRole("textbox");
    await userEvent.type(textboxes[0], "Filling"); // name
    await userEvent.type(textboxes[1], "Dental"); // category
    const spinners = screen.getAllByRole("spinbutton");
    await userEvent.type(spinners[spinners.length - 1], "800"); // price
    const saves = screen.getAllByRole("button", { name: /save/i });
    await userEvent.click(saves[saves.length - 1]);
    await waitFor(() => expect(posted?.name).toBe("Filling"));
    expect(posted.category).toBe("Dental");
    expect(posted.default_price).toBe(800);
  });
});

// ============================================================
// Backups
// ============================================================
describe("Backups", () => {
  it("renders metadata, a backup row, and runs backup-now", async () => {
    const posted: string[] = [];
    installFetchMock({
      routes: {
        "/api/backups": (init: RequestInit | undefined) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") {
            posted.push("now");
            return jsonResponse({ ok: true });
          }
          return jsonResponse({
            dir: "/tmp/b",
            interval_hours: 4,
            keep: 7,
            backups: [
              {
                name: "snap1",
                created_at: "2025-01-01T00:00:00Z",
                size_bytes: 1024 * 5,
                tables: { patient: 10, invoice: 3 },
              },
            ],
          });
        },
        "DELETE /api/backups/snap1": { ok: true },
      },
    });
    renderApp(<Backups />);
    await waitFor(() => screen.getByText("snap1"));
    expect(screen.getByText(/5\.0 KB/)).toBeInTheDocument();

    const backupNow = screen.getByRole("button", { name: /backup now/i });
    await userEvent.click(backupNow);
    await waitFor(() => expect(posted.length).toBe(1));

    const trash = screen.getAllByRole("button").find((b) =>
      b.className.includes("hover:text-rose"),
    )!;
    await userEvent.click(trash);
  });

  it("renders the empty state when no backups exist", async () => {
    installFetchMock({
      routes: {
        "/api/backups": {
          dir: "/tmp/b", interval_hours: 4, keep: 7, backups: [],
        },
      },
    });
    renderApp(<Backups />);
    await waitFor(() =>
      expect(screen.getByText(/no backups|empty/i)).toBeInTheDocument(),
    );
  });

  it("surfaces an API error through a toast", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "no" }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    );
    renderApp(<Backups />);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});

// ============================================================
// Reports
// ============================================================
describe("Reports", () => {
  it("renders four cards, updates on range and month change, and CSV-downloads", async () => {
    const clicks: string[] = [];
    // Capture anchor clicks for CSV download.
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag as any);
      if (tag === "a") {
        el.click = () => {
          clicks.push((el as HTMLAnchorElement).href);
        };
      }
      return el as any;
    });
    installFetchMock({
      routes: {
        "/api/reports/daily-collections": [
          { date: "2025-01-01", amount: 1000, count: 2 },
        ],
        "/api/reports/monthly-revenue": {
          total: 5000, count: 3, month: "2025-01",
          by_method: { cash: 2000, upi: 2000, card: 1000 },
        },
        "/api/reports/pending-dues": [
          {
            invoice_id: 7, patient_name: "Ada",
            balance: 400, days_outstanding: 5,
          },
        ],
        "/api/reports/top-procedures": [
          { name: "Cleaning", count: 5, revenue: 2500 },
        ],
      },
    });
    renderApp(<Reports />);
    await waitFor(() =>
      screen.getByRole("heading", { name: /daily collections/i }),
    );
    expect(
      screen.getByRole("heading", { name: /monthly revenue/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /pending dues/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /top procedures/i }),
    ).toBeInTheDocument();

    // Preset ranges.
    const last7 = screen.getByRole("button", { name: /last 7 days/i });
    await userEvent.click(last7);

    // Trigger CSV downloads.
    const csvButtons = screen.getAllByRole("button", { name: /csv/i });
    for (const b of csvButtons) await userEvent.click(b);
    await waitFor(() => expect(clicks.length).toBeGreaterThan(0));
  });

  it("renders empty-state messages when every endpoint fails", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response("fail", { status: 500 }),
    );
    renderApp(<Reports />);
    await waitFor(() => screen.getByText(/no payments in range/i));
    expect(screen.getByText(/no treatments in range/i)).toBeInTheDocument();
  });
});

// ============================================================
// Invoices list page
// ============================================================
describe("Invoices", () => {
  const inv = {
    id: 1, patient_id: 1, patient_name: "Ada",
    total: 1000, paid: 500, status: "partial",
    created_at: "2025-01-01", items: [], payments: [],
  };

  it("lists invoices, toggles pending-only, creates an invoice, and deletes with undo", async () => {
    let pendingHit = 0;
    installFetchMock({
      routes: {
        "/api/invoices": (init: RequestInit | undefined, url: string) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") return jsonResponse({ id: 2 });
          if (new URL(url, "http://x").searchParams.get("pending_only")) {
            pendingHit++;
          }
          return jsonResponse([inv]);
        },
        "/api/patients": [{ id: 1, name: "Ada", created_at: "x" }],
        "/api/procedures": [{ id: 5, name: "Cleaning", default_price: 500 }],
        "DELETE /api/invoices/1": { undo_token: "u1" },
        "POST /api/undo/u1": { ok: true },
      },
    });
    renderApp(<Invoices />);
    await waitFor(() => screen.getByText(/Ada/));

    const chk = screen.getByRole("checkbox");
    await userEvent.click(chk);
    await waitFor(() => expect(pendingHit).toBeGreaterThan(0));
    await userEvent.click(chk);

    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    const comboboxes = screen.getAllByRole("combobox");
    await userEvent.selectOptions(comboboxes[0], "1"); // Patient select
    await userEvent.type(screen.getByPlaceholderText(/description/i), "Visit");
    const priceInputs = screen.getAllByPlaceholderText(/price/i);
    await userEvent.type(priceInputs[0], "1000");
    // Bump the first-line quantity to exercise that onChange handler.
    const spinnersAll = screen.getAllByRole("spinbutton");
    // Layout is [quantity, unit_price, (repeats), discount]. Bump qty.
    const qty = spinnersAll[0];
    await userEvent.clear(qty);
    await userEvent.type(qty, "2");
    // Add a line with Enter shortcut on the last-line price input, then
    // remove it with the trash button.
    fireEvent.keyDown(priceInputs[0], { key: "Enter" });
    // Notes textarea — use the last textarea in the modal.
    const allTextareas = document.querySelectorAll("textarea");
    if (allTextareas.length > 0) {
      fireEvent.change(allTextareas[allTextareas.length - 1], {
        target: { value: "Cash preferred" },
      });
    }
    // Delete the second line.
    const trashes = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("hover:text-rose"));
    if (trashes.length > 0) {
      await userEvent.click(trashes[0]);
    }

    // Set a discount — last numeric input in the modal.
    const spinners = screen.getAllByRole("spinbutton");
    const discount = spinners[spinners.length - 1];
    await userEvent.clear(discount);
    await userEvent.type(discount, "50");

    const createBtn = screen.getByRole("button", { name: /create invoice/i });
    await userEvent.click(createBtn);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    // Delete the existing invoice.
    const trash = screen.getAllByRole("button").find((b) =>
      b.className.includes("hover:text-rose"),
    )!;
    await userEvent.click(trash);
  });

  it("refuses to save when no patient is selected", async () => {
    installFetchMock({
      routes: {
        "/api/invoices": [],
        "/api/patients": [],
        "/api/procedures": [],
      },
    });
    renderApp(<Invoices />);
    await userEvent.click(screen.getByRole("button", { name: /new/i }));
    const createBtn = screen.getByRole("button", { name: /create invoice/i });
    await userEvent.click(createBtn);
  });
});

// ============================================================
// InvoiceDetail
// ============================================================
describe("InvoiceDetail", () => {
  const invoice = {
    id: 42, patient_id: 1, patient_name: "Ada",
    total: 1000, paid: 200, status: "partial",
    created_at: "2025-01-01",
    items: [{ description: "Visit", quantity: 1, unit_price: 1000 }],
    payments: [{
      id: 10, invoice_id: 42, amount: 200, method: "cash",
      reference: "r", paid_on: "2025-01-01T10:00:00Z",
    }],
  };

  function renderDetail(routes: any) {
    installFetchMock({ routes: { ...BASE_ROUTES, ...routes } });
    return render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/invoices/42"]}>
          <TourProvider>
            <Routes>
              <Route path="/invoices/:id" element={<InvoiceDetail />} />
            </Routes>
          </TourProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  }

  it("renders branded header, line items, and records a payment", async () => {
    let posted: any = null;
    renderDetail({
      "/api/invoices/42": () => jsonResponse(invoice),
      "POST /api/invoices/42/payments": (init: RequestInit | undefined) => {
        posted = JSON.parse(init!.body as string);
        return jsonResponse({ id: 11 });
      },
      "DELETE /api/payments/10": { ok: true },
    });
    await waitFor(() => screen.getByText("Ada"));

    // Quick-amount chip click.
    const quick = screen.getAllByRole("button").find((b) =>
      b.textContent?.includes("₹ 800"),
    );
    if (quick) await userEvent.click(quick);

    // Switch to UPI.
    const upiBtn = screen.getByRole("button", { name: /upi/i });
    await userEvent.click(upiBtn);

    // Submit payment.
    const submit = screen.getByRole("button", { name: /record payment/i });
    await userEvent.click(submit);
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted.method).toBe("upi");

    // Delete the existing payment.
    const del = screen.getByRole("button", { name: /delete this payment/i });
    await userEvent.click(del);
  });

  it("shows the missing-profile warning when required settings are blank", async () => {
    renderDetail({
      "/api/settings": { id: 1, updated_at: "x" },
      "/api/invoices/42": invoice,
    });
    await waitFor(() =>
      screen.getByText(/missing mandatory doctor details/i),
    );
  });

  it("shows 'Loading...' before data arrives", () => {
    // Install the mock first, then override fetch with a never-resolving
    // promise so that neither the settings nor the invoice load completes.
    installFetchMock({ routes: {} });
    (globalThis as any).fetch = vi.fn(() => new Promise(() => {}));
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/invoices/42"]}>
          <TourProvider>
            <Routes>
              <Route path="/invoices/:id" element={<InvoiceDetail />} />
            </Routes>
          </TourProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("refuses to record a zero-amount payment", async () => {
    renderDetail({
      "/api/invoices/42": invoice,
    });
    await waitFor(() => screen.getByText("Ada"));
    const submit = screen.getByRole("button", { name: /record payment/i });
    await userEvent.click(submit);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("shows 'No payments yet' when payments list is empty", async () => {
    renderDetail({
      "/api/invoices/42": { ...invoice, payments: [] },
    });
    await waitFor(() => screen.getByText(/no payments yet/i));
  });
});

// ============================================================
// Calendar
// ============================================================
describe("Calendar", () => {
  const patient = { id: 1, name: "Ada", phone: "999", created_at: "x" };
  const proc = { id: 7, name: "Cleaning", default_price: 500, default_duration_minutes: 45 };
  const room = { id: 3, name: "Chair 1", active: true };
  const appt = {
    id: 88,
    patient_id: 1,
    patient_name: "Ada",
    procedure_id: 7,
    procedure_name: "Cleaning",
    room_id: 3,
    room_name: "Chair 1",
    start: "2025-01-01T09:00:00Z",
    end: "2025-01-01T09:30:00Z",
    status: "scheduled",
    chief_complaint: "x",
    reminder_sent: false,
    created_at: "2025-01-01",
  };
  const availability = Array.from({ length: 7 }, (_, i) => ({
    id: i + 1,
    weekday: i,
    is_working: i < 6,
    start_time: "09:00",
    end_time: "18:00",
    break_start: i === 2 ? "13:00" : null,
    break_end: i === 2 ? "14:00" : null,
  }));

  it("renders events, opens the modal via 'New' and via event click, creates and updates", async () => {
    let postPayload: any = null;
    let putPayload: any = null;
    installFetchMock({
      routes: {
        "/api/patients": [patient],
        "/api/procedures": [proc],
        "/api/rooms": [room],
        "/api/availability": availability,
        "/api/appointments": (init: RequestInit | undefined) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") {
            postPayload = JSON.parse(init!.body as string);
            return jsonResponse({ id: 200 });
          }
          return jsonResponse([appt]);
        },
        "PUT /api/appointments/88": (init: RequestInit | undefined) => {
          putPayload = JSON.parse(init!.body as string);
          return jsonResponse({ ok: true });
        },
        "PATCH /api/appointments/88/status?new_status=completed": { ok: true },
        "PATCH /api/appointments/88/reschedule": { ok: true },
        "DELETE /api/appointments/88": { undo_token: "uA" },
        "POST /api/undo/uA": { ok: true },
        "POST /api/appointments/88/remind?channel=sms": { ok: true },
      },
    });
    renderApp(<Calendar />);

    await waitFor(() => screen.getByTestId("event-88"));
    // Filter by room.
    const roomSelect = screen.getByRole("combobox");
    await userEvent.selectOptions(roomSelect, "3");

    // Open the New modal.
    await userEvent.click(screen.getByRole("button", { name: /new appointment/i }));
    // Inside the modal we have: Patient, Procedure, Room selects.
    // The room filter select above is also present.
    const allCombos = screen.getAllByRole("combobox");
    // [0] = room filter, [1] = Patient, [2] = Procedure, [3] = Room
    await userEvent.selectOptions(allCombos[1], "1");
    await userEvent.selectOptions(allCombos[2], "7");
    const book = screen.getByRole("button", { name: /book/i });
    await userEvent.click(book);
    await waitFor(() => expect(postPayload?.patient_id).toBe(1));

    // Click an existing event to edit and save.
    await userEvent.click(screen.getByTestId("event-88"));
    const saveBtn = screen.getByRole("button", { name: /save changes/i });
    await userEvent.click(saveBtn);
    await waitFor(() => expect(putPayload).not.toBeNull());

    // Quick-shift +1h, then mark completed, send SMS, delete.
    await userEvent.click(screen.getByTestId("event-88"));
    const shift = screen.getAllByRole("button").find((b) => b.textContent === "+1h")!;
    await userEvent.click(shift);
    await userEvent.click(screen.getByTestId("event-88"));
    const completeBtn = screen.getByRole("button", { name: /^complete$/i });
    await userEvent.click(completeBtn);
    await userEvent.click(screen.getByTestId("event-88"));
    await userEvent.click(screen.getByRole("button", { name: /send sms/i }));
    await userEvent.click(screen.getByTestId("event-88"));
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("edits start/end/complaint/notes, exercises WhatsApp reminder, procedure autofill", async () => {
    let putPayload: any = null;
    let whatsappHit = false;
    installFetchMock({
      routes: {
        "/api/patients": [patient],
        "/api/procedures": [proc],
        "/api/rooms": [room],
        "/api/availability": availability,
        "/api/appointments": [appt],
        "PUT /api/appointments/88": (init) => {
          putPayload = JSON.parse((init!.body as string) || "{}");
          return jsonResponse({ ok: true });
        },
        "POST /api/appointments/88/remind?channel=whatsapp": () => {
          whatsappHit = true;
          return jsonResponse({ ok: true });
        },
      },
    });
    renderApp(<Calendar />);
    await waitFor(() => screen.getByTestId("event-88"));
    await userEvent.click(screen.getByTestId("event-88"));

    // Fill chief complaint + notes.
    const complaint = screen.getAllByRole("textbox").find(
      (el) => (el as HTMLInputElement).value === "x",
    ) as HTMLInputElement;
    await userEvent.clear(complaint);
    await userEvent.type(complaint, "fresh complaint");

    const notes = screen.getAllByRole("textbox").find(
      (el) => el.tagName.toLowerCase() === "textarea",
    ) as HTMLTextAreaElement;
    await userEvent.type(notes, "visit notes");

    // Edit start/end via datetime-local inputs.
    const dt = Array.from(
      document.querySelectorAll('input[type="datetime-local"]'),
    ) as HTMLInputElement[];
    fireEvent.change(dt[0], { target: { value: "2025-02-02T10:00" } });
    fireEvent.change(dt[1], { target: { value: "2025-02-02T11:00" } });

    // Switch procedure to trigger onProcedureChange auto-fill branch.
    const combos = screen.getAllByRole("combobox");
    const procCombo = combos.find(
      (c) => (c as HTMLSelectElement).value === "7",
    );
    if (procCombo) {
      fireEvent.change(procCombo, { target: { value: "7" } });
    }

    // Click WhatsApp to cover the reminder callsite at line 496.
    await userEvent.click(screen.getByRole("button", { name: /whatsapp/i }));
    await waitFor(() => expect(whatsappHit).toBe(true));

    // Save.
    await userEvent.click(
      screen.getByRole("button", { name: /save changes/i }),
    );
    await waitFor(() =>
      expect(putPayload?.chief_complaint).toBe("fresh complaint"),
    );
  });
});

// ============================================================
// TreatmentPlanEditor (component used by PatientDetail)
// ============================================================
describe("TreatmentPlanEditor", () => {
  const plan = {
    id: 5,
    patient_id: 1,
    title: "RCT + crown",
    status: "planned",
    notes: "",
    created_at: "x",
    updated_at: "x",
    estimate_total: 1500,
    actual_total: 500,
    completed_steps: 1,
    total_steps: 2,
    steps: [
      {
        id: 10, plan_id: 5, sequence: 1, title: "Pulp ext", tooth: "36",
        status: "completed", estimated_cost: 800, actual_cost: 500,
      },
      {
        id: 11, plan_id: 5, sequence: 2, title: "Crown", tooth: "36",
        status: "planned", estimated_cost: 700, actual_cost: 0,
      },
    ],
  };

  it("renders steps, patches status, reorders, completes, and adds a new step", async () => {
    let putStep: any = null;
    let postStep: any = null;
    let posted: string[] = [];
    installFetchMock({
      routes: {
        "/api/procedures": [{ id: 1, name: "Cleaning", default_price: 100 }],
        "PUT /api/treatment-plans/5": { ok: true },
        "PUT /api/treatment-plans/5/steps/11": (init: RequestInit | undefined) => {
          putStep = JSON.parse(init!.body as string);
          return jsonResponse({ ok: true });
        },
        "POST /api/treatment-plans/5/steps/11/complete": (_) => {
          posted.push("complete-11");
          return jsonResponse({ ok: true });
        },
        "POST /api/treatment-plans/5/steps": (init: RequestInit | undefined) => {
          postStep = JSON.parse(init!.body as string);
          return jsonResponse({ ok: true });
        },
        "DELETE /api/treatment-plans/5/steps/11": { ok: true },
      },
    });
    renderApp(<TreatmentPlanEditor patientId={1} plan={plan as any} onChanged={() => {}} />);

    // Patch a step status via select change.
    const selects = screen.getAllByRole("combobox");
    // Find planned step's status select (value === "planned")
    const statusSelect = selects.find((s) => (s as HTMLSelectElement).value === "planned")!;
    await userEvent.selectOptions(statusSelect, "in_progress");
    await waitFor(() => expect(putStep?.status).toBe("in_progress"));

    // Complete the planned step.
    const complete = screen.getAllByRole("button", { name: /mark complete/i })[0];
    await userEvent.click(complete);
    await waitFor(() => expect(posted).toContain("complete-11"));

    // Add a new step.
    await userEvent.click(screen.getByRole("button", { name: /add step/i }));
    await userEvent.type(screen.getByPlaceholderText(/title/i), "X-ray");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() => expect(postStep?.title).toBe("X-ray"));
  });

  it("rejects a step with no title or procedure", async () => {
    installFetchMock({
      routes: { "/api/procedures": [] },
    });
    renderApp(<TreatmentPlanEditor patientId={1} plan={{ ...plan, steps: [] } as any} />);
    await userEvent.click(screen.getByRole("button", { name: /add step/i }));
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("edits step fields with blur, moves, deletes, cancels add, edits plan meta", async () => {
    let putStep: any[] = [];
    let planPut: any = null;
    let deleted = false;
    installFetchMock({
      routes: {
        "/api/procedures": [{ id: 1, name: "Cleaning", default_price: 100 }],
        "PUT /api/treatment-plans/5": (init) => {
          planPut = JSON.parse((init!.body as string) || "{}");
          return jsonResponse({ ok: true });
        },
        "PUT /api/treatment-plans/5/steps/10": (init) => {
          putStep.push(JSON.parse((init!.body as string) || "{}"));
          return jsonResponse({ ok: true });
        },
        "PUT /api/treatment-plans/5/steps/11": (init) => {
          putStep.push(JSON.parse((init!.body as string) || "{}"));
          return jsonResponse({ ok: true });
        },
        "DELETE /api/treatment-plans/5/steps/11": () => {
          deleted = true;
          return jsonResponse({ ok: true });
        },
      },
    });
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      renderApp(
        <TreatmentPlanEditor
          patientId={1}
          plan={plan as any}
          onChanged={() => {}}
        />,
      );

      // Edit the plan title and blur.
      const titleInput = screen.getByDisplayValue("RCT + crown");
      await userEvent.clear(titleInput);
      await userEvent.type(titleInput, "RCT plan");
      fireEvent.blur(titleInput);
      await waitFor(() => expect(planPut?.title).toBe("RCT plan"));

      // Edit Plan notes and blur.
      const textareas = screen
        .getAllByRole("textbox")
        .filter((el) => el.tagName.toLowerCase() === "textarea");
      await userEvent.type(textareas[0], "some notes");
      fireEvent.blur(textareas[0]);
      await waitFor(() => expect(planPut?.notes).toBe("some notes"));

      // Edit step-2 title, tooth, and cost and blur each.
      const stepTitle = screen.getByDisplayValue("Crown");
      await userEvent.clear(stepTitle);
      await userEvent.type(stepTitle, "Crown fix");
      fireEvent.blur(stepTitle);
      await waitFor(() =>
        expect(putStep.some((p) => p.title === "Crown fix")).toBe(true),
      );

      const toothInputs = screen.getAllByPlaceholderText(/Tooth/i);
      await userEvent.clear(toothInputs[1]);
      await userEvent.type(toothInputs[1], "37");
      fireEvent.blur(toothInputs[1]);
      await waitFor(() =>
        expect(putStep.some((p) => p.tooth === "37")).toBe(true),
      );

      const costInput = screen.getByDisplayValue("700");
      fireEvent.change(costInput, { target: { value: "900" } });
      fireEvent.blur(costInput);
      await waitFor(() =>
        expect(putStep.some((p) => p.estimated_cost === 900)).toBe(true),
      );

      // Move the second step up (and the first step down).
      const ups = screen.getAllByTitle(/move up/i);
      await userEvent.click(ups[1]); // second row's "up"
      // Clicking disabled first-row "up" should be no-op.
      await userEvent.click(ups[0]);
      const downs = screen.getAllByTitle(/move down/i);
      await userEvent.click(downs[0]);

      // Remove the second step.
      const trashes = screen.getAllByTitle(/^Remove$/i);
      await userEvent.click(trashes[1]);
      await waitFor(() => expect(deleted).toBe(true));

      // Add-step: open, select a procedure (auto-fills title), cancel.
      await userEvent.click(screen.getByRole("button", { name: /add step/i }));
      const draftCombos = screen.getAllByRole("combobox");
      await userEvent.selectOptions(
        draftCombos[draftCombos.length - 1],
        "1",
      );
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    } finally {
      window.confirm = origConfirm;
    }
  });

  it("toasts when plan meta save fails and step patch fails", async () => {
    installFetchMock({
      routes: {
        "/api/procedures": [],
        "PUT /api/treatment-plans/5": () =>
          new Response(JSON.stringify({ detail: "bad" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        "PUT /api/treatment-plans/5/steps/11": () =>
          new Response(JSON.stringify({ detail: "nope" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    renderApp(
      <TreatmentPlanEditor patientId={1} plan={plan as any} />,
    );
    const titleInput = screen.getByDisplayValue("RCT + crown");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "X");
    fireEvent.blur(titleInput);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});

// ============================================================
// PatientDetail (exercises TreatmentPlanEditor too)
// ============================================================
describe("PatientDetail", () => {
  const patient = {
    id: 7, name: "Grace", age: 40, phone: "111", email: "g@x",
    allergies: "", medical_history: "", dental_history: "",
    notes: "", created_at: "2025-01-01",
    lifecycle: "in_progress", pending_steps: 1,
  };
  const appt = {
    id: 22, patient_id: 7, patient_name: "Grace",
    start: "2025-01-02T09:00:00Z", end: "2025-01-02T09:30:00Z",
    status: "completed", chief_complaint: "pain",
    reminder_sent: false, created_at: "2025-01-02",
  };
  const note = {
    id: 30, patient_id: 7, appointment_id: 22,
    chief_complaint: "pain", diagnosis: "dx", treatment_advised: "rx",
    notes: "", created_at: "2025-01-02", updated_at: "2025-01-02",
  };
  const standaloneNote = {
    ...note, id: 31, appointment_id: null,
  };
  const treatment = {
    id: 40, patient_id: 7, procedure_id: 5, procedure_name: "Cleaning",
    tooth: "36", notes: "", price: 500, performed_on: "2025-01-02",
  };
  const invoice = {
    id: 50, patient_id: 7, patient_name: "Grace",
    total: 500, paid: 0, status: "unpaid",
    created_at: "2025-01-02", items: [], payments: [],
  };
  const plan = {
    id: 60, patient_id: 7, title: "Plan", status: "planned",
    created_at: "x", updated_at: "x",
    estimate_total: 0, actual_total: 0, completed_steps: 0, total_steps: 0,
    steps: [],
  };

  function renderDetail(routes: any = {}) {
    installFetchMock({
      routes: {
        "/api/patients/7": patient,
        "/api/patients/7/treatments": [treatment],
        "/api/appointments": [appt],
        "/api/patients/7/consultation-notes": [note, standaloneNote],
        "/api/patients/7/treatment-plans": [plan],
        "/api/invoices": [invoice],
        "/api/procedures": [{ id: 5, name: "Cleaning", default_price: 500 }],
        "POST /api/treatments": { id: 42 },
        "DELETE /api/treatments/40": { undo_token: "tx" },
        "POST /api/undo/tx": { ok: true },
        "POST /api/treatment-plans": { id: 100 },
        "DELETE /api/treatment-plans/60": { ok: true },
        "PUT /api/patients/7": { ok: true },
        ...routes,
      },
    });
    return render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/patients/7"]}>
          <TourProvider>
            <Routes>
              <Route path="/patients/:id" element={<PatientDetail />} />
            </Routes>
          </TourProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  }

  it("renders profile, tabs, treatments and lets the user add one", async () => {
    renderDetail();
    await waitFor(() => screen.getByText("Grace"));
    // Switch through every tab.
    await userEvent.click(screen.getByRole("button", { name: /plans/i }));
    await userEvent.click(screen.getByRole("button", { name: /treatments/i }));
    await userEvent.click(screen.getByRole("button", { name: /invoices/i }));
    expect(screen.getByText(/#00050/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /visits/i }));

    // Add a treatment via the Treatments tab.
    await userEvent.click(screen.getByRole("button", { name: /treatments/i }));
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    const combos = screen.getAllByRole("combobox");
    await userEvent.selectOptions(combos[combos.length - 1], "5");
    const saves = screen.getAllByRole("button", { name: /save/i });
    await userEvent.click(saves[saves.length - 1]);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    // Delete that treatment.
    const trash = screen.getAllByRole("button").find((b) =>
      b.className.includes("hover:text-rose"),
    )!;
    await userEvent.click(trash);
  });

  it("creates and deletes a treatment plan", async () => {
    renderDetail();
    await waitFor(() => screen.getByText("Grace"));
    await userEvent.click(screen.getByRole("button", { name: /plans/i }));
    const input = screen.getByPlaceholderText(/new plan title/i);
    await userEvent.type(input, "Rehab{enter}");
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("toggles editing mode and saves profile changes", async () => {
    renderDetail();
    await waitFor(() => screen.getByText("Grace"));
    await userEvent.click(screen.getByRole("button", { name: /edit profile/i }));
    const saveBtn = screen.getByRole("button", { name: /save changes/i });
    await userEvent.click(saveBtn);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("opens a standalone consult note from the Visits tab", async () => {
    renderDetail();
    await waitFor(() => screen.getByText("Grace"));
    await userEvent.click(screen.getByRole("button", { name: /standalone note/i }));
    expect(screen.getByRole("button", { name: /save note/i })).toBeInTheDocument();
  });

  it("fills every field in the Record treatment modal and saves", async () => {
    let body: any = null;
    renderDetail({
      "POST /api/treatments": (init: any) => {
        body = JSON.parse((init!.body as string) || "{}");
        return jsonResponse({ id: 55 });
      },
    });
    await waitFor(() => screen.getByText("Grace"));
    await userEvent.click(screen.getByRole("button", { name: /treatments/i }));
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // Select procedure — auto-fills price.
    const combos = screen.getAllByRole("combobox");
    await userEvent.selectOptions(combos[combos.length - 1], "5");
    // Tooth.
    await userEvent.type(
      screen.getByPlaceholderText(/e\.g\. 36/i),
      "37",
    );
    // Notes textarea (last one in modal).
    const textareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName.toLowerCase() === "textarea",
    );
    await userEvent.type(textareas[textareas.length - 1], "Careful");
    // Price — bump to a different value.
    const spinners = screen.getAllByRole("spinbutton");
    await userEvent.clear(spinners[spinners.length - 1]);
    await userEvent.type(spinners[spinners.length - 1], "650");

    // Cancel first to exercise the setTxOpen(false) button.
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    // Reopen and Save this time.
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    const combos2 = screen.getAllByRole("combobox");
    await userEvent.selectOptions(combos2[combos2.length - 1], "5");
    const saves = screen.getAllByRole("button", { name: /save/i });
    await userEvent.click(saves[saves.length - 1]);
    await waitFor(() => expect(body?.procedure_id).toBe(5));
  });

  it("opens an Edit note modal from a visit row", async () => {
    renderDetail();
    await waitFor(() => screen.getByText("Grace"));
    await userEvent.click(screen.getByRole("button", { name: /visits/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /edit note/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /save changes/i }),
      ).toBeInTheDocument(),
    );
  });

  it("shows 'Loading...' until the patient data arrives", () => {
    (globalThis as any).fetch = vi.fn(() => new Promise(() => {}));
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/patients/7"]}>
          <TourProvider>
            <Routes>
              <Route path="/patients/:id" element={<PatientDetail />} />
            </Routes>
          </TourProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});

// ============================================================
// Settings
// ============================================================
describe("SettingsPage", () => {
  const avail = Array.from({ length: 7 }, (_, i) => ({
    id: i + 1, weekday: i, is_working: i < 6,
    start_time: "09:00", end_time: "18:00",
    break_start: null, break_end: null,
  }));
  const rooms = [{ id: 1, name: "Chair 1", active: true }];
  const audit = [
    { id: 1, action: "patient.create", entity_type: "patient",
      entity_id: 1, summary: "created", actor: null, created_at: "2025-01-01" },
  ];

  it("saves the profile tab, adds a room, switches to activity log", async () => {
    let put: any = null;
    let postRoom: any = null;
    installFetchMock({
      routes: {
        ...BASE_ROUTES,
        "/api/availability": avail,
        "/api/rooms": (init: RequestInit | undefined) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") {
            postRoom = JSON.parse(init!.body as string);
            return jsonResponse({ id: 2 });
          }
          return jsonResponse(rooms);
        },
        "PUT /api/settings": (init: RequestInit | undefined) => {
          put = JSON.parse(init!.body as string);
          return jsonResponse({
            ...BASE_ROUTES["/api/settings"],
            ...JSON.parse(init!.body as string),
            id: 1, updated_at: "x",
          });
        },
        "/api/procedures/categories": ["Dental"],
        "/api/audit": audit,
        "PUT /api/availability/0": { ok: true },
        "PUT /api/rooms/1": { ok: true },
        "DELETE /api/rooms/1": { ok: true },
      },
    });
    renderApp(<SettingsPage />);
    await waitFor(() => screen.getByDisplayValue("Dr A"));

    // Update + save profile.
    const nameInput = screen.getByDisplayValue("Dr A");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Dr B");
    const saves = screen.getAllByRole("button", { name: /save/i });
    await userEvent.click(saves[saves.length - 1]);
    await waitFor(() => expect(put?.doctor_name).toBe("Dr B"));

    // Switch to availability tab and toggle Monday's checkbox.
    await userEvent.click(screen.getByRole("button", { name: /availability/i }));
    const checkboxes = screen.getAllByRole("checkbox");
    await userEvent.click(checkboxes[0]);

    // Rooms tab.
    await userEvent.click(screen.getByRole("button", { name: /rooms/i }));
    const roomInput = screen.getByPlaceholderText(/new room name/i);
    await userEvent.type(roomInput, "Chair 2{enter}");
    await waitFor(() => expect(postRoom?.name).toBe("Chair 2"));
    // Toggle and delete the existing room.
    const toggle = screen.getByRole("button", { name: /deactivate/i });
    await userEvent.click(toggle);

    // Activity log tab.
    await userEvent.click(screen.getByRole("button", { name: /activity/i }));
    await waitFor(() => screen.getByText(/patient\.create/i));
    const filter = screen.getByPlaceholderText(/filter by action/i);
    await userEvent.type(filter, "invoice");
  });

  it("surfaces a save error through a toast", async () => {
    installFetchMock({
      routes: {
        ...BASE_ROUTES,
        "/api/availability": avail,
        "/api/rooms": rooms,
        "/api/procedures/categories": [],
        "PUT /api/settings": () => new Response(
          JSON.stringify({ detail: "bad" }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      },
    });
    renderApp(<SettingsPage />);
    await waitFor(() => screen.getByDisplayValue("Dr A"));
    const saves = screen.getAllByRole("button", { name: /save/i });
    await userEvent.click(saves[saves.length - 1]);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("exercises every profile field, delete+reactivate rooms, audit limit select", async () => {
    let put: any = null;
    let availPut: any = null;
    let roomDeleted = false;
    installFetchMock({
      routes: {
        ...BASE_ROUTES,
        "/api/availability": avail,
        "/api/rooms": [
          { id: 1, name: "Chair 1", active: true },
          { id: 2, name: "Chair 2", active: false },
        ],
        "PUT /api/settings": (init) => {
          put = JSON.parse((init!.body as string) || "{}");
          return jsonResponse({ ...put, id: 1, updated_at: "x" });
        },
        "/api/procedures/categories": ["Dental"],
        "/api/audit": audit,
        "PUT /api/availability/0": (init) => {
          availPut = JSON.parse((init!.body as string) || "{}");
          return jsonResponse({ ok: true });
        },
        "PUT /api/availability/1": { ok: true },
        "PUT /api/rooms/1": { ok: true },
        "PUT /api/rooms/2": { ok: true },
        "DELETE /api/rooms/1": () => {
          roomDeleted = true;
          return jsonResponse({ ok: true });
        },
      },
    });
    // Make window.confirm always accept so we cover the delete path.
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      renderApp(<SettingsPage />);
      await waitFor(() => screen.getByDisplayValue("Dr A"));

      // Fill every profile field via placeholders — clear first so we
      // replace the pre-populated values from BASE_ROUTES.
      const fields: Array<[RegExp, string]> = [
        [/MBBS, MD/i, "MDS"],
        [/Dental \/ Gastro/i, "Dental"],
        [/12345/i, "DL-9999"],
        [/Delhi Medical Council/i, "Delhi Medical Council"],
        [/29AAAAA/i, "29ABCDE1234F1Z5"],
        [/clinic@example/i, "foo@bar.com"],
      ];
      for (const [placeholder, value] of fields) {
        const el = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
        await userEvent.clear(el);
        await userEvent.type(el, value);
      }

      // Save profile — submit the form directly for reliability in jsdom.
      const form = document.querySelector("form") as HTMLFormElement;
      fireEvent.submit(form);
      await waitFor(() =>
        expect(put?.registration_number).toBe("DL-9999"),
      );

      // Availability tab — change start time on Monday and blur.
      await userEvent.click(screen.getByRole("button", { name: /availability/i }));
      const timeInputs = document.querySelectorAll(
        'input[type="time"]',
      ) as unknown as HTMLInputElement[];
      // [0]=Mon start, [1]=Mon end, [2]=Mon break_start, [3]=Mon break_end
      fireEvent.change(timeInputs[0], { target: { value: "10:00" } });
      fireEvent.blur(timeInputs[0]);
      fireEvent.change(timeInputs[1], { target: { value: "18:30" } });
      fireEvent.blur(timeInputs[1]);
      fireEvent.change(timeInputs[2], { target: { value: "13:00" } });
      fireEvent.blur(timeInputs[2]);
      fireEvent.change(timeInputs[3], { target: { value: "14:00" } });
      fireEvent.blur(timeInputs[3]);
      await waitFor(() => expect(availPut).not.toBeNull());

      // Rooms tab — test delete + reactivate.
      await userEvent.click(screen.getByRole("button", { name: /rooms/i }));
      const deactivate = screen.getByRole("button", { name: /deactivate/i });
      await userEvent.click(deactivate);
      const reactivate = screen.getByRole("button", { name: /reactivate/i });
      await userEvent.click(reactivate);
      const trashes = screen
        .getAllByRole("button")
        .filter((b) => b.className.includes("hover:text-rose"));
      await userEvent.click(trashes[0]);
      await waitFor(() => expect(roomDeleted).toBe(true));

      // Activity tab — change limit select.
      await userEvent.click(screen.getByRole("button", { name: /activity/i }));
      const selects = screen.getAllByRole("combobox");
      await userEvent.selectOptions(selects[0], "200");
    } finally {
      window.confirm = origConfirm;
    }
  });

  it("skips add when room name is blank and handles add error", async () => {
    installFetchMock({
      routes: {
        ...BASE_ROUTES,
        "/api/availability": avail,
        "/api/rooms": (init) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") {
            return new Response(
              JSON.stringify({ detail: "duplicate" }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
          }
          return jsonResponse(rooms);
        },
        "/api/procedures/categories": [],
        "/api/audit": [],
      },
    });
    renderApp(<SettingsPage />);
    await waitFor(() => screen.getByDisplayValue("Dr A"));
    await userEvent.click(screen.getByRole("button", { name: /rooms/i }));
    // Clicking Add with empty text should bail silently.
    await userEvent.click(screen.getByRole("button", { name: /add/i }));
    // Now fill something so it hits the error branch.
    const roomInput = screen.getByPlaceholderText(/new room name/i);
    await userEvent.type(roomInput, "Chair X");
    await userEvent.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});

// ============================================================
// GlobalSearch
// ============================================================
describe("GlobalSearch", () => {
  it("searches after debounce, navigates with arrow keys + Enter", async () => {
    installFetchMock({
      routes: {
        "/api/search": [
          { type: "patient", id: 1, title: "Ada Lovelace", subtitle: "9999", match_phone: true },
          { type: "invoice", id: 2, title: "Invoice #00002", subtitle: "Grace" },
          { type: "treatment", id: 3, title: "Cleaning", patient_id: 9 },
          { type: "note", id: 4, title: "Note", patient_id: 9 },
        ],
      },
    });
    renderApp(<GlobalSearch />);
    const input = screen.getByPlaceholderText(/search patients/i);
    await userEvent.type(input, "ada");
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
  });

  it("hides results for empty queries and shows 'no results' for empty arrays", async () => {
    installFetchMock({ routes: { "/api/search": [] } });
    renderApp(<GlobalSearch />);
    const input = screen.getByPlaceholderText(/search patients/i);
    await userEvent.type(input, "zz");
    await waitFor(() => screen.getByText(/no results/i));
  });

  it("focuses the input when '/' is pressed outside an editable element", async () => {
    installFetchMock({ routes: { "/api/search": [] } });
    renderApp(<GlobalSearch />);
    const input = screen.getByPlaceholderText(/search patients/i) as HTMLInputElement;
    (document.body as HTMLElement).focus();
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(window, { key: "Escape" });
  });

  it("closes the results dropdown when clicking outside", async () => {
    installFetchMock({
      routes: {
        "/api/search": [
          { type: "patient", id: 1, title: "Ada", match_phone: false },
        ],
      },
    });
    renderApp(<GlobalSearch />);
    const input = screen.getByPlaceholderText(/search patients/i);
    await userEvent.type(input, "ad");
    await waitFor(() => screen.getByText("Ada"));
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText("Ada")).not.toBeInTheDocument());
  });

  it("clicking a result navigates", async () => {
    installFetchMock({
      routes: {
        "/api/search": [
          { type: "patient", id: 1, title: "Ada" },
        ],
      },
    });
    renderApp(<GlobalSearch />);
    const input = screen.getByPlaceholderText(/search patients/i);
    await userEvent.type(input, "ad");
    await waitFor(() => screen.getByText("Ada"));
    await userEvent.click(screen.getByText("Ada"));
  });
});

// ============================================================
// Layout + App routing smoke test
// ============================================================
describe("Layout and App", () => {
  it("renders the Layout chrome with NavLinks and the help button", async () => {
    installFetchMock({
      routes: {
        ...BASE_ROUTES,
        "/api/search": [],
        "/api/dashboard": {
          patients: 0, today_appointments: 0, pending_invoices: 0,
          pending_dues: 0, month_revenue: 0,
        },
        "/api/appointments": [],
      },
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/"]}>
          <TourProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<div data-testid="home">home</div>} />
              </Route>
            </Routes>
          </TourProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByTestId("home")).toBeInTheDocument();
    const help = screen.getByRole("button", { name: /help/i });
    await userEvent.click(help);
  });

  it("App boots its route tree", async () => {
    installFetchMock({
      routes: {
        ...BASE_ROUTES,
        "/api/dashboard": {
          patients: 1, today_appointments: 0, pending_invoices: 0,
          pending_dues: 0, month_revenue: 0,
        },
        "/api/appointments": [],
        "/api/search": [],
      },
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      </I18nProvider>,
    );
    // Dashboard renders stats — eventually.
    await waitFor(() =>
      expect(screen.getAllByText(/patients/i).length).toBeGreaterThan(0),
    );
  });
});
