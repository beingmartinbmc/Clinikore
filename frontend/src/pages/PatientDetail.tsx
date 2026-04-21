import { useEffect, useState, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import {
  api,
  Appointment,
  Patient,
  Procedure,
  Treatment,
} from "../api";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import StatusBadge from "../components/StatusBadge";
import { format } from "date-fns";

export default function PatientDetail() {
  const { id } = useParams();
  const pid = Number(id);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [treatments, setTreatments] = useState<Treatment[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);

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

  const reload = () => {
    api.get<Patient>(`/api/patients/${pid}`).then((p) => {
      setPatient(p);
      setDraft(p);
    });
    api.get<Treatment[]>(`/api/patients/${pid}/treatments`).then(setTreatments);
    api.get<Appointment[]>(`/api/appointments?patient_id=${pid}`).then(setAppts);
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
    await api.del(`/api/treatments/${tid}`);
    reload();
  }

  if (!patient) return <div className="p-8 text-slate-500">Loading...</div>;

  return (
    <div className="p-8">
      <Link to="/patients" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ArrowLeft size={14} /> Back to patients
      </Link>
      <PageHeader
        title={patient.name}
        subtitle={`Patient #${patient.id} · Registered ${format(new Date(patient.created_at), "dd MMM yyyy")}`}
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

        {/* Right column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Treatments */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-slate-900">Treatments</h2>
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

          {/* Appointments */}
          <div className="card p-5">
            <h2 className="font-semibold text-slate-900 mb-3">Appointments</h2>
            {appts.length === 0 ? (
              <div className="text-sm text-slate-500 py-6 text-center">No appointments yet.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {appts.map((a) => (
                  <div key={a.id} className="py-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium text-slate-900">
                        {format(new Date(a.start), "dd MMM yyyy, p")}
                      </div>
                      <div className="text-xs text-slate-500">{a.chief_complaint || "—"}</div>
                    </div>
                    <StatusBadge value={a.status} />
                  </div>
                ))}
              </div>
            )}
          </div>
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
    </div>
  );
}
