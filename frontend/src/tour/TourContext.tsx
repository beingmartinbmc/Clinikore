import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";

/**
 * Shared state for the guided demo / onboarding tour.
 *
 * We keep the API intentionally small: the tour is always a linear sequence
 * of steps, and every component that cares (TourBanner, WelcomeModal,
 * sidebar Help button) reads/writes through this hook.
 */

export interface TourStep {
  path: string;      // route to push when this step is activated
  titleKey: string;  // i18n key — resolved at render time
  bodyKey: string;
}

export const TOUR_STEPS: TourStep[] = [
  { path: "/",           titleKey: "tour.dashboard.title",  bodyKey: "tour.dashboard.body" },
  { path: "/patients",   titleKey: "tour.patients.title",   bodyKey: "tour.patients.body" },
  { path: "/calendar",   titleKey: "tour.calendar.title",   bodyKey: "tour.calendar.body" },
  { path: "/procedures", titleKey: "tour.procedures.title", bodyKey: "tour.procedures.body" },
  { path: "/invoices",   titleKey: "tour.invoices.title",   bodyKey: "tour.invoices.body" },
  { path: "/backups",    titleKey: "tour.backups.title",    bodyKey: "tour.backups.body" },
];

const ONBOARDING_KEY = "clinikore.onboarding_seen_v1";

interface TourContextValue {
  // Welcome modal
  welcomeOpen: boolean;
  openWelcome: () => void;
  closeWelcome: () => void;

  // Step-through tour
  tourActive: boolean;
  stepIndex: number;
  step: TourStep | null;
  startTour: () => void;
  nextStep: () => void;
  prevStep: () => void;
  stopTour: () => void;

  // Demo data
  demoLoading: boolean;
  loadDemoData: () => Promise<void>;
  clearDemoData: () => Promise<void>;

  /**
   * Monotonic counter bumped on every tour step transition and every demo
   * data change. Use it as a `key` on a parent container to force the
   * currently-mounted page to remount and re-fetch its data — fixes the
   * "page shows stale data until I click Next → Back" issue.
   */
  refreshToken: number;
  bumpRefresh: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function TourProvider({ children }: { children: ReactNode }) {
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [tourActive, setTourActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [demoLoading, setDemoLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  // Open the welcome modal automatically on first launch.
  useEffect(() => {
    if (!localStorage.getItem(ONBOARDING_KEY)) {
      setWelcomeOpen(true);
    }
  }, []);

  const markOnboardingSeen = () =>
    localStorage.setItem(ONBOARDING_KEY, new Date().toISOString());

  const openWelcome = useCallback(() => setWelcomeOpen(true), []);
  const closeWelcome = useCallback(() => {
    setWelcomeOpen(false);
    markOnboardingSeen();
  }, []);

  const startTour = useCallback(() => {
    setStepIndex(0);
    setTourActive(true);
    setWelcomeOpen(false);
    markOnboardingSeen();
    bumpRefresh();
  }, [bumpRefresh]);

  const stopTour = useCallback(() => setTourActive(false), []);

  const nextStep = useCallback(() => {
    setStepIndex((i) => {
      if (i >= TOUR_STEPS.length - 1) {
        setTourActive(false);
        return i;
      }
      return i + 1;
    });
    bumpRefresh();
  }, [bumpRefresh]);

  const prevStep = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
    bumpRefresh();
  }, [bumpRefresh]);

  const loadDemoData = useCallback(async () => {
    setDemoLoading(true);
    try {
      const r = await fetch("/api/demo/seed", { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      bumpRefresh();
    } finally {
      setDemoLoading(false);
    }
  }, [bumpRefresh]);

  const clearDemoData = useCallback(async () => {
    setDemoLoading(true);
    try {
      const r = await fetch("/api/demo/clear", { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      bumpRefresh();
    } finally {
      setDemoLoading(false);
    }
  }, [bumpRefresh]);

  const value: TourContextValue = {
    welcomeOpen,
    openWelcome,
    closeWelcome,
    tourActive,
    stepIndex,
    step: tourActive ? TOUR_STEPS[stepIndex] : null,
    startTour,
    nextStep,
    prevStep,
    stopTour,
    demoLoading,
    loadDemoData,
    clearDemoData,
    refreshToken,
    bumpRefresh,
  };
  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used inside <TourProvider>");
  return ctx;
}
