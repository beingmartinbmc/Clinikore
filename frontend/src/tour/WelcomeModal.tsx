import {
  CalendarDays,
  Users,
  Receipt,
  ShieldCheck,
  Sparkles,
  Activity,
  Loader2,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useTour } from "./TourContext";
import { useI18n } from "../i18n/I18nContext";

const FEATURE_KEYS = [
  { icon: Users,        titleKey: "welcome.feature.charts.title",    bodyKey: "welcome.feature.charts.body" },
  { icon: CalendarDays, titleKey: "welcome.feature.calendar.title",  bodyKey: "welcome.feature.calendar.body" },
  { icon: Receipt,      titleKey: "welcome.feature.invoices.title",  bodyKey: "welcome.feature.invoices.body" },
  { icon: ShieldCheck,  titleKey: "welcome.feature.backups.title",   bodyKey: "welcome.feature.backups.body" },
];

export default function WelcomeModal() {
  const { welcomeOpen, closeWelcome, startTour, loadDemoData, clearDemoData, demoLoading } = useTour();
  const { t } = useI18n();
  const [demoActive, setDemoActive] = useState(false);

  useEffect(() => {
    if (!welcomeOpen) return;
    fetch("/api/demo")
      .then((r) => r.json())
      .then((d) => setDemoActive(!!d.active))
      .catch(() => {});
  }, [welcomeOpen]);

  if (!welcomeOpen) return null;

  async function loadAndTour() {
    try {
      if (!demoActive) {
        await loadDemoData();
        toast.success("Demo data loaded");
      }
      startTour();
    } catch (e: any) {
      toast.error(e.message || "Could not load demo data");
    }
  }

  async function onClearDemo() {
    if (!confirm("Remove all sample/demo data? Your real data is untouched.")) return;
    try {
      await clearDemoData();
      setDemoActive(false);
      toast.success("Demo data removed");
    } catch (e: any) {
      toast.error(e.message || "Failed to clear demo data");
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-br from-brand-600 to-brand-800 text-white p-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-12 w-12 rounded-xl bg-white/15 grid place-items-center">
              <Activity size={24} />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider opacity-80">{t("welcome.kicker")}</div>
              <div className="text-2xl font-semibold">{t("app.name")}</div>
            </div>
          </div>
          <p className="text-sm opacity-90">{t("welcome.intro")}</p>
        </div>

        {/* Feature grid */}
        <div className="p-6 grid grid-cols-2 gap-4">
          {FEATURE_KEYS.map((f) => (
            <div key={f.titleKey} className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-lg bg-brand-50 text-brand-700 grid place-items-center shrink-0">
                <f.icon size={18} />
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900">{t(f.titleKey)}</div>
                <div className="text-xs text-slate-500">{t(f.bodyKey)}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Demo badge */}
        {demoActive && (
          <div className="mx-6 mb-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-center gap-2">
            <Sparkles size={14} />
            <span>{t("welcome.demo_active")}</span>
            <button
              onClick={onClearDemo}
              className="ml-auto inline-flex items-center gap-1 text-amber-900 hover:text-amber-950 font-medium"
            >
              <Trash2 size={12} /> {t("welcome.demo_clear")}
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="p-6 pt-2 space-y-3">
          <button
            className="w-full btn-primary justify-center py-3 text-base"
            onClick={loadAndTour}
            disabled={demoLoading}
          >
            {demoLoading ? (
              <>
                <Loader2 size={18} className="animate-spin" /> {t("welcome.cta.working")}
              </>
            ) : demoActive ? (
              <>
                <Sparkles size={18} /> {t("welcome.cta.take_tour")}
              </>
            ) : (
              <>
                <Sparkles size={18} /> {t("welcome.cta.load_and_tour")}
              </>
            )}
          </button>
          <div className="grid grid-cols-2 gap-3">
            <button className="btn-outline justify-center" onClick={startTour}>
              {t("welcome.cta.tour_only")}
            </button>
            <button className="btn-ghost justify-center" onClick={closeWelcome}>
              {t("welcome.cta.explore")}
            </button>
          </div>
          <p className="text-xs text-slate-400 text-center pt-1">{t("welcome.footer")}</p>
        </div>
      </div>
    </div>
  );
}
