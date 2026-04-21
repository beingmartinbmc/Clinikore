import { useEffect, useState, FormEvent } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { Plus, Search, Trash2, Phone, Mail, Cake } from "lucide-react";
import { api, Patient, ageFromDob, patientAge, Gender } from "../api";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import StatusBadge from "../components/StatusBadge";
import { format } from "date-fns";
import { useI18n } from "../i18n/I18nContext";

const emptyForm = {
  name: "",
  // `age` is now a derived value but we still keep the direct input as a
  // fallback for patients who don't remember their exact birth date.
  age: "",
  date_of_birth: "",
  gender: "" as "" | Gender,
  phone: "",
  email: "",
  medical_history: "",
  dental_history: "",
  allergies: "",
  notes: "",
};

export default function Patients() {
  const { t } = useI18n();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = () => {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    api.get<Patient[]>(`/api/patients${qs}`).then(setPatients).catch((e) => toast.error(e.message));
  };

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      // Prefer DOB — it's the source of truth and doesn't go stale. Only fall
      // back to the typed-in `age` value when the doctor left DOB blank.
      const derivedAge = ageFromDob(form.date_of_birth);
      await api.post("/api/patients", {
        ...form,
        age: derivedAge ?? (form.age ? Number(form.age) : null),
        date_of_birth: form.date_of_birth || null,
        gender: form.gender || null,
      });
      toast.success("Patient added");
      setOpen(false);
      setForm(emptyForm);
      load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!confirm(t("patients.confirm_delete"))) return;
    try {
      const data: any = await api.del(`/api/patients/${id}`);
      if (data?.undo_token) {
        toast.success(
          (tt) => (
            <span className="flex items-center gap-3">
              Patient deleted.
              <button
                className="underline font-semibold text-brand-700"
                onClick={async () => {
                  await api.post(`/api/undo/${data.undo_token}`);
                  toast.dismiss(tt.id);
                  load();
                }}
              >
                Undo
              </button>
            </span>
          ),
          { duration: 6000 },
        );
      } else {
        toast.success("Patient deleted");
      }
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="p-8">
      <PageHeader
        title={t("patients.title")}
        subtitle={t("patients.subtitle_count", { count: patients.length })}
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            <Plus size={16} /> {t("patients.new")}
          </button>
        }
      />

      <div className="card p-4 mb-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9"
            placeholder={t("patients.search_placeholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-medium">{t("patients.col.name")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("patients.col.age")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("patients.col.contact")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("patients.col.allergies")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("patients.col.registered")}</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {patients.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link to={`/patients/${p.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                    {p.name}
                  </Link>
                  {p.lifecycle && (
                    <div className="mt-1 flex items-center gap-1.5">
                      <StatusBadge value={p.lifecycle} />
                      {typeof p.pending_steps === "number" && p.pending_steps > 0 && (
                        <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                          {p.pending_steps} pending
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm text-slate-700">{patientAge(p) ?? "—"}</div>
                  {p.date_of_birth && (
                    <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                      <Cake size={10} /> {format(new Date(p.date_of_birth + "T00:00:00"), "dd MMM yyyy")}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-0.5">
                    {p.phone && (
                      <span className="flex items-center gap-1 text-slate-600">
                        <Phone size={12} /> {p.phone}
                      </span>
                    )}
                    {p.email && (
                      <span className="flex items-center gap-1 text-slate-500 text-xs">
                        <Mail size={12} /> {p.email}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 max-w-[200px] truncate text-slate-600">
                  {p.allergies || "—"}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {format(new Date(p.created_at), "dd MMM yyyy")}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    className="text-slate-400 hover:text-rose-600 p-1"
                    onClick={() => remove(p.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
            {patients.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-12 text-slate-500 text-sm">
                  {t("patients.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New patient"
        width="max-w-2xl"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={onSubmit as any} disabled={saving}>
              {saving ? "Saving..." : "Save patient"}
            </button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">Full name *</label>
            <input
              className="input"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Date of birth</label>
            <input
              className="input"
              type="date"
              // Block impossible future birth dates — the widget on most
              // browsers will grey them out but a paste can still slip in.
              max={new Date().toISOString().slice(0, 10)}
              value={form.date_of_birth}
              onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
            />
            {form.date_of_birth && ageFromDob(form.date_of_birth) !== null && (
              <p className="text-xs text-slate-500 mt-1">
                Age: {ageFromDob(form.date_of_birth)} years
              </p>
            )}
          </div>
          <div>
            <label className="label">Age (if DOB unknown)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={150}
              value={form.age}
              onChange={(e) => setForm({ ...form, age: e.target.value })}
              disabled={!!form.date_of_birth}
            />
          </div>
          <div>
            <label className="label">Gender</label>
            <select
              className="input"
              value={form.gender}
              onChange={(e) => setForm({ ...form, gender: e.target.value as Gender | "" })}
            >
              <option value="">—</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="label">Phone</label>
            <input
              className="input"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="label">Medical history</label>
            <textarea
              className="textarea"
              rows={2}
              value={form.medical_history}
              onChange={(e) => setForm({ ...form, medical_history: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="label">Dental history</label>
            <textarea
              className="textarea"
              rows={2}
              value={form.dental_history}
              onChange={(e) => setForm({ ...form, dental_history: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="label">Allergies</label>
            <input
              className="input"
              value={form.allergies}
              onChange={(e) => setForm({ ...form, allergies: e.target.value })}
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}
