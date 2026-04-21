// Tiny typed API client. Same-origin in prod (served by FastAPI), proxied in dev.
const BASE = "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.detail) msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  del: <T>(p: string) => request<T>(p, { method: "DELETE" }),
};

// ---------- Types ----------
export type AppointmentStatus = "scheduled" | "completed" | "cancelled";
export type InvoiceStatus = "unpaid" | "partial" | "paid";
export type PaymentMethod = "cash" | "upi" | "card";

export interface Patient {
  id: number;
  name: string;
  age?: number | null;
  phone?: string | null;
  email?: string | null;
  medical_history?: string | null;
  dental_history?: string | null;
  allergies?: string | null;
  notes?: string | null;
  created_at: string;
}

export interface Procedure {
  id: number;
  name: string;
  description?: string | null;
  default_price: number;
}

export interface Appointment {
  id: number;
  patient_id: number;
  patient_name?: string | null;
  start: string;
  end: string;
  status: AppointmentStatus;
  chief_complaint?: string | null;
  notes?: string | null;
  reminder_sent: boolean;
  created_at: string;
}

export interface Treatment {
  id: number;
  patient_id: number;
  appointment_id?: number | null;
  procedure_id: number;
  procedure_name?: string | null;
  tooth?: string | null;
  notes?: string | null;
  price: number;
  performed_on: string;
}

export interface InvoiceItem {
  id?: number;
  invoice_id?: number | null;
  procedure_id?: number | null;
  description: string;
  quantity: number;
  unit_price: number;
}

export interface Payment {
  id: number;
  invoice_id: number;
  amount: number;
  method: PaymentMethod;
  reference?: string | null;
  paid_on: string;
}

export interface Invoice {
  id: number;
  patient_id: number;
  patient_name?: string | null;
  appointment_id?: number | null;
  total: number;
  paid: number;
  status: InvoiceStatus;
  notes?: string | null;
  created_at: string;
  items: InvoiceItem[];
  payments: Payment[];
}

export interface DashboardSummary {
  patients: number;
  today_appointments: number;
  pending_invoices: number;
  pending_dues: number;
  month_revenue: number;
}
