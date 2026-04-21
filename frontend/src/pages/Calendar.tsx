import { useEffect, useMemo, useRef, useState, FormEvent } from "react";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import toast from "react-hot-toast";
import { MessageSquare, Plus, Trash2, Clock } from "lucide-react";

import {
  api,
  Appointment,
  AppointmentStatus,
  DoctorAvailability,
  Patient,
  Procedure,
  Room,
} from "../api";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import StatusBadge from "../components/StatusBadge";
import { useI18n } from "../i18n/I18nContext";

const STATUS_COLORS: Record<AppointmentStatus, string> = {
  scheduled: "#2563eb",
  completed: "#059669",
  cancelled: "#e11d48",
  no_show: "#9333ea",
};

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

/** FullCalendar `businessHours` takes daysOfWeek in 0=Sunday..6=Saturday,
 *  whereas our `DoctorAvailability` uses ISO 0=Monday..6=Sunday. Convert.
 */
function availabilityToBusinessHours(av: DoctorAvailability[]) {
  const segs: any[] = [];
  for (const a of av) {
    if (!a.is_working) continue;
    // ISO weekday (Mon=0 .. Sun=6) -> FC dayOfWeek (Sun=0 .. Sat=6)
    const fcDay = (a.weekday + 1) % 7;
    if (a.break_start && a.break_end) {
      segs.push({ daysOfWeek: [fcDay], startTime: a.start_time, endTime: a.break_start });
      segs.push({ daysOfWeek: [fcDay], startTime: a.break_end, endTime: a.end_time });
    } else {
      segs.push({ daysOfWeek: [fcDay], startTime: a.start_time, endTime: a.end_time });
    }
  }
  return segs;
}

