import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import {
  FileText,
  NotebookPen,
  Printer,
  Search,
  PillBottle,
  User,
  CalendarDays,
  X,
  Stethoscope,
  ClipboardList,
  Sparkles,
} from "lucide-react";
import {
  api,
  ConsultationNote,
  parsePrescriptionItems,
} from "../api";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import ConsultNoteEditor from "../components/ConsultNoteEditor";
import { format, subDays, startOfMonth } from "date-fns";
import clsx from "clsx";

/**
 * Clinic-wide consultations & prescriptions page.
 *
 * Every visit note the doctor has recorded — across all patients — lands
 * here with filters for text search, date range, and "has prescription"
 * so the doctor can quickly find a specific visit, open the note, or hit
 * print/PDF to re-issue the Rx.
 */
type Filter = "all" | "rx" | "no_rx";

const FILTERS: { id: Filter; label: string; icon: JSX.Element }[] = [
  { id: "all", label: "All visits", icon: <ClipboardList size={13} /> },
  { id: "rx", label: "With Rx", icon: <PillBottle size={13} /> },
  { id: "no_rx", label: "Needs Rx", icon: <Sparkles size={13} /> },
];

// Quick date presets the doctor reaches for most often. Each button only
// sets date_from; date_to defaults to today on the backend via "no upper
// bound", but we set an explicit upper bound too so custom ranges work.
type Preset = {
  id: string;
  label: string;
  range: () => { from: string; to: string };
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const PRESETS: Preset[] = [
  {
    id: "7d",
    label: "Last 7 days",
    range: () => ({
      from: format(subDays(new Date(), 6), "yyyy-MM-dd"),
      to: todayISO(),
    }),
  },
  {
    id: "30d",
    label: "Last 30 days",
    range: () => ({
      from: format(subDays(new Date(), 29), "yyyy-MM-dd"),
      to: todayISO(),
    }),
  },
  {
    id: "mtd",
    label: "This month",
    range: () => ({
      from: format(startOfMonth(new Date()), "yyyy-MM-dd"),
      to: todayISO(),
    }),
  },
];

export default function Consultations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [notes, setNotes] = useState<ConsultationNote[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ConsultationNote | null>(null);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (filter === "rx") params.set("has_prescription", "true");
    if (filter === "no_rx") params.set("has_prescription", "false");
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    api
      .get<ConsultationNote[]>(
        `/api/consultation-notes${params.toString() ? `?${params}` : ""}`,
      )
      .then((rows) => {
        setNotes(rows);
        setLoading(false);
      })
      .catch((e) => {
        toast.error(e.message);
        setLoading(false);
      });
  }

  // Debounce search so we don't hammer the API on every keystroke.
  useEffect(() => {
    const h = setTimeout(load, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filter, dateFrom, dateTo]);

  // URLs are rendered into <a target="_blank"> elements rather than being
  // opened via JS. pywebview (our desktop shell) blocks window.open()
  // popups, but target-blank anchors are handed off to the system
  // browser — so the printable Rx and PDF always open reliably.
  const printableUrl = (n: ConsultationNote) =>
    `/api/consultation-notes/${n.id}/prescription`;
  const pdfUrl = (n: ConsultationNote) =>
    `/api/consultation-notes/${n.id}/prescription.pdf`;

  function applyPreset(p: Preset) {
    const r = p.range();
    setDateFrom(r.from);
    setDateTo(r.to);
  }

  function clearDates() {
    setDateFrom("");
    setDateTo("");
  }

  const dateFilterActive = Boolean(dateFrom || dateTo);
  const activePreset = useMemo(() => {
    if (!dateFrom || !dateTo) return null;
    for (const p of PRESETS) {
      const r = p.range();
      if (r.from === dateFrom && r.to === dateTo) return p.id;
    }
    return null;
  }, [dateFrom, dateTo]);

  // Deep-link support: if the URL carries ?open=<noteId>, fetch that note
  // and open it in the editor modal. Useful for jumping from an invoice
  // page ("View consultation") or any bookmark.
  useEffect(() => {
    const openId = Number(searchParams.get("open") || "");
    if (!openId) return;
    const existing = notes.find((n) => n.id === openId);
    if (existing) {
      setEditing(existing);
      searchParams.delete("open");
      setSearchParams(searchParams, { replace: true });
      return;
    }
    api
      .get<ConsultationNote>(`/api/consultation-notes/${openId}`)
      .then((n) => {
        setEditing(n);
        searchParams.delete("open");
        setSearchParams(searchParams, { replace: true });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, notes]);

  const grouped = useMemo(() => {
    // Group visits by day so the timeline reads naturally. The backend
    // already sorts by created_at desc, so map insertion order preserves
    // newest-first.
    const m = new Map<string, ConsultationNote[]>();
    for (const n of notes) {
      const key = format(
        new Date(n.appointment_start || n.created_at),
        "EEEE, dd MMM yyyy",
      );
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(n);
    }
    return Array.from(m.entries());
  }, [notes]);

  const stats = useMemo(() => {
    let rxCount = 0;
    let meds = 0;
    const patients = new Set<number>();
    for (const n of notes) {
      patients.add(n.patient_id);
      const rx = parsePrescriptionItems(n.prescription_items);
      if (rx.length > 0) {
        rxCount += 1;
        meds += rx.length;
      }
    }
    return { rxCount, meds, patients: patients.size, total: notes.length };
  }, [notes]);

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto">
      <PageHeader
        title="Consultations & prescriptions"
        subtitle="Every visit note in one place — search, filter by date, open or re-issue the Rx."
      />

      {/* ─── Summary strip ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard
          icon={<ClipboardList size={16} />}
          label="Visits"
          value={stats.total}
          tone="slate"
        />
        <StatCard
          icon={<PillBottle size={16} />}
          label="With Rx"
          value={stats.rxCount}
          tone="brand"
        />
        <StatCard
          icon={<Stethoscope size={16} />}
          label="Medicines"
          value={stats.meds}
          tone="indigo"
        />
        <StatCard
          icon={<User size={16} />}
          label="Patients"
          value={stats.patients}
          tone="amber"
        />
      </div>

      {/* ─── Filter bar ────────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-4 mb-5">
        <div className="flex flex-col lg:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-0">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              className="input pl-9"
              placeholder="Search by patient, complaint, diagnosis or advice…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {q && (
              <button
                onClick={() => setQ("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Segmented filter */}
          <div className="inline-flex bg-slate-100 rounded-lg p-0.5 shrink-0">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={clsx(
                  "px-3 py-1.5 text-sm rounded-md flex items-center gap-1.5 transition-colors",
                  filter === f.id
                    ? "bg-white text-brand-700 shadow-sm font-medium"
                    : "text-slate-600 hover:text-slate-800",
                )}
              >
                {f.icon}
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Date row */}
        <div className="mt-3 pt-3 border-t border-slate-100 flex flex-col lg:flex-row gap-3 items-start lg:items-center">
          <div className="flex items-center gap-2 text-sm text-slate-600 shrink-0">
            <CalendarDays size={15} className="text-slate-400" />
            <span className="font-medium">Date</span>
          </div>
          <div className="flex flex-wrap gap-2 items-center flex-1">
            <input
              type="date"
              className="input !py-1.5 !text-sm w-auto"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="From"
            />
            <span className="text-slate-400 text-sm">→</span>
            <input
              type="date"
              className="input !py-1.5 !text-sm w-auto"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="To"
            />
            <div className="flex flex-wrap gap-1 ml-0 lg:ml-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => applyPreset(p)}
                  className={clsx(
                    "px-2.5 py-1 text-xs rounded-md border transition-colors",
                    activePreset === p.id
                      ? "bg-brand-50 border-brand-200 text-brand-700 font-medium"
                      : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50",
                  )}
                >
                  {p.label}
                </button>
              ))}
              {dateFilterActive && (
                <button
                  onClick={clearDates}
                  className="px-2.5 py-1 text-xs rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 flex items-center gap-1"
                >
                  <X size={12} /> Clear
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Results ───────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonList />
      ) : notes.length === 0 ? (
        <EmptyState hasFilters={Boolean(q || dateFilterActive || filter !== "all")} />
      ) : (
        <div className="space-y-6">
          {grouped.map(([day, items]) => (
            <section key={day}>
              <div className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <CalendarDays size={13} className="text-slate-400" />
                {day}
                <span className="text-slate-300 font-normal">·</span>
                <span className="text-slate-400 font-normal normal-case tracking-normal">
                  {items.length} visit{items.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="space-y-2.5">
                {items.map((n) => (
                  <ConsultationCard
                    key={n.id}
                    note={n}
                    onOpen={() => setEditing(n)}
                    printHref={printableUrl(n)}
                    pdfHref={pdfUrl(n)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing?.patient_name
            ? `${editing.patient_name} — consultation`
            : "Consultation"
        }
        width="max-w-3xl"
      >
        {editing && (
          <ConsultNoteEditor
            patientId={editing.patient_id}
            appointmentId={editing.appointment_id}
            existing={editing}
            onSaved={() => {
              setEditing(null);
              load();
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
    </div>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────
type Tone = "slate" | "brand" | "indigo" | "amber";
const TONES: Record<Tone, { bg: string; text: string; icon: string }> = {
  slate: { bg: "bg-slate-50", text: "text-slate-700", icon: "text-slate-500" },
  brand: { bg: "bg-brand-50", text: "text-brand-700", icon: "text-brand-600" },
  indigo: { bg: "bg-indigo-50", text: "text-indigo-700", icon: "text-indigo-600" },
  amber: { bg: "bg-amber-50", text: "text-amber-700", icon: "text-amber-600" },
};

function StatCard({
  icon, label, value, tone,
}: {
  icon: JSX.Element;
  label: string;
  value: number;
  tone: Tone;
}) {
  const t = TONES[tone];
  return (
    <div className={clsx("rounded-xl border border-slate-200 bg-white p-3 flex items-center gap-3")}>
      <div className={clsx("w-9 h-9 rounded-lg flex items-center justify-center", t.bg, t.icon)}>
        {icon}
      </div>
      <div>
        <div className="text-xs text-slate-500 uppercase tracking-wide">
          {label}
        </div>
        <div className="text-lg font-semibold text-slate-900 tabular-nums leading-tight">
          {value}
        </div>
      </div>
    </div>
  );
}

function ConsultationCard({
  note, onOpen, printHref, pdfHref,
}: {
  note: ConsultationNote;
  onOpen: () => void;
  printHref: string;
  pdfHref: string;
}) {
  const rx = parsePrescriptionItems(note.prescription_items);
  const when = new Date(note.appointment_start || note.created_at);
  const initials = (note.patient_name || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="group rounded-xl border border-slate-200 bg-white hover:border-brand-200 hover:shadow-sm transition-all overflow-hidden">
      <div className="p-4 flex items-start gap-4">
        {/* Avatar */}
        <Link
          to={`/patients/${note.patient_id}`}
          className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-500 to-emerald-500 text-white font-semibold text-sm flex items-center justify-center shrink-0 shadow-sm"
          title={`Open ${note.patient_name || "patient"}'s record`}
        >
          {initials}
        </Link>

        <div className="flex-1 min-w-0">
          {/* Top row: patient + meta */}
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <Link
                to={`/patients/${note.patient_id}`}
                className="font-semibold text-slate-900 hover:text-brand-700 text-sm truncate block"
              >
                {note.patient_name || `Patient #${note.patient_id}`}
              </Link>
              <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                <span>{format(when, "p")}</span>
                {rx.length > 0 && (
                  <>
                    <span className="text-slate-300">·</span>
                    <span className="inline-flex items-center gap-1 text-brand-700 font-medium">
                      <PillBottle size={11} /> {rx.length} medicine{rx.length === 1 ? "" : "s"}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Actions — fade in on hover on desktop, always visible on
                mobile. Anchors (not buttons) so pywebview routes the
                popup to the system browser instead of blocking it. */}
            <div className="flex items-center gap-1 shrink-0 opacity-100 lg:opacity-60 group-hover:opacity-100 transition-opacity">
              <a
                href={printHref}
                target="_blank"
                rel="noreferrer"
                className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                title="Open printable prescription"
              >
                <Printer size={14} />
              </a>
              <a
                href={pdfHref}
                target="_blank"
                rel="noreferrer"
                className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                title="Download prescription as PDF"
              >
                <FileText size={14} />
              </a>
              <button
                onClick={onOpen}
                className="px-2.5 py-1.5 rounded-md text-xs font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-100"
              >
                Open
              </button>
            </div>
          </div>

          {/* SOAP fields */}
          <div className="mt-2 space-y-1.5">
            {note.chief_complaint && (
              <Field label="Complaint" value={note.chief_complaint} tone="slate" />
            )}
            {note.diagnosis && (
              <Field label="Diagnosis" value={note.diagnosis} tone="indigo" />
            )}
            {note.treatment_advised && (
              <Field label="Advice" value={note.treatment_advised} tone="amber" />
            )}
          </div>

          {/* Rx strip */}
          {rx.length > 0 && (
            <div className="mt-3 rounded-lg bg-brand-50/60 border border-brand-100 px-3 py-2 text-xs text-slate-700">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-brand-700 font-semibold mb-1">
                <PillBottle size={11} /> Prescription
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rx.slice(0, 4).map((it, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-brand-100 text-slate-800"
                  >
                    <b>{it.drug}</b>
                    {it.strength && (
                      <span className="text-slate-500">{it.strength}</span>
                    )}
                    {it.frequency && (
                      <span className="text-slate-400">· {it.frequency}</span>
                    )}
                  </span>
                ))}
                {rx.length > 4 && (
                  <span className="text-slate-500 px-1">
                    + {rx.length - 4} more
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone: "slate" | "indigo" | "amber";
}) {
  const labelTone = {
    slate: "text-slate-500",
    indigo: "text-indigo-600",
    amber: "text-amber-600",
  }[tone];
  return (
    <div className="text-sm text-slate-700 leading-snug">
      <span
        className={clsx(
          "text-[10px] uppercase tracking-widest font-semibold mr-1.5",
          labelTone,
        )}
      >
        {label}
      </span>
      <span className="text-slate-800">{value}</span>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-slate-200 bg-white p-4 animate-pulse"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-slate-100" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-slate-100 rounded w-1/3" />
              <div className="h-3 bg-slate-100 rounded w-3/4" />
              <div className="h-3 bg-slate-100 rounded w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white py-16 px-6 text-center">
      <div className="mx-auto w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center mb-3">
        <NotebookPen size={22} className="text-brand-600" />
      </div>
      <h3 className="font-semibold text-slate-900">
        {hasFilters ? "No matches" : "No consultations yet"}
      </h3>
      <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
        {hasFilters
          ? "Try a different search term or widen the date range."
          : "Mark an appointment as completed or open a patient to add a visit note."}
      </p>
    </div>
  );
}
