"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Crosshair,
  Download,
  LocateFixed,
  MapPin,
  RefreshCw,
  Satellite,
  XCircle,
} from "lucide-react";
import { fetchPlantRows, type PlantRow } from "@/lib/plantStatus";
import { ESTIMATOR_LABELS, dispersion, distanceM, estimate, toLocal, type Estimator } from "@/lib/gpsStats";
import {
  ACCEPT_CEP95_M,
  ACCEPT_MEDIAN_ACCURACY_M,
  SESSION_FIXES,
  collectFixes,
  exportQueueCsv,
  isAcceptable,
  listSessions,
  pendingObservationCount,
  recordSession,
  saveSlotPosition,
  syncObservations,
  type ObsSample,
  type SessionSummary,
} from "@/lib/gpsCapture";
import { syncPendingSubmissions } from "@/lib/syncService";
import { getUserProfile } from "@/lib/authService";

const ESTIMATORS: Estimator[] = ["raw", "mean", "weighted_mean", "median"];

/** Slot id from a plant id ("A01-P001-G2" -> "A01-P001") when the row has none. */
const slotOf = (r: PlantRow) => r.slot_id ?? r.plant_id.replace(/-G\d+$/, "");

interface SlotInfo {
  slot_id: string;
  plant_id: string;
  zone: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  /** Why it needs re-capture, or null when the stored fix looks fine. */
  reason: string | null;
}

function slotList(rows: PlantRow[]): SlotInfo[] {
  const shared = new Map<string, number>();
  rows.forEach((r) => {
    if (r.latitude != null) shared.set(`${r.latitude},${r.longitude}`, (shared.get(`${r.latitude},${r.longitude}`) ?? 0) + 1);
  });
  return rows
    .map((r) => {
      const dup = r.latitude != null ? shared.get(`${r.latitude},${r.longitude}`) ?? 0 : 0;
      const reason =
        r.latitude == null
          ? "no GPS position"
          : r.accuracy == null
            ? "accuracy unknown"
            : r.accuracy > ACCEPT_MEDIAN_ACCURACY_M
              ? `single fix ±${Math.round(r.accuracy)} m`
              : dup > 1
                ? `same fix as ${dup - 1} other plant${dup > 2 ? "s" : ""}`
                : null;
      return {
        slot_id: slotOf(r),
        plant_id: r.plant_id,
        zone: r.zone,
        latitude: r.latitude,
        longitude: r.longitude,
        accuracy: r.accuracy,
        reason,
      };
    })
    .sort((a, b) => (b.accuracy ?? 1e9) - (a.accuracy ?? 1e9) || a.slot_id.localeCompare(b.slot_id));
}

export default function GpsCapturePage() {
  return (
    <Suspense fallback={null}>
      <GpsCaptureInner />
    </Suspense>
  );
}

