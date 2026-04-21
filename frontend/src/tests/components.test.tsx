import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import toast from "react-hot-toast";

import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";
import StatusBadge from "../components/StatusBadge";
import DentalChart from "../components/DentalChart";
import { installFetchMock, jsonResponse, renderApp } from "./helpers";

vi.mock("react-hot-toast", () => ({
  default: Object.assign(
    vi.fn(() => "toast-id"),
    { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
  ),
}));

describe("Modal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} title="x">
        <p>hi</p>
      </Modal>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the title, body, and optional footer when open", () => {
    render(
      <Modal
        open
        onClose={() => {}}
        title="My modal"
        footer={<button type="button">OK</button>}
      >
        <p>body here</p>
      </Modal>,
    );
    expect(screen.getByText("My modal")).toBeInTheDocument();
    expect(screen.getByText("body here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OK/ })).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="x">
        <p>hi</p>
      </Modal>,
    );
    const closeBtn = screen.getAllByRole("button")[0];
    await userEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape key press", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="x">
        <p>hi</p>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not react to Escape while closed", () => {
    const onClose = vi.fn();
    render(
      <Modal open={false} onClose={onClose} title="x">
        <p>hi</p>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("accepts a custom width class", () => {
    const { container } = render(
      <Modal open onClose={() => {}} title="wide" width="max-w-2xl">
        <p>wide body</p>
      </Modal>,
    );
    expect(container.querySelector(".max-w-2xl")).not.toBeNull();
  });
});

describe("PageHeader", () => {
  it("renders the title only when no subtitle or actions are given", () => {
    render(<PageHeader title="Hello" />);
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
  });

  it("renders subtitle and actions when provided", () => {
    render(
      <PageHeader
        title="Patients"
        subtitle="123 total"
        actions={<button>Add</button>}
      />,
    );
    expect(screen.getByText("123 total")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});

describe("StatusBadge", () => {
  it("translates known status values", () => {
    renderApp(<StatusBadge value="paid" />);
    expect(screen.getByText(/paid/i)).toBeInTheDocument();
  });

  it("renders raw (underscore-replaced) text for unknown values", () => {
    renderApp(<StatusBadge value="in_progress" />);
    expect(screen.getByText(/in progress/i)).toBeInTheDocument();
  });

  it("falls back to slate class for completely unknown values", () => {
    const { container } = renderApp(<StatusBadge value="made_up_status" />);
    const badge = container.querySelector(".badge");
    expect(badge?.className).toMatch(/bg-slate-100/);
  });
});

describe("DentalChart", () => {
  it("loads records, renders both arches, opens the modal, edits and saves a tooth", async () => {
    let put: any = null;
    let reloadCount = 0;
    installFetchMock({
      routes: {
        "/api/patients/7/dental-chart": () => {
          reloadCount++;
          return jsonResponse([
            {
              id: 1, patient_id: 7, tooth_number: "16",
              status: "caries", conditions: "deep",
              notes: "treat", created_at: "x", updated_at: "x",
            },
          ]);
        },
        "PUT /api/patients/7/dental-chart/11": (init) => {
          put = JSON.parse((init!.body as string) || "{}");
          return jsonResponse({
            id: 2, patient_id: 7, tooth_number: "11",
            status: put.status, conditions: put.conditions,
            notes: put.notes, created_at: "x", updated_at: "x",
          });
        },
      },
    });
    renderApp(<DentalChart patientId={7} />);
    await waitFor(() => expect(reloadCount).toBe(1));
    // Click tooth 11 (from upper row).
    await userEvent.click(screen.getByRole("button", { name: /^11$/ }));
    // Modal opens. Pick "Caries" status.
    await userEvent.click(screen.getByRole("button", { name: /^caries$/i }));
    await userEvent.type(
      screen.getByPlaceholderText(/Deep caries/i),
      "mesial surface",
    );
    await userEvent.type(
      screen.getByPlaceholderText(/Planned treatment/i),
      "needs filling",
    );
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(put?.status).toBe("caries"));
    expect(put?.conditions).toBe("mesial surface");
  });

  it("deletes the record when the status is reset back to healthy with empty fields", async () => {
    let deleted = false;
    installFetchMock({
      routes: {
        "/api/patients/7/dental-chart": [
          {
            id: 1, patient_id: 7, tooth_number: "16",
            status: "caries", conditions: null, notes: null,
            created_at: "x", updated_at: "x",
          },
        ],
        "DELETE /api/patients/7/dental-chart/16": () => {
          deleted = true;
          return jsonResponse({ ok: true });
        },
      },
    });
    renderApp(<DentalChart patientId={7} />);
    await waitFor(() => screen.getByRole("button", { name: /^16$/ }));
    await userEvent.click(screen.getByRole("button", { name: /^16$/ }));
    // Switch back to Healthy — with empty conditions/notes this triggers DELETE.
    await userEvent.click(screen.getByRole("button", { name: /^healthy$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it("cancels the tooth modal via the Cancel button", async () => {
    installFetchMock({
      routes: { "/api/patients/7/dental-chart": [] },
    });
    renderApp(<DentalChart patientId={7} />);
    await waitFor(() =>
      expect(
        screen.queryByText(/Loading/i),
      ).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: /^18$/ }));
    await waitFor(() => screen.getByText("Tooth 18"));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByText("Tooth 18")).not.toBeInTheDocument(),
    );
  });

  it("toasts on save error", async () => {
    installFetchMock({
      routes: {
        "/api/patients/7/dental-chart": [],
        "PUT /api/patients/7/dental-chart/11": () =>
          new Response(JSON.stringify({ detail: "oops" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    renderApp(<DentalChart patientId={7} />);
    await waitFor(() =>
      expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: /^11$/ }));
    await waitFor(() => screen.getByText("Tooth 11"));
    await userEvent.click(screen.getByRole("button", { name: /^caries$/i }));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
