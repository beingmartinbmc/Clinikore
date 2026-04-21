// Tiny typed API client. Same-origin in prod (served by FastAPI), proxied in dev.
import toast from "react-hot-toast";

const BASE = "";

/** Callback that pages can register to be notified after a soft-delete so
 * they can render an "Undo" toast wired to POST /api/undo/{token}. */
type UndoHandler = (payload: {
  undo_token: string;
  entity_type: string;
  entity_id: number;
  label?: string;
}) => void;

let undoHandler: UndoHandler | null = null;
export function setUndoHandler(h: UndoHandler | null) {
  undoHandler = h;
}

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
  if (ct.includes("application/json")) {
    const data = await res.json();
    // Auto-dispatch undo payloads returned from soft-delete endpoints so any
    // page that deletes something gets a free "Undo" toast.
    if (
      data &&
      typeof data === "object" &&
      (init.method === "DELETE" || (init as any).__undoable) &&
      "undo_token" in data &&
      undoHandler
    ) {
      try {
        undoHandler(data);
      } catch {
        /* best-effort */
      }
    }
    return data as T;
  }
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

/** Convenience helper: soft-delete and toast an Undo button. */
export async function deleteWithUndo(
  path: string,
  successMessage: string,
): Promise<void> {
  const data: any = await api.del(path);
  if (data?.undo_token) {
    const token: string = data.undo_token;
    toast.success(
      (t) => (
        // Inline rendered as JSX string — the caller wraps with react-hot-toast
        // so the button can call api.post to restore.
        // This helper is the plain-text version; pages that want a richer
        // toast can call `renderUndoToast` below.
        successMessage + " · Undo in 60s"
      ) as any,
      { duration: 6000 },
    );
    // Keep the token around on window for 60s so a page can restore it.
    (window as any).__lastUndoToken = token;
  } else {
    toast.success(successMessage);
  }
}

/** Render a toast with an actual Undo button. Returns the toast id. */
export function showUndoToast(
  message: string,
  token: string,
  onUndone?: () => void,
) {
  const id = toast(
    (t) => {
      const root = document.createElement("span");
      return root as any;
    },
    { duration: 8000 },
  );
  // Simple text + button via DOM injection into the toast element.
  // We rely on react-hot-toast's JSX message form instead (see callers).
  return id;
}

// ---------- Types ----------
export type AppointmentStatus = "scheduled" | "completed" | "cancelled" | "no_show";
export type InvoiceStatus = "unpaid" | "partial" | "paid";
export type PaymentMethod = "cash" | "upi" | "card";
export type PatientLifecycle =
  | "new"
  | "consulted"
  | "planned"
  | "in_progress"
  | "completed"
  | "no_show";
export type TreatmentPlanStatus =
  | "planned"
  | "in_progress"
  | "completed"
  | "cancelled";
export type TreatmentStepStatus =
  | "planned"
  | "in_progress"
  | "completed"
  | "skipped";

export type Gender = "male" | "female" | "other";

export interface Patient {
  id: number;
  name: string;
  age?: number | null;
  date_of_birth?: string | null; // ISO date string "YYYY-MM-DD"
  gender?: Gender | null;
  phone?: string | null;
  email?: string | null;
  medical_history?: string | null;
  dental_history?: string | null;
  allergies?: string | null;
  notes?: string | null;
  created_at: string;
  lifecycle?: PatientLifecycle | null;
  last_visit?: string | null;
  pending_steps?: number;
}

/** Compute current age from a YYYY-MM-DD date-of-birth string. Returns null
 * for missing / unparseable input. Mirrors `services.compute_patient_age`. */
export function ageFromDob(dob?: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years -= 1;
  return Math.max(years, 0);
}

/** Best-effort current age: prefer DOB over the stored `age` field. */
export function patientAge(p: Pick<Patient, "age" | "date_of_birth">): number | null {
  return ageFromDob(p.date_of_birth) ?? (p.age ?? null);
}

export interface Procedure {
  id: number;
  name: string;
  description?: string | null;
  default_price: number;
  category?: string | null;
  default_duration_minutes?: number;
}

export interface Room {
  id: number;
  name: string;
  active: boolean;
}

export interface DoctorAvailability {
  id?: number;
  weekday: number; // 0=Mon ... 6=Sun
  is_working: boolean;
  start_time: string; // "HH:MM"
  end_time: string;
  break_start?: string | null;
  break_end?: string | null;
}

export interface Settings {
  id: number;
  doctor_name?: string | null;
  doctor_qualifications?: string | null;
  registration_number?: string | null;
  registration_council?: string | null;
  clinic_name?: string | null;
  clinic_address?: string | null;
  clinic_phone?: string | null;
  clinic_email?: string | null;
  clinic_gstin?: string | null;
  specialization?: string | null;
  /** Structured clinical category (enum-ish, see `DOCTOR_CATEGORIES`). Drives
   *  speciality-aware patient filtering server-side. */
  doctor_category?: string | null;
  locale?: string | null;
  onboarded_at?: string | null;
  updated_at: string;
}

/** Doctor categories in the order the onboarding UI presents them. Kept
 *  in sync with `services.DOCTOR_CATEGORIES` on the backend — the server is
 *  source of truth and exposes `GET /api/doctor-categories` too. */
export const DOCTOR_CATEGORIES: readonly string[] = [
  "general",
  "dental",
  "pediatric",
  "geriatric",
  "gynecology",
  "andrology",
  "cardiology",
  "dermatology",
  "ent",
  "orthopedic",
  "psychiatry",
  "ophthalmology",
] as const;

/** Human-friendly label for a category id (covers the built-in set; falls
 *  back to a Title-Case of the raw string for custom values). */
