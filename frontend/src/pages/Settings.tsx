import { useEffect, useState, FormEvent } from "react";
import toast from "react-hot-toast";
import {
  Save,
  UserCircle2,
  Building2,
  HardDrive,
  ShieldCheck,
  IdCard,
  AlertTriangle,
  Clock,
  DoorOpen,
  Activity,
  Trash2,
  Plus,
} from "lucide-react";
import {
  api,
  Settings as SettingsType,
  settingsComplete,
  DoctorAvailability,
  Room,
  AuditEntry,
  DOCTOR_CATEGORIES,
  doctorCategoryLabel,
} from "../api";
import PageHeader from "../components/PageHeader";
import { useI18n } from "../i18n/I18nContext";
import { format } from "date-fns";
import clsx from "clsx";

interface SystemInfo {
  app_dir: string;
  db_path: string;
  backup_dir: string;
  log_dir: string;
}

type Tab = "profile" | "availability" | "rooms" | "activity";
const TAB_DEFS: { id: Tab; labelKey: string; icon: any }[] = [
  { id: "profile", labelKey: "settings.tab.profile", icon: UserCircle2 },
  { id: "availability", labelKey: "settings.tab.availability", icon: Clock },
  { id: "rooms", labelKey: "settings.tab.rooms", icon: DoorOpen },
  { id: "activity", labelKey: "settings.tab.activity", icon: Activity },
];
const DAY_KEYS = [
  "settings.day.mon",
  "settings.day.tue",
  "settings.day.wed",
  "settings.day.thu",
  "settings.day.fri",
  "settings.day.sat",
  "settings.day.sun",
];

