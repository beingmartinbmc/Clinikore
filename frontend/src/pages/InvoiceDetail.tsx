import { useEffect, useState, FormEvent, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import {
  ArrowLeft,
  FileText,
  Plus,
  Trash2,
  Printer,
  Stethoscope,
  CreditCard,
  Wallet,
  Smartphone,
  IndianRupee,
  Calendar as CalendarIcon,
  PillBottle,
} from "lucide-react";
import { api, ConsultationNote, Invoice, PaymentMethod, Settings } from "../api";
import PageHeader from "../components/PageHeader";
import StatusBadge from "../components/StatusBadge";
import { format } from "date-fns";

export default function InvoiceDetail() {
  const { id } = useParams();
  const iid = Number(id);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState<string>(() =>
    new Date().toISOString().slice(0, 16),
  );

  const [note, setNote] = useState<ConsultationNote | null>(null);

  const load = () => api.get<Invoice>(`/api/invoices/${iid}`).then(setInv);
  useEffect(() => {
    load();
    api.get<Settings>("/api/settings").then(setSettings).catch(() => {});
  }, [iid]);

  // Load the consultation note linked to this invoice so we can deep-link
  // to the printable prescription directly from the invoice page. The
  // /api/invoices/{id}/note endpoint tries both the direct invoice_id link
  // and falls back to the appointment_id join, so standalone Rx (no
  // appointment) still surface on the invoice page.
  useEffect(() => {
    if (!inv?.id) {
      setNote(null);
      return;
    }
    api
      .get<ConsultationNote | null>(`/api/invoices/${inv.id}/note`)
      .then((n) => setNote(n || null))
      .catch(() => setNote(null));
  }, [inv?.id]);

  async function addPayment(e: FormEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error("Enter amount");
    try {
      await api.post(`/api/invoices/${iid}/payments`, {
        amount: amt,
        method,
        reference: reference || null,
        paid_on: paidOn ? new Date(paidOn).toISOString() : null,
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

  const regLine = useMemo(() => {
    if (!settings?.registration_number) return "";
    return settings.registration_council
      ? `Reg. No. ${settings.registration_number} (${settings.registration_council})`
      : `Reg. No. ${settings.registration_number}`;
  }, [settings]);

  const missingProfile = !(
    settings?.doctor_name?.trim() &&
    settings?.clinic_name?.trim() &&
    settings?.registration_number?.trim()
  );

  if (!inv) return <div className="p-8 text-slate-500">Loading...</div>;
  const balance = Math.round((inv.total - inv.paid) * 100) / 100;
  const balanceTone =
    balance > 0
      ? "text-rose-600"
      : balance < 0
      ? "text-amber-600"
      : "text-emerald-600";
  const balanceLabel =
    balance > 0 ? "Balance due" : balance < 0 ? "Overpaid" : "Fully paid";

  const quickAmounts = balance > 0
    ? [balance, Math.round(balance / 2), 100, 500, 1000].filter(
        (v, i, a) => v > 0 && a.indexOf(v) === i,
      )
    : [];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <Link
        to="/invoices"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3"
      >
        <ArrowLeft size={14} /> Back to invoices
      </Link>
      <PageHeader
        title={`Invoice #${String(inv.id).padStart(5, "0")}`}
        subtitle={`${inv.patient_name} · ${format(new Date(inv.created_at), "dd MMM yyyy")}`}
        actions={
          <div className="flex gap-2 flex-wrap">
            <a
              href={`/api/invoices/${inv.id}/print`}
              target="_blank"
              rel="noreferrer"
              className="btn-primary"
            >
              <Printer size={14} /> Print invoice
            </a>
            <a
              href={`/api/invoices/${inv.id}/pdf`}
              target="_blank"
              rel="noreferrer"
              className="btn-outline"
            >
              <FileText size={14} /> PDF
            </a>
            {note ? (
              <>
                <a
                  href={`/api/consultation-notes/${note.id}/prescription`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-outline"
                  title="Open the printable prescription linked to this visit"
                >
                  <Printer size={14} /> Print Rx
                </a>
                <a
                  href={`/api/consultation-notes/${note.id}/prescription.pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-outline"
                  title="Download the prescription as a PDF"
                >
                  <FileText size={14} /> Rx PDF
                </a>
                <Link
                  to={`/consultations?open=${note.id}`}
                  className="btn-outline"
                  title="Open the full consultation note"
                >
                  <PillBottle size={14} /> View consultation
                </Link>
              </>
            ) : inv.appointment_id ? (
              <Link
                to={`/patients/${inv.patient_id}?tab=visits&appointment=${inv.appointment_id}`}
                className="btn-outline"
                title="Open the visit to write the prescription"
              >
                <PillBottle size={14} /> Add Rx
              </Link>
            ) : (
              <Link
                to={`/patients/${inv.patient_id}?tab=visits`}
                className="btn-outline"
                title="Open the patient's visit history to add a prescription"
              >
                <PillBottle size={14} /> Add Rx
              </Link>
            )}
          </div>
        }
      />

      {missingProfile && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 flex items-start gap-3">
          <Stethoscope size={18} className="mt-0.5 shrink-0 text-amber-700" />
          <div>
            <div className="font-semibold">
              Your invoice is missing mandatory doctor details
            </div>
            <div className="mt-1 leading-relaxed">
              Indian Medical Council regulations require your full name,
              clinic name, and State Medical Council / NMC registration
              number to appear on every invoice and prescription.
              {" "}
              <Link
                to="/settings"
                className="font-semibold underline underline-offset-2"
              >
                Complete your profile →
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Branded preview card at the top — matches the printed output and
          gives the doctor confidence in what the patient will see. */}
      <div className="mb-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="h-1.5 bg-gradient-to-r from-brand-600 to-emerald-500" />
        <div className="p-6">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <div className="text-2xl font-bold text-brand-700 leading-tight">
                {settings?.clinic_name || "Your clinic name"}
              </div>
              {settings?.doctor_name && (
                <div className="mt-0.5 text-slate-800 font-medium">
                  Dr. {settings.doctor_name}
                  {settings.doctor_qualifications
                    ? `, ${settings.doctor_qualifications}`
                    : ""}
                </div>
              )}
              {settings?.specialization && (
                <div className="text-sm text-slate-500">
                  {settings.specialization}
                </div>
              )}
              {regLine ? (
                <span className="inline-block mt-2 px-2.5 py-0.5 rounded-full text-xs font-semibold text-cyan-800 bg-cyan-50 border border-cyan-200">
                  {regLine}
                </span>
              ) : (
                <span className="inline-block mt-2 px-2.5 py-0.5 rounded-full text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200">
                  Registration number missing
                </span>
              )}
              {settings?.clinic_address && (
                <div className="mt-2 text-sm text-slate-500 whitespace-pre-wrap max-w-md">
                  {settings.clinic_address}
                </div>
              )}
              <div className="text-sm text-slate-500">
                {settings?.clinic_phone && <>Phone: {settings.clinic_phone} </>}
                {settings?.clinic_phone && settings?.clinic_email && " · "}
                {settings?.clinic_email && <>Email: {settings.clinic_email}</>}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">
                Invoice
              </div>
              <div className="text-xl font-bold text-brand-700 tabular-nums">
                #{String(inv.id).padStart(5, "0")}
              </div>
              <div className="text-sm text-slate-500">
                {format(new Date(inv.created_at), "dd MMM yyyy")}
              </div>
              <div className="mt-2">
                <StatusBadge value={inv.status} />
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3">
            <div className="text-[11px] uppercase tracking-widest text-slate-500 font-semibold">
              Billed to
            </div>
            <div className="font-semibold text-slate-900">
              {inv.patient_name}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Line items */}
          <div className="card p-0 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">Line items</h2>
              <StatusBadge value={inv.status} />
            </div>
            <table className="w-full text-sm">
              <thead className="text-slate-500 bg-slate-50">
                <tr>
                  <th className="text-left font-medium py-2.5 px-5">Description</th>
                  <th className="text-right font-medium py-2.5 px-2 w-16">Qty</th>
                  <th className="text-right font-medium py-2.5 px-2 w-28">Unit</th>
                  <th className="text-right font-medium py-2.5 px-5 w-32">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {inv.items.map((it, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/60">
                    <td className="py-2.5 px-5">{it.description}</td>
                    <td className="py-2.5 px-2 text-right tabular-nums">
                      {it.quantity}
                    </td>
                    <td className="py-2.5 px-2 text-right tabular-nums">
                      ₹ {it.unit_price.toLocaleString()}
                    </td>
                    <td className="py-2.5 px-5 text-right font-medium tabular-nums">
                      ₹ {(it.unit_price * it.quantity).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-slate-700 bg-slate-50">
                <tr>
                  <td colSpan={3} className="pt-3 px-5 text-right">
                    Total
                  </td>
                  <td className="pt-3 px-5 text-right font-semibold tabular-nums">
                    ₹ {inv.total.toLocaleString()}
                  </td>
                </tr>
                <tr>
                  <td colSpan={3} className="px-5 text-right">
                    Paid
                  </td>
                  <td className="px-5 text-right tabular-nums">
                    ₹ {inv.paid.toLocaleString()}
                  </td>
                </tr>
                <tr>
                  <td
                    colSpan={3}
                    className={`pb-3 px-5 text-right font-semibold ${balanceTone}`}
                  >
                    {balanceLabel}
                  </td>
                  <td
                    className={`pb-3 px-5 text-right font-semibold tabular-nums ${balanceTone}`}
                  >
                    ₹ {Math.abs(balance).toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Payments */}
          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900">Payments</h2>
            </div>
            {inv.payments.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">
                No payments yet.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-slate-500 bg-slate-50">
                  <tr>
                    <th className="text-left font-medium py-2.5 px-5">Date</th>
                    <th className="text-left font-medium py-2.5 px-2">Method</th>
                    <th className="text-left font-medium py-2.5 px-2">Reference</th>
                    <th className="text-right font-medium py-2.5 px-2">Amount</th>
                    <th className="py-2.5 px-5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {inv.payments.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/60">
                      <td className="py-2.5 px-5">
                        {format(new Date(p.paid_on), "dd MMM yyyy, p")}
                      </td>
                      <td className="py-2.5 px-2 uppercase text-slate-700">
                        {p.method}
                      </td>
                      <td className="py-2.5 px-2 text-slate-500">
                        {p.reference || "—"}
                      </td>
                      <td className="py-2.5 px-2 text-right font-medium tabular-nums">
                        ₹ {p.amount.toLocaleString()}
                      </td>
                      <td className="py-2.5 px-5 text-right">
                        <button
                          className="text-slate-400 hover:text-rose-600"
                          onClick={() => deletePayment(p.id)}
                          aria-label="Delete payment"
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

        <div className="card p-5 h-fit sticky top-4">
          <h2 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
            <CreditCard size={16} className="text-brand-600" />
            Record payment
          </h2>
          <form onSubmit={addPayment} className="space-y-3">
            <div>
              <label className="label flex items-center gap-1.5">
                <IndianRupee size={13} />
                Amount
              </label>
              <input
                className="input text-lg font-semibold"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={balance > 0 ? String(balance) : "0"}
                autoFocus
              />
              {quickAmounts.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {quickAmounts.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setAmount(String(v))}
                      className="px-2 py-0.5 rounded-full text-xs border border-slate-200 bg-slate-50 hover:bg-brand-50 hover:border-brand-300 hover:text-brand-700"
                    >
                      ₹ {v.toLocaleString()}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="label">Method</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(["cash", "upi", "card"] as PaymentMethod[]).map((m) => {
                  const Icon =
                    m === "cash" ? Wallet : m === "upi" ? Smartphone : CreditCard;
                  const active = method === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMethod(m)}
                      className={
                        "flex flex-col items-center gap-1 py-2.5 rounded-lg border text-xs font-medium uppercase tracking-wide " +
                        (active
                          ? "border-brand-500 bg-brand-50 text-brand-700"
                          : "border-slate-200 text-slate-600 hover:border-slate-300")
                      }
                    >
                      <Icon size={16} />
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="label flex items-center gap-1.5">
                <CalendarIcon size={13} />
                Payment date
              </label>
              <input
                className="input"
                type="datetime-local"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Defaults to today — change it for backdated / partial payments.
              </p>
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
