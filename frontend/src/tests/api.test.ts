import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import toast from "react-hot-toast";

import {
  api,
  deleteWithUndo,
  showUndoToast,
  setUndoHandler,
  settingsComplete,
  parsePrescriptionItems,
  isDentalSpecialization,
  uploadAttachment,
} from "../api";
import { errorResponse, installFetchMock, jsonResponse, textResponse } from "./helpers";

// react-hot-toast runs side-effects we don't care about in unit tests.
vi.mock("react-hot-toast", () => ({
  default: Object.assign(
    vi.fn(() => "toast-id"),
    {
      success: vi.fn(() => "toast-id"),
      error: vi.fn(() => "toast-id"),
      dismiss: vi.fn(),
    },
  ),
}));

describe("api.request()", () => {
  beforeEach(() => {
    setUndoHandler(null);
  });

  it("returns JSON on a plain 200 GET", async () => {
    installFetchMock({ routes: { "/api/ping": { ok: true } } });
    const r = await api.get<{ ok: boolean }>("/api/ping");
    expect(r).toEqual({ ok: true });
  });

  it("returns undefined on a 204", async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const r = await api.del<void>("/api/x/1");
    expect(r).toBeUndefined();
  });

  it("returns text when content-type is not JSON", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      textResponse("<html></html>", 200, "text/html"),
    );
    const r = await api.get<string>("/api/invoices/1/print");
    expect(r).toBe("<html></html>");
  });

  it("throws a user-friendly error on 4xx with detail", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      errorResponse(400, "Invalid patient_id"),
    );
    await expect(api.post("/api/invoices", {})).rejects.toThrow("Invalid patient_id");
  });

  it("throws with status+text when the 4xx body isn't JSON", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response("<html>500 error</html>", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    await expect(api.get("/api/boom")).rejects.toThrow(/500/);
  });

  it("stringifies a non-string detail before throwing", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse({ detail: [{ msg: "bad value" }] }, 422),
    );
    await expect(api.post("/api/x", {})).rejects.toThrow(/bad value/);
  });

  it("supports POST / PUT / PATCH / DELETE helpers", async () => {
    const routes: Record<string, unknown> = {
      "/api/x": { created: true },
      "/api/x/1": { ok: true },
    };
    const { fetchImpl } = installFetchMock({ routes });
    await api.post("/api/x", { a: 1 });
    await api.put("/api/x/1", { a: 2 });
    await api.patch("/api/x/1", { a: 3 });
    await api.del("/api/x/1");
    const methods = fetchImpl.mock.calls.map((c: any[]) => c[1]?.method);
    expect(methods).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
  });

  it("serializes undefined body as no payload", async () => {
    const { fetchImpl } = installFetchMock({ routes: { "/api/ping": {} } });
    await api.post("/api/ping");
    const init = fetchImpl.mock.calls[0][1];
    expect(init.body).toBeUndefined();
  });
});

describe("undo handler auto-dispatch", () => {
  it("invokes the undo handler on a DELETE that returns a token", async () => {
    const handler = vi.fn();
    setUndoHandler(handler);
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse({
        ok: true,
        undo_token: "tok-1",
        entity_type: "patient",
        entity_id: 7,
        label: "Rahul",
      }),
    );
    await api.del("/api/patients/7");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ undo_token: "tok-1", entity_type: "patient" }),
    );
    setUndoHandler(null);
  });

  it("silently swallows handler errors", async () => {
    const handler = vi.fn(() => { throw new Error("handler bad"); });
    setUndoHandler(handler);
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse({ undo_token: "tok-2" }),
    );
    // Must NOT reject.
    await expect(api.del("/api/x/1")).resolves.toBeTruthy();
    setUndoHandler(null);
  });

  it("does not call the handler if the response has no token", async () => {
    const handler = vi.fn();
    setUndoHandler(handler);
    (globalThis as any).fetch = vi.fn(async () => jsonResponse({ ok: true }));
    await api.del("/api/x/1");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("deleteWithUndo / showUndoToast", () => {
  it("calls toast.success with undo hint when backend returns a token", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse({ undo_token: "abcd" }),
    );
    await deleteWithUndo("/api/patients/1", "Patient deleted");
    expect(toast.success).toHaveBeenCalled();
    expect((window as any).__lastUndoToken).toBe("abcd");
  });

  it("calls plain toast.success when no token is returned", async () => {
    (globalThis as any).fetch = vi.fn(async () => jsonResponse({}));
    await deleteWithUndo("/api/patients/1", "Patient deleted");
    expect(toast.success).toHaveBeenCalled();
  });

  it("showUndoToast returns an id without throwing", () => {
    const id = showUndoToast("Deleted", "tok");
    expect(id).toBeDefined();
  });
});