export default function SettingsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("profile");
  const [form, setForm] = useState<Partial<SettingsType>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [availability, setAvailability] = useState<DoctorAvailability[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [newRoom, setNewRoom] = useState("");
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditFilter, setAuditFilter] = useState({ action: "", limit: 50 });

  function loadAvailability() {
    api.get<DoctorAvailability[]>("/api/availability").then(setAvailability).catch(() => {});
  }
  function loadRooms() {
    api.get<Room[]>("/api/rooms").then(setRooms).catch(() => {});
  }
  function loadAudit() {
    const qs = new URLSearchParams();
    if (auditFilter.action) qs.set("action", auditFilter.action);
    qs.set("limit", String(auditFilter.limit));
    api.get<AuditEntry[]>(`/api/audit?${qs.toString()}`).then(setAudit).catch(() => {});
  }

  useEffect(() => {
    api.get<SettingsType>("/api/settings").then(setForm).catch(() => {});
    api.get<string[]>("/api/procedures/categories").then(setCategories).catch(() => {});
    api.get<SystemInfo>("/api/system/info").then(setSysInfo).catch(() => {});
    loadAvailability();
    loadRooms();
  }, []);

  useEffect(() => {
    if (tab === "activity") loadAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, auditFilter.action, auditFilter.limit]);

  async function saveAvailability(updated: DoctorAvailability) {
    try {
      await api.put(`/api/availability/${updated.weekday}`, updated);
      loadAvailability();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function addRoom() {
    if (!newRoom.trim()) return;
    try {
      await api.post("/api/rooms", { name: newRoom.trim() });
      setNewRoom("");
      loadRooms();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function toggleRoom(room: Room) {
    await api.put(`/api/rooms/${room.id}`, { active: !room.active });
    loadRooms();
  }

  async function deleteRoom(room: Room) {
    if (!confirm(t("settings.rooms.confirm_remove", { name: room.name }))) return;
    await api.del(`/api/rooms/${room.id}`);
    loadRooms();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const saved = await api.put<SettingsType>("/api/settings", {
        doctor_name: form.doctor_name || null,
        doctor_qualifications: form.doctor_qualifications || null,
        registration_number: form.registration_number || null,
        registration_council: form.registration_council || null,
        clinic_name: form.clinic_name || null,
        clinic_address: form.clinic_address || null,
        clinic_phone: form.clinic_phone || null,
        clinic_email: form.clinic_email || null,
        clinic_gstin: form.clinic_gstin || null,
        specialization: form.specialization || null,
        doctor_category: form.doctor_category || null,
      });
      setForm(saved);
      toast.success(t("settings.saved"));
    } catch (err: any) {
      toast.error(err?.message || t("settings.save_failed"));
    } finally {
      setSaving(false);
    }
  }

  const complete = settingsComplete(form);

  return (
    <div className="p-8 max-w-4xl">
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />

      <div className="flex gap-1 border-b border-slate-200 mb-5">
        {TAB_DEFS.map((tt) => {
          const Icon = tt.icon;
          return (
            <button
              key={tt.id}
              onClick={() => setTab(tt.id)}
              className={clsx(
                "px-4 py-2 -mb-px text-sm font-medium border-b-2 flex items-center gap-2",
                tab === tt.id
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-slate-500 hover:text-slate-800",
              )}
            >
              <Icon size={14} />
              {t(tt.labelKey as any)}
            </button>
          );
        })}
      </div>

      {tab === "availability" && (
        <div className="card p-6">
          <h2 className="font-semibold text-slate-900 mb-1">
            {t("settings.availability.title")}
          </h2>
          <p className="text-sm text-slate-500 mb-4">
            {t("settings.availability.subtitle")}
          </p>
          <div className="space-y-2">
            {availability.map((a) => (
              <div
                key={a.weekday}
                className="grid grid-cols-12 gap-2 items-center bg-slate-50 rounded-lg p-2.5"
              >
                <div className="col-span-2 font-medium text-slate-700">
                  {t(DAY_KEYS[a.weekday] as any)}
                </div>
                <label className="col-span-2 inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={a.is_working}
                    onChange={(e) =>
                      saveAvailability({ ...a, is_working: e.target.checked })
                    }
                  />
                  {t("settings.availability.working")}
                </label>
                <input
                  type="time"
                  className="input !py-1 !text-sm col-span-2"
                  value={a.start_time}
                  disabled={!a.is_working}
                  onChange={(e) => setAvailability((cur) => cur.map((x) => x.weekday === a.weekday ? { ...x, start_time: e.target.value } : x))}
                  onBlur={() => saveAvailability(a)}
                />
                <input
                  type="time"
                  className="input !py-1 !text-sm col-span-2"
                  value={a.end_time}
                  disabled={!a.is_working}
                  onChange={(e) => setAvailability((cur) => cur.map((x) => x.weekday === a.weekday ? { ...x, end_time: e.target.value } : x))}
                  onBlur={() => saveAvailability(a)}
                />
                <div className="col-span-4 flex items-center gap-1 text-xs text-slate-500">
                  {t("settings.availability.break")}
                  <input
                    type="time"
                    className="input !py-1 !text-xs w-24"
                    value={a.break_start || ""}
                    disabled={!a.is_working}
                    onChange={(e) => setAvailability((cur) => cur.map((x) => x.weekday === a.weekday ? { ...x, break_start: e.target.value } : x))}
                    onBlur={() => saveAvailability(a)}
                  />
                  –
                  <input
                    type="time"
                    className="input !py-1 !text-xs w-24"
                    value={a.break_end || ""}
                    disabled={!a.is_working}
                    onChange={(e) => setAvailability((cur) => cur.map((x) => x.weekday === a.weekday ? { ...x, break_end: e.target.value } : x))}
                    onBlur={() => saveAvailability(a)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "rooms" && (
        <div className="card p-6">
          <h2 className="font-semibold text-slate-900 mb-1">
            {t("settings.rooms.title")}
          </h2>
          <p className="text-sm text-slate-500 mb-4">
            {t("settings.rooms.subtitle")}
          </p>
          <div className="flex gap-2 mb-4">
            <input
              className="input flex-1"
              placeholder={t("settings.rooms.placeholder")}
              value={newRoom}
              onChange={(e) => setNewRoom(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addRoom()}
            />
            <button className="btn-primary" onClick={addRoom}>
              <Plus size={14} /> {t("common.add")}
            </button>
          </div>
          {rooms.length === 0 ? (
            <div className="text-sm text-slate-500 text-center py-6">
              {t("settings.rooms.empty")}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {rooms.map((r) => (
                <div key={r.id} className="py-2.5 flex items-center gap-3">
                  <DoorOpen size={14} className={r.active ? "text-brand-500" : "text-slate-300"} />
                  <div className={clsx("flex-1 font-medium", !r.active && "line-through text-slate-400")}>
                    {r.name}
                  </div>
                  <button
                    className="text-xs text-slate-500 hover:text-slate-800"
                    onClick={() => toggleRoom(r)}
                  >
                    {r.active ? t("common.deactivate") : t("common.reactivate")}
                  </button>
                  <button
                    className="text-slate-400 hover:text-rose-600"
                    onClick={() => deleteRoom(r)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "activity" && (
        <div className="card p-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-semibold text-slate-900">
              {t("settings.activity.title")}
            </h2>
            <div className="flex items-center gap-2">
              <input
                className="input !py-1 !text-sm"
                placeholder={t("settings.activity.filter_placeholder")}
                value={auditFilter.action}
                onChange={(e) => setAuditFilter((f) => ({ ...f, action: e.target.value }))}
              />
              <select
                className="select !py-1 !text-sm"
                value={auditFilter.limit}
                onChange={(e) => setAuditFilter((f) => ({ ...f, limit: Number(e.target.value) }))}
              >
                {[50, 100, 200, 500].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>
          {audit.length === 0 ? (
            <div className="text-sm text-slate-500 text-center py-10">
              {t("settings.activity.empty")}
            </div>
          ) : (
            <div className="max-h-[640px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-500 text-xs">
                  <tr>
                    <th className="text-left py-2">{t("settings.activity.col.when")}</th>
                    <th className="text-left py-2">{t("settings.activity.col.action")}</th>
                    <th className="text-left py-2">{t("settings.activity.col.entity")}</th>
                    <th className="text-left py-2">{t("settings.activity.col.summary")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {audit.map((e) => (
                    <tr key={e.id}>
                      <td className="py-2 whitespace-nowrap text-slate-500">
                        {format(new Date(e.created_at), "dd MMM yyyy HH:mm:ss")}
                      </td>
                      <td className="py-2 font-mono text-xs text-slate-700">
                        {e.action}
                      </td>
                      <td className="py-2 text-xs text-slate-500">
                        {e.entity_type ? `${e.entity_type}#${e.entity_id}` : "—"}
                      </td>
                      <td className="py-2 text-slate-800">
                        {e.summary || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "profile" && <>
      {!complete && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-700" />
          <div>
            <div className="font-semibold">
              {t("settings.mandatory_banner_title")}
            </div>
            <div className="mt-1 leading-relaxed">
              {t("settings.mandatory_banner_body")}
            </div>
          </div>
        </div>
      )}

      <form onSubmit={save} className="space-y-6">
        {/* Doctor profile */}
        <div className="card p-6">
          <div className="flex items-center gap-2 mb-5">
            <UserCircle2 size={18} className="text-brand-600" />
            <h2 className="font-semibold text-slate-900">{t("settings.section.doctor")}</h2>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="label">
                {t("settings.doctor_name")} <span className="text-rose-500">*</span>
              </label>
              <input
                className="input"
                value={form.doctor_name || ""}
                onChange={(e) => setForm({ ...form, doctor_name: e.target.value })}
                placeholder={t("settings.doctor_name_placeholder")}
              />
              <p className="text-xs text-slate-500 mt-1">{t("settings.doctor_name_help")}</p>
            </div>
            <div>
              <label className="label">{t("settings.qualifications")}</label>
              <input
                className="input"
                value={form.doctor_qualifications || ""}
                onChange={(e) =>
                  setForm({ ...form, doctor_qualifications: e.target.value })
                }
                placeholder={t("settings.qualifications_placeholder")}
              />
              <p className="text-xs text-slate-500 mt-1">{t("settings.qualifications_help")}</p>
            </div>
            <div>
              <label className="label" htmlFor="doctor-category-select">
                {t("settings.practice_category")}
              </label>
              <select
                id="doctor-category-select"
                className="input"
                value={form.doctor_category || ""}
                onChange={(e) =>
                  setForm({ ...form, doctor_category: e.target.value || null })
                }
              >
                <option value="">{t("settings.practice_category_select")}</option>
                {DOCTOR_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {doctorCategoryLabel(c)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-1">
                {t("settings.practice_category_help")}
              </p>
            </div>
            <div>
              <label className="label">{t("settings.specialization")}</label>
              <input
                className="input"
                list="specialization-options"
                value={form.specialization || ""}
                onChange={(e) => setForm({ ...form, specialization: e.target.value })}
                placeholder={t("settings.specialization_placeholder")}
              />
              <datalist id="specialization-options">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <p className="text-xs text-slate-500 mt-1">{t("settings.specialization_help")}</p>
            </div>
          </div>
        </div>

        {/* Registration — statutory block, visually separated for importance */}
        <div className="card p-6 border-2 border-brand-100">
          <div className="flex items-center gap-2 mb-5">
            <IdCard size={18} className="text-brand-600" />
            <h2 className="font-semibold text-slate-900">
              {t("settings.section.registration")}
            </h2>
          </div>
          <p className="text-sm text-slate-600 mb-4 leading-relaxed">
            {t("settings.registration_help")}
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="label">
                {t("settings.reg_number")} <span className="text-rose-500">*</span>
              </label>
              <input
                className="input font-mono"
                value={form.registration_number || ""}
                onChange={(e) =>
                  setForm({ ...form, registration_number: e.target.value })
                }
                placeholder={t("settings.reg_number_placeholder")}
              />
            </div>
            <div>
              <label className="label">{t("settings.reg_council")}</label>
              <input
                className="input"
                list="council-options"
                value={form.registration_council || ""}
                onChange={(e) =>
                  setForm({ ...form, registration_council: e.target.value })
                }
                placeholder={t("settings.reg_council_placeholder")}
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
          </div>
          {form.registration_number && (
            <div className="mt-4 text-xs text-slate-600">
              {t("settings.reg_preview")}{" "}
              <span className="ml-1 inline-block px-2 py-0.5 rounded-full bg-cyan-50 border border-cyan-200 text-cyan-800 font-semibold">
                Reg. No. {form.registration_number}
                {form.registration_council
                  ? ` (${form.registration_council})`
                  : ""}
              </span>
            </div>
          )}
        </div>

        {/* Clinic details */}
        <div className="card p-6">
          <div className="flex items-center gap-2 mb-5">
            <Building2 size={18} className="text-brand-600" />
            <h2 className="font-semibold text-slate-900">{t("settings.section.clinic")}</h2>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="label">
                {t("settings.clinic_name")} <span className="text-rose-500">*</span>
              </label>
              <input
                className="input"
                value={form.clinic_name || ""}
                onChange={(e) => setForm({ ...form, clinic_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">{t("settings.clinic_phone")}</label>
              <input
                className="input"
                value={form.clinic_phone || ""}
                onChange={(e) => setForm({ ...form, clinic_phone: e.target.value })}
              />
            </div>
            <div>
              <label className="label">{t("settings.clinic_email")}</label>
              <input
                className="input"
                type="email"
                value={form.clinic_email || ""}
                onChange={(e) => setForm({ ...form, clinic_email: e.target.value })}
                placeholder={t("settings.clinic_email_placeholder")}
              />
            </div>
            <div>
              <label className="label">{t("settings.clinic_gstin")}</label>
              <input
                className="input font-mono"
                value={form.clinic_gstin || ""}
                onChange={(e) => setForm({ ...form, clinic_gstin: e.target.value })}
                placeholder={t("settings.clinic_gstin_placeholder")}
              />
            </div>
            <div className="md:col-span-2">
              <label className="label">{t("settings.clinic_address")}</label>
              <textarea
                className="input min-h-[80px]"
                value={form.clinic_address || ""}
                onChange={(e) => setForm({ ...form, clinic_address: e.target.value })}
              />
            </div>
          </div>
        </div>

        {/* Data location */}
        <div className="card p-6">
          <div className="flex items-center gap-2 mb-5">
            <HardDrive size={18} className="text-brand-600" />
            <h2 className="font-semibold text-slate-900">{t("settings.section.data")}</h2>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200 mb-4">
            <ShieldCheck size={18} className="text-emerald-600 mt-0.5 shrink-0" />
            <p className="text-sm text-emerald-900">{t("settings.data_safe")}</p>
          </div>
          <div className="text-sm">
            <div className="label">{t("settings.data_location")}</div>
            <code className="block px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded font-mono break-all">
              {sysInfo?.app_dir || "—"}
            </code>
            <p className="text-xs text-slate-500 mt-2">{t("settings.data_location_help")}</p>
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit" className="btn-primary" disabled={saving}>
            <Save size={16} />
            {saving ? t("common.loading") : t("common.save")}
          </button>
        </div>
      </form>
      </>}
    </div>
  );
}
