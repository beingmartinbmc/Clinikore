import { useEffect, useMemo, useState } from "react";
import { Download, Wallet, TrendingUp, Clock, Stethoscope } from "lucide-react";
import { api } from "../api";
import PageHeader from "../components/PageHeader";
import { useI18n } from "../i18n/I18nContext";

type Row = Record<string, any>;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function Reports() {
  const { t } = useI18n();
  const [range, setRange] = useState({ start: daysAgoISO(29), end: todayISO() });
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [daily, setDaily] = useState<Row[]>([]);
  const [monthly, setMonthly] = useState<Row | null>(null);
  const [pending, setPending] = useState<Row[]>([]);
  const [top, setTop] = useState<Row[]>([]);

  function load() {
    api
      .get<Row[]>(`/api/reports/daily-collections?start=${range.start}&end=${range.end}`)
      .then(setDaily)
      .catch(() => setDaily([]));
    api
      .get<Row>(`/api/reports/monthly-revenue?month=${month}`)
      .then(setMonthly)
      .catch(() => setMonthly(null));
    api.get<Row[]>("/api/reports/pending-dues").then(setPending).catch(() => setPending([]));
    api
      .get<Row[]>(`/api/reports/top-procedures?start=${range.start}&end=${range.end}`)
      .then(setTop)
      .catch(() => setTop([]));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end, month]);

  const dailyTotal = useMemo(
    () => daily.reduce((s, r) => s + (r.amount || 0), 0),
    [daily]
  );
  const pendingTotal = useMemo(
    () => pending.reduce((s, r) => s + (r.balance || 0), 0),
    [pending]
  );

  function dl(path: string) {
    // Delegating to an anchor keeps the download path out of JS-fetch so the
    // browser's native filename / save dialog is used.
    const a = document.createElement("a");
    a.href = path;
    a.click();
  }

  return (
    <div className="p-8 max-w-6xl">
      <PageHeader
        title={t("reports.title")}
        subtitle={t("reports.subtitle")}
      />
      <div className="card p-4 mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="label">{t("reports.from")}</label>
          <input
            type="date"
            className="input"
            value={range.start}
            onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
          />
        </div>
        <div>
          <label className="label">{t("reports.to")}</label>
          <input
            type="date"
            className="input"
            value={range.end}
            onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
          />
        </div>
        <div>
          <label className="label">{t("reports.month")}</label>
          <input
            type="month"
            className="input"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        <div className="flex gap-2 ml-auto">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              className="btn-outline !py-1 !text-xs"
              onClick={() =>
                setRange({ start: daysAgoISO(n - 1), end: todayISO() })
              }
            >
              {t("reports.last_days", { n })}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Daily collections */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Wallet size={18} className="text-brand-600" />
              <h2 className="font-semibold text-slate-900">{t("reports.daily_collections")}</h2>
            </div>
            <button
              className="btn-ghost !py-1 !text-xs"
              onClick={() =>
                dl(
                  `/api/reports/daily-collections.csv?start=${range.start}&end=${range.end}`
                )
              }
            >
              <Download size={12} /> {t("reports.csv")}
            </button>
          </div>
          <div className="text-2xl font-semibold text-slate-900 mb-1">
            ₹ {dailyTotal.toLocaleString()}
          </div>
          <div className="text-xs text-slate-500 mb-3">
            {t("reports.daily_total_sub", { count: daily.length })}
          </div>
          <div className="max-h-56 overflow-y-auto border-t border-slate-100">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-slate-100">
                {daily.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-center py-4 text-slate-400">
                      {t("reports.no_payments_in_range")}
                    </td>
                  </tr>
                ) : (
                  daily.map((r) => (
                    <tr key={r.date}>
                      <td className="py-1.5">{r.date}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        ₹ {r.amount?.toLocaleString?.() ?? r.amount}
                      </td>
                      <td className="py-1.5 text-right text-slate-400 w-16">
                        {r.count} {t("reports.payments_short")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Monthly revenue */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <TrendingUp size={18} className="text-emerald-600" />
              <h2 className="font-semibold text-slate-900">{t("reports.monthly_revenue")}</h2>
            </div>
            <button
              className="btn-ghost !py-1 !text-xs"
              onClick={() => dl(`/api/reports/monthly-revenue.csv?month=${month}`)}
            >
              <Download size={12} /> {t("reports.csv")}
            </button>
          </div>
          {monthly ? (
            <>
              <div className="text-2xl font-semibold text-slate-900 mb-1">
                ₹ {(monthly.total ?? 0).toLocaleString()}
              </div>
              <div className="text-xs text-slate-500 mb-4">
                {t("reports.month_for", { month: monthly.month, count: monthly.count ?? 0 })}
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                {(["cash", "upi", "card"] as const).map((k) => (
                  <div key={k}>
                    <div className="text-lg font-semibold text-slate-900 tabular-nums">
                      ₹ {(monthly.by_method?.[k] ?? 0).toLocaleString()}
                    </div>
                    <div className="text-[11px] uppercase text-slate-500">
                      {t(`idetail.method.${k}`)}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-500 py-4">{t("reports.no_data")}</div>
          )}
        </div>

        {/* Pending dues */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Clock size={18} className="text-rose-600" />
              <h2 className="font-semibold text-slate-900">{t("reports.pending_dues")}</h2>
            </div>
            <button
              className="btn-ghost !py-1 !text-xs"
              onClick={() => dl(`/api/reports/pending-dues.csv`)}
            >
              <Download size={12} /> {t("reports.csv")}
            </button>
          </div>
          <div className="text-2xl font-semibold text-slate-900 mb-1">
            ₹ {pendingTotal.toLocaleString()}
          </div>
          <div className="text-xs text-slate-500 mb-3">
            {t("reports.across_invoices", { count: pending.length })}
          </div>
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-slate-100">
                {pending.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-center py-4 text-slate-400">
                      {t("reports.no_pending")}
                    </td>
                  </tr>
                ) : (
                  pending.map((r) => (
                    <tr key={r.invoice_id}>
                      <td className="py-1.5">
                        #{String(r.invoice_id).padStart(5, "0")}
                      </td>
                      <td className="py-1.5 truncate max-w-[140px]">
                        {r.patient_name}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-rose-700 font-medium">
                        ₹ {r.balance?.toLocaleString?.()}
                      </td>
                      <td className="py-1.5 text-right text-slate-400 w-14">
                        {r.days_outstanding}d
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Top procedures */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Stethoscope size={18} className="text-violet-600" />
              <h2 className="font-semibold text-slate-900">{t("reports.top_procedures")}</h2>
            </div>
            <button
              className="btn-ghost !py-1 !text-xs"
              onClick={() =>
                dl(
                  `/api/reports/top-procedures.csv?start=${range.start}&end=${range.end}`
                )
              }
            >
              <Download size={12} /> {t("reports.csv")}
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="text-left py-1">{t("reports.col.procedure")}</th>
                  <th className="text-right py-1 w-12">#</th>
                  <th className="text-right py-1 w-24">{t("reports.col.revenue")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {top.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-center py-4 text-slate-400">
                      {t("reports.no_treatments")}
                    </td>
                  </tr>
                ) : (
                  top.map((r, i) => (
                    <tr key={i}>
                      <td className="py-1.5 truncate">{r.name ?? r.procedure_name}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {r.count}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        ₹ {r.revenue?.toLocaleString?.()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
