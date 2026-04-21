import { useEffect, useState, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { ArrowLeft, FileText, Plus, Trash2 } from "lucide-react";
import { api, Invoice, PaymentMethod } from "../api";
import PageHeader from "../components/PageHeader";
import StatusBadge from "../components/StatusBadge";
import { format } from "date-fns";

export default function InvoiceDetail() {
  const { id } = useParams();
  const iid = Number(id);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");

  const load = () => api.get<Invoice>(`/api/invoices/${iid}`).then(setInv);
  useEffect(() => { load(); }, [iid]);

  async function addPayment(e: FormEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error("Enter amount");
    try {
      await api.post(`/api/invoices/${iid}/payments`, {
        amount: amt,
        method,
        reference: reference || null,
      });
      setAmount("");
      setReference("");
      toast.success("Payment recorded");
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function deletePayment(pid: number) {
    if (!confirm("Delete this payment?")) return;
    await api.del(`/api/payments/${pid}`);
    load();
  }

  if (!inv) return <div className="p-8 text-slate-500">Loading...</div>;
  const balance = inv.total - inv.paid;

  return (
    <div className="p-8">
      <Link to="/invoices" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3">
        <ArrowLeft size={14} /> Back to invoices
      </Link>
      <PageHeader
        title={`Invoice #${String(inv.id).padStart(5, "0")}`}
        subtitle={`${inv.patient_name} · ${format(new Date(inv.created_at), "dd MMM yyyy")}`}
        actions={
          <a
            href={`/api/invoices/${inv.id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="btn-outline"
          >
            <FileText size={14} /> View PDF
          </a>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-slate-900">Line items</h2>
              <StatusBadge value={inv.status} />
            </div>
            <table className="w-full text-sm">
              <thead className="text-slate-500">
                <tr>
                  <th className="text-left font-medium py-2">Description</th>
                  <th className="text-right font-medium py-2">Qty</th>
                  <th className="text-right font-medium py-2">Unit</th>
                  <th className="text-right font-medium py-2">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {inv.items.map((it, idx) => (
                  <tr key={idx}>
                    <td className="py-2">{it.description}</td>
                    <td className="py-2 text-right">{it.quantity}</td>
                    <td className="py-2 text-right">₹ {it.unit_price.toLocaleString()}</td>
                    <td className="py-2 text-right font-medium">
                      ₹ {(it.unit_price * it.quantity).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-slate-700">
                <tr>
                  <td colSpan={3} className="pt-3 text-right">Total</td>
                  <td className="pt-3 text-right font-semibold">₹ {inv.total.toLocaleString()}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="text-right">Paid</td>
                  <td className="text-right">₹ {inv.paid.toLocaleString()}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="text-right font-semibold text-rose-600">Balance</td>
                  <td className="text-right font-semibold text-rose-600">
                    ₹ {balance.toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-slate-900 mb-3">Payments</h2>
            {inv.payments.length === 0 ? (
              <div className="text-sm text-slate-500 py-6 text-center">No payments yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-slate-500">
                  <tr>
                    <th className="text-left font-medium py-2">Date</th>
                    <th className="text-left font-medium py-2">Method</th>
                    <th className="text-left font-medium py-2">Reference</th>
                    <th className="text-right font-medium py-2">Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {inv.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="py-2">{format(new Date(p.paid_on), "dd MMM yyyy, p")}</td>
                      <td className="py-2 uppercase text-slate-700">{p.method}</td>
                      <td className="py-2 text-slate-500">{p.reference || "—"}</td>
                      <td className="py-2 text-right font-medium">₹ {p.amount.toLocaleString()}</td>
                      <td className="py-2 text-right">
                        <button
                          className="text-slate-400 hover:text-rose-600"
                          onClick={() => deletePayment(p.id)}
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
        </div>

        <div className="card p-5 h-fit">
          <h2 className="font-semibold text-slate-900 mb-3">Record payment</h2>
          <form onSubmit={addPayment} className="space-y-3">
            <div>
              <label className="label">Amount (₹)</label>
              <input
                className="input"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={`Balance: ${balance}`}
              />
            </div>
            <div>
              <label className="label">Method</label>
              <select
                className="select"
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
              </select>
            </div>
            <div>
              <label className="label">Reference (optional)</label>
              <input
                className="input"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="UPI txn id / card last 4..."
              />
            </div>
            <button className="btn-primary w-full justify-center" type="submit">
              <Plus size={14} /> Record payment
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
