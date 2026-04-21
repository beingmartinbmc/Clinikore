import { useEffect, useRef, useState, FormEvent } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { Plus, Trash2, FileText, Wallet } from "lucide-react";
import { api, Invoice, Patient, Procedure } from "../api";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import StatusBadge from "../components/StatusBadge";
import { format } from "date-fns";
import { useI18n } from "../i18n/I18nContext";

interface Line {
  procedure_id: string;
  description: string;
  quantity: number;
  unit_price: number;
}

export default function Invoices() {
  const { t } = useI18n();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [open, setOpen] = useState(false);

  const [patientId, setPatientId] = useState("");
  const [notes, setNotes] = useState("");
  const [discount, setDiscount] = useState(0);
  const [lines, setLines] = useState<Line[]>([
    { procedure_id: "", description: "", quantity: 1, unit_price: 0 },
  ]);
  const lineRefs = useRef<(HTMLInputElement | null)[]>([]);

  const load = () =>
    api.get<Invoice[]>(`/api/invoices${pendingOnly ? "?pending_only=true" : ""}`).then(setInvoices);

  useEffect(() => { load(); }, [pendingOnly]);
  useEffect(() => {
    api.get<Patient[]>("/api/patients").then(setPatients);
    api.get<Procedure[]>("/api/procedures").then(setProcedures);
  }, []);

  const totalPendingDues = invoices
    .filter((i) => i.status !== "paid")
    .reduce((s, i) => s + (i.total - i.paid), 0);

  function updateLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((p) => [...p, { procedure_id: "", description: "", quantity: 1, unit_price: 0 }]);
  }
  function removeLine(i: number) {
    setLines((p) => p.filter((_, idx) => idx !== i));
  }

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const total = Math.max(subtotal - discount, 0);

  function resetForm() {
    setPatientId("");
    setNotes("");
    setDiscount(0);
    setLines([{ procedure_id: "", description: "", quantity: 1, unit_price: 0 }]);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!patientId) return toast.error("Pick a patient");
    const validLines = lines.filter((l) => l.description && l.quantity > 0);
    if (validLines.length === 0) return toast.error("Add at least one line item");
    try {
      await api.post("/api/invoices", {
        patient_id: Number(patientId),
        notes: notes || null,
        discount_amount: discount || 0,
        items: validLines.map((l) => ({
          procedure_id: l.procedure_id ? Number(l.procedure_id) : null,
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price,
        })),
      });
      toast.success("Invoice created");
      setOpen(false);
      resetForm();
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this invoice and its payments?")) return;
    const data: any = await api.del(`/api/invoices/${id}`);
    if (data?.undo_token) {
      toast.success(
        (t) => (
          <span className="flex items-center gap-3">
            Invoice deleted.
            <button
              className="underline font-semibold text-brand-700"
              onClick={async () => {
                await api.post(`/api/undo/${data.undo_token}`);
                toast.dismiss(t.id);
                toast.success("Restored");
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
      toast.success("Deleted");
    }
    load();
  }

  return (
    <div className="p-8">
      <PageHeader
        title={t("invoices.title")}
        subtitle={`${t("invoices.pending_dues")}: ₹ ${totalPendingDues.toLocaleString()}`}
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            <Plus size={16} /> {t("invoices.new")}
          </button>
        }
      />

      <div className="flex items-center gap-3 mb-4">
        <label className="inline-flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
          />
          {t("invoices.show_pending_only")}
        </label>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-medium">#</th>
              <th className="text-left px-4 py-3 font-medium">{t("invoices.col.patient")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("invoices.col.date")}</th>
              <th className="text-right px-4 py-3 font-medium">{t("invoices.col.total")}</th>
              <th className="text-right px-4 py-3 font-medium">{t("invoices.col.paid")}</th>
              <th className="text-right px-4 py-3 font-medium">{t("invoices.col.balance")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("invoices.col.status")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {invoices.map((inv) => (
              <tr key={inv.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link to={`/invoices/${inv.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                    #{String(inv.id).padStart(5, "0")}
                  </Link>
                </td>
                <td className="px-4 py-3">{inv.patient_name}</td>
                <td className="px-4 py-3 text-slate-500">
                  {format(new Date(inv.created_at), "dd MMM yyyy")}
                </td>
                <td className="px-4 py-3 text-right">₹ {inv.total.toLocaleString()}</td>
                <td className="px-4 py-3 text-right">₹ {inv.paid.toLocaleString()}</td>
                <td className="px-4 py-3 text-right font-medium">
                  ₹ {(inv.total - inv.paid).toLocaleString()}
                </td>
                <td className="px-4 py-3"><StatusBadge value={inv.status} /></td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    {inv.status !== "paid" && (
                      <Link
                        to={`/invoices/${inv.id}`}
                        title="Record payment"
                        className="text-slate-400 hover:text-emerald-600"
                      >
                        <Wallet size={16} />
                      </Link>
                    )}
                    <a
                      href={`/api/invoices/${inv.id}/pdf`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-400 hover:text-brand-700"
                      title="PDF"
                    >
                      <FileText size={16} />
                    </a>
                    <button
                      onClick={() => remove(inv.id)}
                      className="text-slate-400 hover:text-rose-600"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-12 text-slate-500 text-sm">
                  {t("invoices.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New invoice"
        width="max-w-3xl"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={save as any}>Create invoice</button>
          </>
        }
      >
        <form onSubmit={save} className="space-y-4">
          <div>
            <label className="label">Patient *</label>
            <select
              className="select"
              required
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            >
              <option value="">Select patient...</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label !mb-0">Line items</label>
              <button type="button" className="btn-ghost !py-1 !text-xs" onClick={addLine}>
                <Plus size={12} /> Add line
              </button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-start">
                  <div className="col-span-4">
                    <select
                      className="select"
                      value={l.procedure_id}
                      onChange={(e) => {
                        const proc = procedures.find((p) => p.id === Number(e.target.value));
                        updateLine(i, {
                          procedure_id: e.target.value,
                          description: proc ? proc.name : l.description,
                          unit_price: proc ? proc.default_price : l.unit_price,
                        });
                      }}
                    >
                      <option value="">Custom...</option>
                      {procedures.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <input
                    className="input col-span-4"
                    placeholder="Description"
                    value={l.description}
                    onChange={(e) => updateLine(i, { description: e.target.value })}
                  />
                  <input
                    className="input col-span-1 text-right"
                    type="number"
                    min={1}
                    value={l.quantity}
                    onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })}
                  />
                  <input
                    ref={(el) => { lineRefs.current[i] = el; }}
                    className="input col-span-2 text-right"
                    type="number"
                    placeholder="Price"
                    value={l.unit_price}
                    onChange={(e) => updateLine(i, { unit_price: Number(e.target.value) })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        // Keyboard-first flow: Enter on the last line's price
                        // adds a new row and focuses it; otherwise jumps to
                        // the next row's procedure dropdown.
                        if (i === lines.length - 1) addLine();
                        setTimeout(() => lineRefs.current[i + 1]?.focus(), 0);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="col-span-1 text-slate-400 hover:text-rose-600 self-center"
                    onClick={() => removeLine(i)}
                    disabled={lines.length === 1}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-end justify-end gap-3 text-sm">
              <div>
                <label className="label !mb-1">Discount (₹)</label>
                <input
                  className="input text-right w-32"
                  type="number"
                  min={0}
                  value={discount}
                  onChange={(e) => setDiscount(Math.max(0, Number(e.target.value)))}
                />
              </div>
              <div className="text-right">
                <div className="text-slate-500 text-xs">
                  Subtotal: ₹ {subtotal.toLocaleString()}
                </div>
                {discount > 0 && (
                  <div className="text-amber-600 text-xs">
                    Discount: −₹ {discount.toLocaleString()}
                  </div>
                )}
                <div className="text-base font-semibold text-slate-900">
                  Total: ₹ {total.toLocaleString()}
                </div>
              </div>
            </div>
          </div>

          <div>
            <label className="label">Notes</label>
            <textarea
              className="textarea"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}