function GpsCaptureInner() {
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<PlantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slotId, setSlotId] = useState((searchParams.get("slot") ?? "").toUpperCase());

  const [phase, setPhase] = useState<"idle" | "capturing" | "review">("idle");
  const [samples, setSamples] = useState<ObsSample[]>([]);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refreshLocal = useCallback(async () => {
    setSessions(await listSessions());
    setPending(await pendingObservationCount());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRows((await fetchPlantRows()).rows);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(async () => {
      await refreshLocal();
      await load();
    });
  }, [load, refreshLocal]);

  const slots = useMemo(() => slotList(rows), [rows]);
  const todo = slots.filter((s) => s.reason);
  const selected = slots.find((s) => s.slot_id === slotId) ?? null;
  const sessionsBySlot = useMemo(() => {
    const m = new Map<string, SessionSummary[]>();
    sessions.forEach((s) => m.set(s.slot_id, [...(m.get(s.slot_id) ?? []), s]));
    return m;
  }, [sessions]);

  const start = async () => {
    if (!selected) return;
    setMessage(null);
    setSamples([]);
    setSession(null);
    setPhase("capturing");
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const got = await collectFixes(SESSION_FIXES, setSamples, ac.signal);
      if (!got.length) {
        setPhase("idle");
        setMessage({ kind: "warn", text: "No GPS readings were received." });
        return;
      }
      const legacy =
        selected.latitude != null && selected.longitude != null
          ? { latitude: selected.latitude, longitude: selected.longitude, accuracy: selected.accuracy, altitude: null }
          : null;
      const summary = await recordSession(selected.slot_id, got, legacy, getUserProfile()?.email ?? null);
      setSamples(got);
      setSession(summary);
      setPhase("review");
      await refreshLocal();
      void sync(true);
    } catch (e) {
      setPhase("idle");
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      abortRef.current = null;
    }
  };

  const savePosition = async () => {
    if (!session || !selected) return;
    try {
      await saveSlotPosition(session.session_id, selected.slot_id, samples);
      const res = navigator.onLine ? await syncPendingSubmissions() : null;
      setMessage({
        kind: "ok",
        text: res && res.failed === 0 ? `Position of ${selected.slot_id} updated.` : `Position of ${selected.slot_id} saved on this phone; it will sync when online.`,
      });
      setPhase("idle");
      await refreshLocal();
      void load();
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const sync = async (quiet = false) => {
    setSyncing(true);
    const r = await syncObservations();
    setSyncing(false);
    setPending(r.remaining);
    if (r.error && !(quiet && r.error === "Offline")) setMessage({ kind: "warn", text: `Readings kept on this phone: ${r.error}` });
    else if (!quiet && r.uploaded) setMessage({ kind: "ok", text: `${r.uploaded} readings uploaded.` });
  };

  const download = async () => {
    const url = URL.createObjectURL(new Blob([await exportQueueCsv()], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `gps-observations-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 lg:p-0">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <Satellite className="h-6 w-6 text-emerald-600" />
            <h1 className="text-xl font-bold text-slate-900">GPS Re-capture</h1>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {SESSION_FIXES} readings per plant give a far more reliable position than one fix
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={() => sync(false)}
            disabled={syncing || pending === 0}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <CloudUpload className={`h-3.5 w-3.5 ${syncing ? "animate-pulse text-emerald-600" : ""}`} />
            {pending} reading{pending === 1 ? "" : "s"} to upload
          </button>
          <button
            onClick={download}
            disabled={pending === 0}
            title="Download readings not yet uploaded"
            className="rounded-lg border border-slate-300 bg-slate-50 p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {loadError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Could not load plants: {loadError}
        </div>
      )}
      {message && (
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
            message.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : message.kind === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {message.kind === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          {message.text}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {/* Slot + capture */}
          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">Plant slot (from the tag)</label>
              <input
                list="slot-ids"
                value={slotId}
                onChange={(e) => {
                  setSlotId(e.target.value.trim().toUpperCase());
                  setPhase("idle");
                }}
                disabled={phase === "capturing"}
                placeholder="e.g. D01-P007"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:bg-white focus:outline-none"
              />
              <datalist id="slot-ids">
                {slots.map((s) => (
                  <option key={s.slot_id} value={s.slot_id} />
                ))}
              </datalist>
              {selected && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11px] text-slate-500">
                  <span>Plant {selected.plant_id}</span>
                  <span>
                    Stored: {selected.accuracy != null ? `±${Math.round(selected.accuracy)} m` : "no position"}
                    {selected.reason && <span className="ml-1 text-orange-600">({selected.reason})</span>}
                  </span>
                  <span>Sessions on this phone: {sessionsBySlot.get(selected.slot_id)?.length ?? 0}</span>
                </p>
              )}
              {slotId && !selected && !loading && <p className="mt-1.5 text-[11px] text-red-600">Unknown slot.</p>}
            </div>

            {phase === "capturing" ? (
              <div className="space-y-3 text-center">
                <p className="flex items-center justify-center gap-2 text-sm font-semibold text-slate-800">
                  <Crosshair className="h-5 w-5 animate-pulse text-emerald-600" />
                  Stand at the plant and hold still… {samples.length}/{SESSION_FIXES}
                </p>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full bg-emerald-600 transition-all" style={{ width: `${(samples.length / SESSION_FIXES) * 100}%` }} />
                </div>
                {samples.at(-1) && <p className="text-xs text-slate-500">Last reading ±{samples.at(-1)!.accuracy.toFixed(1)} m</p>}
                <Scatter samples={samples} stored={selected} />
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Stop and use {samples.length} readings
                </button>
              </div>
            ) : (
              <button
                onClick={start}
                disabled={!selected || loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 py-4 text-base font-bold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
              >
                <LocateFixed className="h-5 w-5" />
                {phase === "review" ? "Capture again" : `Take ${SESSION_FIXES} readings`}
              </button>
            )}
            <p className="text-[10px] text-slate-400">
              Tip: hold the phone at chest height beside the vine, screen up. For the GPS study take two sessions per
              plant at different times of day.
            </p>
          </section>

          {phase === "review" && session && selected && (
            <SessionReview samples={samples} session={session} stored={selected} onSave={savePosition} />
          )}
        </div>

        {/* Re-capture list */}
        <aside className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-xs shadow-sm lg:max-h-[75vh] lg:overflow-y-auto">
          <div className="flex items-center justify-between">
            <p className="font-bold text-slate-900">Needs re-capture ({todo.length})</p>
            <button onClick={load} disabled={loading} className="rounded p-1 text-slate-400 hover:bg-slate-100" title="Refresh">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
          <p className="text-[10px] text-slate-400">Worst stored position first. Tick = position re-captured on this phone.</p>
          <ul className="space-y-1">
            {todo.map((s) => {
              const done = sessionsBySlot.get(s.slot_id)?.some((x) => x.position_saved);
              return (
                <li key={s.slot_id}>
                  <button
                    onClick={() => {
                      setSlotId(s.slot_id);
                      setPhase("idle");
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left ${
                      s.slot_id === slotId ? "bg-emerald-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      {done ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <MapPin className="h-3.5 w-3.5 text-orange-500" />}
                      <span className="font-mono text-slate-800">{s.slot_id}</span>
                    </span>
                    <span className="text-[10px] text-slate-400">{s.reason}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Link href="/digital-twin" className="block pt-2 text-[11px] font-semibold text-emerald-700 hover:underline">
            View on the map →
          </Link>
        </aside>
      </div>
    </div>
  );
}

function SessionReview({
  samples,
  session,
  stored,
  onSave,
}: {
  samples: ObsSample[];
  session: SessionSummary;
  stored: SlotInfo;
  onSave: () => void;
}) {
  const d = dispersion(samples);
  const ok = isAcceptable(d);
  const best = estimate(samples, "weighted_mean");
  const moved = stored.latitude != null && stored.longitude != null ? distanceM(best, { latitude: stored.latitude, longitude: stored.longitude }) : null;

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-xs shadow-sm">
      <div className="flex items-center justify-between">
        <p className="font-bold text-slate-900">Session result · {session.n} readings</p>
        <span
          className={`flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold ${
            ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"
          }`}
        >
          {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {ok ? "Good enough to store" : "Too scattered"}
        </span>
      </div>

      <Scatter samples={samples} stored={stored} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="CEP50" value={`${d.cep50.toFixed(1)} m`} hint="half the readings within" />
        <Stat label="CEP95" value={`${d.cep95.toFixed(1)} m`} hint={`must be ≤ ${ACCEPT_CEP95_M} m`} bad={d.cep95 > ACCEPT_CEP95_M} />
        <Stat label="RMS" value={`${d.rms.toFixed(1)} m`} hint="spread from the mean" />
        <Stat
          label="Phone accuracy"
          value={`±${d.medianReportedAccuracy.toFixed(1)} m`}
          hint={`median, must be ≤ ${ACCEPT_MEDIAN_ACCURACY_M} m`}
          bad={d.medianReportedAccuracy > ACCEPT_MEDIAN_ACCURACY_M}
        />
      </div>

      <table className="w-full text-left text-[11px]">
        <thead className="text-slate-400">
          <tr>
            <th className="font-medium">Estimate</th>
            <th className="font-medium">Offset from weighted mean</th>
            {moved != null && <th className="font-medium">From stored position</th>}
          </tr>
        </thead>
        <tbody>
          {ESTIMATORS.map((m) => {
            const e = estimate(samples, m);
            return (
              <tr key={m} className="border-t border-slate-100">
                <td className="py-1 text-slate-600">{ESTIMATOR_LABELS[m]}</td>
                <td className="py-1 font-semibold text-slate-800">{distanceM(e, best).toFixed(1)} m</td>
                {moved != null && (
                  <td className="py-1 text-slate-600">
                    {distanceM(e, { latitude: stored.latitude as number, longitude: stored.longitude as number }).toFixed(1)} m
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {ok ? (
        <button onClick={onSave} className="w-full rounded-lg bg-emerald-700 py-2.5 text-sm font-bold text-white hover:bg-emerald-800">
          Save as plant position{moved != null && ` (moves it ${moved.toFixed(0)} m)`}
        </button>
      ) : (
        <p className="rounded-lg bg-amber-50 p-2.5 text-amber-900">
          Readings were saved for the GPS study, but the plant position was not changed. Move out from under dense canopy
          for a moment, wait for the GPS to settle, and capture again.
        </p>
      )}
    </section>
  );
}

function Stat({ label, value, hint, bad }: { label: string; value: string; hint: string; bad?: boolean }) {
  return (
    <div className={`rounded-lg border p-2 ${bad ? "border-amber-200 bg-amber-50" : "border-slate-100 bg-slate-50/60"}`}>
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className={`text-sm font-bold ${bad ? "text-amber-800" : "text-slate-800"}`}>{value}</p>
      <p className="text-[9px] text-slate-400">{hint}</p>
    </div>
  );
}

/** Readings around their mean, with distance rings; the stored position is shown when in range. */
function Scatter({ samples, stored }: { samples: ObsSample[]; stored: SlotInfo | null }) {
  if (!samples.length) return <div className="mx-auto h-48 w-48 rounded-full border border-dashed border-slate-200" />;
  const c = estimate(samples, "mean");
  const pts = samples.map((s) => toLocal(s, c));
  const storedXY = stored?.latitude != null && stored.longitude != null ? toLocal({ latitude: stored.latitude, longitude: stored.longitude }, c) : null;
  const reach = Math.max(5, ...pts.map(([x, y]) => Math.hypot(x, y))) * 1.15;
  const storedIn = storedXY && Math.hypot(...storedXY) <= reach;
  const S = 96 / reach; // svg units per metre (radius 96)
  const rings = [1, 2, 5, 10, 20, 50].filter((r) => r <= reach);
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="-100 -100 200 200" className="h-48 w-48">
        {rings.map((r) => (
          <g key={r}>
            <circle r={r * S} fill="none" stroke="#e2e8f0" strokeDasharray="2 2" />
            <text x={r * S * 0.71 + 2} y={-r * S * 0.71} fontSize="8" fill="#94a3b8">
              {r} m
            </text>
          </g>
        ))}
        <line x1="-4" x2="4" stroke="#047857" />
        <line y1="-4" y2="4" stroke="#047857" />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x * S} cy={-y * S} r="3.5" fill="#10b981" fillOpacity="0.75" stroke="#065f46" strokeWidth="0.5" />
        ))}
        {storedIn && <rect x={storedXY![0] * S - 4} y={-storedXY![1] * S - 4} width="8" height="8" fill="#f97316" />}
      </svg>
      <p className="text-[10px] text-slate-400">
        Green = readings, + = their mean
        {storedXY && (storedIn ? ", orange = stored position" : `, stored position is ${Math.hypot(...storedXY).toFixed(0)} m away`)}
      </p>
    </div>
  );
}
