import { useEffect, useMemo, useRef, useState, FormEvent } from "react";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import toast from "react-hot-toast";
import { MessageSquare, Plus, Trash2 } from "lucide-react";

import { api, Appointment, AppointmentStatus, Patient } from "../api";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import StatusBadge from "../components/StatusBadge";
import { useI18n } from "../i18n/I18nContext";

const STATUS_COLORS: Record<AppointmentStatus, string> = {
  scheduled: "#2563eb",
  completed: "#059669",
  cancelled: "#e11d48",
};

function toLocalInput(d: Date): string {
  // Format a Date as the `datetime-local` expects: YYYY-MM-DDTHH:mm
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function Calendar() {
  const { t } = useI18n();
  const [events, setEvents] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const [form, setForm] = useState({
    patient_id: "",
    start: "",
    end: "",
    chief_complaint: "",
    notes: "",
  });
  const calRef = useRef<FullCalendar | null>(null);

  const load = () => {
    api.get<Appointment[]>("/api/appointments").then(setEvents);
  };

  useEffect(() => {
    load();
    api.get<Patient[]>("/api/patients").then(setPatients);
  }, []);

  const fcEvents = useMemo(
    () =>
      events.map((a) => ({
        id: String(a.id),
        title: `${a.patient_name ?? "Patient"} — ${a.chief_complaint || "Check-up"}`,
        start: a.start,
        end: a.end,
        backgroundColor: STATUS_COLORS[a.status],
        borderColor: STATUS_COLORS[a.status],
        extendedProps: { appointment: a },
      })),
    [events]
  );

  function openNew(start?: Date, end?: Date) {
    const s = start || new Date();
    const e = end || new Date(s.getTime() + 30 * 60 * 1000);
    setSelected(null);
    setForm({
      patient_id: patients[0] ? String(patients[0].id) : "",
      start: toLocalInput(s),
      end: toLocalInput(e),
      chief_complaint: "",
      notes: "",
    });
    setOpen(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form.patient_id) return toast.error("Pick a patient");
    const payload = {
      patient_id: Number(form.patient_id),
      start: new Date(form.start).toISOString(),
      end: new Date(form.end).toISOString(),
      chief_complaint: form.chief_complaint || null,
      notes: form.notes || null,
      status: selected?.status ?? "scheduled",
      reminder_sent: selected?.reminder_sent ?? false,
    };
    try {
      if (selected) {
        await api.put(`/api/appointments/${selected.id}`, payload);
        toast.success("Appointment updated");
      } else {
        await api.post("/api/appointments", payload);
        toast.success("Appointment booked");
      }
      setOpen(false);
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function setStatus(s: AppointmentStatus) {
    if (!selected) return;
    await api.patch(`/api/appointments/${selected.id}/status?new_status=${s}`);
    toast.success(`Marked ${s}`);
    setOpen(false);
    load();
  }

  async function remove() {
    if (!selected) return;
    if (!confirm(t("calendar.confirm_delete"))) return;
    await api.del(`/api/appointments/${selected.id}`);
    toast.success("Deleted");
    setOpen(false);
    load();
  }

  async function remind(channel: "sms" | "whatsapp") {
    if (!selected) return;
    try {
      await api.post(`/api/appointments/${selected.id}/remind?channel=${channel}`);
      toast.success(`Reminder sent via ${channel}`);
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="p-8">
      <PageHeader
        title={t("calendar.title")}
        subtitle={t("calendar.subtitle")}
        actions={
          <button className="btn-primary" onClick={() => openNew()}>
            <Plus size={16} /> {t("calendar.new_appt")}
          </button>
        }
      />

      <div className="card p-4">
        <FullCalendar
          ref={calRef as any}
          plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "timeGridDay,timeGridWeek,dayGridMonth",
          }}
          slotMinTime="08:00:00"
          slotMaxTime="21:00:00"
          height="auto"
          selectable
          selectMirror
          nowIndicator
          allDaySlot={false}
          events={fcEvents}
          select={(info) => openNew(info.start, info.end)}
          eventClick={(info) => {
            const a = info.event.extendedProps.appointment as Appointment;
            setSelected(a);
            setForm({
              patient_id: String(a.patient_id),
              start: toLocalInput(new Date(a.start)),
              end: toLocalInput(new Date(a.end)),
              chief_complaint: a.chief_complaint || "",
              notes: a.notes || "",
            });
            setOpen(true);
          }}
        />
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={selected ? "Appointment" : "New appointment"}
        width="max-w-lg"
        footer={
          <>
            {selected && (
              <button className="btn-danger mr-auto" onClick={remove}>
                <Trash2 size={14} /> Delete
              </button>
            )}
            <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={save as any}>
              {selected ? "Save changes" : "Book"}
            </button>
          </>
        }
      >
        <form onSubmit={save} className="space-y-4">
          {selected && (
            <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
              <StatusBadge value={selected.status} />
              <div className="flex gap-2 ml-auto">
                <button type="button" className="btn-outline !py-1 !text-xs" onClick={() => setStatus("completed")}>
                  Mark completed
                </button>
                <button type="button" className="btn-outline !py-1 !text-xs" onClick={() => setStatus("cancelled")}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div>
            <label className="label">Patient *</label>
            <select
              className="select"
              required
              value={form.patient_id}
              onChange={(e) => setForm({ ...form, patient_id: e.target.value })}
            >
              <option value="">Select patient...</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.phone ? `· ${p.phone}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Start</label>
              <input
                type="datetime-local"
                className="input"
                required
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
              />
            </div>
            <div>
              <label className="label">End</label>
              <input
                type="datetime-local"
                className="input"
                required
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="label">Chief complaint</label>
            <input
              className="input"
              value={form.chief_complaint}
              onChange={(e) => setForm({ ...form, chief_complaint: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea
              className="textarea"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
          {selected && (
            <div className="flex gap-2 pt-2 border-t border-slate-100">
              <button type="button" className="btn-outline" onClick={() => remind("sms")}>
                <MessageSquare size={14} /> Send SMS
              </button>
              <button type="button" className="btn-outline" onClick={() => remind("whatsapp")}>
                <MessageSquare size={14} /> WhatsApp
              </button>
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
