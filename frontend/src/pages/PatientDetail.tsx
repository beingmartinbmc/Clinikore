import { useEffect, useState, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { ArrowLeft, Plus, Trash2, FileText, Receipt, ClipboardList, Stethoscope, NotebookPen, Bone } from "lucide-react";
import {
  api,
  Appointment,
  ConsultationNote,
  Invoice,
  patientAge,
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
import { useI18n } from "../i18n/I18nContext";

type Tab = "visits" | "dental" | "plans" | "treatments" | "invoices";

export default function PatientDetail() {
  const { t } = useI18n();
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
  const [, setSettings] = useState<Settings | null>(null);

  // Dental chart is always visible. Doctors of other specialities rarely need
  // it, but the UI cost is one extra tab and the clinical value of having a
  // quick odontogram accessible to every clinician is worth the footprint.
  const TABS: { id: Tab; label: string; icon: any }[] = [
    { id: "visits", label: t("pdetail.tab.visits"), icon: NotebookPen },
    { id: "dental", label: t("pdetail.tab.dental"), icon: Bone },
    { id: "plans", label: t("pdetail.tab.plans"), icon: ClipboardList },
    { id: "treatments", label: t("pdetail.tab.treatments"), icon: Stethoscope },
    { id: "invoices", label: t("pdetail.tab.invoices"), icon: Receipt },
  ];

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
      // When DOB is provided, recompute age so a stale hand-entered value
      // doesn't silently override the canonical derived age.
      const dob = (draft as any).date_of_birth || null;
      const derivedAge = patientAge({ age: null, date_of_birth: dob });
      await api.put(`/api/patients/${pid}`, {
        ...draft,
        date_of_birth: dob,
        gender: (draft as any).gender || null,
        age: derivedAge ?? (draft.age ? Number(draft.age) : null),
      });
      toast.success(t("common.saved"));
      setEditing(false);
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function addTreatment(e: FormEvent) {
    e.preventDefault();
    if (!tx.procedure_id) return toast.error(t("pdetail.pick_a_procedure"));
    try {
      await api.post("/api/treatments", {
        patient_id: pid,
        procedure_id: Number(tx.procedure_id),
        tooth: tx.tooth || null,
        notes: tx.notes || null,
        price: tx.price ? Number(tx.price) : 0,
        performed_on: tx.performed_on,
      });
      toast.success(t("pdetail.treatment_recorded"));
      setTxOpen(false);
      setTx({ procedure_id: "", tooth: "", notes: "", price: "", performed_on: new Date().toISOString().slice(0, 10) });
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function removeTreatment(tid: number) {
    if (!confirm(t("pdetail.confirm_delete_treatment"))) return;
    const data: any = await api.del(`/api/treatments/${tid}`);
    if (data?.undo_token) {
      toast.success(
        (tt) => (
          <span className="flex items-center gap-3">
            {t("pdetail.treatment_deleted")}
            <button
              className="underline font-semibold text-brand-700"
              onClick={async () => {
                await api.post(`/api/undo/${data.undo_token}`);
                toast.dismiss(tt.id);
                reload();
              }}
            >
              {t("common.undo")}
            </button>
          </span>
        ),
        { duration: 6000 },
      );
    }
    reload();
  }

  async function createPlan() {
    if (!newPlanTitle.trim()) return toast.error(t("pdetail.plan_name_required"));
    try {
      await api.post("/api/treatment-plans", {
        patient_id: pid,
        title: newPlanTitle.trim(),
      });
      setNewPlanTitle("");
      toast.success(t("pdetail.plan_created"));
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function deletePlan(planId: number) {
    if (!confirm(t("pdetail.delete_plan_confirm"))) return;
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

  if (!patient) return <div className="p-8 text-slate-500">{t("common.loading")}</div>;

  const lifecycle = patient.lifecycle || "new";

  // Labels for the profile fields list. Uses translation keys and a few flags
  // to keep the JSX below compact.
  const profileFields: {
    key: "age" | "phone" | "email" | "allergies" | "medical_history" | "dental_history" | "notes";
    label: string;
    multiline?: boolean;
  }[] = [
    { key: "age", label: t("pdetail.age") },
    { key: "phone", label: t("pdetail.phone") },
    { key: "email", label: t("pdetail.email") },
    { key: "allergies", label: t("pdetail.allergies") },
    { key: "medical_history", label: t("pdetail.medical_history"), multiline: true },
    { key: "dental_history", label: t("pdetail.dental_history"), multiline: true },
    { key: "notes", label: t("pdetail.notes"), multiline: true },
  ];

  return (
    <div className="p-8">
      <Link to="/patients" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ArrowLeft size={14} /> {t("pdetail.back")}
      </Link>
      <PageHeader
        title={patient.name}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            <span>
              {t("pdetail.subtitle", {
                id: patient.id,
                date: format(new Date(patient.created_at), "dd MMM yyyy"),
              })}
            </span>
            <StatusBadge value={lifecycle} />
            {typeof patient.pending_steps === "number" && patient.pending_steps > 0 && (
              <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                {t("pdetail.pending_steps", {
                  count: patient.pending_steps,
                  s: patient.pending_steps === 1 ? "" : "s",
                })}
              </span>
            )}
          </span> as any
        }
        actions={
          editing ? (
            <>
              <button className="btn-ghost" onClick={() => { setEditing(false); setDraft(patient); }}>{t("common.cancel")}</button>
              <button className="btn-primary" onClick={saveProfile}>{t("pdetail.save_changes")}</button>
            </>
          ) : (
            <button className="btn-outline" onClick={() => setEditing(true)}>{t("pdetail.edit_profile")}</button>
          )
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Profile */}
        <div className="card p-5 lg:col-span-1 space-y-3 h-fit">
          <h2 className="font-semibold text-slate-900 mb-2">{t("pdetail.profile")}</h2>

          {/* Date of birth — source of truth for age. Editing it updates the
              derived age immediately so the doctor sees the canonical value. */}
          <div>
            <label className="label">{t("pdetail.dob")}</label>
            {editing ? (
              <>
                <input
                  className="input"
                  type="date"
                  max={new Date().toISOString().slice(0, 10)}
                  value={(draft as any).date_of_birth || ""}
                  onChange={(e) => setDraft({ ...draft, date_of_birth: e.target.value } as any)}
                />
                {(draft as any).date_of_birth && (
                  <p className="text-xs text-slate-500 mt-1">
                    {t("pdetail.age_in_dob", {
                      age: patientAge({ age: null, date_of_birth: (draft as any).date_of_birth }) ?? "—",
                    })}
                  </p>
                )}
              </>
            ) : patient.date_of_birth ? (
              <div className="text-sm text-slate-700">
                {format(new Date(patient.date_of_birth + "T00:00:00"), "dd MMM yyyy")}
                <span className="text-slate-400 ml-2">
                  ({t("pdetail.age_label", { age: patientAge(patient) ?? "—" })})
                </span>
              </div>
            ) : (
              <div className="text-sm text-slate-400">—</div>
            )}
          </div>

          {/* Gender — drives the gynaecology / andrology relevance filter. */}
          <div>
            <label className="label">{t("pdetail.gender")}</label>
            {editing ? (
              <select
                className="input"
                value={(draft as any).gender || ""}
                onChange={(e) => setDraft({ ...draft, gender: e.target.value || null } as any)}
              >
                <option value="">—</option>
                <option value="male">{t("pdetail.gender.male")}</option>
                <option value="female">{t("pdetail.gender.female")}</option>
                <option value="other">{t("pdetail.gender.other")}</option>
              </select>
            ) : (
              <div className="text-sm text-slate-700">
                {patient.gender === "male"
                  ? t("pdetail.gender.male")
                  : patient.gender === "female"
                    ? t("pdetail.gender.female")
                    : patient.gender === "other"
                      ? t("pdetail.gender.other")
                      : <span className="text-slate-400">—</span>}
              </div>
            )}
          </div>

          {profileFields.map(({ key, label, multiline }) => (
            <div key={key}>
              <label className="label">{label}</label>
              {editing ? (
                multiline ? (
                  <textarea
                    className="textarea"
                    rows={2}
                    value={(draft as any)[key] || ""}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                  />
                ) : (
                  <input
                    className="input"
                    type={key === "age" ? "number" : "text"}
                    value={(draft as any)[key] || ""}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    // When DOB is filled it's the source of truth; keep the
                    // age input visible for records without DOB but disable it
                    // to avoid contradictory values.
                    disabled={key === "age" && !!(draft as any).date_of_birth}
                  />
                )
              ) : (
                <div className="text-sm text-slate-700 whitespace-pre-wrap">
                  {key === "age"
                    ? (patientAge(patient) ?? <span className="text-slate-400">—</span>)
                    : ((patient as any)[key] || <span className="text-slate-400">—</span>)}
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
                  <h3 className="font-semibold text-slate-900">{t("pdetail.visits")}</h3>
                  <button className="btn-ghost !text-sm" onClick={openStandaloneNote}>
                    <Plus size={14} /> {t("pdetail.standalone_note")}
                  </button>
                </div>
                {appts.length === 0 && notes.filter((n) => !n.appointment_id).length === 0 ? (
                  <div className="text-sm text-slate-500 py-6 text-center">{t("pdetail.no_visits")}</div>
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
                                {note.diagnosis && <div><b>{t("pdetail.dx")}</b> {note.diagnosis}</div>}
                                {note.treatment_advised && <div><b>{t("pdetail.rx")}</b> {note.treatment_advised}</div>}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <StatusBadge value={a.status} />
                            <button
                              className="btn-ghost !py-1 !text-xs"
                              onClick={() => openNoteFor(a)}
                            >
                              {note ? t("pdetail.edit_note") : t("pdetail.add_note")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {notes.filter((n) => !n.appointment_id).map((n) => (
                      <div key={`standalone-${n.id}`} className="py-3">
                        <div className="font-medium text-slate-900 text-sm">
                          {t("pdetail.standalone_prefix")} {format(new Date(n.created_at), "dd MMM yyyy")}
                        </div>
                        {n.diagnosis && <div className="text-xs"><b>{t("pdetail.dx")}</b> {n.diagnosis}</div>}
                        {n.treatment_advised && <div className="text-xs"><b>{t("pdetail.rx")}</b> {n.treatment_advised}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "dental" && (
            <DentalChart patientId={pid} />
          )}

          {tab === "plans" && (
            <div className="space-y-4">
              <div className="card p-3 flex items-center gap-2">
                <input
                  className="input flex-1"
                  placeholder={t("pdetail.new_plan_placeholder")}
                  value={newPlanTitle}
                  onChange={(e) => setNewPlanTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createPlan()}
                />
                <button className="btn-primary" onClick={createPlan}>
                  <Plus size={14} /> {t("pdetail.new_plan")}
                </button>
              </div>
              {plans.length === 0 ? (
                <div className="card p-8 text-center text-sm text-slate-500">
                  {t("pdetail.no_plans")}
                </div>
              ) : (
                plans.map((p) => (
                  <div key={p.id} className="relative">
                    <TreatmentPlanEditor patientId={pid} plan={p} onChanged={reload} />
                    <button
                      className="absolute top-4 right-4 text-slate-400 hover:text-rose-600"
                      onClick={() => deletePlan(p.id)}
                      title={t("pdetail.delete_plan_title")}
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
                <h3 className="font-semibold text-slate-900">{t("pdetail.treatments")}</h3>
                <button className="btn-primary" onClick={() => setTxOpen(true)}>
                  <Plus size={14} /> {t("common.add")}
                </button>
              </div>
              {treatments.length === 0 ? (
                <div className="text-sm text-slate-500 py-6 text-center">{t("pdetail.no_treatments")}</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="text-left font-medium py-2">{t("pdetail.col.date")}</th>
                      <th className="text-left font-medium py-2">{t("pdetail.col.procedure")}</th>
                      <th className="text-left font-medium py-2">{t("pdetail.col.tooth")}</th>
                      <th className="text-right font-medium py-2">{t("pdetail.col.price")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {treatments.map((tr) => (
                      <tr key={tr.id}>
                        <td className="py-2">{format(new Date(tr.performed_on), "dd MMM yyyy")}</td>
                        <td className="py-2 font-medium text-slate-900">{tr.procedure_name}</td>
                        <td className="py-2">{tr.tooth || "—"}</td>
                        <td className="py-2 text-right">₹ {tr.price.toLocaleString()}</td>
                        <td className="py-2 text-right">
                          <button
                            className="text-slate-400 hover:text-rose-600"
                            onClick={() => removeTreatment(tr.id)}
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
              <h3 className="font-semibold text-slate-900 mb-3">{t("pdetail.invoices")}</h3>
              {invoices.length === 0 ? (
                <div className="text-sm text-slate-500 py-6 text-center">
                  {t("pdetail.no_invoices")}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="text-left font-medium py-2">#</th>
                      <th className="text-left font-medium py-2">{t("pdetail.col.date")}</th>
                      <th className="text-right font-medium py-2">{t("pdetail.col.total")}</th>
                      <th className="text-right font-medium py-2">{t("pdetail.col.balance")}</th>
                      <th className="text-left font-medium py-2">{t("pdetail.col.status")}</th>
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
        title={t("pdetail.record_treatment")}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setTxOpen(false)}>{t("common.cancel")}</button>
            <button className="btn-primary" onClick={addTreatment as any}>{t("common.save")}</button>
          </>
        }
      >
        <form onSubmit={addTreatment} className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">{t("pdetail.procedure_required")}</label>
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
              <option value="">{t("pdetail.select_procedure")}</option>
              {procedures.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (₹{p.default_price})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">{t("pdetail.col.tooth")}</label>
            <input
              className="input"
              placeholder={t("pdetail.tooth_placeholder")}
              value={tx.tooth}
              onChange={(e) => setTx({ ...tx, tooth: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t("pdetail.col.date")}</label>
            <input
              className="input"
              type="date"
              value={tx.performed_on}
              onChange={(e) => setTx({ ...tx, performed_on: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="label">{t("pdetail.price_label")}</label>
            <input
              className="input"
              type="number"
              value={tx.price}
              onChange={(e) => setTx({ ...tx, price: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="label">{t("pdetail.notes")}</label>
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
            ? t("pdetail.note_for", { when: format(new Date(noteForAppt.appt.start), "dd MMM yyyy, p") })
            : t("pdetail.consultation_note")
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
