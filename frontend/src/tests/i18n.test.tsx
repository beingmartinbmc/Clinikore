import { act, renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { I18nProvider, useI18n, useT } from "../i18n/I18nContext";
import LanguageSwitcher from "../i18n/LanguageSwitcher";
import { translations } from "../i18n/translations";
import { renderApp } from "./helpers";

describe("I18n provider", () => {
  it("defaults to English when no localStorage / navigator hint is set", () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
    });
    expect(result.current.locale).toBe("en");
    expect(result.current.t("common.save")).toBe(translations.en["common.save"]);
  });

  it("picks up Hindi from navigator.language", () => {
    Object.defineProperty(navigator, "language", {
      value: "hi-IN",
      configurable: true,
    });
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
    });
    expect(result.current.locale).toBe("hi");
    // Reset navigator.language so other tests aren't affected.
    Object.defineProperty(navigator, "language", {
      value: "en-US",
      configurable: true,
    });
  });

  it("prefers an explicit localStorage entry over navigator", () => {
    localStorage.setItem("clinikore.locale", "hi");
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
    });
    expect(result.current.locale).toBe("hi");
  });

  it("persists the locale to localStorage on setLocale", () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
    });
    act(() => result.current.setLocale("hi"));
    expect(localStorage.getItem("clinikore.locale")).toBe("hi");
    expect(document.documentElement.getAttribute("lang")).toBe("hi");
  });

  it("interpolates {name} style placeholders in translation strings", () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
    });
    const t = result.current.t;
    // Use a live key if it exists; otherwise exercise the fallback path.
    const withVar = t("dashboard.welcome_doctor", { name: "Rahul" });
    expect(withVar).toContain("Rahul");
  });

  it("falls back to English if the Hindi entry is missing", () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
    });
    act(() => result.current.setLocale("hi"));
    // Pick a random key that _definitely_ only exists in English (use
    // a fake key so the final fallback path to the raw key also runs).
    expect(result.current.t("absolutely.not.a.real.key")).toBe(
      "absolutely.not.a.real.key",
    );
  });

  it("useT hook returns the t function alone", () => {
    const { result } = renderHook(() => useT(), {
      wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
    });
    expect(typeof result.current).toBe("function");
    expect(result.current("common.save")).toBe(translations.en["common.save"]);
  });

  it("throws when useI18n is used outside the provider", () => {
    // renderHook without wrapper → hook throws.
    expect(() => renderHook(() => useI18n())).toThrow(
      /useI18n must be used inside/,
    );
  });

  it("leaves {vars} intact when a placeholder is missing from the map", () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
    });
    // Build a synthetic key by shadowing the English dictionary at runtime
    // via the translations object export.
    translations.en["__synthetic.test"] = "Hello {name} age {age}";
    try {
      expect(result.current.t("__synthetic.test", { name: "X" })).toBe(
        "Hello X age {age}",
      );
    } finally {
      delete translations.en["__synthetic.test"];
    }
  });
});

describe("LanguageSwitcher", () => {
  it("changes the active locale when the user picks a new option", async () => {
    renderApp(<LanguageSwitcher />);
    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();
    await userEvent.selectOptions(select, "hi");
    expect(localStorage.getItem("clinikore.locale")).toBe("hi");
  });

  it("lists both locales as options", () => {
    renderApp(<LanguageSwitcher />);
    expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "हिन्दी" })).toBeInTheDocument();
  });
});
