import { NavLink, Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  Stethoscope,
  Receipt,
  Activity,
  ShieldCheck,
  HelpCircle,
  BarChart3,
  NotebookPen,
  Settings as SettingsIcon,
} from "lucide-react";
import clsx from "clsx";
import TourBanner from "../tour/TourBanner";
import { useTour } from "../tour/TourContext";
import { useI18n } from "../i18n/I18nContext";
import LanguageSwitcher from "../i18n/LanguageSwitcher";
import GlobalSearch from "./GlobalSearch";

const NAV = [
  { to: "/", key: "nav.dashboard", icon: LayoutDashboard, end: true },
  { to: "/patients", key: "nav.patients", icon: Users },
  { to: "/calendar", key: "nav.calendar", icon: CalendarDays },
  { to: "/procedures", key: "nav.procedures", icon: Stethoscope },
  { to: "/consultations", key: "nav.consultations", icon: NotebookPen },
  { to: "/invoices", key: "nav.invoices", icon: Receipt },
  { to: "/reports", key: "nav.reports", icon: BarChart3 },
  { to: "/backups", key: "nav.backups", icon: ShieldCheck },
  { to: "/settings", key: "nav.settings", icon: SettingsIcon },
];

export default function Layout() {
  const { openWelcome, refreshToken } = useTour();
  const { t } = useI18n();
  return (
    <div className="flex h-screen bg-slate-50">
      <aside className="w-60 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="h-16 flex items-center gap-2 px-5 border-b border-slate-200">
          <div className="h-9 w-9 rounded-lg bg-brand-600 text-white grid place-items-center">
            <Activity size={18} />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">{t("app.name")}</div>
            <div className="text-xs text-slate-500">{t("app.tagline")}</div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                )
              }
            >
              <item.icon size={18} />
              {t(item.key)}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3 space-y-2">
          <LanguageSwitcher />
          <button
            onClick={openWelcome}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            <HelpCircle size={18} />
            {t("nav.help")}
          </button>
          <div className="px-3 text-xs text-slate-400">{t("app.offline_sqlite")}</div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto flex flex-col">
        <div className="h-14 border-b border-slate-200 bg-white/80 backdrop-blur flex items-center gap-3 px-6 sticky top-0 z-30">
          <GlobalSearch />
        </div>
        <TourBanner />
        {/* Keying the page container on refreshToken forces a remount
            whenever the tour advances or demo data changes, so the current
            page re-fetches its data instead of showing stale results. */}
        <div key={refreshToken} className="flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
