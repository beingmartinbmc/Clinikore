import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Phone, User, Receipt, Stethoscope, FileText } from "lucide-react";
import { api, SearchResult } from "../api";

/**
 * Global fuzzy search exposed via a header input and the `/` keyboard
 * shortcut. Phone-number matches for patients float to the top so the
 * doctor's most common lookup flow (front desk hands over a phone) is
 * instant.
 */
export default function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const tag = (tgt?.tagName || "").toLowerCase();
      const isEditable =
        tag === "input" || tag === "textarea" || tag === "select" ||
        (tgt as any)?.isContentEditable;
      if (!isEditable && e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (!q.trim() || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const id = setTimeout(() => {
      api
        .get<SearchResult[]>(`/api/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => {
          setResults(r);
          setHi(0);
          setOpen(true);
        })
        .catch(() => setResults([]));
    }, 120);
    return () => clearTimeout(id);
  }, [q]);

  function go(r: SearchResult) {
    setOpen(false);
    setQ("");
    if (r.type === "patient") nav(`/patients/${r.id}`);
    else if (r.type === "invoice") nav(`/invoices/${r.id}`);
    else if (r.type === "treatment" || r.type === "note")
      nav(`/patients/${r.patient_id}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[hi];
      if (r) go(r);
    }
  }

  const icons: Record<string, any> = {
    patient: User,
    invoice: Receipt,
    treatment: Stethoscope,
    note: FileText,
  };

  return (
    <div ref={rootRef} className="relative w-full max-w-md">
      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
        />
        <input
          ref={inputRef}
          className="w-full pl-9 pr-12 py-2 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          placeholder="Search patients, invoices, notes…  (press /)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-mono px-1.5 py-0.5 rounded border border-slate-200 text-slate-400 bg-slate-50">
          /
        </kbd>
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white rounded-lg shadow-xl border border-slate-200 overflow-hidden">
          {results.map((r, i) => {
            const Icon = icons[r.type] || Search;
            return (
              <button
                key={`${r.type}-${r.id}-${i}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => go(r)}
                className={
                  "w-full flex items-start gap-3 px-3 py-2 text-left border-b last:border-b-0 border-slate-100 " +
                  (i === hi ? "bg-brand-50" : "hover:bg-slate-50")
                }
              >
                <Icon size={14} className="mt-1 shrink-0 text-slate-400" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">
                    {r.title}
                  </div>
                  {r.subtitle && (
                    <div className="text-xs text-slate-500 truncate">
                      {r.subtitle}
                    </div>
                  )}
                </div>
                {r.match_phone && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                    <Phone size={10} /> match
                  </span>
                )}
                <span className="text-[10px] uppercase text-slate-400 shrink-0">
                  {r.type}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {open && q.trim().length >= 2 && results.length === 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white rounded-lg shadow-xl border border-slate-200 px-3 py-4 text-sm text-slate-500">
          No results for "{q}"
        </div>
      )}
    </div>
  );
}
