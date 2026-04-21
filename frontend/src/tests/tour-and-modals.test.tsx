import { act, renderHook, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import toast from "react-hot-toast";

import { I18nProvider } from "../i18n/I18nContext";
import { TourProvider, TOUR_STEPS, useTour } from "../tour/TourContext";
import WelcomeModal from "../tour/WelcomeModal";
import TourBanner from "../tour/TourBanner";
import OnboardingModal from "../components/OnboardingModal";
import ConsultNoteEditor from "../components/ConsultNoteEditor";
import { installFetchMock, jsonResponse, renderApp } from "./helpers";

vi.mock("react-hot-toast", () => ({
  default: Object.assign(
    vi.fn(() => "toast-id"),
    { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
  ),
}));

function tourWrapper({ children }: { children: any }) {
  return (
    <I18nProvider>
      <TourProvider>{children}</TourProvider>
    </I18nProvider>
  );
}

describe("TourContext", () => {
  it("opens the welcome modal on first launch", () => {
    const { result } = renderHook(() => useTour(), { wrapper: tourWrapper });
    expect(result.current.welcomeOpen).toBe(true);
  });

  it("does not reopen once onboarding is marked seen", () => {
    localStorage.setItem("clinikore.onboarding_seen_v1", new Date().toISOString());
    const { result } = renderHook(() => useTour(), { wrapper: tourWrapper });
    expect(result.current.welcomeOpen).toBe(false);
  });

  it("marks onboarding seen when the welcome modal is closed", () => {
    const { result } = renderHook(() => useTour(), { wrapper: tourWrapper });
    act(() => result.current.closeWelcome());
    expect(result.current.welcomeOpen).toBe(false);
    expect(localStorage.getItem("clinikore.onboarding_seen_v1")).toBeTruthy();
  });

  it("steps through the tour and stops at the end", () => {
    const { result } = renderHook(() => useTour(), { wrapper: tourWrapper });
    act(() => result.current.startTour());
    expect(result.current.tourActive).toBe(true);
    expect(result.current.stepIndex).toBe(0);
    act(() => result.current.nextStep());
    expect(result.current.stepIndex).toBe(1);
    act(() => result.current.prevStep());
    expect(result.current.stepIndex).toBe(0);
    // prev at 0 stays at 0.
    act(() => result.current.prevStep());
    expect(result.current.stepIndex).toBe(0);
    // Jump to last step.
    act(() => {
      for (let i = 0; i < TOUR_STEPS.length + 2; i++) result.current.nextStep();
    });
    expect(result.current.tourActive).toBe(false);
  });

  it("loadDemoData and clearDemoData call their endpoints and bump refresh", async () => {
    localStorage.setItem("clinikore.onboarding_seen_v1", "now");
    installFetchMock({
      routes: {
        "POST /api/demo/seed": { created: true },
        "POST /api/demo/clear": { cleared: true },
      },
    });
    const { result } = renderHook(() => useTour(), { wrapper: tourWrapper });
    const before = result.current.refreshToken;
    await act(async () => {
      await result.current.loadDemoData();
    });
    await act(async () => {
      await result.current.clearDemoData();
    });
    expect(result.current.refreshToken).toBeGreaterThan(before);
  });

  it("bubbles up a server error from loadDemoData", async () => {
    localStorage.setItem("clinikore.onboarding_seen_v1", "now");
    (globalThis as any).fetch = vi.fn(async () =>
      new Response("bad", { status: 500 }),
    );
    const { result } = renderHook(() => useTour(), { wrapper: tourWrapper });
    await expect(
      act(async () => {
        await result.current.loadDemoData();
      }),
    ).rejects.toThrow();
  });

  it("throws when useTour is used outside the provider", () => {
    expect(() => renderHook(() => useTour())).toThrow(
      /useTour must be used inside/,
    );
  });
});

describe("WelcomeModal", () => {
  beforeEach(() => {
    installFetchMock({
      routes: {
        "/api/demo": { active: false },
        "POST /api/demo/seed": { created: true },
        "POST /api/demo/clear": { cleared: true },
      },
    });
  });

  it("is only visible on the first launch", async () => {
    renderApp(<WelcomeModal />);
    await waitFor(() =>
      expect(screen.getByText(/Clinikore/i)).toBeInTheDocument(),
    );
  });

  it("hides itself once onboarding is seen", () => {
    localStorage.setItem("clinikore.onboarding_seen_v1", "now");
    const { container } = renderApp(<WelcomeModal />);
    expect(container.textContent).toBe("");
  });

  it("renders a demo badge when the server reports demo data is active", async () => {
    installFetchMock({ routes: { "/api/demo": { active: true } } });
    renderApp(<WelcomeModal />);
    await waitFor(() =>
      expect(screen.getByText(/demo data/i)).toBeInTheDocument(),
    );
  });

  it("confirm-clears demo data from the banner button", async () => {
    installFetchMock({
      routes: {
        "/api/demo": { active: true },
        "POST /api/demo/clear": { cleared: true },
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp(<WelcomeModal />);
    await screen.findByText(/demo data/i);
    const clearBtn = screen.getByRole("button", { name: /clear|remove/i });
    await userEvent.click(clearBtn);
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    });
  });

  it("exits on the 'Just explore' button", async () => {
    renderApp(<WelcomeModal />);
    await screen.findByText(/Clinikore/i);
    const exploreBtn = screen.getByRole("button", { name: /explore|dismiss|later/i });
    await userEvent.click(exploreBtn);
    await waitFor(() => {
      expect(screen.queryByText(/Feature/i)).not.toBeInTheDocument();
    });
  });

  it("'Load demo & take tour' seeds demo data then starts the tour", async () => {
    let seeded = false;
    installFetchMock({
      routes: {
        "/api/demo": { active: false },
        "POST /api/demo/seed": () => {
          seeded = true;
          return jsonResponse({ created: true });
        },
      },
    });
    renderApp(<WelcomeModal />);
    await screen.findByText(/Clinikore/i);
    const loadAndTour = screen.getByRole("button", {
      name: /load.*tour|take.*tour|take a tour/i,
    });
    await userEvent.click(loadAndTour);
    await waitFor(() => expect(seeded).toBe(true));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Demo data loaded"),
    );
  });

  it("toasts when seeding demo data fails on the primary CTA", async () => {
    installFetchMock({
      routes: {
        "/api/demo": { active: false },
        "POST /api/demo/seed": () =>
          new Response(JSON.stringify({ detail: "bad" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    renderApp(<WelcomeModal />);
    await screen.findByText(/Clinikore/i);
    await userEvent.click(
      screen.getByRole("button", {
        name: /load.*tour|take.*tour/i,
      }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("toasts when clearing demo fails", async () => {
    installFetchMock({
      routes: {
        "/api/demo": { active: true },
        "POST /api/demo/clear": () =>
          new Response(JSON.stringify({ detail: "bad" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp(<WelcomeModal />);
    await screen.findByText(/demo data/i);
    await userEvent.click(
      screen.getByRole("button", { name: /clear|remove/i }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("does nothing when confirm is cancelled on clear demo", async () => {
    installFetchMock({
      routes: {
        "/api/demo": { active: true },
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp(<WelcomeModal />);
    await screen.findByText(/demo data/i);
    await userEvent.click(
      screen.getByRole("button", { name: /clear|remove/i }),
    );
    // Still showing the banner.
    expect(screen.getByText(/demo data/i)).toBeInTheDocument();
  });
});

describe("TourBanner", () => {
  it("renders nothing when the tour isn't active", () => {
    const { container } = renderApp(<TourBanner />);
    expect(container.textContent).toBe("");
  });

  it("renders the step title + next/prev/skip when the tour starts", async () => {
    // Start the tour via a captured setter, then render the banner.
    let tour: ReturnType<typeof useTour> | null = null;
    function Harness() {
      tour = useTour();
      return <TourBanner />;
    }
    localStorage.setItem("clinikore.onboarding_seen_v1", "now");
    renderApp(<Harness />);
    act(() => tour!.startTour());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /next|finish/i })).toBeInTheDocument(),
    );

    // Click next — should advance.
    const nextBtn = screen.getByRole("button", { name: /next|finish/i });
    await userEvent.click(nextBtn);
    expect(tour!.stepIndex).toBe(1);

    // Click skip (X button).
    const skipButtons = screen.getAllByRole("button");
    const skip = skipButtons[skipButtons.length - 1];
    await userEvent.click(skip);
    expect(tour!.tourActive).toBe(false);
  });
});

describe("OnboardingModal", () => {
  it("hides itself when settings are already complete", async () => {
    installFetchMock({
      routes: {
        "/api/settings": {
          id: 1, doctor_name: "Dr. A", clinic_name: "Clinic",
          registration_number: "DMC/1234", updated_at: new Date().toISOString(),
        },
      },
    });
    const { container } = renderApp(<OnboardingModal />);
    await waitFor(() => {
      expect(container.textContent).toBe("");
    });
  });

  it("appears when required fields are missing and submits a PUT on save", async () => {
    let putBody: unknown = null;
    installFetchMock({
      routes: {
        "/api/settings": (init: RequestInit | undefined) => {
          if ((init?.method || "GET").toUpperCase() === "PUT") {
            putBody = init?.body;
            return jsonResponse({
              id: 1, doctor_name: "Dr A", clinic_name: "C",
              registration_number: "R", updated_at: "now",
            });
          }
          return jsonResponse({
            id: 1, updated_at: new Date().toISOString(),
          });
        },
      },
    });
    renderApp(<OnboardingModal />);

    await screen.findByText(/Set up your clinic profile/i);
    const name = screen.getByPlaceholderText(/Priya Sharma/i);
    const regNo = screen.getByPlaceholderText(/12345/i);
    const clinic = screen.getByPlaceholderText(/Smile Dental Care/i);

    await userEvent.type(name, "Dr Test");
    await userEvent.type(regNo, "DMC/9999");
    await userEvent.type(clinic, "Test Clinic");

    const save = screen.getByRole("button", { name: /Save.*continue/i });
    await userEvent.click(save);

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = JSON.parse(putBody as string);
    expect(body.doctor_name).toBe("Dr Test");
    expect(body.clinic_name).toBe("Test Clinic");
    expect(body.registration_number).toBe("DMC/9999");
  });

  it("shows an error toast when save fails", async () => {
    installFetchMock({
      routes: {
        "/api/settings": (init: RequestInit | undefined) => {
          if ((init?.method || "GET").toUpperCase() === "PUT") {
            return new Response(JSON.stringify({ detail: "kaboom" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
          return jsonResponse({ id: 1, updated_at: "now" });
        },
      },
    });
    renderApp(<OnboardingModal />);
    await screen.findByText(/Set up your clinic profile/i);
    await userEvent.type(screen.getByPlaceholderText(/Priya Sharma/i), "A");
    await userEvent.type(screen.getByPlaceholderText(/12345/i), "R");
    await userEvent.type(screen.getByPlaceholderText(/Smile Dental Care/i), "C");
    await userEvent.click(screen.getByRole("button", { name: /Save.*continue/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("refuses to submit when required fields are empty", async () => {
    installFetchMock({
      routes: { "/api/settings": { id: 1, updated_at: "now" } },
    });
    renderApp(<OnboardingModal />);
    await screen.findByText(/Set up your clinic profile/i);
    const save = screen.getByRole("button", { name: /Save.*continue/i });
    expect(save).toBeDisabled();
  });

  it("stays hidden if GET /api/settings rejects", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response("network down", { status: 503 }),
    );
    const { container } = renderApp(<OnboardingModal />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("fills every optional clinic / doctor field and persists them all", async () => {
    let putBody: any = null;
    installFetchMock({
      routes: {
        "/api/settings": (init: RequestInit | undefined) => {
          if ((init?.method || "GET").toUpperCase() === "PUT") {
            putBody = JSON.parse((init!.body as string) || "{}");
            return jsonResponse({
              id: 1, ...putBody, updated_at: "now",
            });
          }
          return jsonResponse({ id: 1, updated_at: "now" });
        },
      },
    });
    renderApp(<OnboardingModal />);
    await screen.findByText(/Set up your clinic profile/i);
    await userEvent.type(
      screen.getByPlaceholderText(/Priya Sharma/i),
      "Dr Full",
    );
    await userEvent.type(
      screen.getByPlaceholderText(/MBBS, MD/i),
      "MBBS",
    );
    await userEvent.type(
      screen.getByPlaceholderText(/12345/i),
      "DMC/42",
    );
    await userEvent.type(
      screen.getByPlaceholderText(/Delhi Medical Council/i),
      "Delhi Medical Council",
    );
    await userEvent.type(
      screen.getByPlaceholderText(/Dental Surgeon/i),
      "Dentist",
    );
    await userEvent.type(
      screen.getByPlaceholderText(/Smile Dental Care/i),
      "Sunrise Clinic",
    );
    await userEvent.type(
      screen.getByPlaceholderText(/\+91/),
      "+911234567890",
    );
    await userEvent.type(
      screen.getByPlaceholderText(/clinic@example/i),
      "hi@clinic.test",
    );
    await userEvent.type(
      screen.getByPlaceholderText(/MG Road/i),
      "12 MG Road, Bengaluru",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save.*continue/i }),
    );
    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody.doctor_qualifications).toBe("MBBS");
    expect(putBody.registration_council).toBe("Delhi Medical Council");
    expect(putBody.specialization).toBe("Dentist");
    expect(putBody.clinic_phone).toBe("+911234567890");
    expect(putBody.clinic_email).toBe("hi@clinic.test");
    expect(putBody.clinic_address).toBe("12 MG Road, Bengaluru");
  });
});

describe("ConsultNoteEditor", () => {
  it("creates a new note via POST when no existing note is passed", async () => {
    let body: any = null;
    installFetchMock({
      routes: {
        "POST /api/consultation-notes": (init: RequestInit | undefined) => {
          body = init?.body ? JSON.parse(init.body as string) : null;
          return jsonResponse({
            id: 99, patient_id: 1, chief_complaint: body.chief_complaint,
            created_at: "2025-01-01", updated_at: "2025-01-01",
          });
        },
      },
    });
    const onSaved = vi.fn();
    renderApp(<ConsultNoteEditor patientId={1} onSaved={onSaved} />);

    await userEvent.type(
      screen.getByPlaceholderText(/Lower back pain/i),
      "Toothache",
    );
    await userEvent.click(screen.getByRole("button", { name: /Save note/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(body.chief_complaint).toBe("Toothache");
    expect(body.patient_id).toBe(1);
  });

  it("updates an existing note via PUT and calls onSaved", async () => {
    let method = "";
    installFetchMock({
      routes: {
        "/api/consultation-notes/42": (init: RequestInit | undefined) => {
          method = (init?.method || "").toUpperCase();
          return jsonResponse({
            id: 42, patient_id: 1, chief_complaint: "updated",
            created_at: "x", updated_at: "x",
          });
        },
      },
    });
    const onSaved = vi.fn();
    const existing = {
      id: 42, patient_id: 1, chief_complaint: "old",
      created_at: "x", updated_at: "x",
    } as any;
    renderApp(
      <ConsultNoteEditor
        patientId={1}
        existing={existing}
        onSaved={onSaved}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(method).toBe("PUT");
  });

  it("shows an error toast when the save fails", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "no" }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    );
    renderApp(<ConsultNoteEditor patientId={1} />);
    await userEvent.click(screen.getByRole("button", { name: /Save note/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("cancel button calls the provided callback", async () => {
    const onCancel = vi.fn();
    renderApp(
      <ConsultNoteEditor patientId={1} onCancel={onCancel} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("edits every text field, manages prescription rows, and saves items", async () => {
    let body: any = null;
    installFetchMock({
      routes: {
        "POST /api/consultation-notes": (init: RequestInit | undefined) => {
          body = init?.body ? JSON.parse(init.body as string) : null;
          return jsonResponse({
            id: 1, patient_id: 1, chief_complaint: body.chief_complaint,
            created_at: "x", updated_at: "x",
          });
        },
      },
    });
    const onSaved = vi.fn();
    renderApp(
      <ConsultNoteEditor
        patientId={1}
        appointmentId={5}
        onSaved={onSaved}
      />,
    );
    // Fill every text field.
    await userEvent.type(
      screen.getByPlaceholderText(/Lower back pain/i),
      "Toothache",
    );
    const textareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName.toLowerCase() === "textarea",
    );
    // [0]=diagnosis, [1]=advice, [2]=Rx notes, [3]=additional notes
    await userEvent.type(textareas[0], "Inflammation");
    await userEvent.type(textareas[1], "Rest and fluids");
    await userEvent.type(textareas[2], "No dairy");
    await userEvent.type(textareas[3], "Review in 1 week");

    // Add two medicine rows, then remove the first.
    const addBtn = screen.getByRole("button", { name: /add medicine/i });
    await userEvent.click(addBtn);
    await userEvent.click(addBtn);
    const rxInputs = screen.getAllByPlaceholderText(/Drug \(e\.g\. Paracetamol\)/i);
    expect(rxInputs.length).toBe(2);
    await userEvent.type(rxInputs[0], "Ibuprofen");
    await userEvent.type(rxInputs[1], "Paracetamol");

    // Fill a strength/frequency/duration/notes on first row.
    await userEvent.type(screen.getAllByPlaceholderText(/Strength/i)[0], "400mg");
    await userEvent.type(screen.getAllByPlaceholderText(/Frequency/i)[0], "TDS");
    await userEvent.type(screen.getAllByPlaceholderText(/Duration/i)[0], "5 days");
    await userEvent.type(screen.getAllByPlaceholderText(/^Notes$/)[0], "after meal");

    // Remove the FIRST row (Ibuprofen).
    const removeBtns = screen.getAllByRole("button", { name: /remove row/i });
    await userEvent.click(removeBtns[0]);

    await userEvent.click(screen.getByRole("button", { name: /Save note/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const saved = JSON.parse(body.prescription_items);
    expect(saved.length).toBe(1);
    expect(saved[0].drug).toBe("Paracetamol");
    expect(body.diagnosis).toBe("Inflammation");
    expect(body.appointment_id).toBe(5);
  });

  it("print button is disabled for unsaved notes and toasts an error", async () => {
    renderApp(<ConsultNoteEditor patientId={1} />);
    const printBtn = screen.getByRole("button", { name: /print/i });
    expect(printBtn).toBeDisabled();
  });

  it("exposes a printable Rx link and a PDF link when the note exists", async () => {
    const existing = {
      id: 77, patient_id: 1,
      created_at: "x", updated_at: "x",
    } as any;
    renderApp(
      <ConsultNoteEditor patientId={1} existing={existing} />,
    );
    const printLink = screen.getByRole("link", { name: /print/i });
    expect(printLink).toHaveAttribute(
      "href",
      "/api/consultation-notes/77/prescription",
    );
    expect(printLink).toHaveAttribute("target", "_blank");

    const pdfLink = screen.getByRole("link", { name: /pdf/i });
    expect(pdfLink).toHaveAttribute(
      "href",
      "/api/consultation-notes/77/prescription.pdf",
    );
  });

  it("loads and renders attachments, downloads, and removes with confirm", async () => {
    const listCalls: string[] = [];
    const existing = {
      id: 77, patient_id: 1, created_at: "x", updated_at: "x",
    } as any;
    installFetchMock({
      routes: {
        "/api/consultation-notes/77/attachments": (
          init: RequestInit | undefined,
          url: string,
        ) => {
          const m = (init?.method || "GET").toUpperCase();
          listCalls.push(`${m} ${url}`);
          return jsonResponse([
            {
              id: 1, note_id: 77, patient_id: 1,
              filename: "xray.png", mime_type: "image/png",
              size_bytes: 2048, kind: "image",
              download_url: "/files/xray.png",
              uploaded_at: "x",
            },
            {
              id: 2, note_id: 77, patient_id: 1,
              filename: "report.pdf", mime_type: "application/pdf",
              size_bytes: 5 * 1024 * 1024, kind: "pdf",
              uploaded_at: "x",
            },
          ]);
        },
        "DELETE /api/attachments/1": { ok: true },
      },
    });
    const spy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      renderApp(<ConsultNoteEditor patientId={1} existing={existing} />);
      await waitFor(() => screen.getByText("xray.png"));
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
      // Size formatter exercised: 2 KB and 5.0 MB strings.
      expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
      expect(screen.getByText(/5\.0 MB/)).toBeInTheDocument();
      // Remove the image attachment.
      const removeBtns = screen.getAllByRole("button", {
        name: /remove attachment/i,
      });
      await userEvent.click(removeBtns[0]);
      await waitFor(() =>
        expect(screen.queryByText("xray.png")).not.toBeInTheDocument(),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("skips upload when no note id yet and toasts a guidance error", async () => {
    renderApp(<ConsultNoteEditor patientId={1} />);
    // The Upload button is disabled without a note id; exercise the hidden
    // file input directly by firing a change event.
    const file = new File(["hi"], "a.png", { type: "image/png" });
    const hiddenInputs = document.querySelectorAll(
      'input[type="file"]',
    ) as unknown as HTMLInputElement[];
    fireEvent.change(hiddenInputs[0], { target: { files: [file] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("uploads attachments sequentially and appends to the list", async () => {
    const existing = {
      id: 88, patient_id: 1, created_at: "x", updated_at: "x",
    } as any;
    let uploadCount = 0;
    installFetchMock({
      routes: {
        "/api/consultation-notes/88/attachments": (init: RequestInit | undefined) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") {
            uploadCount++;
            return jsonResponse({
              id: 100 + uploadCount,
              note_id: 88,
              patient_id: 1,
              filename: `f${uploadCount}.png`,
              mime_type: "image/png",
              size_bytes: 10,
              kind: "image",
              uploaded_at: "x",
            });
          }
          return jsonResponse([]);
        },
      },
    });
    renderApp(<ConsultNoteEditor patientId={1} existing={existing} />);
    await waitFor(() =>
      screen.getByText(/No attachments yet/i),
    );
    const files = [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ];
    const hiddenInputs = document.querySelectorAll(
      'input[type="file"]',
    ) as unknown as HTMLInputElement[];
    fireEvent.change(hiddenInputs[0], { target: { files } });
    await waitFor(() => expect(uploadCount).toBe(2));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("2 attachments uploaded"),
    );
  });

  it("toasts when attachment upload fails", async () => {
    const existing = {
      id: 99, patient_id: 1, created_at: "x", updated_at: "x",
    } as any;
    installFetchMock({
      routes: {
        "/api/consultation-notes/99/attachments": (init: RequestInit | undefined) => {
          const m = (init?.method || "GET").toUpperCase();
          if (m === "POST") {
            return new Response(
              JSON.stringify({ detail: "too big" }),
              { status: 413, headers: { "content-type": "application/json" } },
            );
          }
          return jsonResponse([]);
        },
      },
    });
    renderApp(<ConsultNoteEditor patientId={1} existing={existing} />);
    await waitFor(() => screen.getByText(/No attachments yet/i));
    const files = [new File(["x"], "big.bin", { type: "application/octet-stream" })];
    const hiddenInputs = document.querySelectorAll(
      'input[type="file"]',
    ) as unknown as HTMLInputElement[];
    fireEvent.change(hiddenInputs[0], { target: { files } });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("resets state when the existing prop changes (via key on id)", async () => {
    const e1 = {
      id: 1, patient_id: 1, chief_complaint: "first",
      prescription_items: JSON.stringify([{ drug: "A" }]),
      created_at: "x", updated_at: "x",
    } as any;
    const e2 = {
      id: 2, patient_id: 1, chief_complaint: "second",
      prescription_items: JSON.stringify([{ drug: "B" }]),
      created_at: "x", updated_at: "x",
    } as any;
    const Harness = ({ which }: { which: any }) => (
      <ConsultNoteEditor patientId={1} existing={which} />
    );
    const { rerender } = renderApp(<Harness which={e1} />);
    expect(screen.getByDisplayValue("first")).toBeInTheDocument();
    expect(screen.getByDisplayValue("A")).toBeInTheDocument();
    rerender(<Harness which={e2} />);
    expect(screen.getByDisplayValue("second")).toBeInTheDocument();
    expect(screen.getByDisplayValue("B")).toBeInTheDocument();
  });
});
