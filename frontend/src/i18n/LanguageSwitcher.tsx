import { Languages } from "lucide-react";
import { useI18n } from "./I18nContext";
import { locales, Locale } from "./translations";

export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="relative">
      <Languages
        size={14}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
      />
      <select
        aria-label={t("lang.label")}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="w-full appearance-none rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm text-slate-700 hover:bg-slate-50 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
      >
        {locales.map((l) => (
          <option key={l.code} value={l.code}>
            {l.nativeLabel}
          </option>
        ))}
      </select>
    </div>
  );
}
