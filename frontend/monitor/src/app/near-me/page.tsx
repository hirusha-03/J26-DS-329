"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Crosshair,
  Download,
  FlaskConical,
  History,
  LocateFixed,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  STATUS_COLOURS,
  STATUS_LABELS,
  fetchPlantRows,
  historyOf,
  isGpsFix,
  toPlantView,
  type DataSource,
  type InspectionRecord,
  type PlantView,
} from "@/lib/plantStatus";
import {
  RADIUS_OPTIONS_M,
  TOP_K_OPTIONS,
  candidatesWithin,
  captureFix,
  rankPlants,
  type Candidate,
  type Fix,
} from "@/lib/retrieval";
import {
  addRecord,
  clearRecords,
  intendedRank,
  listRecords,
  setConfirmed,
  toCsv,
  type RetrievalRecord,
} from "@/lib/retrievalLog";
import { getSetting, saveSetting } from "@/lib/offline-db";

// Capture stops once this many samples are at least this accurate, or after MAX_WAIT_MS.
const TARGET_ACCURACY_M = 5;
const TARGET_SAMPLES = 5;
const MAX_WAIT_MS = 15_000;

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

const fmtAgo = (iso: string | null) => {
  if (!iso) return "unknown";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
};

interface Result {
  fix: Fix;
  ranked: Candidate[];
  record: RetrievalRecord;
}

