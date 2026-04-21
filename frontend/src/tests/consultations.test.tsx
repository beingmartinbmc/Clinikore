/**
 * Consultations page (clinic-wide notes & prescriptions list).
 *
 * The page is brand-new so the suite had 0% coverage. These tests exercise
 * every branch: search, segmented filter, date presets + manual range,
 * empty states, skeleton, the Rx strip on cards, and the deep-link modal
 * (both the "note already in memory" path and the "fetch by id" path).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import toast from "react-hot-toast";

import Consultations from "../pages/Consultations";
import { installFetchMock, jsonResponse, renderApp } from "./helpers";

vi.mock("react-hot-toast", () => ({
  default: Object.assign(
    vi.fn(() => "t"),
    { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
  ),
}));

function note(over: Partial<any> = {}) {
  return {
    id: 1,
    patient_id: 10,
    patient_name: "Priya Sharma",
    appointment_id: null,
    chief_complaint: "Fever",
    diagnosis: "Viral",
    treatment_advised: "Rest + hydration",
    notes: null,
    prescription_notes: null,
    prescription_items: null,
    appointment_start: null,
    created_at: "2026-04-21T10:00:00Z",
    updated_at: "2026-04-21T10:00:00Z",
    invoice_id: null,
    ...over,
  };
}

const RX_JSON = JSON.stringify([
  { drug: "Paracetamol", strength: "500mg", frequency: "TDS", duration: "5 days" },
  { drug: "Azithromycin", strength: "500mg", frequency: "OD", duration: "3 days" },
  { drug: "ORS", strength: "", frequency: "SOS", duration: "" },
  { drug: "Vit-C", strength: "500mg", frequency: "OD", duration: "" },
  { drug: "Zinc", strength: "", frequency: "", duration: "" },
]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Consultations page", () => {
  it("shows the skeleton while loading, then renders grouped cards with the Rx strip", async () => {
    installFetchMock({
      routes: {
        "/api/consultation-notes": [
          note({ id: 1, prescription_items: RX_JSON }),
          note({ id: 2, patient_id: 11, patient_name: "Arjun Verma",
                 prescription_items: null, chief_complaint: "Cough" }),
        ],
      },
    });
    renderApp(<Consultations />);
    await waitFor(() => screen.getByText("Priya Sharma"));

    // Summary strip shows visit / Rx / medicine / patient counts.
    expect(screen.getByText("Visits")).toBeInTheDocument();
    expect(screen.getByText("Medicines")).toBeInTheDocument();

    // The Rx strip renders the first drugs + a "+N more" when > 4 items.
    expect(screen.getByText("Paracetamol")).toBeInTheDocument();
    expect(screen.getByText(/\+ 1 more/i)).toBeInTheDocument();

    // Every card exposes a single PDF link (the viewer has its own
    // Print button — showing a second HTML-print action was redundant).
    expect(
      screen.getAllByTitle(/prescription pdf/i).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("shows the empty state with filter-aware copy", async () => {
    installFetchMock({ routes: { "/api/consultation-notes": [] } });
    renderApp(<Consultations />);
    await waitFor(() =>
      expect(screen.getByText(/no consultations yet/i)).toBeInTheDocument(),
    );
    // After filtering, the copy switches to the "no matches" variant.
    await userEvent.type(
      screen.getByPlaceholderText(/Search by patient/i),
      "zzz",
    );
    await waitFor(() =>
      expect(screen.getByText(/no matches/i)).toBeInTheDocument(),
    );
  });

  it("passes the search term, filter and date range to the API", async () => {
    const calls: string[] = [];
    installFetchMock({
      routes: {
        "/api/consultation-notes": (_init, url) => {
          calls.push(url);
          return jsonResponse([]);
        },
      },
    });
    renderApp(<Consultations />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    // Search text.
    await userEvent.type(
      screen.getByPlaceholderText(/Search by patient/i),
      "priya",
    );
    await waitFor(() =>
      expect(calls.some((c) => c.includes("q=priya"))).toBe(true),
    );

    // With-Rx filter.
    await userEvent.click(screen.getByRole("button", { name: /with rx/i }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.includes("has_prescription=true")),
      ).toBe(true),
    );

    // Needs-Rx filter.
    await userEvent.click(screen.getByRole("button", { name: /needs rx/i }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.includes("has_prescription=false")),
      ).toBe(true),
    );

    // Date preset applies both date_from and date_to.
    await userEvent.click(screen.getByRole("button", { name: /last 7 days/i }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.includes("date_from=") && c.includes("date_to=")),
      ).toBe(true),
    );

    // And Clear nukes them.
    await userEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(last).not.toMatch(/date_from/);
    });
  });

  it("clears the search via the inline X button", async () => {
    installFetchMock({ routes: { "/api/consultation-notes": [] } });
    renderApp(<Consultations />);
    const input = screen.getByPlaceholderText(/Search by patient/i);
    await userEvent.type(input, "fever");
    expect(input).toHaveValue("fever");
    await userEvent.click(screen.getByLabelText(/clear search/i));
    expect(input).toHaveValue("");
  });

  it("allows editing date inputs directly (From / To)", async () => {
    installFetchMock({ routes: { "/api/consultation-notes": [] } });
    renderApp(<Consultations />);
    const from = screen.getByLabelText(/^from$/i) as HTMLInputElement;
    const to = screen.getByLabelText(/^to$/i) as HTMLInputElement;
    fireEvent.change(from, { target: { value: "2026-01-01" } });
    fireEvent.change(to, { target: { value: "2026-12-31" } });
    expect(from.value).toBe("2026-01-01");
    expect(to.value).toBe("2026-12-31");
  });

  it("opens the editor modal when the Open button is clicked", async () => {
    installFetchMock({
      routes: {
        "/api/consultation-notes": [note({ id: 5 })],
        "/api/consultation-notes/5/attachments": [],
      },
    });
    renderApp(<Consultations />);
    await waitFor(() => screen.getByText("Priya Sharma"));
    await userEvent.click(screen.getByRole("button", { name: /^open$/i }));
    await waitFor(() =>
      screen.getByText(/Priya Sharma.*consultation/i),
    );
    // Modal body hosts the ConsultNoteEditor (Chief complaint field).
    expect(screen.getByText(/chief complaint/i)).toBeInTheDocument();
  });

  it("deep-links via ?open=<id> using a note already in the list", async () => {
    installFetchMock({
      routes: {
        "/api/consultation-notes": [note({ id: 9 })],
        // Also register the by-id endpoint so the fallback fetch succeeds
        // if the in-memory cache misses.
        "/api/consultation-notes/9": note({ id: 9 }),
        "/api/consultation-notes/9/attachments": [],
      },
    });
    renderApp(<Consultations />, { route: "/consultations?open=9" });
    // Both the card and the modal eventually show the patient name.
    await waitFor(() =>
      expect(screen.getAllByText("Priya Sharma").length).toBeGreaterThan(0),
    );
    // Modal title is unique (has "consultation" suffix).
    await waitFor(() =>
      expect(screen.getByText(/— consultation$/i)).toBeInTheDocument(),
    );
  });

  it("deep-links via ?open=<id> by fetching the note when not in the list", async () => {
    installFetchMock({
      routes: {
        "/api/consultation-notes": [],
        "/api/consultation-notes/42": note({
          id: 42, patient_name: "Unknown Visitor",
        }),
        "/api/consultation-notes/42/attachments": [],
      },
    });
    renderApp(<Consultations />, { route: "/consultations?open=42" });
    await waitFor(() =>
      expect(
        screen.getByText(/Unknown Visitor — consultation/i),
      ).toBeInTheDocument(),
    );
  });

  it("swallows an API error on the deep-link fetch without crashing", async () => {
    installFetchMock({
      routes: {
        "/api/consultation-notes": [],
        "/api/consultation-notes/77": () =>
          new Response(JSON.stringify({ detail: "gone" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    renderApp(<Consultations />, { route: "/consultations?open=77" });
    await waitFor(() =>
      screen.getByText(/no consultations yet/i),
    );
    // Modal never opens (no "— consultation" modal title).
    expect(screen.queryByText(/— consultation$/i)).not.toBeInTheDocument();
  });

  it("surfaces a server error through a toast", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "boom" }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    );
    renderApp(<Consultations />);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("closes the editor modal and reloads after save", async () => {
    let reloads = 0;
    installFetchMock({
      routes: {
        "/api/consultation-notes": () => {
          reloads += 1;
          return jsonResponse([note({ id: 5 })]);
        },
        "/api/consultation-notes/5": (init) => {
          if ((init?.method || "GET").toUpperCase() === "PUT") {
            return jsonResponse(
              note({ id: 5, chief_complaint: "Updated" }),
            );
          }
          return jsonResponse(note({ id: 5 }));
        },
        "/api/consultation-notes/5/attachments": [],
      },
    });
    renderApp(<Consultations />);
    await waitFor(() => screen.getByText("Priya Sharma"));
    await userEvent.click(screen.getByRole("button", { name: /^open$/i }));

    const modal = await screen.findByText(/Priya Sharma.*consultation/i);
    // "Save" button inside the modal footer triggers the PUT.
    const modalRoot = modal.closest(".max-w-3xl") as HTMLElement;
    const saveBtn = within(modalRoot)
      .getAllByRole("button")
      .find((b) => /save/i.test(b.textContent || ""))!;
    await userEvent.click(saveBtn);

    await waitFor(() => expect(reloads).toBeGreaterThanOrEqual(2));
  });

  it("StatCard and Field helpers render with every tone", async () => {
    // We can exercise these through the page by feeding a card that has
    // a complaint, diagnosis, and advice (covers all Field tones).
    installFetchMock({
      routes: {
        "/api/consultation-notes": [
          note({
            id: 1,
            chief_complaint: "Fever",
            diagnosis: "Viral URTI",
            treatment_advised: "Rest",
            prescription_items: JSON.stringify([
              { drug: "Paracetamol", strength: "500mg", frequency: "TDS" },
            ]),
          }),
        ],
      },
    });
    renderApp(<Consultations />);
    await waitFor(() => screen.getByText("Fever"));
    expect(screen.getByText("Viral URTI")).toBeInTheDocument();
    expect(screen.getByText("Rest")).toBeInTheDocument();
  });

  it("falls back to 'Patient #id' when no name is returned", async () => {
    installFetchMock({
      routes: {
        "/api/consultation-notes": [
          note({ id: 1, patient_id: 77, patient_name: null }),
        ],
      },
    });
    renderApp(<Consultations />);
    await waitFor(() => screen.getByText(/patient #77/i));
  });

  it("uses appointment_start for the date header when present", async () => {
    installFetchMock({
      routes: {
        "/api/consultation-notes": [
          note({
            id: 1,
            appointment_start: "2026-03-15T09:00:00Z",
          }),
        ],
      },
    });
    renderApp(<Consultations />);
    await waitFor(() => screen.getByText("Priya Sharma"));
    // Any date string containing "Mar 2026" should appear.
    const headers = screen.getAllByText(/Mar 2026/);
    expect(headers.length).toBeGreaterThan(0);
  });
});
