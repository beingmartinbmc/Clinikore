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
import { useI18n } from "../i18n/I18nContext";

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

// Status colors + translation keys. Labels are resolved at render time so
// they react to locale changes.
const STATUS_META: { value: ToothStatus; labelKey: string; color: string }[] = [
  { value: "healthy",    labelKey: "dental.healthy",    color: "bg-white text-slate-700 border-slate-300" },
  { value: "caries",     labelKey: "dental.caries",     color: "bg-amber-100 text-amber-800 border-amber-300" },
  { value: "filled",     labelKey: "dental.filled",     color: "bg-sky-100 text-sky-800 border-sky-300" },
  { value: "root_canal", labelKey: "dental.root_canal", color: "bg-indigo-100 text-indigo-800 border-indigo-300" },
  { value: "crown",      labelKey: "dental.crown",      color: "bg-yellow-100 text-yellow-800 border-yellow-300" },
  { value: "bridge",     labelKey: "dental.bridge",     color: "bg-purple-100 text-purple-800 border-purple-300" },
  { value: "implant",    labelKey: "dental.implant",    color: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  { value: "missing",    labelKey: "dental.missing",    color: "bg-slate-200 text-slate-600 border-slate-400 line-through" },
  { value: "impacted",   labelKey: "dental.impacted",   color: "bg-orange-100 text-orange-800 border-orange-300" },
  { value: "fractured",  labelKey: "dental.fractured",  color: "bg-rose-100 text-rose-800 border-rose-300" },
  { value: "mobile",     labelKey: "dental.mobile",     color: "bg-pink-100 text-pink-800 border-pink-300" },
  { value: "watch",      labelKey: "dental.watch",      color: "bg-lime-100 text-lime-800 border-lime-300" },
];

const STATUS_CLASS: Record<ToothStatus, string> = Object.fromEntries(
  STATUS_META.map((o) => [o.value, o.color]),
) as Record<ToothStatus, string>;

export default function DentalChart({ patientId }: Props) {
  const { t } = useI18n();
  const STATUS_OPTIONS = STATUS_META.map((o) => ({
    value: o.value,
    label: t(o.labelKey),
    color: o.color,
  }));
  const STATUS_LABEL: Record<ToothStatus, string> = Object.fromEntries(
    STATUS_OPTIONS.map((o) => [o.value, o.label]),
  ) as Record<ToothStatus, string>;
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
      toast.success(t("dental.saved", { n: selected }));
      setSelected(null);
      reload();
    } catch (e: any) {
      toast.error(e.message || t("dental.save_failed"));
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
            : `${n} · ${t("dental.healthy")}`
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
          <h3 className="font-semibold text-slate-900">{t("dental.title")}</h3>
          <p className="text-xs text-slate-500">
            {t("dental.subtitle")}
          </p>
        </div>
        {loading && <div className="text-xs text-slate-400">{t("dental.loading")}</div>}
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
        title={selected ? t("dental.tooth_title", { n: selected }) : ""}
      >
        <div className="space-y-3">
          <div>
            <label className="label">{t("dental.status")}</label>
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
            <label className="label">{t("dental.conditions")}</label>
            <input
              className="input"
              placeholder={t("dental.conditions_placeholder")}
              value={draft.conditions}
              onChange={(e) => setDraft({ ...draft, conditions: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t("common.notes")}</label>
            <textarea
              className="textarea"
              rows={3}
              placeholder={t("dental.notes_placeholder")}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-ghost" onClick={() => setSelected(null)} type="button">
              <X size={14} /> {t("common.cancel")}
            </button>
            <button
              className="btn-primary"
              onClick={saveTooth}
              type="button"
              disabled={saving}
            >
              <Save size={14} /> {t("common.save")}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
