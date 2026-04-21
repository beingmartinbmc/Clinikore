import clsx from "clsx";
import { useI18n } from "../i18n/I18nContext";

const styles: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-rose-100 text-rose-700",
  paid: "bg-emerald-100 text-emerald-700",
  partial: "bg-amber-100 text-amber-700",
  unpaid: "bg-rose-100 text-rose-700",
};

// Map DB status value -> i18n key. Unknown values fall back to raw text.
const labelKey: Record<string, string> = {
  scheduled: "appt.scheduled",
  completed: "appt.completed",
  cancelled: "appt.cancelled",
  paid: "invoices.status.paid",
  partial: "invoices.status.partial",
  unpaid: "invoices.status.unpaid",
};

export default function StatusBadge({ value }: { value: string }) {
  const { t } = useI18n();
  const label = labelKey[value] ? t(labelKey[value]) : value;
  return (
    <span className={clsx("badge", styles[value] || "bg-slate-100 text-slate-700")}>
      {label}
    </span>
  );
}
