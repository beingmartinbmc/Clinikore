import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import {
  Plus, Trash2, ArrowUp, ArrowDown, CheckCircle2, Circle, CircleDashed,
} from "lucide-react";
import {
  api,
  Procedure,
  TreatmentPlan,
  TreatmentPlanStep,
  TreatmentStepStatus,
} from "../api";
import { useI18n } from "../i18n/I18nContext";

interface Props {
  patientId: number;
  plan: TreatmentPlan;
  onChanged?: () => void;
}

const STATUS_ICON: Record<TreatmentStepStatus, any> = {
  planned: CircleDashed,
  in_progress: Circle,
  completed: CheckCircle2,
  skipped: Circle,
};

const STATUS_TONE: Record<TreatmentStepStatus, string> = {
  planned: "text-slate-400",
  in_progress: "text-amber-500",
  completed: "text-emerald-600",
  skipped: "text-slate-300 line-through",
};

/**
 * Compact plan editor. Steps can be reordered, tooth-tagged (useful for
 * dental), status-updated, and marked complete — which atomically records
 * a Treatment row on the backend, so the ledger and the plan stay in sync.
 */
export default function TreatmentPlanEditor({ plan, onChanged }: Props) {
  const { t } = useI18n();
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [steps, setSteps] = useState<TreatmentPlanStep[]>(plan.steps);
  const [title, setTitle] = useState(plan.title);
  const [notes, setNotes] = useState(plan.notes || "");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    procedure_id: "",
    tooth: "",
    estimated_cost: 0,
  });

  useEffect(() => {
    api.get<Procedure[]>("/api/procedures").then(setProcedures);
  }, []);

  useEffect(() => {
    setSteps(plan.steps);
    setTitle(plan.title);
    setNotes(plan.notes || "");
  }, [plan.id, plan.updated_at]);

  const estimate = useMemo(
    () => steps.reduce((s, t) => s + (t.estimated_cost || 0), 0),
    [steps]
  );
  const actual = useMemo(
    () =>
      steps
        .filter((t) => t.status === "completed")
        .reduce((s, t) => s + (t.actual_cost || 0), 0),
    [steps]
  );
  const doneCount = steps.filter((t) => t.status === "completed").length;

  async function savePlanMeta() {
    try {
      await api.put(`/api/treatment-plans/${plan.id}`, {
        title,
        notes: notes || null,
      });
      toast.success(t("tpe.saved"));
      onChanged?.();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function patchStep(step: TreatmentPlanStep, patch: Partial<TreatmentPlanStep>) {
    try {
      await api.put(`/api/treatment-plans/${plan.id}/steps/${step.id}`, patch);
      onChanged?.();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function addStep() {
    if (!draft.title.trim() && !draft.procedure_id)
      return toast.error(t("tpe.pick_or_title"));
    try {
      await api.post(`/api/treatment-plans/${plan.id}/steps`, {
        title:
          draft.title ||
          procedures.find((p) => p.id === Number(draft.procedure_id))?.name ||
          t("tpe.default_step"),
        procedure_id: draft.procedure_id ? Number(draft.procedure_id) : null,
        tooth: draft.tooth || null,
        estimated_cost: draft.estimated_cost || 0,
      });
      setDraft({ title: "", procedure_id: "", tooth: "", estimated_cost: 0 });
      setAdding(false);
      toast.success(t("tpe.step_added"));
      onChanged?.();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function removeStep(step: TreatmentPlanStep) {
    if (!confirm(t("tpe.remove_confirm"))) return;
    await api.del(`/api/treatment-plans/${plan.id}/steps/${step.id}`);
    onChanged?.();
  }

  async function move(step: TreatmentPlanStep, delta: -1 | 1) {
    const idx = steps.findIndex((s) => s.id === step.id);
    const target = idx + delta;
    if (target < 0 || target >= steps.length) return;
    const newSeq = steps[target].sequence;
    await patchStep(step, { sequence: newSeq } as any);
  }

  async function complete(step: TreatmentPlanStep) {
    try {
      await api.post(`/api/treatment-plans/${plan.id}/steps/${step.id}/complete`);
      toast.success(t("tpe.step_completed"));
      onChanged?.();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1">
          <input
            className="input text-lg font-semibold"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={savePlanMeta}
          />
          <div className="text-xs text-slate-500 mt-1 flex items-center gap-3 flex-wrap">
            <span>
              {t("tpe.steps_progress", { done: doneCount, total: steps.length })}
            </span>
            <span>
              {t("tpe.estimate")} <b>₹ {estimate.toLocaleString()}</b>
            </span>
            <span>
              {t("tpe.actual")} <b>₹ {actual.toLocaleString()}</b>
            </span>
            <span className={
              "px-1.5 rounded bg-slate-100 text-slate-700 uppercase " +
              (plan.status === "completed" ? "bg-emerald-100 text-emerald-700" : "")
            }>
              {t(`tpe.status.${plan.status}` as any)}
            </span>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-3">
        {steps.length === 0 ? (
          <div className="text-sm text-slate-500 text-center py-6">
            {t("tpe.no_steps")}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {steps.map((step, idx) => {
              const Icon = STATUS_ICON[step.status];
              return (
                <li key={step.id} className="py-2.5 flex items-center gap-2">
                  <Icon size={16} className={STATUS_TONE[step.status]} />
                  <div className="flex-1 min-w-0 grid grid-cols-12 gap-2 items-center">
                    <input
                      className={"input !py-1 !text-sm col-span-5 " + (step.status === "skipped" ? "line-through text-slate-400" : "")}
                      value={step.title}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSteps((ss) => ss.map((s) => s.id === step.id ? { ...s, title: v } : s));
                      }}
                      onBlur={(e) => patchStep(step, { title: e.target.value })}
                    />
                    <input
                      className="input !py-1 !text-sm col-span-1"
                      placeholder={t("tpe.tooth")}
                      value={step.tooth || ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSteps((ss) => ss.map((s) => s.id === step.id ? { ...s, tooth: v } : s));
                      }}
                      onBlur={(e) => patchStep(step, { tooth: e.target.value || null })}
                    />
                    <input
                      className="input !py-1 !text-sm col-span-2 text-right"
                      type="number"
                      value={step.estimated_cost}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setSteps((ss) => ss.map((s) => s.id === step.id ? { ...s, estimated_cost: v } : s));
                      }}
                      onBlur={(e) => patchStep(step, { estimated_cost: Number(e.target.value) })}
                    />
                    <select
                      className="select !py-1 !text-sm col-span-2"
                      value={step.status}
                      onChange={(e) =>
                        patchStep(step, { status: e.target.value as TreatmentStepStatus })
                      }
                    >
                      <option value="planned">{t("tpe.status.planned")}</option>
                      <option value="in_progress">{t("tpe.status.in_progress")}</option>
                      <option value="completed">{t("tpe.status.completed")}</option>
                      <option value="skipped">{t("tpe.status.skipped")}</option>
                    </select>
                    <div className="col-span-2 flex items-center justify-end gap-0.5">
                      <button
                        className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                        disabled={idx === 0}
                        onClick={() => move(step, -1)}
                        title={t("tpe.move_up")}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                        disabled={idx === steps.length - 1}
                        onClick={() => move(step, +1)}
                        title={t("tpe.move_down")}
                      >
                        <ArrowDown size={14} />
                      </button>
                      {step.status !== "completed" && (
                        <button
                          className="p-1 text-emerald-500 hover:text-emerald-700"
                          onClick={() => complete(step)}
                          title={t("tpe.mark_complete")}
                        >
                          <CheckCircle2 size={14} />
                        </button>
                      )}
                      <button
                        className="p-1 text-slate-400 hover:text-rose-600"
                        onClick={() => removeStep(step)}
                        title={t("common.remove")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {adding ? (
        <div className="border-t border-slate-100 pt-3 grid grid-cols-12 gap-2 items-center">
          <select
            className="select !py-1 !text-sm col-span-4"
            value={draft.procedure_id}
            onChange={(e) => {
              const proc = procedures.find((p) => p.id === Number(e.target.value));
              setDraft({
                ...draft,
                procedure_id: e.target.value,
                title: proc?.name || draft.title,
                estimated_cost: proc?.default_price || draft.estimated_cost,
              });
            }}
          >
            <option value="">{t("tpe.procedure_select")}</option>
            {procedures.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input
            className="input !py-1 !text-sm col-span-3"
            placeholder={t("tpe.title_placeholder")}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <input
            className="input !py-1 !text-sm col-span-1"
            placeholder={t("tpe.tooth")}
            value={draft.tooth}
            onChange={(e) => setDraft({ ...draft, tooth: e.target.value })}
          />
          <input
            className="input !py-1 !text-sm col-span-2 text-right"
            type="number"
            placeholder={t("tpe.cost_placeholder")}
            value={draft.estimated_cost}
            onChange={(e) => setDraft({ ...draft, estimated_cost: Number(e.target.value) })}
          />
          <div className="col-span-2 flex gap-1 justify-end">
            <button type="button" className="btn-ghost !py-1 !text-xs" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn-primary !py-1 !text-xs" onClick={addStep}>
              {t("common.add")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn-ghost !py-1 !text-sm"
          onClick={() => setAdding(true)}
        >
          <Plus size={14} /> {t("tpe.add_step")}
        </button>
      )}

      <div>
        <label className="label">{t("tpe.plan_notes")}</label>
        <textarea
          className="textarea"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={savePlanMeta}
        />
      </div>
    </div>
  );
}
