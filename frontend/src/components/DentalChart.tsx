import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Save, X } from "lucide-react";
import {
  api,
  FDI_LOWER,
  FDI_UPPER,
  ToothRecord,
  ToothStatus,
} from "../api";
import Modal from "./Modal";

/**
 * Dental chart (odontogram) for dentist users.
 *
 * Uses FDI / ISO 3950 two-digit numbering, which is the standard Indian /
 * WHO dental chart. Adult permanent dentition only (16 upper + 16 lower);
 * deciduous teeth can be added later if needed.
 *
 * Rows are oriented patient-facing, so the upper-right quadrant (18..11)
 * sits on the LEFT of the top row, matching how the doctor sees the patient
 * across the chair.
 */
interface Props {
  patientId: number;
}

const STATUS_OPTIONS: { value: ToothStatus; label: string; color: string }[] = [
  { value: "healthy",    label: "Healthy",     color: "bg-white text-slate-700 border-slate-300" },
  { value: "caries",     label: "Caries",      color: "bg-amber-100 text-amber-800 border-amber-300" },
  { value: "filled",     label: "Filled",      color: "bg-sky-100 text-sky-800 border-sky-300" },
  { value: "root_canal", label: "Root canal",  color: "bg-indigo-100 text-indigo-800 border-indigo-300" },
  { value: "crown",      label: "Crown",       color: "bg-yellow-100 text-yellow-800 border-yellow-300" },
  { value: "bridge",     label: "Bridge",      color: "bg-purple-100 text-purple-800 border-purple-300" },
  { value: "implant",    label: "Implant",     color: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  { value: "missing",    label: "Missing",     color: "bg-slate-200 text-slate-600 border-slate-400 line-through" },
  { value: "impacted",   label: "Impacted",    color: "bg-orange-100 text-orange-800 border-orange-300" },
  { value: "fractured",  label: "Fractured",   color: "bg-rose-100 text-rose-800 border-rose-300" },
  { value: "mobile",     label: "Mobile",      color: "bg-pink-100 text-pink-800 border-pink-300" },
  { value: "watch",      label: "Watch",       color: "bg-lime-100 text-lime-800 border-lime-300" },
];

const STATUS_CLASS: Record<ToothStatus, string> = Object.fromEntries(
  STATUS_OPTIONS.map((o) => [o.value, o.color]),
) as Record<ToothStatus, string>;

const STATUS_LABEL: Record<ToothStatus, string> = Object.fromEntries(
  STATUS_OPTIONS.map((o) => [o.value, o.label]),
) as Record<ToothStatus, string>;

export default function DentalChart({ patientId }: Props) {
  const [records, setRecords] = useState<ToothRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    status: ToothStatus;
    conditions: string;
    notes: string;
  }>({ status: "healthy", conditions: "", notes: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  function reload() {
    setLoading(true);
    api
      .get<ToothRecord[]>(`/api/patients/${patientId}/dental-chart`)
      .then((r) => {
        setRecords(r);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  const byTooth = useMemo(() => {
    const m = new Map<string, ToothRecord>();
    for (const r of records) m.set(r.tooth_number, r);
    return m;
  }, [records]);

  function openTooth(tooth: string) {
    const existing = byTooth.get(tooth);
    setSelected(tooth);
    setDraft({
      status: existing?.status || "healthy",
      conditions: existing?.conditions || "",
      notes: existing?.notes || "",
    });
  }

  async function saveTooth() {
    if (!selected) return;
    setSaving(true);
    try {
      // Healthy + empty fields = nothing worth storing, so delete the row
      // to keep the DB tidy (and the chart visually clean).
      const isEmpty =
        draft.status === "healthy" &&
        !draft.conditions.trim() &&
        !draft.notes.trim();
      if (isEmpty && byTooth.has(selected)) {
        await api.del(`/api/patients/${patientId}/dental-chart/${selected}`);
      } else if (!isEmpty) {
        await api.put<ToothRecord>(
          `/api/patients/${patientId}/dental-chart/${selected}`,
          {
            status: draft.status,
            conditions: draft.conditions || null,
            notes: draft.notes || null,
          },
        );
      }
      toast.success(`Tooth ${selected} saved`);
      setSelected(null);
      reload();
    } catch (e: any) {
      toast.error(e.message || "Could not save tooth");
    } finally {
      setSaving(false);
    }
  }

  function Tooth({ n }: { n: string }) {
    const rec = byTooth.get(n);
    const cls = rec ? STATUS_CLASS[rec.status] : STATUS_CLASS.healthy;
    return (
      <button
        type="button"
        onClick={() => openTooth(n)}
        className={`relative w-10 h-12 border rounded-md text-xs font-semibold flex items-center justify-center transition hover:ring-2 hover:ring-brand-300 ${cls}`}
        title={
          rec
            ? `${n} · ${STATUS_LABEL[rec.status]}${rec.notes ? ` — ${rec.notes}` : ""}`
            : `${n} · Healthy`
        }
      >
        {n}
        {rec && rec.status !== "healthy" && (
          <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-brand-600 ring-2 ring-white" />
        )}
      </button>
    );
  }

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-slate-900">Dental chart</h3>
          <p className="text-xs text-slate-500">
            FDI numbering · click a tooth to mark its status, conditions and notes.
          </p>
        </div>
        {loading && <div className="text-xs text-slate-400">Loading…</div>}
      </div>

      <div className="flex flex-col items-center gap-1 select-none overflow-x-auto">
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: "repeat(16, minmax(0,1fr))" }}
        >
          {FDI_UPPER.map((n) => (
            <Tooth key={n} n={n} />
          ))}
        </div>
        <div className="h-px w-full bg-slate-200 my-1" />
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: "repeat(16, minmax(0,1fr))" }}
        >
          {FDI_LOWER.map((n) => (
            <Tooth key={n} n={n} />
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2 text-xs pt-2 border-t border-slate-100">
        {STATUS_OPTIONS.filter((o) => o.value !== "healthy").map((o) => (
          <span
            key={o.value}
            className={`px-2 py-0.5 border rounded-md ${o.color}`}
          >
            {o.label}
          </span>
        ))}
      </div>

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Tooth ${selected}` : ""}
      >
        <div className="space-y-3">
          <div>
            <label className="label">Status</label>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              {STATUS_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setDraft({ ...draft, status: o.value })}
                  className={`px-2 py-1 text-xs rounded border ${o.color} ${
                    draft.status === o.value ? "ring-2 ring-brand-500" : ""
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Conditions / findings</label>
            <input
              className="input"
              placeholder="e.g. Deep caries on mesial surface"
              value={draft.conditions}
              onChange={(e) => setDraft({ ...draft, conditions: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea
              className="textarea"
              rows={3}
              placeholder="Planned treatment, last X-ray, referral…"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-ghost" onClick={() => setSelected(null)} type="button">
              <X size={14} /> Cancel
            </button>
            <button
              className="btn-primary"
              onClick={saveTooth}
              type="button"
              disabled={saving}
            >
              <Save size={14} /> Save
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
