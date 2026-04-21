import { useEffect, useState, FormEvent } from "react";
import toast from "react-hot-toast";
import { Plus, Trash2 } from "lucide-react";
import { api, Procedure } from "../api";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import { useI18n } from "../i18n/I18nContext";

export default function Procedures() {
  const { t } = useI18n();
  const [items, setItems] = useState<Procedure[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", default_price: "" });

  const load = () => api.get<Procedure[]>("/api/procedures").then(setItems);
  useEffect(() => { load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/procedures", {
        name: form.name,
        description: form.description || null,
        default_price: Number(form.default_price || 0),
      });
      toast.success("Procedure added");
      setOpen(false);
      setForm({ name: "", description: "", default_price: "" });
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this procedure?")) return;
    await api.del(`/api/procedures/${id}`);
    load();
  }

  async function updatePrice(p: Procedure, price: number) {
    await api.put(`/api/procedures/${p.id}`, { ...p, default_price: price });
    load();
  }

  return (
    <div className="p-8">
      <PageHeader
        title={t("procedures.title")}
        subtitle={t("procedures.subtitle")}
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            <Plus size={16} /> {t("procedures.new")}
          </button>
        }
      />

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-medium">{t("procedures.col.name")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("procedures.col.description")}</th>
              <th className="text-right px-4 py-3 font-medium">{t("procedures.col.default_price")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{p.name}</td>
                <td className="px-4 py-3 text-slate-600">{p.description || "—"}</td>
                <td className="px-4 py-3 text-right">
                  <input
                    className="input !py-1 text-right w-28 ml-auto"
                    type="number"
                    defaultValue={p.default_price}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== p.default_price) updatePrice(p, v);
                    }}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => remove(p.id)} className="text-slate-400 hover:text-rose-600">
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center py-12 text-slate-500 text-sm">
                  {t("procedures.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New procedure"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={save as any}>Save</button>
          </>
        }
      >
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="label">Name *</label>
            <input
              className="input"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Description</label>
            <input
              className="input"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Default price (₹)</label>
            <input
              className="input"
              type="number"
              value={form.default_price}
              onChange={(e) => setForm({ ...form, default_price: e.target.value })}
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}