export default function Calendar() {
  const { t } = useI18n();
  const [events, setEvents] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [availability, setAvailability] = useState<DoctorAvailability[]>([]);
  const [roomFilter, setRoomFilter] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const [form, setForm] = useState({
    patient_id: "",
    procedure_id: "",
    room_id: "",
    start: "",
    end: "",
    chief_complaint: "",
    notes: "",
  });
  const calRef = useRef<FullCalendar | null>(null);

  const refetch = () => {
    calRef.current?.getApi().refetchEvents();
  };

  const load = () => {
    const qs = roomFilter ? `?room_id=${roomFilter}` : "";
    api.get<Appointment[]>(`/api/appointments${qs}`).then((list) => {
      setEvents(list);
      // Belt & braces: FC sometimes ignores state changes on same-day repaint.
      setTimeout(refetch, 0);
    });
  };

  useEffect(() => {
    api.get<Patient[]>("/api/patients").then(setPatients);
    api.get<Procedure[]>("/api/procedures").then(setProcedures);
    api.get<Room[]>("/api/rooms?active_only=true").then(setRooms).catch(() => {});
    api.get<DoctorAvailability[]>("/api/availability").then(setAvailability).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomFilter]);

  const fcEvents = useMemo(
    () =>
      events.map((a) => ({
        id: String(a.id),
        title:
          `${a.patient_name ?? "Patient"} — ${a.procedure_name || a.chief_complaint || "Visit"}` +
          (a.room_name ? ` · ${a.room_name}` : ""),
        start: a.start,
        end: a.end,
        backgroundColor: STATUS_COLORS[a.status],
        borderColor: STATUS_COLORS[a.status],
        extendedProps: { appointment: a },
      })),
    [events]
  );

  const businessHours = useMemo(
    () => availabilityToBusinessHours(availability),
    [availability]
  );

  function openNew(start?: Date, end?: Date) {
    const s = start || new Date();
    const e = end || new Date(s.getTime() + 30 * 60 * 1000);
    setSelected(null);
    setForm({
      patient_id: patients[0] ? String(patients[0].id) : "",
      procedure_id: "",
      room_id: roomFilter,
      start: toLocalInput(s),
      end: toLocalInput(e),
      chief_complaint: "",
      notes: "",
    });
    setOpen(true);
  }

  function onProcedureChange(pid: string) {
    const proc = procedures.find((p) => p.id === Number(pid));
    setForm((f) => {
      if (proc && f.start) {
        // Auto-fill the end time based on procedure duration unless the user
        // has already typed something. We check: if the current end-minus-start
        // equals the default 30min, we treat it as "unset" and autofill.
        const startD = new Date(f.start);
        const endD = new Date(f.end);
        const currMinutes = Math.round((endD.getTime() - startD.getTime()) / 60000);
        const shouldAutofill =
          !f.end || currMinutes === 30 || currMinutes <= 0;
        if (shouldAutofill) {
          const newEnd = new Date(startD.getTime() + (proc.default_duration_minutes || 30) * 60000);
          return {
            ...f,
            procedure_id: pid,
            chief_complaint: f.chief_complaint || proc.name,
            end: toLocalInput(newEnd),
          };
        }
      }
      return { ...f, procedure_id: pid, chief_complaint: f.chief_complaint || (proc?.name ?? "") };
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form.patient_id) return toast.error("Pick a patient");
    const payload = {
      patient_id: Number(form.patient_id),
      procedure_id: form.procedure_id ? Number(form.procedure_id) : null,
      room_id: form.room_id ? Number(form.room_id) : null,
      start: new Date(form.start).toISOString(),
      end: new Date(form.end).toISOString(),
      chief_complaint: form.chief_complaint || null,
      notes: form.notes || null,
      status: selected?.status ?? "scheduled",
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
    toast.success(`Marked ${s.replace("_", " ")}`);
    setOpen(false);
    load();
  }

  async function remove() {
    if (!selected) return;
    if (!confirm(t("calendar.confirm_delete"))) return;
    const data: any = await api.del(`/api/appointments/${selected.id}`);
    if (data?.undo_token) {
      toast.success(
        (tt) => (
          <span className="flex items-center gap-3">
            Appointment deleted.
            <button
              className="underline font-semibold text-brand-700"
              onClick={async () => {
                await api.post(`/api/undo/${data.undo_token}`);
                toast.dismiss(tt.id);
                toast.success("Restored");
                load();
              }}
            >
              Undo
            </button>
          </span>
        ),
        { duration: 6000 },
      );
    } else {
      toast.success("Deleted");
    }
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

  async function onEventDropOrResize(info: any) {
    const id = Number(info.event.id);
    const start = info.event.start as Date;
    const end = (info.event.end as Date) || new Date(start.getTime() + 30 * 60000);
    try {
      await api.patch(`/api/appointments/${id}/reschedule`, {
        start: start.toISOString(),
        end: end.toISOString(),
      });
      toast.success("Rescheduled");
      load();
    } catch (err: any) {
      toast.error(err.message);
      info.revert();
    }
  }

  async function quickShift(minutes: number) {
    if (!selected) return;
    const newStart = new Date(new Date(selected.start).getTime() + minutes * 60000);
    const newEnd = new Date(new Date(selected.end).getTime() + minutes * 60000);
    try {
      await api.patch(`/api/appointments/${selected.id}/reschedule`, {
        start: newStart.toISOString(),
        end: newEnd.toISOString(),
      });
      toast.success(minutes > 0 ? `Shifted +${minutes >= 60 ? minutes / 60 + "h" : minutes + "m"}` : `Shifted ${minutes}m`);
      setOpen(false);
      load();
    } catch (err: any) {
      toast.error(err.message);
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

      {rooms.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <label className="text-sm text-slate-600">Room / Chair:</label>
          <select
            className="select !w-auto"
            value={roomFilter}
            onChange={(e) => setRoomFilter(e.target.value)}
          >
            <option value="">All</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      )}

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
          editable
          eventDurationEditable
          businessHours={businessHours.length ? businessHours : undefined}
          events={fcEvents}
          select={(info) => openNew(info.start, info.end)}
          eventDrop={onEventDropOrResize}
          eventResize={onEventDropOrResize}
          eventClick={(info) => {
            const a = info.event.extendedProps.appointment as Appointment;
            setSelected(a);
            setForm({
              patient_id: String(a.patient_id),
              procedure_id: a.procedure_id ? String(a.procedure_id) : "",
              room_id: a.room_id ? String(a.room_id) : "",
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
            <div className="flex items-center gap-2 pb-2 border-b border-slate-100 flex-wrap">
              <StatusBadge value={selected.status} />
              <div className="flex gap-1 ml-auto flex-wrap">
                <button type="button" className="btn-outline !py-1 !text-xs" onClick={() => setStatus("completed")}>
                  Complete
                </button>
                <button type="button" className="btn-outline !py-1 !text-xs" onClick={() => setStatus("cancelled")}>
                  Cancel
                </button>
                <button type="button" className="btn-outline !py-1 !text-xs" onClick={() => setStatus("no_show")}>
                  No-show
                </button>
              </div>
            </div>
          )}
          {selected && (
            <div className="flex items-center gap-1 flex-wrap text-xs">
              <span className="text-slate-500 mr-1">
                <Clock size={12} className="inline -mt-0.5 mr-1" />
                Quick shift:
              </span>
              {[-60, -15, 15, 60, 24 * 60].map((m) => (
                <button
                  key={m}
                  type="button"
                  className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50"
                  onClick={() => quickShift(m)}
                >
                  {m < 0 ? "" : "+"}
                  {Math.abs(m) >= 60 ? Math.round(m / 60) + "h" : m + "m"}
                </button>
              ))}
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
              <label className="label">Procedure</label>
              <select
                className="select"
                value={form.procedure_id}
                onChange={(e) => onProcedureChange(e.target.value)}
              >
                <option value="">—</option>
                {procedures.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.default_duration_minutes ?? 30}m
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Room / Chair</label>
              <select
                className="select"
                value={form.room_id}
                onChange={(e) => setForm({ ...form, room_id: e.target.value })}
              >
                <option value="">—</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
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
