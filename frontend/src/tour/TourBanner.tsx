import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Sparkles, X } from "lucide-react";
import { TOUR_STEPS, useTour } from "./TourContext";
import { useI18n } from "../i18n/I18nContext";

/**
 * Persistent banner shown across every page while the guided tour is active.
 *
 * Navigation to the right route is driven by the banner itself: whenever the
 * step changes we push the matching path via react-router. We also stop the
 * tour if the user navigates somewhere else on their own (they can always
 * restart from the sidebar Help button).
 */
export default function TourBanner() {
  const { tourActive, stepIndex, step, nextStep, prevStep, stopTour } = useTour();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useI18n();

  // Drive routing from the current step.
  useEffect(() => {
    if (!tourActive || !step) return;
    if (pathname !== step.path) navigate(step.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourActive, stepIndex]);

  if (!tourActive || !step) return null;

  const isLast = stepIndex === TOUR_STEPS.length - 1;
  const isFirst = stepIndex === 0;

  return (
    <div className="sticky top-0 z-40 border-b border-brand-700/20 bg-gradient-to-r from-brand-700 to-brand-600 text-white shadow-sm">
      <div className="px-6 py-3 flex items-center gap-4">
        <div className="h-9 w-9 rounded-lg bg-white/15 grid place-items-center shrink-0">
          <Sparkles size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs opacity-80">
            <span>{t("tour.label")}</span>
            <span>·</span>
            <span>
              {t("tour.step", { current: stepIndex + 1, total: TOUR_STEPS.length })}
            </span>
          </div>
          <div className="flex items-baseline gap-3">
            <h3 className="text-sm font-semibold">{t(step.titleKey)}</h3>
            <p className="text-sm opacity-90 truncate">{t(step.bodyKey)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={prevStep}
            disabled={isFirst}
            className="rounded-md px-2.5 py-1.5 text-sm bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <ArrowLeft size={14} /> {t("tour.back")}
          </button>
          <button
            onClick={nextStep}
            className="rounded-md px-3 py-1.5 text-sm bg-white text-brand-700 font-medium hover:bg-brand-50 flex items-center gap-1"
          >
            {isLast ? t("tour.finish") : t("tour.next")} <ArrowRight size={14} />
          </button>
          <button
            onClick={stopTour}
            title={t("tour.skip")}
            className="rounded-md p-1.5 bg-white/10 hover:bg-white/20"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="px-6 pb-3 text-sm opacity-90 md:hidden">{t(step.bodyKey)}</div>
    </div>
  );
}
