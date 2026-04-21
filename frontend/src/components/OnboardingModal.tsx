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
} from "lucide-react";
import { api, Settings, settingsComplete } from "../api";

/**
 * Blocking onboarding flow — shown on first launch (and re-shown whenever
 * Settings is missing one of the mandatory fields: doctor name, clinic
 * name, or medical-council registration number). The registration number
 * is a statutory requirement under the Indian Medical Council
 * (Professional Conduct) Regulations 2002 — clause 1.4.2 — and must
 * appear on every prescription, invoice, lab report, and certificate
 * handed over to a patient. We therefore refuse to dismiss until the
 * doctor has supplied it.
 */
export default function OnboardingModal() {
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
  };
  const canSubmit =
    !!trimmed.doctor_name &&
    !!trimmed.clinic_name &&
    !!trimmed.registration_number;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      toast.error(
        "Doctor name, clinic name and registration number are required.",
      );
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
        onboarded_at: new Date().toISOString(),
      });
      setForm(saved);
      toast.success("Profile saved — ready to go!");
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.message || "Could not save settings");
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
                Welcome to Clinikore
              </div>
              <div className="text-xl font-bold">Set up your clinic profile</div>
            </div>
          </div>
          <p className="mt-3 text-sm text-white/90 leading-relaxed max-w-2xl">
            These details appear on every invoice and prescription you hand
            to a patient. As per the Indian Medical Council regulations,
            doctors must display their registration number on all
            professional documents — we'll take care of that for you.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={save} className="overflow-y-auto">
          <div className="px-7 py-6 space-y-6">
            {/* Doctor identity */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <IdCard size={16} className="text-brand-600" />
                <h3 className="font-semibold text-slate-900">
                  Doctor identity
                </h3>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                  Required on every document
                </span>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="label">
                    Doctor's full name <span className="text-rose-500">*</span>
                  </label>
                  <input
                    className="input"
                    value={form.doctor_name || ""}
                    onChange={(e) =>
                      setForm({ ...form, doctor_name: e.target.value })
                    }
                    placeholder="e.g. Priya Sharma"
                    required
                  />
                </div>
                <div>
                  <label className="label flex items-center gap-1.5">
                    <GraduationCap size={13} />
                    Qualifications
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
                    placeholder="e.g. MBBS, MD (Medicine)"
                  />
                </div>
                <div>
                  <label className="label">
                    Medical Council registration no.{" "}
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
                    placeholder="e.g. 12345"
                    required
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Your State Medical Council / NMC number. Printed on every
                    invoice & prescription (MCI Reg. 1.4.2).
                  </p>
                </div>
                <div>
                  <label className="label">Issuing council</label>
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
                    placeholder="e.g. Delhi Medical Council"
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
                  <label className="label">Specialization</label>
                  <input
                    className="input"
                    value={form.specialization || ""}
                    onChange={(e) =>
                      setForm({ ...form, specialization: e.target.value })
                    }
                    placeholder="e.g. Dental Surgeon / Physician / Paediatrician"
                  />
                </div>
              </div>
            </section>

            <div className="border-t border-slate-100" />

            {/* Clinic details */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Building2 size={16} className="text-brand-600" />
                <h3 className="font-semibold text-slate-900">Clinic details</h3>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="label">
                    Clinic / practice name{" "}
                    <span className="text-rose-500">*</span>
                  </label>
                  <input
                    className="input"
                    value={form.clinic_name || ""}
                    onChange={(e) =>
                      setForm({ ...form, clinic_name: e.target.value })
                    }
                    placeholder="e.g. Smile Dental Care"
                    required
                  />
                </div>
                <div>
                  <label className="label flex items-center gap-1.5">
                    <Phone size={13} />
                    Clinic phone
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
                  <label className="label">Email (optional)</label>
                  <input
                    className="input"
                    type="email"
                    value={form.clinic_email || ""}
                    onChange={(e) =>
                      setForm({ ...form, clinic_email: e.target.value })
                    }
                    placeholder="clinic@example.com"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="label flex items-center gap-1.5">
                    <MapPin size={13} />
                    Address
                  </label>
                  <textarea
                    className="input min-h-[70px]"
                    value={form.clinic_address || ""}
                    onChange={(e) =>
                      setForm({ ...form, clinic_address: e.target.value })
                    }
                    placeholder="Shop 12, MG Road, Bengaluru 560001"
                  />
                </div>
              </div>
            </section>

            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3.5 text-sm text-emerald-900 flex items-start gap-2.5">
              <ShieldCheck
                size={18}
                className="shrink-0 text-emerald-700 mt-0.5"
              />
              <div>
                Your details stay on <b>this laptop</b>. They're used to
                brand invoices / prescriptions and never sent anywhere else.
                You can edit them any time from{" "}
                <span className="font-medium">Settings</span>.
              </div>
            </div>
          </div>

          <div className="px-7 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between flex-wrap gap-3">
            <div className="text-xs text-slate-500 flex items-center gap-2">
              {canSubmit ? (
                <>
                  <CheckCircle2 size={14} className="text-emerald-600" />
                  All required fields are filled.
                </>
              ) : (
                <>
                  Fields marked{" "}
                  <span className="text-rose-500 font-semibold">*</span> are
                  required.
                </>
              )}
            </div>
            <button
              type="submit"
              className="btn-primary min-w-[180px] justify-center"
              disabled={saving || !canSubmit}
            >
              {saving ? "Saving..." : "Save & continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
