import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  Save, X, Plus, Trash2, PillBottle,
  Paperclip, Image as ImageIcon, FileText, Download, Upload,
} from "lucide-react";
import {
  api,
  ConsultationAttachment,
  ConsultationNote,
  PrescriptionItem,
  parsePrescriptionItems,
  uploadAttachment,
} from "../api";
import { useI18n } from "../i18n/I18nContext";

interface Props {
  patientId: number;
  appointmentId?: number | null;
  existing?: ConsultationNote | null;
  onSaved?: (note: ConsultationNote) => void;
  onCancel?: () => void;
}

const BLANK_RX: PrescriptionItem = {
  drug: "",
  strength: "",
  frequency: "",
  duration: "",
  instructions: "",
};

/**
 * SOAP-lite consult note editor. The four original fields (complaint /
 * diagnosis / advice / notes) cover the doctor's thought process without
 * forcing a rigid structure, and a structured prescription block below
 * renders as a printable Rx on the invoice.
 */
export default function ConsultNoteEditor({
  patientId,
  appointmentId,
  existing,
  onSaved,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const [form, setForm] = useState<Partial<ConsultationNote>>(() => ({
    chief_complaint: existing?.chief_complaint || "",
    diagnosis: existing?.diagnosis || "",
    treatment_advised: existing?.treatment_advised || "",
    notes: existing?.notes || "",
    prescription_notes: existing?.prescription_notes || "",
  }));
  const [items, setItems] = useState<PrescriptionItem[]>(() =>
    parsePrescriptionItems(existing?.prescription_items),
  );
  const [saving, setSaving] = useState(false);
  const [attachments, setAttachments] = useState<ConsultationAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setForm({
      chief_complaint: existing?.chief_complaint || "",
      diagnosis: existing?.diagnosis || "",
      treatment_advised: existing?.treatment_advised || "",
      notes: existing?.notes || "",
      prescription_notes: existing?.prescription_notes || "",
    });
    setItems(parsePrescriptionItems(existing?.prescription_items));
  }, [existing?.id]);

  // Load the attachment list whenever we're editing an already-saved note.
  // A brand-new note has no id yet, so we skip the fetch and let the user
  // save first before uploading files.
  useEffect(() => {
    if (!existing?.id) {
      setAttachments([]);
      return;
    }
    api
      .get<ConsultationAttachment[]>(
        `/api/consultation-notes/${existing.id}/attachments`,
      )
      .then(setAttachments)
      .catch(() => setAttachments([]));
  }, [existing?.id]);

  const cleanedItems = useMemo(
    () => items.filter((it) => (it.drug || "").trim()),
    [items],
  );

  async function save() {
    setSaving(true);
    try {
      const payload = {
        ...form,
        prescription_items:
          cleanedItems.length > 0 ? JSON.stringify(cleanedItems) : null,
      };
      let saved: ConsultationNote;
      if (existing?.id) {
        saved = await api.put<ConsultationNote>(
          `/api/consultation-notes/${existing.id}`,
          payload,
        );
      } else {
        saved = await api.post<ConsultationNote>("/api/consultation-notes", {
          patient_id: patientId,
          appointment_id: appointmentId || null,
          ...payload,
        });
      }
      toast.success(t("cne.note_saved"));
      onSaved?.(saved);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  function updateItem(i: number, patch: Partial<PrescriptionItem>) {
    setItems((prev) =>
      prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)),
    );
  }
  function addItem() {
    setItems((p) => [...p, { ...BLANK_RX }]);
  }
  function removeItem(i: number) {
    setItems((p) => p.filter((_, idx) => idx !== i));
  }

  // PDF is exposed as an anchor tag so pywebview routes it to the system
  // PDF viewer (where a Print button already exists — no need to duplicate
  // a separate "Print Rx" button here).
  const pdfUrl = existing?.id
    ? `/api/consultation-notes/${existing.id}/prescription.pdf`
    : "";

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function onFilesPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!existing?.id) {
      toast.error(t("cne.save_first_attach"));
      return;
    }
    setUploading(true);
    try {
      const uploaded: ConsultationAttachment[] = [];
      // Sequential upload keeps the progress toast deterministic and avoids
      // hammering the backend with big files in parallel on slow connections.
      for (const f of Array.from(files)) {
        const a = await uploadAttachment(existing.id, f);
        uploaded.push(a);
      }
      setAttachments((prev) => [...prev, ...uploaded]);
      toast.success(
        uploaded.length === 1
          ? t("cne.attachment_uploaded")
          : t("cne.attachments_uploaded", { count: uploaded.length }),
      );
    } catch (e: any) {
      toast.error(e.message || t("cne.upload_failed"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function removeAttachment(aid: number) {
    if (!confirm(t("cne.confirm_remove_attachment"))) return;
    try {
      await api.del(`/api/attachments/${aid}`);
      setAttachments((prev) => prev.filter((a) => a.id !== aid));
    } catch (e: any) {
      toast.error(e.message || t("cne.remove_attachment_failed"));
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="label">{t("cne.chief_complaint")}</label>
        <input
          className="input"
          value={form.chief_complaint || ""}
          onChange={(e) =>
            setForm({ ...form, chief_complaint: e.target.value })
          }
          placeholder={t("cne.chief_complaint_placeholder")}
        />
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="label">{t("cne.diagnosis")}</label>
          <textarea
            className="textarea"
            rows={3}
            value={form.diagnosis || ""}
            onChange={(e) => setForm({ ...form, diagnosis: e.target.value })}
          />
        </div>
        <div>
          <label className="label">{t("cne.advice")}</label>
          <textarea
            className="textarea"
            rows={3}
            value={form.treatment_advised || ""}
            onChange={(e) =>
              setForm({ ...form, treatment_advised: e.target.value })
            }
            placeholder={t("cne.advice_placeholder")}
          />
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 bg-slate-50 rounded-t-lg">
          <div className="flex items-center gap-2 text-slate-700 font-medium text-sm">
            <PillBottle size={15} className="text-brand-600" />
            {t("cne.rx_header")}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              className="btn-ghost text-xs !py-1"
              type="button"
              onClick={addItem}
            >
              <Plus size={12} /> {t("cne.add_medicine")}
            </button>
            {existing?.id ? (
              <a
                className="btn-ghost text-xs !py-1"
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                title={t("cne.pdf_title")}
              >
                <FileText size={12} /> {t("cne.pdf")}
              </a>
            ) : (
              <button
                className="btn-ghost text-xs !py-1"
                type="button"
                disabled
                title={t("cne.pdf_disabled_title")}
              >
                <FileText size={12} /> {t("cne.pdf")}
              </button>
            )}
          </div>
        </div>

        {items.length === 0 ? (
          <div className="text-xs text-slate-500 px-4 py-6 text-center">
            {t("cne.no_meds")}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {items.map((it, idx) => (
              <div
                key={idx}
                className="grid grid-cols-12 gap-2 px-3 py-2 items-start"
              >
                <input
                  className="input !py-1 col-span-4"
                  placeholder={t("cne.drug_placeholder")}
                  value={it.drug}
                  onChange={(e) => updateItem(idx, { drug: e.target.value })}
                />
                <input
                  className="input !py-1 col-span-2"
                  placeholder={t("cne.strength_placeholder")}
                  value={it.strength || ""}
                  onChange={(e) =>
                    updateItem(idx, { strength: e.target.value })
                  }
                />
                <input
                  className="input !py-1 col-span-2"
                  placeholder={t("cne.frequency_placeholder")}
                  value={it.frequency || ""}
                  onChange={(e) =>
                    updateItem(idx, { frequency: e.target.value })
                  }
                />
                <input
                  className="input !py-1 col-span-2"
                  placeholder={t("cne.duration_placeholder")}
                  value={it.duration || ""}
                  onChange={(e) =>
                    updateItem(idx, { duration: e.target.value })
                  }
                />
                <input
                  className="input !py-1 col-span-1"
                  placeholder={t("cne.notes_placeholder")}
                  value={it.instructions || ""}
                  onChange={(e) =>
                    updateItem(idx, { instructions: e.target.value })
                  }
                />
                <button
                  className="text-slate-400 hover:text-rose-600 mt-1 col-span-1 justify-self-end"
                  type="button"
                  onClick={() => removeItem(idx)}
                  aria-label={t("cne.remove_row")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="px-3 pb-3 pt-1">
          <label className="label text-xs">{t("cne.rx_notes")}</label>
          <textarea
            className="textarea !py-1 text-sm"
            rows={2}
            placeholder={t("cne.rx_notes_placeholder")}
            value={form.prescription_notes || ""}
            onChange={(e) =>
              setForm({ ...form, prescription_notes: e.target.value })
            }
          />
        </div>
      </div>

      {/* Attachments: lab reports, X-rays, photos -- anything pinned to
          this visit. Only available once the note has been saved (we need
          a note id to attach files to). */}
      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 bg-slate-50 rounded-t-lg">
          <div className="flex items-center gap-2 text-slate-700 font-medium text-sm">
            <Paperclip size={15} className="text-brand-600" />
            {t("cne.attachments")}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept={[
                "image/png",
                "image/jpeg",
                "image/heic",
                "image/heif",
                "image/gif",
                "image/webp",
                "image/bmp",
                "image/tiff",
                ".heic",
                ".heif",
                ".jpg",
                ".jpeg",
                ".png",
                ".gif",
                ".webp",
                ".bmp",
                ".tif",
                ".tiff",
                "application/pdf",
                ".pdf",
                ".doc",
                ".docx",
                ".xls",
                ".xlsx",
                ".txt",
                ".csv",
              ].join(",")}
              onChange={(e) => onFilesPicked(e.target.files)}
            />
            <button
              className="btn-ghost text-xs !py-1"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!existing?.id || uploading}
              title={
                existing?.id
                  ? t("cne.upload_title")
                  : t("cne.upload_disabled_title")
              }
            >
              <Upload size={12} />{" "}
              {uploading ? t("cne.uploading") : t("cne.upload")}
            </button>
          </div>
        </div>

        {!existing?.id ? (
          <div className="text-xs text-slate-500 px-4 py-6 text-center">
            {t("cne.save_first")}
          </div>
        ) : attachments.length === 0 ? (
          <div className="text-xs text-slate-500 px-4 py-6 text-center">
            {t("cne.no_attachments")}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {attachments.map((a) => {
              const Icon = a.kind === "image"
                ? ImageIcon
                : a.kind === "pdf"
                  ? FileText
                  : FileText;
              return (
                <li
                  key={a.id}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  {a.kind === "image" && a.download_url ? (
                    <img
                      src={a.download_url}
                      alt={a.filename}
                      className="h-10 w-10 object-cover rounded border border-slate-200"
                    />
                  ) : (
                    <div className="h-10 w-10 rounded border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-500">
                      <Icon size={18} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium text-slate-800">
                      {a.filename}
                    </div>
                    <div className="text-xs text-slate-500">
                      {a.mime_type} · {fmtSize(a.size_bytes)}
                    </div>
                  </div>
                  {a.download_url && (
                    <a
                      href={a.download_url}
                      target="_blank"
                      rel="noopener"
                      className="text-slate-500 hover:text-brand-700"
                      title={t("cne.attach_tooltip")}
                    >
                      <Download size={16} />
                    </a>
                  )}
                  <button
                    className="text-slate-400 hover:text-rose-600"
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={t("cne.remove_attachment")}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <label className="label">{t("cne.additional_notes")}</label>
        <textarea
          className="textarea"
          rows={2}
          value={form.notes || ""}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        {onCancel && (
          <button className="btn-ghost" onClick={onCancel} type="button">
            <X size={14} /> {t("cne.cancel")}
          </button>
        )}
        <button
          className="btn-primary"
          onClick={save}
          type="button"
          disabled={saving}
        >
          <Save size={14} /> {existing?.id ? t("cne.save_changes") : t("cne.save_note")}
        </button>
      </div>
    </div>
  );
}
