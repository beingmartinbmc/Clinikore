import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Download, HardDrive, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api";
import PageHeader from "../components/PageHeader";
import { format } from "date-fns";
import { useI18n } from "../i18n/I18nContext";

interface BackupEntry {
  name: string;
  created_at: string;
  size_bytes: number;
  tables: Record<string, number>;
}

interface BackupsResponse {
  dir: string;
  interval_hours: number;
  keep: number;
  backups: BackupEntry[];
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function Backups() {
  const { t } = useI18n();
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<BackupsResponse>("/api/backups").then(setData).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  async function backupNow() {
    setBusy(true);
    try {
      await api.post("/api/backups");
      toast.success("Backup created");
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (!confirm(`Delete backup ${name}? This cannot be undone.`)) return;
    await api.del(`/api/backups/${name}`);
    load();
  }

  return (
    <div className="p-8">
      <PageHeader
        title={t("backups.title")}
        subtitle={t("backups.subtitle")}
        actions={
          <>
            <button className="btn-outline" onClick={load} disabled={busy}>
              <RefreshCw size={14} /> {t("common.refresh")}
            </button>
            <button className="btn-primary" onClick={backupNow} disabled={busy}>
              <ShieldCheck size={14} /> {busy ? t("common.loading") : t("backups.backup_now")}
            </button>
          </>
        }
      />

      {data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="card p-5">
            <div className="text-xs uppercase text-slate-500 mb-1">{t("backups.schedule")}</div>
            <div className="text-lg font-semibold text-slate-900">
              {t("backups.schedule_value", { hours: data.interval_hours })}
            </div>
            <div className="text-xs text-slate-500 mt-1">{t("backups.schedule_note")}</div>
          </div>
          <div className="card p-5">
            <div className="text-xs uppercase text-slate-500 mb-1">{t("backups.retention")}</div>
            <div className="text-lg font-semibold text-slate-900">
              {t("backups.retention_value", { keep: data.keep })}
            </div>
            <div className="text-xs text-slate-500 mt-1">{t("backups.retention_note")}</div>
          </div>
          <div className="card p-5">
            <div className="text-xs uppercase text-slate-500 mb-1">{t("backups.location")}</div>
            <div className="flex items-start gap-2 text-sm font-mono text-slate-700 break-all">
              <HardDrive size={14} className="shrink-0 mt-0.5 text-slate-400" />
              {data.dir}
            </div>
            <div className="text-xs text-slate-500 mt-1">{t("backups.location_note")}</div>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-medium">{t("backups.col.snapshot")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("backups.col.created")}</th>
              <th className="text-right px-4 py-3 font-medium">{t("backups.col.size")}</th>
              <th className="text-left px-4 py-3 font-medium">{t("backups.col.records")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.backups.map((b) => {
              const totalRows = Object.values(b.tables).reduce((s, n) => s + n, 0);
              return (
                <tr key={b.name} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-slate-900">{b.name}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {format(new Date(b.created_at), "dd MMM yyyy, p")}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600">
                    {fmtBytes(b.size_bytes)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {totalRows} rows across {Object.keys(b.tables).length} tables
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <a
                        href={`/api/backups/${b.name}/download`}
                        className="text-slate-400 hover:text-brand-700"
                        title="Download as zip"
                      >
                        <Download size={16} />
                      </a>
                      <button
                        onClick={() => remove(b.name)}
                        className="text-slate-400 hover:text-rose-600"
                        title="Delete"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {data && data.backups.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-12 text-slate-500 text-sm">
                  {t("backups.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-6 card p-5 bg-amber-50 border-amber-200">
        <div className="font-semibold text-amber-900 mb-1">{t("backups.offsite_title")}</div>
        <p className="text-sm text-amber-800">{t("backups.offsite_body")}</p>
      </div>
    </div>
  );
}
