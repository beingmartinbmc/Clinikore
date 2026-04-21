import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Appointment, DashboardSummary, Settings } from "../api";
import PageHeader from "../components/PageHeader";
import StatusBadge from "../components/StatusBadge";
import { Users, CalendarClock, Receipt, Wallet, TrendingUp, ClipboardList } from "lucide-react";
import { format } from "date-fns";
import { useI18n } from "../i18n/I18nContext";

function Stat({
  icon: Icon,
  label,
  value,
  tone = "brand",
}: {
  icon: any;
  label: string;
  value: string;
  tone?: "brand" | "amber" | "rose" | "emerald";
}) {
  const tones: Record<string, string> = {
    brand: "bg-brand-50 text-brand-700",
    amber: "bg-amber-50 text-amber-700",
    rose: "bg-rose-50 text-rose-700",
    emerald: "bg-emerald-50 text-emerald-700",
  };
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className={`h-12 w-12 rounded-lg grid place-items-center ${tones[tone]}`}>
        <Icon size={22} />
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-2xl font-semibold text-slate-900">{value}</div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [today, setToday] = useState<Appointment[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    api.get<DashboardSummary>("/api/dashboard").then(setSummary).catch(() => {});
    api.get<Settings>("/api/settings").then(setSettings).catch(() => {});
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    api
      .get<Appointment[]>(
        `/api/appointments?start=${start.toISOString()}&end=${end.toISOString()}`
      )
      .then(setToday)
      .catch(() => {});
  }, []);

  const doctorName = settings?.doctor_name?.trim();
  const headerTitle = doctorName
    ? t("dashboard.welcome_doctor", { name: doctorName })
    : t("dashboard.title");
  const headerSubtitle = doctorName ? t("dashboard.subtitle") : t("dashboard.subtitle");

  return (
    <div className="p-8">
      <PageHeader
        title={headerTitle}
        subtitle={headerSubtitle}
        actions={
          !doctorName && settings !== null ? (
            <Link to="/settings" className="btn-outline text-sm">
              {t("dashboard.set_name_cta")}
            </Link>
          ) : null
        }
      />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <Stat icon={Users} label={t("dashboard.patients")} value={String(summary?.patients ?? "—")} />
        <Stat
          icon={CalendarClock}
          label={t("dashboard.today_appts")}
          value={String(summary?.today_appointments ?? "—")}
          tone="emerald"
        />
        <Stat
          icon={ClipboardList}
          label="Pending treatment"
          value={String(summary?.pending_treatment_patients ?? "—")}
          tone="amber"
        />
        <Stat
          icon={Receipt}
          label={t("dashboard.pending_invoices")}
          value={String(summary?.pending_invoices ?? "—")}
          tone="amber"
        />
        <Stat
          icon={Wallet}
          label={t("dashboard.pending_dues")}
          value={summary ? `₹ ${summary.pending_dues.toLocaleString()}` : "—"}
          tone="rose"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">{t("dashboard.today_list")}</h2>
            <span className="text-xs text-slate-500">{format(new Date(), "EEE, dd MMM yyyy")}</span>
          </div>
          {today.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">
              {t("dashboard.no_appts_today")}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {today.map((a) => (
                <div key={a.id} className="py-3 flex items-center justify-between">
                  <div>
                    <div className="font-medium text-slate-900">{a.patient_name}</div>
                    <div className="text-xs text-slate-500">
                      {format(new Date(a.start), "p")} – {format(new Date(a.end), "p")} ·{" "}
                      {a.chief_complaint || "Check-up"}
                    </div>
                  </div>
                  <StatusBadge value={a.status} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={18} className="text-brand-600" />
            <h2 className="font-semibold text-slate-900">{t("dashboard.this_month")}</h2>
          </div>
          <div className="text-3xl font-semibold text-slate-900">
            ₹ {summary ? summary.month_revenue.toLocaleString() : "—"}
          </div>
          <div className="text-xs text-slate-500 mt-1">{t("dashboard.payments_received")}</div>
        </div>
      </div>
    </div>
  );
}
