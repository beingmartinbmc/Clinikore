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
export default function TreatmentPlanEditor({ patientId, plan, onChanged }: Props) {
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
      toast.success("Plan saved");
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
      return toast.error("Pick a procedure or add a title");
    try {
      await api.post(`/api/treatment-plans/${plan.id}/steps`, {
        title: draft.title || procedures.find((p) => p.id === Number(draft.procedure_id))?.name || "Step",
        procedure_id: draft.procedure_id ? Number(draft.procedure_id) : null,
        tooth: draft.tooth || null,
        estimated_cost: draft.estimated_cost || 0,
      });
      setDraft({ title: "", procedure_id: "", tooth: "", estimated_cost: 0 });
      setAdding(false);
      toast.success("Step added");
      onChanged?.();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function removeStep(step: TreatmentPlanStep) {
    if (!confirm("Remove this step?")) return;
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
      toast.success("Step completed — treatment recorded");
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
              {doneCount} / {steps.length} steps complete
            </span>
            <span>
              Estimate: <b>₹ {estimate.toLocaleString()}</b>
            </span>
            <span>
              Actual so far: <b>₹ {actual.toLocaleString()}</b>
            </span>
            <span className={
              "px-1.5 rounded bg-slate-100 text-slate-700 uppercase " +
              (plan.status === "completed" ? "bg-emerald-100 text-emerald-700" : "")
            }>
              {plan.status.replace("_", " ")}
            </span>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-3">
        {steps.length === 0 ? (
          <div className="text-sm text-slate-500 text-center py-6">
            No steps yet. Add the first one below.
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
                      placeholder="Tooth"
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
                      <option value="planned">Planned</option>
                      <option value="in_progress">In progress</option>
                      <option value="completed">Completed</option>
                      <option value="skipped">Skipped</option>
                    </select>
                    <div className="col-span-2 flex items-center justify-end gap-0.5">
                      <button
                        className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                        disabled={idx === 0}
                        onClick={() => move(step, -1)}
                        title="Move up"
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                        disabled={idx === steps.length - 1}
                        onClick={() => move(step, +1)}
                        title="Move down"
                      >
                        <ArrowDown size={14} />
                      </button>
                      {step.status !== "completed" && (
                        <button
                          className="p-1 text-emerald-500 hover:text-emerald-700"
                          onClick={() => complete(step)}
                          title="Mark complete & record treatment"
                        >
                          <CheckCircle2 size={14} />
                        </button>
                      )}
                      <button
                        className="p-1 text-slate-400 hover:text-rose-600"
                        onClick={() => removeStep(step)}
                        title="Remove"
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
            <option value="">Procedure...</option>
            {procedures.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input
            className="input !py-1 !text-sm col-span-3"
            placeholder="Title"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <input
            className="input !py-1 !text-sm col-span-1"
            placeholder="Tooth"
            value={draft.tooth}
            onChange={(e) => setDraft({ ...draft, tooth: e.target.value })}
          />
          <input
            className="input !py-1 !text-sm col-span-2 text-right"
            type="number"
            placeholder="Cost"
            value={draft.estimated_cost}
            onChange={(e) => setDraft({ ...draft, estimated_cost: Number(e.target.value) })}
          />
          <div className="col-span-2 flex gap-1 justify-end">
            <button type="button" className="btn-ghost !py-1 !text-xs" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary !py-1 !text-xs" onClick={addStep}>
              Add
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn-ghost !py-1 !text-sm"
          onClick={() => setAdding(true)}
        >
          <Plus size={14} /> Add step
        </button>
      )}

      <div>
        <label className="label">Plan notes</label>
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