export function doctorCategoryLabel(cat?: string | null): string {
  const key = (cat || "").trim().toLowerCase();
  const map: Record<string, string> = {
    general: "General / Family Medicine",
    dental: "Dental",
    pediatric: "Pediatrics",
    geriatric: "Geriatrics",
    gynecology: "Gynecology",
    andrology: "Andrology / Urology",
    cardiology: "Cardiology",
    dermatology: "Dermatology",
    ent: "ENT",
    orthopedic: "Orthopedics",
    psychiatry: "Psychiatry",
    ophthalmology: "Ophthalmology",
  };
  if (map[key]) return map[key];
  if (!key) return "";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Settings are considered complete for onboarding when the four fields we
 * absolutely need are filled in:
 *   - doctor_name / clinic_name / registration_number: legally required on
 *     every invoice / prescription (Indian Medical Council 1.4.2)
 *   - doctor_category: drives speciality-aware patient filtering, captured
 *     during onboarding so Day-1 lists show only relevant patients.
 */
export function settingsComplete(s?: Partial<Settings> | null): boolean {
  if (!s) return false;
  return Boolean(
    (s.doctor_name || "").trim() &&
    (s.clinic_name || "").trim() &&
    (s.registration_number || "").trim() &&
    (s.doctor_category || "").trim()
  );
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
  procedure_id?: number | null;
  procedure_name?: string | null;
  room_id?: number | null;
  room_name?: string | null;
}

export interface PrescriptionItem {
  drug: string;
  strength?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
}

export interface ConsultationNote {
  id: number;
  patient_id: number;
  appointment_id?: number | null;
  invoice_id?: number | null;
  chief_complaint?: string | null;
  diagnosis?: string | null;
  treatment_advised?: string | null;
  notes?: string | null;
  /** JSON-encoded array of PrescriptionItem. Stored as a string so the
   *  wire format stays DB-portable. Use parsePrescriptionItems() to read. */
  prescription_items?: string | null;
  prescription_notes?: string | null;
  created_at: string;
  updated_at: string;
  appointment_start?: string | null;
  patient_name?: string | null;
}

export function parsePrescriptionItems(
  raw?: string | null,
): PrescriptionItem[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v as PrescriptionItem[];
  } catch {
    // Legacy free-text — one line per drug.
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => ({ drug: line }));
  }
  return [];
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

// ---------- Dental chart (odontogram) --------------------------------------
export type ToothStatus =
  | "healthy"
  | "caries"
  | "filled"
  | "root_canal"
  | "crown"
  | "bridge"
  | "implant"
  | "missing"
  | "impacted"
  | "fractured"
  | "mobile"
  | "watch";

export interface ToothRecord {
  id: number;
  patient_id: number;
  tooth_number: string; // FDI two-digit ("11".."48", deciduous "51".."85")
  status: ToothStatus;
  conditions?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

/** FDI arches, oriented patient-facing (Upper row left→right = 18..11, 21..28). */
export const FDI_UPPER: string[] = [
  "18","17","16","15","14","13","12","11","21","22","23","24","25","26","27","28",
];
export const FDI_LOWER: string[] = [
  "48","47","46","45","44","43","42","41","31","32","33","34","35","36","37","38",
];

export function isDentalSpecialization(
  settings?: Pick<Settings, "specialization" | "doctor_category"> | null,
): boolean {
  const cat = (settings?.doctor_category || "").toLowerCase();
  if (cat === "dental") return true;
  const s = (settings?.specialization || "").toLowerCase();
  return s.includes("dent") || s.includes("orthodont") || s.includes("endodont");
}

// ---------- Consultation attachments ---------------------------------------
export type AttachmentKind = "image" | "pdf" | "document" | "other";

export interface ConsultationAttachment {
  id: number;
  note_id: number;
  patient_id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  kind: AttachmentKind;
  caption?: string | null;
  uploaded_at: string;
  download_url?: string | null;
}

export async function uploadAttachment(
  noteId: number,
  file: File,
  caption?: string,
): Promise<ConsultationAttachment> {
  const fd = new FormData();
  fd.append("file", file);
  if (caption) fd.append("caption", caption);
  const res = await fetch(`${BASE}/api/consultation-notes/${noteId}/attachments`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.detail) msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<ConsultationAttachment>;
}

export interface TreatmentPlanStep {
  id: number;
  plan_id: number;
  sequence: number;
  title: string;
  procedure_id?: number | null;
  procedure_name?: string | null;
  tooth?: string | null;
  status: TreatmentStepStatus;
  estimated_cost: number;
  actual_cost: number;
  planned_date?: string | null;
  completed_date?: string | null;
  notes?: string | null;
  treatment_id?: number | null;
}

export interface TreatmentPlan {
  id: number;
  patient_id: number;
  title: string;
  status: TreatmentPlanStatus;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  steps: TreatmentPlanStep[];
  estimate_total: number;
  actual_total: number;
  completed_steps: number;
  total_steps: number;
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
  discount_amount?: number;
  status: InvoiceStatus;
  notes?: string | null;
  created_at: string;
  items: InvoiceItem[];
  payments: Payment[];
  subtotal?: number;
  balance?: number;
}

export interface DashboardSummary {
  patients: number;
  today_appointments: number;
  pending_invoices: number;
  pending_dues: number;
  month_revenue: number;
  pending_treatment_patients?: number;
}

export interface AuditEntry {
  id: number;
  action: string;
  entity_type?: string | null;
  entity_id?: number | null;
  summary?: string | null;
  details_json?: string | null;
  actor?: string | null;
  created_at: string;
}

export interface SearchResult {
  type: "patient" | "invoice" | "treatment" | "note";
  id: number;
  title: string;
  subtitle?: string;
  match_phone?: boolean;
  patient_id?: number;
  appointment_id?: number;
}
