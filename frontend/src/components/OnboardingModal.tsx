import { useEffect, useState, FormEvent } from "react";
import toast from "react-hot-toast";
import {
  Stethoscope,
  Building2,
  IdCard,
  Phone,
  MapPin,
  GraduationCap,
  ShieldCheck,
  CheckCircle2,
  Baby,
  HeartPulse,
  Bone,
  Ear,
  Eye,
  Sparkles,
  Users,
  UserCheck,
  UserPlus,
  Smile,
  Brain,
  Activity,
} from "lucide-react";
import { api, Settings, settingsComplete, DOCTOR_CATEGORIES } from "../api";
import { useI18n } from "../i18n/I18nContext";

// Visual metadata for each structured category. Translatable strings are
// resolved at render time via `t()`; only the icon component is kept here.
const CATEGORY_ICON: Record<string, any> = {
  general: Stethoscope,
  dental: Smile,
  pediatric: Baby,
  geriatric: Users,
  gynecology: UserCheck,
  andrology: UserPlus,
  cardiology: HeartPulse,
  dermatology: Sparkles,
  ent: Ear,
  orthopedic: Bone,
  psychiatry: Brain,
  ophthalmology: Eye,
};

/**
 * Blocking onboarding flow — shown on first launch (and re-shown whenever
 * Settings is missing one of the mandatory fields: doctor name, clinic
 * name, medical-council registration number, or doctor category). The
 * registration number is a statutory requirement under the Indian Medical
 * Council (Professional Conduct) Regulations 2002 — clause 1.4.2 — and must
 * appear on every prescription, invoice, lab report, and certificate
 * handed over to a patient. The doctor category is captured here (rather
 * than in Settings only) because it drives "show me only my patients"
 * filtering across the whole app — we want that filter set on Day 1.
 */
