import { useEffect, useState, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { ArrowLeft, Plus, Trash2, FileText, Receipt, ClipboardList, Stethoscope, NotebookPen, Bone } from "lucide-react";
import {
  api,
  Appointment,
  ConsultationNote,
  Invoice,
  isDentalSpecialization,
  Patient,
  Procedure,
  Settings,
  Treatment,
  TreatmentPlan,
} from "../api";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import StatusBadge from "../components/StatusBadge";
import ConsultNoteEditor from "../components/ConsultNoteEditor";
import DentalChart from "../components/DentalChart";
import TreatmentPlanEditor from "../components/TreatmentPlanEditor";
import { format } from "date-fns";
import clsx from "clsx";

type Tab = "visits" | "dental" | "plans" | "treatments" | "invoices";

const BASE_TABS: { id: Tab; label: string; icon: any }[] = [
  { id: "visits", label: "Visits & notes", icon: NotebookPen },
  { id: "plans", label: "Treatment plans", icon: ClipboardList },
  { id: "treatments", label: "Treatments", icon: Stethoscope },
  { id: "invoices", label: "Invoices", icon: Receipt },
];

const DENTAL_TAB: { id: Tab; label: string; icon: any } = {
  id: "dental", label: "Dental chart", icon: Bone,
};

const LIFECYCLE_LABEL: Record<string, string> = {
  new: "New",
  consulted: "Consulted",
  planned: "Plan ready",
  in_progress: "In progress",
  completed: "Completed",
  no_show: "No-show",
};

export default function PatientDetail() {
  const { id } = useParams();
  const pid = Number(id);
  const [tab, setTab] = useState<Tab>("visits");
  const [patient, setPatient] = useState<Patient | null>(null);
  const [treatments, setTreatments] = useState<Treatment[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [notes, setNotes] = useState<ConsultationNote[]>([]);
  const [plans, setPlans] = useState<TreatmentPlan[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  // Dentist-only UI: the dental-chart tab is added to the tab strip when
  // the clinic settings describe a dental specialization.
  const isDentist = isDentalSpecialization(settings);
  const TABS = isDentist ? [BASE_TABS[0], DENTAL_TAB, ...BASE_TABS.slice(1)] : BASE_TABS;

  const [txOpen, setTxOpen] = useState(false);
  const [tx, setTx] = useState({
    procedure_id: "",
    tooth: "",
    notes: "",
    price: "",
    performed_on: new Date().toISOString().slice(0, 10),
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Patient>>({});
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteForAppt, setNoteForAppt] = useState<{ appt: Appointment | null; existing: ConsultationNote | null } | null>(null);
  const [newPlanTitle, setNewPlanTitle] = useState("");

  const reload = () => {
    api.get<Patient>(`/api/patients/${pid}`).then((p) => {
      setPatient(p);
      setDraft(p);
    });
    api.get<Treatment[]>(`/api/patients/${pid}/treatments`).then(setTreatments);
    api.get<Appointment[]>(`/api/appointments?patient_id=${pid}`).then(setAppts);
    api.get<ConsultationNote[]>(`/api/patients/${pid}/consultation-notes`).then(setNotes).catch(() => setNotes([]));
    api.get<TreatmentPlan[]>(`/api/patients/${pid}/treatment-plans`).then(setPlans).catch(() => setPlans([]));
    api.get<Invoice[]>(`/api/invoices?patient_id=${pid}`).then(setInvoices).catch(() => setInvoices([]));
    api.get<Settings>("/api/settings").then(setSettings).catch(() => setSettings(null));
  };

  useEffect(() => {
    reload();
    api.get<Procedure[]>("/api/procedures").then(setProcedures);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  async function saveProfile() {
    try {
      await api.put(`/api/patients/${pid}`, {
        ...draft,
        age: draft.age ? Number(draft.age) : null,
      });
      toast.success("Saved");
      setEditing(false);
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function addTreatment(e: FormEvent) {
    e.preventDefault();
    if (!tx.procedure_id) return toast.error("Pick a procedure");
    try {
      await api.post("/api/treatments", {
        patient_id: pid,
        procedure_id: Number(tx.procedure_id),
        tooth: tx.tooth || null,
        notes: tx.notes || null,
        price: tx.price ? Number(tx.price) : 0,
        performed_on: tx.performed_on,
      });
      toast.success("Treatment recorded");
      setTxOpen(false);
      setTx({ procedure_id: "", tooth: "", notes: "", price: "", performed_on: new Date().toISOString().slice(0, 10) });
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function removeTreatment(tid: number) {
    if (!confirm("Delete this treatment?")) return;
    const data: any = await api.del(`/api/treatments/${tid}`);
    if (data?.undo_token) {
      toast.success(
        (t) => (
          <span className="flex items-center gap-3">
            Treatment deleted.
            <button
              className="underline font-semibold text-brand-700"
              onClick={async () => {
                await api.post(`/api/undo/${data.undo_token}`);
                toast.dismiss(t.id);
                reload();
              }}
            >
              Undo
            </button>
          </span>
        ),
        { duration: 6000 },
      );
    }
    reload();
  }

  async function createPlan() {
    if (!newPlanTitle.trim()) return toast.error("Name the plan");
    try {
      await api.post("/api/treatment-plans", {
        patient_id: pid,
        title: newPlanTitle.trim(),
      });
      setNewPlanTitle("");
      toast.success("Plan created");
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function deletePlan(planId: number) {
    if (!confirm("Delete this plan? Treatments already recorded stay intact.")) return;
    await api.del(`/api/treatment-plans/${planId}`);
    reload();
  }

  function openNoteFor(appt: Appointment | null) {
    const existing = appt
      ? notes.find((n) => n.appointment_id === appt.id) || null
      : null;
    setNoteForAppt({ appt, existing });
    setNoteOpen(true);
  }

  function openStandaloneNote() {
    setNoteForAppt({ appt: null, existing: null });
    setNoteOpen(true);
  }

  if (!patient) return <div className="p-8 text-slate-500">Loading...</div>;

  const lifecycle = patient.lifecycle || "new";

  return (
    <div className="p-8">
      <Link to="/patients" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ArrowLeft size={14} /> Back to patients
      </Link>
      <PageHeader
        title={patient.name}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            <span>Patient #{patient.id} · Registered {format(new Date(patient.created_at), "dd MMM yyyy")}</span>
            <StatusBadge value={lifecycle} />
            {typeof patient.pending_steps === "number" && patient.pending_steps > 0 && (
              <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                {patient.pending_steps} pending step{patient.pending_steps === 1 ? "" : "s"}
              </span>
            )}
          </span> as any
        }
        actions={
          editing ? (
            <>
              <button className="btn-ghost" onClick={() => { setEditing(false); setDraft(patient); }}>Cancel</button>
              <button className="btn-primary" onClick={saveProfile}>Save changes</button>
            </>
          ) : (
            <button className="btn-outline" onClick={() => setEditing(true)}>Edit profile</button>
          )
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Profile */}
        <div className="card p-5 lg:col-span-1 space-y-3 h-fit">
          <h2 className="font-semibold text-slate-900 mb-2">Profile</h2>
          {(["age", "phone", "email", "allergies", "medical_history", "dental_history", "notes"] as const).map((k) => (
            <div key={k}>
              <label className="label capitalize">{k.replace("_", " ")}</label>
              {editing ? (
                k === "medical_history" || k === "dental_history" || k === "notes" ? (
                  <textarea
                    className="textarea"
                    rows={2}
                    value={(draft as any)[k] || ""}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                  />
                ) : (
                  <input
                    className="input"
                    type={k === "age" ? "number" : "text"}
                    value={(draft as any)[k] || ""}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                  />
                )
              ) : (
                <div className="text-sm text-slate-700 whitespace-pre-wrap">
                  {(patient as any)[k] || <span className="text-slate-400">—</span>}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Right column with tabs */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex gap-1 border-b border-slate-200">
            {TABS.map((tt) => {
              const Icon = tt.icon;
              return (
                <button
                  key={tt.id}
                  onClick={() => setTab(tt.id)}
                  className={clsx(
                    "px-3 py-2 -mb-px text-sm font-medium border-b-2 flex items-center gap-2",
                    tab === tt.id
                      ? "border-brand-600 text-brand-700"
                      : "border-transparent text-slate-500 hover:text-slate-800",
                  )}
                >
                  <Icon size={14} />
                  {tt.label}
                </button>
              );
            })}
          </div>

          {tab === "visits" && (
            <div className="space-y-4">
              <div className="card p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-slate-900">Visits</h3>
                  <button className="btn-ghost !text-sm" onClick={openStandaloneNote}>
                    <Plus size={14} /> Standalone note
                  </button>
                </div>
                {appts.length === 0 && notes.filter((n) => !n.appointment_id).length === 0 ? (
                  <div className="text-sm text-slate-500 py-6 text-center">No visits yet.</div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {appts.map((a) => {
                      const note = notes.find((n) => n.appointment_id === a.id);
                      return (
                        <div key={a.id} className="py-3 flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <div className="font-medium text-slate-900">
                              {format(new Date(a.start), "dd MMM yyyy, p")}
                            </div>
                            <div className="text-xs text-slate-500">
                              {a.chief_complaint || "—"}
                            </div>
                            {note && (
                              <div className="mt-1 text-xs text-slate-600 pl-2 border-l-2 border-brand-100">
                                {note.diagnosis && <div><b>Dx:</b> {note.diagnosis}</div>}
                                {note.treatment_advised && <div><b>Rx:</b> {note.treatment_advised}</div>}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <StatusBadge value={a.status} />
                            <button
                              className="btn-ghost !py-1 !text-xs"
                              onClick={() => openNoteFor(a)}
                            >
                              {note ? "Edit note" : "Add note"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {notes.filter((n) => !n.appointment_id).map((n) => (
                      <div key={`standalone-${n.id}`} className="py-3">
                        <div className="font-medium text-slate-900 text-sm">
                          Standalone note · {format(new Date(n.created_at), "dd MMM yyyy")}
                        </div>
                        {n.diagnosis && <div className="text-xs"><b>Dx:</b> {n.diagnosis}</div>}
                        {n.treatment_advised && <div className="text-xs"><b>Rx:</b> {n.treatment_advised}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "dental" && isDentist && (
            <DentalChart patientId={pid} />
          )}

          {tab === "plans" && (
            <div className="space-y-4">
              <div className="card p-3 flex items-center gap-2">
                <input
                  className="input flex-1"
                  placeholder="New plan title (e.g. Full-mouth dental rehab)"
                  value={newPlanTitle}
                  onChange={(e) => setNewPlanTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createPlan()}
                />
                <button className="btn-primary" onClick={createPlan}>
                  <Plus size={14} /> New plan
                </button>
              </div>
              {plans.length === 0 ? (
                <div className="card p-8 text-center text-sm text-slate-500">
                  No treatment plans. Create one above to organize multi-visit care.
                </div>
              ) : (
                plans.map((p) => (
                  <div key={p.id} className="relative">
                    <TreatmentPlanEditor patientId={pid} plan={p} onChanged={reload} />
                    <button
                      className="absolute top-4 right-4 text-slate-400 hover:text-rose-600"
                      onClick={() => deletePlan(p.id)}
                      title="Delete plan"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === "treatments" && (
            <div className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-slate-900">Treatments</h3>
                <button className="btn-primary" onClick={() => setTxOpen(true)}>
                  <Plus size={14} /> Add
                </button>
              </div>
              {treatments.length === 0 ? (
                <div className="text-sm text-slate-500 py-6 text-center">No treatments recorded.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="text-left font-medium py-2">Date</th>
                      <th className="text-left font-medium py-2">Procedure</th>
                      <th className="text-left font-medium py-2">Tooth</th>
                      <th className="text-right font-medium py-2">Price</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {treatments.map((t) => (
                      <tr key={t.id}>
                        <td className="py-2">{format(new Date(t.performed_on), "dd MMM yyyy")}</td>
                        <td className="py-2 font-medium text-slate-900">{t.procedure_name}</td>
                        <td className="py-2">{t.tooth || "—"}</td>
                        <td className="py-2 text-right">₹ {t.price.toLocaleString()}</td>
                        <td className="py-2 text-right">
                          <button
                            className="text-slate-400 hover:text-rose-600"
                            onClick={() => removeTreatment(t.id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === "invoices" && (
            <div className="card p-5">
              <h3 className="font-semibold text-slate-900 mb-3">Invoices</h3>
              {invoices.length === 0 ? (
                <div className="text-sm text-slate-500 py-6 text-center">
                  No invoices for this patient.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="text-left font-medium py-2">#</th>
                      <th className="text-left font-medium py-2">Date</th>
                      <th className="text-right font-medium py-2">Total</th>
                      <th className="text-right font-medium py-2">Balance</th>
                      <th className="text-left font-medium py-2">Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {invoices.map((inv) => (
                      <tr key={inv.id}>
                        <td className="py-2">
                          <Link to={`/invoices/${inv.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                            #{String(inv.id).padStart(5, "0")}
                          </Link>
                        </td>
                        <td className="py-2 text-slate-500">
                          {format(new Date(inv.created_at), "dd MMM yyyy")}
                        </td>
                        <td className="py-2 text-right">₹ {inv.total.toLocaleString()}</td>
                        <td className="py-2 text-right">
                          ₹ {(inv.total - inv.paid).toLocaleString()}
                        </td>
                        <td className="py-2"><StatusBadge value={inv.status} /></td>
                        <td className="py-2 text-right">
                          <a
                            href={`/api/invoices/${inv.id}/pdf`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-slate-400 hover:text-brand-700"
                          >
                            <FileText size={14} />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={txOpen}
        onClose={() => setTxOpen(false)}
        title="Record treatment"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setTxOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={addTreatment as any}>Save</button>
          </>
        }
      >
        <form onSubmit={addTreatment} className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">Procedure *</label>
            <select
              className="select"
              required
              value={tx.procedure_id}
              onChange={(e) => {
                const p = procedures.find((pp) => pp.id === Number(e.target.value));
                setTx({
                  ...tx,
                  procedure_id: e.target.value,
                  price: p ? String(p.default_price) : tx.price,
                });
              }}
            >
              <option value="">Select procedure...</option>
              {procedures.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (₹{p.default_price})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Tooth</label>
            <input
              className="input"
              placeholder="e.g. 36"
              value={tx.tooth}
              onChange={(e) => setTx({ ...tx, tooth: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Date</label>
            <input
              className="input"
              type="date"
              value={tx.performed_on}
              onChange={(e) => setTx({ ...tx, performed_on: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="label">Price (₹)</label>
            <input
              className="input"
              type="number"
              value={tx.price}
              onChange={(e) => setTx({ ...tx, price: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="label">Notes</label>
            <textarea
              className="textarea"
              rows={2}
              value={tx.notes}
              onChange={(e) => setTx({ ...tx, notes: e.target.value })}
            />
          </div>
        </form>
      </Modal>

      <Modal
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title={
          noteForAppt?.appt
            ? `Note for ${format(new Date(noteForAppt.appt.start), "dd MMM yyyy, p")}`
            : "Consultation note"
        }
        width="max-w-2xl"
      >
        {noteOpen && (
          <ConsultNoteEditor
            patientId={pid}
            appointmentId={noteForAppt?.appt?.id || null}
            existing={noteForAppt?.existing || null}
            onSaved={() => {
              setNoteOpen(false);
              reload();
            }}
            onCancel={() => setNoteOpen(false)}
          />
        )}
      </Modal>
    </div>
  );
}