describe("settingsComplete", () => {
  it("is false for null / empty", () => {
    expect(settingsComplete(null)).toBe(false);
    expect(settingsComplete(undefined)).toBe(false);
    expect(settingsComplete({})).toBe(false);
  });

  it("is false when any required field is missing or blank", () => {
    expect(settingsComplete({ doctor_name: "A", clinic_name: "B" })).toBe(false);
    expect(settingsComplete({ doctor_name: "  ", clinic_name: "B", registration_number: "X", doctor_category: "general" })).toBe(false);
    expect(settingsComplete({ doctor_name: "A", clinic_name: "", registration_number: "X", doctor_category: "general" })).toBe(false);
    // New requirement: doctor_category is mandatory so the specialty-aware
    // patient filter knows what to show on first launch.
    expect(settingsComplete({
      doctor_name: "A",
      clinic_name: "B",
      registration_number: "X",
    })).toBe(false);
  });

  it("is true when all required fields are non-blank (incl. doctor_category)", () => {
    expect(settingsComplete({
      doctor_name: "Dr A",
      clinic_name: "Clinic X",
      registration_number: "DMC/1234",
      doctor_category: "general",
    })).toBe(true);
  });
});

describe("parsePrescriptionItems", () => {
  it("returns [] for null / empty / undefined", () => {
    expect(parsePrescriptionItems(null)).toEqual([]);
    expect(parsePrescriptionItems(undefined)).toEqual([]);
    expect(parsePrescriptionItems("")).toEqual([]);
  });

  it("parses JSON arrays", () => {
    const items = parsePrescriptionItems(
      JSON.stringify([{ drug: "X" }, { drug: "Y" }]),
    );
    expect(items.length).toBe(2);
    expect(items[0].drug).toBe("X");
  });

  it("returns [] when JSON parses to a non-array", () => {
    expect(parsePrescriptionItems(JSON.stringify({ drug: "X" }))).toEqual([]);
  });

  it("falls back to line-by-line parsing when the raw is not JSON", () => {
    const items = parsePrescriptionItems("Paracetamol\r\nIbuprofen\n  \nAspirin");
    expect(items.map((i) => i.drug)).toEqual([
      "Paracetamol",
      "Ibuprofen",
      "Aspirin",
    ]);
  });
});

describe("isDentalSpecialization", () => {
  it("matches dentistry keywords case-insensitively", () => {
    expect(isDentalSpecialization({ specialization: "Dentist" })).toBe(true);
    expect(isDentalSpecialization({ specialization: "Orthodontist" })).toBe(true);
    expect(isDentalSpecialization({ specialization: "Endodontics" })).toBe(true);
  });
  it("returns false for non-dental or missing specializations", () => {
    expect(isDentalSpecialization(null)).toBe(false);
    expect(isDentalSpecialization(undefined as any)).toBe(false);
    expect(isDentalSpecialization({ specialization: "Pediatrics" })).toBe(false);
    expect(isDentalSpecialization({ specialization: "" })).toBe(false);
  });
});

describe("uploadAttachment", () => {
  it("POSTs FormData with optional caption", async () => {
    let seenUrl = "";
    let seenInit: any = null;
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse({
        id: 1,
        note_id: 10,
        patient_id: 1,
        filename: "a.png",
        mime_type: "image/png",
        size_bytes: 5,
        kind: "image",
        uploaded_at: "x",
      });
    });
    const file = new File(["x"], "a.png", { type: "image/png" });
    const res = await uploadAttachment(10, file, "caption!");
    expect(res.id).toBe(1);
    expect(seenUrl).toContain("/api/consultation-notes/10/attachments");
    expect(seenInit.method).toBe("POST");
    expect(seenInit.body).toBeInstanceOf(FormData);
    const keys = Array.from((seenInit.body as FormData).keys());
    expect(keys).toContain("file");
    expect(keys).toContain("caption");
  });

  it("throws with detail on non-OK with JSON body", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      errorResponse(413, "File too big"),
    );
    const file = new File(["x"], "a.png");
    await expect(uploadAttachment(10, file)).rejects.toThrow(/File too big/);
  });

  it("throws with status+text when non-OK body isn't JSON", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response("<html>500</html>", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    const file = new File(["x"], "a.png");
    await expect(uploadAttachment(10, file)).rejects.toThrow(/500/);
  });

  it("serializes an object detail into the thrown message", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse({ detail: { reason: "quota" } }, 507),
    );
    const file = new File(["x"], "a.png");
    await expect(uploadAttachment(10, file)).rejects.toThrow(/quota/);
  });
});