export default function OnboardingModal() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Partial<Settings>>({});

  useEffect(() => {
    api
      .get<Settings>("/api/settings")
      .then((s) => {
        setForm(s);
        setOpen(!settingsComplete(s));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const trimmed = {
    doctor_name: (form.doctor_name || "").trim(),
    clinic_name: (form.clinic_name || "").trim(),
    registration_number: (form.registration_number || "").trim(),
    doctor_category: (form.doctor_category || "").trim(),
  };
  const canSubmit =
    !!trimmed.doctor_name &&
    !!trimmed.clinic_name &&
    !!trimmed.registration_number &&
    !!trimmed.doctor_category;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      toast.error(t("onboarding.toast_missing"));
      return;
    }
    setSaving(true);
    try {
      const saved = await api.put<Settings>("/api/settings", {
        doctor_name: trimmed.doctor_name,
        doctor_qualifications: (form.doctor_qualifications || "").trim() || null,
        registration_number: trimmed.registration_number,
        registration_council: (form.registration_council || "").trim() || null,
        clinic_name: trimmed.clinic_name,
        clinic_address: (form.clinic_address || "").trim() || null,
        clinic_phone: (form.clinic_phone || "").trim() || null,
        clinic_email: (form.clinic_email || "").trim() || null,
        specialization: (form.specialization || "").trim() || null,
        doctor_category: trimmed.doctor_category,
        onboarded_at: new Date().toISOString(),
      });
      setForm(saved);
      toast.success(t("onboarding.toast_saved"));
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.message || t("onboarding.toast_save_failed"));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded || !open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-[92vh] overflow-hidden">
        {/* Banner */}
        <div className="relative bg-gradient-to-br from-brand-600 to-emerald-600 text-white px-7 py-6">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-white/15 grid place-items-center">
              <Stethoscope size={22} />
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-white/70 font-semibold">
                {t("onboarding.welcome_kicker")}
              </div>
              <div className="text-xl font-bold">{t("onboarding.title")}</div>
            </div>
          </div>
          <p className="mt-3 text-sm text-white/90 leading-relaxed max-w-2xl">
            {t("onboarding.intro")}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={save} className="overflow-y-auto">
          <div className="px-7 py-6 space-y-6">
            {/* Doctor category — picked first because it drives filters */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Activity size={16} className="text-brand-600" />
                <h3 className="font-semibold text-slate-900">
                  {t("onboarding.category_heading")}
                </h3>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                  {t("onboarding.category_required")}
                </span>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                {t("onboarding.category_help")}
              </p>
              <div
                className="grid grid-cols-2 md:grid-cols-3 gap-2"
                role="radiogroup"
                aria-label={t("onboarding.category_heading")}
              >
                {DOCTOR_CATEGORIES.map((id) => {
                  const Icon = CATEGORY_ICON[id];
                  if (!Icon) return null;
                  const label = t(`onboarding.cat.${id}.label` as any);
                  const description = t(`onboarding.cat.${id}.desc` as any);
                  const selected = trimmed.doctor_category === id;
                  return (
                    <button
                      type="button"
                      key={id}
                      role="radio"
                      aria-checked={selected}
                      onClick={() =>
                        setForm({ ...form, doctor_category: id })
                      }
                      className={
                        "text-left rounded-lg border p-3 transition focus:outline-none focus:ring-2 focus:ring-brand-400 " +
                        (selected
                          ? "border-brand-500 bg-brand-50 ring-1 ring-brand-300"
                          : "border-slate-200 hover:border-brand-300 hover:bg-slate-50")
                      }
                    >
                      <div className="flex items-center gap-2">
                        <Icon
                          size={16}
                          className={
                            selected ? "text-brand-700" : "text-slate-500"
                          }
                        />
                        <div className="font-medium text-sm text-slate-900">
                          {label}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500 leading-snug">
                        {description}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="border-t border-slate-100" />

            {/* Doctor identity */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <IdCard size={16} className="text-brand-600" />
                <h3 className="font-semibold text-slate-900">
                  {t("onboarding.identity_heading")}
                </h3>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                  {t("onboarding.identity_required")}
                </span>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="label">
                    {t("onboarding.doctor_name_label")}{" "}
                    <span className="text-rose-500">*</span>
                  </label>
                  <input
                    className="input"
                    value={form.doctor_name || ""}
                    onChange={(e) =>
                      setForm({ ...form, doctor_name: e.target.value })
                    }
                    placeholder={t("settings.doctor_name_placeholder")}
                    required
                  />
                </div>
                <div>
                  <label className="label flex items-center gap-1.5">
                    <GraduationCap size={13} />
                    {t("onboarding.qualifications_label")}
                  </label>
                  <input
                    className="input"
                    value={form.doctor_qualifications || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        doctor_qualifications: e.target.value,
                      })
                    }
                    placeholder={t("onboarding.qualifications_placeholder")}
                  />
                </div>
                <div>
                  <label className="label">
                    {t("onboarding.reg_number_label")}{" "}
                    <span className="text-rose-500">*</span>
                  </label>
                  <input
                    className="input font-mono"
                    value={form.registration_number || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        registration_number: e.target.value,
                      })
                    }
                    placeholder={t("onboarding.reg_number_placeholder")}
                    required
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    {t("onboarding.reg_number_help")}
                  </p>
                </div>
                <div>
                  <label className="label">
                    {t("onboarding.reg_council_label")}
                  </label>
                  <input
                    className="input"
                    list="council-options"
                    value={form.registration_council || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        registration_council: e.target.value,
                      })
                    }
                    placeholder={t("onboarding.reg_council_placeholder")}
                  />
                  <datalist id="council-options">
                    <option value="National Medical Commission (NMC)" />
                    <option value="Delhi Medical Council" />
                    <option value="Maharashtra Medical Council" />
                    <option value="Karnataka Medical Council" />
                    <option value="Tamil Nadu Medical Council" />
                    <option value="West Bengal Medical Council" />
                    <option value="Uttar Pradesh Medical Council" />
                    <option value="Gujarat Medical Council" />
                    <option value="Rajasthan Medical Council" />
                    <option value="Andhra Pradesh Medical Council" />
                    <option value="Telangana State Medical Council" />
                    <option value="Kerala Medical Council" />
                    <option value="Dental Council of India" />
                  </datalist>
                </div>
                <div className="md:col-span-2">
                  <label className="label">
                    {t("onboarding.specialization_label")}
                  </label>
                  <input
                    className="input"
                    value={form.specialization || ""}
                    onChange={(e) =>
                      setForm({ ...form, specialization: e.target.value })
                    }
                    placeholder={t("onboarding.specialization_placeholder")}
                  />
                </div>
              </div>
            </section>

            <div className="border-t border-slate-100" />

            {/* Clinic details */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Building2 size={16} className="text-brand-600" />
                <h3 className="font-semibold text-slate-900">
                  {t("onboarding.clinic_heading")}
                </h3>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="label">
                    {t("onboarding.clinic_name_label")}{" "}
                    <span className="text-rose-500">*</span>
                  </label>
                  <input
                    className="input"
                    value={form.clinic_name || ""}
                    onChange={(e) =>
                      setForm({ ...form, clinic_name: e.target.value })
                    }
                    placeholder={t("onboarding.clinic_name_placeholder")}
                    required
                  />
                </div>
                <div>
                  <label className="label flex items-center gap-1.5">
                    <Phone size={13} />
                    {t("onboarding.clinic_phone_label")}
                  </label>
                  <input
                    className="input"
                    value={form.clinic_phone || ""}
                    onChange={(e) =>
                      setForm({ ...form, clinic_phone: e.target.value })
                    }
                    placeholder="+91 ..."
                  />
                </div>
                <div>
                  <label className="label">
                    {t("onboarding.clinic_email_label")}
                  </label>
                  <input
                    className="input"
                    type="email"
                    value={form.clinic_email || ""}
                    onChange={(e) =>
                      setForm({ ...form, clinic_email: e.target.value })
                    }
                    placeholder={t("settings.clinic_email_placeholder")}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="label flex items-center gap-1.5">
                    <MapPin size={13} />
                    {t("onboarding.clinic_address_label")}
                  </label>
                  <textarea
                    className="input min-h-[70px]"
                    value={form.clinic_address || ""}
                    onChange={(e) =>
                      setForm({ ...form, clinic_address: e.target.value })
                    }
                    placeholder={t("onboarding.clinic_address_placeholder")}
                  />
                </div>
              </div>
            </section>

            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3.5 text-sm text-emerald-900 flex items-start gap-2.5">
              <ShieldCheck
                size={18}
                className="shrink-0 text-emerald-700 mt-0.5"
              />
              <div>{t("onboarding.privacy_body")}</div>
            </div>
          </div>

          <div className="px-7 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between flex-wrap gap-3">
            <div className="text-xs text-slate-500 flex items-center gap-2">
              {canSubmit ? (
                <>
                  <CheckCircle2 size={14} className="text-emerald-600" />
                  {t("onboarding.ready")}
                </>
              ) : (
                <>
                  {t("onboarding.required_hint_prefix")}{" "}
                  <span className="text-rose-500 font-semibold">*</span>{" "}
                  {t("onboarding.required_hint_suffix")}
                </>
              )}
            </div>
            <button
              type="submit"
              className="btn-primary min-w-[180px] justify-center"
              disabled={saving || !canSubmit}
            >
              {saving ? t("onboarding.saving") : t("onboarding.save_cta")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
