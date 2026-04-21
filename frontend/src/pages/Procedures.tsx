import { useEffect, useMemo, useState, FormEvent } from "react";
import toast from "react-hot-toast";
import { Plus, Trash2 } from "lucide-react";
import { api, Procedure, Settings } from "../api";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import { useI18n } from "../i18n/I18nContext";

const BLANK_FORM = { name: "", description: "", default_price: "", category: "" };

export default function Procedures() {
  const { t } = useI18n();
  const [items, setItems] = useState<Procedure[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);

  function load() {
    api.get<Procedure[]>("/api/procedures").then(setItems);
    api.get<string[]>("/api/procedures/categories").then(setCategories).catch(() => {});
  }
  useEffect(() => {
    load();
    // Pre-fill the new-procedure form's category with the doctor's own
    // specialization so they rarely need to change it.
    api.get<Settings>("/api/settings")
      .then((s) => {
        if (s.specialization) {
          setForm((f) => ({ ...f, category: s.specialization as string }));
        }
      })
      .catch(() => {});
  }, []);

  const visibleItems = useMemo(() => {
    if (!filter) return items;
    return items.filter((p) => (p.category || "") === filter);
  }, [items, filter]);

  // Categories to show in the filter: whatever shows up on existing
  // procedures + backend suggestions, de-duplicated.
  const filterOptions = useMemo(() => {
    const seen = new Set<string>();
    items.forEach((p) => p.category && seen.add(p.category));
    categories.forEach((c) => seen.add(c));
    return Array.from(seen);
  }, [items, categories]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const category = form.category.trim();
    if (!category) {
      toast.error("Category is required");
      return;
    }
    try {
      await api.post("/api/procedures", {
        name: form.name,
        description: form.description || null,
        default_price: Number(form.default_price || 0),
        category,
      });
      toast.success(t("procedures.added"));
      setOpen(false);
      setForm(BLANK_FORM);
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function remove(id: number) {
    if (!confirm(t("procedures.confirm_delete"))) return;
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
          <div className="flex items-center gap-2">
            <select
              className="input !py-2"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">{t("procedures.filter.all")}</option>
              {filterOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <button className="btn-primary" onClick={() => setOpen(true)}>
              <Plus size={16} /> {t("procedures.new")}
            </button>
          </div>
        }
      />

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-medium">{t("procedures.col.name")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("procedures.col.category")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("procedures.col.description")}</th>
              <th className="text-right px-4 py-3 font-medium">{t("procedures.col.default_price")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleItems.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{p.name}</td>
                <td className="px-4 py-3">
                  {p.category ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-brand-50 text-brand-700 text-xs font-medium">
                      {p.category}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
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
            {visibleItems.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-12 text-slate-500 text-sm">
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
        title={t("procedures.new")}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</button>
            <button className="btn-primary" onClick={save as any}>{t("common.save")}</button>
          </>
        }
      >
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="label">{t("procedures.form.name")} *</label>
            <input
              className="input"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t("procedures.form.category")} *</label>
            <input
              className="input"
              list="procedure-category-options"
              placeholder={t("procedures.form.category_placeholder")}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              required
            />
            <datalist id="procedure-category-options">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <p className="text-xs text-slate-500 mt-1">
              Every procedure needs a category so reports and filters stay tidy.
            </p>
          </div>
          <div>
            <label className="label">{t("procedures.form.description")}</label>
            <input
              className="input"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t("procedures.form.price")}</label>
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