export default function NearMePage() {
  const [plants, setPlants] = useState<PlantView[]>([]);
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [source, setSource] = useState<DataSource | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [radius, setRadius] = useState<number>(5);
  const [k, setK] = useState<number>(3);
  const [trialMode, setTrialMode] = useState(false);
  const [intendedId, setIntendedId] = useState("");

  const [phase, setPhase] = useState<"idle" | "locating" | "done">("idle");
  const [live, setLive] = useState<{ n: number; best: number | null }>({ n: 0, best: null });
  const [result, setResult] = useState<Result | null>(null);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  const [trials, setTrials] = useState<RetrievalRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchPlantRows();
      const now = Date.now();
      setPlants(res.rows.map((r) => toPlantView(r, now)));
      setInspections(res.inspections);
      setSource(res.source);
      setSavedAt(res.savedAt);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(async () => {
      const [r, kk] = await Promise.all([getSetting("retrieval_radius_m"), getSetting("retrieval_k")]);
      if (typeof r === "number") setRadius(r);
      if (typeof kk === "number") setK(kk);
      setTrials((await listRecords()).filter((t) => t.mode === "trial"));
      await load();
    });
  }, [load]);

  const located = useMemo(() => plants.filter((p) => p.latitude != null && p.longitude != null), [plants]);
  // Trials measure retrieval accuracy, so they use field GPS fixes only; estimated positions would bias recall.
  const gpsLocated = useMemo(() => located.filter(isGpsFix), [located]);

  const chooseRadius = (r: number) => {
    setRadius(r);
    void saveSetting("retrieval_radius_m", r);
  };
  const chooseK = (v: number) => {
    setK(v);
    void saveSetting("retrieval_k", v);
  };

  const locate = async () => {
    if (trialMode && !gpsLocated.some((p) => p.plant_id === intendedId)) {
      setLocateError("Field trial: first pick the GPS-tagged plant you are standing at.");
      return;
    }
    setLocateError(null);
    setResult(null);
    setConfirmedId(null);
    setLive({ n: 0, best: null });
    setPhase("locating");
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const fix = await captureFix({
        targetAccuracyM: TARGET_ACCURACY_M,
        targetSamples: TARGET_SAMPLES,
        maxWaitMs: MAX_WAIT_MS,
        signal: ac.signal,
        onSample: (_s, all) => setLive({ n: all.length, best: Math.min(...all.map((x) => x.accuracy)) }),
      });
      const t0 = performance.now();
      const ranked = rankPlants(fix, trialMode ? gpsLocated : plants);
      const computeMs = Math.round((performance.now() - t0) * 10) / 10;
      const record = await addRecord({
        mode: trialMode ? "trial" : "use",
        intended_plant_id: trialMode ? intendedId : null,
        confirmed_plant_id: null,
        radius_m: radius,
        k,
        fix: { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, samples: fix.samples.length },
        raw_samples: fix.samples,
        fix_ms: fix.elapsedMs,
        compute_ms: computeMs,
        ranked,
      });
      if (trialMode) setTrials((t) => [...t, record]);
      setResult({ fix, ranked, record });
      setPhase("done");
    } catch (e) {
      setLocateError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    } finally {
      abortRef.current = null;
    }
  };

  const confirm = async (plantId: string) => {
    setConfirmedId(plantId);
    if (result) await setConfirmed(result.record.id, plantId);
  };

  const exportTrials = async () => {
    const csv = toCsv(await listRecords());
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `retrieval-trials-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetTrials = async () => {
    if (!window.confirm("Delete all logged retrieval attempts on this device?")) return;
    await clearRecords();
    setTrials([]);
  };

  const candidates = result ? candidatesWithin(result.ranked, radius, k) : [];
  const outside = result
    ? result.ranked.filter((c) => !candidates.includes(c)).slice(0, 3)
    : [];
  const confirmed = confirmedId ? plants.find((p) => p.plant_id === confirmedId) ?? null : null;
  const trialRank = result && trialMode ? intendedRank(result.record) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 lg:p-0">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <LocateFixed className="h-6 w-6 text-emerald-600" />
            <h1 className="text-xl font-bold text-slate-900">Near Me</h1>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Find the plant you are standing at and open its history ·{" "}
            <Link href="/gps-capture" className="font-semibold text-emerald-700 hover:underline">
              Re-capture plant GPS
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 font-semibold ${
              source === "supabase"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            {source === "supabase" ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {source === "supabase" ? "Online" : source ? "Offline copy" : "Loading"}
            {savedAt && <span className="font-normal">· saved {fmtAgo(savedAt)}</span>}
          </span>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin text-emerald-600" : ""}`} />
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </header>

      {loadError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Could not load plants: {loadError}. Open this page once while online to save a copy.</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {/* Locate */}
          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            {trialMode && (
              <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs">
                <label className="mb-1 block font-semibold text-violet-900">Plant you are standing at</label>
                <input
                  list="plant-ids"
                  value={intendedId}
                  onChange={(e) => setIntendedId(e.target.value.trim().toUpperCase())}
                  placeholder="Read it from the plant tag, e.g. B02-P005-G1"
                  className="w-full rounded-md border border-violet-200 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-violet-500 focus:outline-none"
                />
                <datalist id="plant-ids">
                  {gpsLocated.map((p) => (
                    <option key={p.plant_id} value={p.plant_id} />
                  ))}
                </datalist>
              </div>
            )}

            {phase === "locating" ? (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <Crosshair className="h-10 w-10 animate-pulse text-emerald-600" />
                <p className="text-sm font-semibold text-slate-800">Getting your position… hold still</p>
                <p className="text-xs text-slate-500">
                  {live.n} reading{live.n === 1 ? "" : "s"}
                  {live.best != null && <> · best ±{live.best.toFixed(1)} m</>} · stops at {TARGET_SAMPLES} readings within ±
                  {TARGET_ACCURACY_M} m or after {MAX_WAIT_MS / 1000} s
                </p>
                <button
                  onClick={() => abortRef.current?.abort()}
                  disabled={live.n === 0}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  Use current position now
                </button>
              </div>
            ) : (
              <button
                onClick={locate}
                disabled={loading || !located.length}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 py-4 text-base font-bold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
              >
                <LocateFixed className="h-5 w-5" />
                {phase === "done" ? "Locate again" : "Find plants near me"}
              </button>
            )}

            {locateError && (
              <p className="flex items-start gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {locateError}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold">Radius</span>
                {RADIUS_OPTIONS_M.map((r) => (
                  <button
                    key={r}
                    onClick={() => chooseRadius(r)}
                    className={`rounded-md px-2 py-1 ${radius === r ? "bg-emerald-700 text-white" : "bg-slate-100 hover:bg-slate-200"}`}
                  >
                    {r} m
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-semibold">Show</span>
                {TOP_K_OPTIONS.map((v) => (
                  <button
                    key={v}
                    onClick={() => chooseK(v)}
                    className={`rounded-md px-2 py-1 ${k === v ? "bg-emerald-700 text-white" : "bg-slate-100 hover:bg-slate-200"}`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-slate-400">
              {located.length} of {plants.length} plants have a stored GPS position. Radius and number shown are being tested
              in field trials; final values come from those results.
            </p>
          </section>

          {/* Results */}
          {result && (
            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <span>
                  Your position ±{result.fix.accuracy.toFixed(1)} m · {result.fix.samples.length} readings ·{" "}
                  {(result.fix.elapsedMs / 1000).toFixed(1)} s
                </span>
                <span>matched in {result.record.compute_ms} ms</span>
              </div>

              {result.fix.accuracy > radius && (
                <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  GPS is ±{result.fix.accuracy.toFixed(0)} m, wider than the {radius} m radius. Check the tag on the plant
                  before choosing.
                </p>
              )}

              {trialMode && (
                <p
                  className={`rounded-lg p-2.5 text-xs font-semibold ${
                    candidates.some((c) => c.plant.plant_id === intendedId)
                      ? "bg-emerald-50 text-emerald-800"
                      : "bg-red-50 text-red-700"
                  }`}
                >
                  Trial: {intendedId}{" "}
                  {trialRank
                    ? `is #${trialRank} nearest at ${result.record.nearest[trialRank - 1].distance_m} m`
                    : "is not among the 10 nearest"}
                  {candidates.some((c) => c.plant.plant_id === intendedId) ? " — found" : " — missed with these settings"}
                </p>
              )}

              {candidates.length === 0 && (
                <p className="text-sm text-slate-600">No GPS-tagged plant within {radius} m.</p>
              )}

              <ul className="space-y-2">
                {candidates.map((c, i) => (
                  <CandidateRow key={c.plant.plant_id} c={c} rank={i + 1} confirmed={confirmedId} onConfirm={confirm} />
                ))}
              </ul>

              {outside.length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Nearest outside {radius} m
                  </p>
                  <ul className="space-y-1 opacity-70">
                    {outside.map((c) => (
                      <CandidateRow key={c.plant.plant_id} c={c} confirmed={confirmedId} onConfirm={confirm} compact />
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>

        {/* Right: confirmed plant + trials */}
        <aside className="space-y-4">
          {confirmed ? (
            <PlantHistoryCard plant={confirmed} history={historyOf(inspections, confirmed.plant_id)} onClose={() => setConfirmedId(null)} />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-center text-xs text-slate-500 shadow-sm">
              <History className="mx-auto mb-2 h-8 w-8 stroke-1 text-slate-300" />
              Pick your plant from the list to see its inspection history, even offline.
            </div>
          )}

          <TrialPanel
            trialMode={trialMode}
            setTrialMode={setTrialMode}
            trials={trials}
            onExport={exportTrials}
            onClear={resetTrials}
          />
        </aside>
      </div>
    </div>
  );
}

function CandidateRow({
  c,
  rank,
  confirmed,
  onConfirm,
  compact,
}: {
  c: Candidate;
  rank?: number;
  confirmed: string | null;
  onConfirm: (id: string) => void;
  compact?: boolean;
}) {
  const p = c.plant;
  const isConfirmed = confirmed === p.plant_id;
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border ${compact ? "p-2" : "p-3"} ${
        isConfirmed ? "border-emerald-400 bg-emerald-50" : "border-slate-200"
      }`}
    >
      {rank != null && (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">
          {rank}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className={`truncate font-mono font-bold text-slate-900 ${compact ? "text-xs" : "text-sm"}`}>{p.plant_id}</p>
        <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOURS[p.status] }} />
          {STATUS_LABELS[p.status]} · inspected {fmtDate(p.last_inspection_date)}
        </p>
      </div>
      <span className="shrink-0 text-right">
        <span className={`block font-bold text-slate-800 ${compact ? "text-xs" : "text-base"}`}>{c.distanceM.toFixed(1)} m</span>
        {p.accuracy != null && <span className="block text-[10px] text-slate-400">tag ±{Math.round(p.accuracy)} m</span>}
      </span>
      <button
        onClick={() => onConfirm(p.plant_id)}
        className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold ${
          isConfirmed ? "bg-emerald-700 text-white" : "border border-emerald-600 text-emerald-700 hover:bg-emerald-50"
        }`}
      >
        {isConfirmed ? <CheckCircle2 className="h-4 w-4" /> : "This one"}
      </button>
    </li>
  );
}

function PlantHistoryCard({ plant, history, onClose }: { plant: PlantView; history: InspectionRecord[]; onClose: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-xs shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Plant history</span>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div>
        <h3 className="font-mono text-lg font-bold text-slate-900">{plant.plant_id}</h3>
        <p className="mt-0.5 flex items-center gap-1.5 text-slate-600">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOURS[plant.status] }} />
          {STATUS_LABELS[plant.status]} · Zone {plant.zone ?? "—"} · Block {plant.block ?? "—"}
        </p>
      </div>

      {history.length === 0 ? (
        <p className="rounded-lg bg-slate-50 p-3 text-slate-500">No inspections recorded yet.</p>
      ) : (
        <ol className="max-h-80 space-y-2 overflow-y-auto">
          {history.map((h, i) => (
            <li key={`${h.inspection_date}-${i}`} className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
              <p className="font-semibold text-slate-800">{fmtDate(h.inspection_date)}</p>
              <dl className="mt-1 grid grid-cols-3 gap-x-2 gap-y-1 text-[11px] text-slate-600">
                <Metric label="Foliage" value={h.foliage_color} />
                <Metric label="pH" value={h.soil_ph} />
                <Metric label="EC" value={h.soil_ec} />
                <Metric label="Moisture" value={h.moisture} />
                <Metric label="Temp" value={h.temperature != null ? `${h.temperature}°C` : null} />
                <Metric label="Height" value={h.vine_height_cm != null ? `${h.vine_height_cm} cm` : null} />
              </dl>
              {h.notes && <p className="mt-1 text-[11px] italic text-slate-500">{h.notes}</p>}
            </li>
          ))}
        </ol>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Link
          href={`/inspect/form?plant_id=${encodeURIComponent(plant.plant_id)}`}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 font-semibold text-white hover:bg-emerald-800"
        >
          <ClipboardCheck className="h-4 w-4" /> Log inspection
        </Link>
        <Link
          href={`/plant/${encodeURIComponent(plant.plant_id)}`}
          className="flex items-center justify-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 font-semibold text-emerald-800 hover:bg-emerald-100"
        >
          Full record <ChevronRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <dt className="text-[10px] text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-700">{value ?? "—"}</dd>
    </div>
  );
}

/** Field trial mode for the retrieval experiment, with a live recall table over the radius / k grid. */
function TrialPanel({
  trialMode,
  setTrialMode,
  trials,
  onExport,
  onClear,
}: {
  trialMode: boolean;
  setTrialMode: (v: boolean) => void;
  trials: RetrievalRecord[];
  onExport: () => void;
  onClear: () => void;
}) {
  const recall = (radius: number, k: number) => {
    const hits = trials.filter((t) => {
      const r = intendedRank(t);
      return r != null && r <= k && t.nearest[r - 1].distance_m <= radius;
    }).length;
    return trials.length ? Math.round((hits / trials.length) * 100) : null;
  };
  const strictHits = trials.filter((t) => intendedRank(t) === 1).length;

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-xs shadow-sm">
      <label className="flex cursor-pointer items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-bold text-slate-900">
          <FlaskConical className="h-4 w-4 text-violet-600" /> Field trial mode
        </span>
        <input type="checkbox" checked={trialMode} onChange={(e) => setTrialMode(e.target.checked)} className="h-4 w-4 accent-violet-600" />
      </label>
      <p className="text-[11px] text-slate-500">
        Stand at a tagged plant, enter its ID, then locate. Every attempt is saved on this phone with the raw GPS readings.
      </p>

      {trials.length > 0 && (
        <>
          <p className="text-slate-600">
            <strong>{trials.length}</strong> trials · strict nearest correct{" "}
            <strong>{Math.round((strictHits / trials.length) * 100)}%</strong>
          </p>
          <table className="w-full text-center text-[11px]">
            <thead>
              <tr className="text-slate-400">
                <th className="text-left font-medium">Recall</th>
                {TOP_K_OPTIONS.map((v) => (
                  <th key={v} className="font-medium">top {v}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RADIUS_OPTIONS_M.map((r) => (
                <tr key={r} className="border-t border-slate-100">
                  <td className="py-1 text-left text-slate-500">{r} m</td>
                  {TOP_K_OPTIONS.map((v) => (
                    <td key={v} className="py-1 font-semibold text-slate-800">{recall(r, v)}%</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="flex gap-2">
        <button
          onClick={onExport}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Download className="h-3.5 w-3.5" /> Export CSV
        </button>
        <button
          onClick={onClear}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 font-semibold text-red-600 hover:bg-red-50"
          title="Delete logged attempts"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
