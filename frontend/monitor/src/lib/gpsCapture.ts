// Repeated-fix GPS capture at a plant slot (WS2 / E1). Every raw fix is kept as research data:
// queued on the phone, then uploaded to plant_location_observations when online. Accepted sessions
// also replace the slot's stored position (synced through the app's normal slot queue).

import { getSetting, getSlot, saveSetting, saveSlotOffline } from "./offline-db";
import { supabase } from "./supabaseClient";
import { estimate, dispersion, type Dispersion } from "./gpsStats";

export interface ObsSample {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  /** Device timestamp of the fix (ms since epoch). */
  timestamp: number;
}

/** One row of plant_location_observations. */
export interface ObservationRow {
  id: string;
  slot_id: string;
  session_id: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  captured_at: string;
  device: string | null;
  captured_by: string | null;
}

export interface SessionSummary {
  session_id: string;
  slot_id: string;
  at: string;
  n: number;
  cep50: number;
  cep95: number;
  rms: number;
  median_accuracy: number;
  accepted: boolean;
  position_saved: boolean;
}

const QUEUE_KEY = "gps_observations_pending";
const SESSIONS_KEY = "gps_sessions";
const LEGACY_KEY = "gps_legacy_queued";

/** Fixes per session, minimum spacing between them, and when a session is good enough to store. */
export const SESSION_FIXES = 10;
export const MIN_FIX_INTERVAL_MS = 1000;
export const ACCEPT_CEP95_M = 10;
export const ACCEPT_MEDIAN_ACCURACY_M = 15;

export function isAcceptable(d: Dispersion): boolean {
  return d.n >= SESSION_FIXES && d.cep95 <= ACCEPT_CEP95_M && d.medianReportedAccuracy <= ACCEPT_MEDIAN_ACCURACY_M;
}

/** Accuracy stored with a session's position: its 95% spread, never better than the phone's own estimate. */
export function storedAccuracyM(d: Dispersion): number {
  return Math.round(Math.max(d.cep95, d.medianReportedAccuracy / Math.sqrt(d.n)) * 10) / 10;
}

/** Position to store for a session: accuracy-weighted mean, mean altitude of the fixes that had one. */
export function sessionPosition(samples: ObsSample[]) {
  const best = estimate(samples, "weighted_mean");
  const d = dispersion(samples);
  const altitudes = samples.map((s) => s.altitude).filter((a): a is number => a != null);
  return {
    latitude: best.latitude,
    longitude: best.longitude,
    accuracy: storedAccuracyM(d),
    altitude: altitudes.length ? altitudes.reduce((a, b) => a + b, 0) / altitudes.length : null,
    dispersion: d,
    acceptable: isAcceptable(d),
  };
}

const uuid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

/**
 * Collects `count` fixes at least MIN_FIX_INTERVAL_MS apart (repeated cached positions are skipped).
 * Resolves with what was collected when aborted, rejects if location is unavailable.
 */
export function collectFixes(count: number, onSample: (all: ObsSample[]) => void, signal?: AbortSignal): Promise<ObsSample[]> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("This device has no GPS / location support."));
      return;
    }
    const samples: ObsSample[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      navigator.geolocation.clearWatch(id);
      resolve(samples);
    };
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const last = samples.at(-1);
        if (last && pos.timestamp - last.timestamp < MIN_FIX_INTERVAL_MS) return;
        samples.push({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          timestamp: pos.timestamp,
        });
        onSample([...samples]);
        if (samples.length >= count) finish();
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          done = true;
          navigator.geolocation.clearWatch(id);
          reject(new Error("Location permission was denied. Allow location for this app and try again."));
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    signal?.addEventListener("abort", finish);
  });
}

async function readList<T>(key: string): Promise<T[]> {
  return ((await getSetting(key)) as T[] | null) ?? [];
}

export async function pendingObservationCount(): Promise<number> {
  return (await readList<ObservationRow>(QUEUE_KEY)).length;
}

export async function listSessions(): Promise<SessionSummary[]> {
  return readList<SessionSummary>(SESSIONS_KEY);
}

/**
 * Stores a finished session: all raw fixes go to the upload queue (plus, once per slot, the slot's
 * original single fix as session "legacy-<slot>", for the raw-vs-averaged comparison).
 */
export async function recordSession(
  slotId: string,
  samples: ObsSample[],
  legacy: { latitude: number; longitude: number; accuracy: number | null; altitude: number | null; created_at?: string } | null,
  capturedBy: string | null,
): Promise<SessionSummary> {
  const sessionId = `${slotId}-${new Date().toISOString().replace(/[:.]/g, "")}`;
  const device = typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 200) : null;
  const rows: ObservationRow[] = samples.map((s) => ({
    id: uuid(),
    slot_id: slotId,
    session_id: sessionId,
    latitude: s.latitude,
    longitude: s.longitude,
    altitude: s.altitude,
    accuracy: s.accuracy,
    captured_at: new Date(s.timestamp).toISOString(),
    device,
    captured_by: capturedBy,
  }));

  const legacyDone = await readList<string>(LEGACY_KEY);
  if (legacy && !legacyDone.includes(slotId)) {
    rows.push({
      id: uuid(),
      slot_id: slotId,
      session_id: `legacy-${slotId}`,
      latitude: legacy.latitude,
      longitude: legacy.longitude,
      altitude: legacy.altitude,
      accuracy: legacy.accuracy,
      captured_at: legacy.created_at ?? new Date().toISOString(),
      device: "legacy-single-fix",
      captured_by: null,
    });
    await saveSetting(LEGACY_KEY, [...legacyDone, slotId]);
  }
  await saveSetting(QUEUE_KEY, [...(await readList<ObservationRow>(QUEUE_KEY)), ...rows]);

  const d = dispersion(samples);
  const summary: SessionSummary = {
    session_id: sessionId,
    slot_id: slotId,
    at: new Date().toISOString(),
    n: d.n,
    cep50: d.cep50,
    cep95: d.cep95,
    rms: d.rms,
    median_accuracy: d.medianReportedAccuracy,
    accepted: isAcceptable(d),
    position_saved: false,
  };
  await saveSetting(SESSIONS_KEY, [...(await listSessions()), summary]);
  return summary;
}

/**
 * Replaces the slot's stored position with the session's accuracy-weighted mean. The slot is
 * updated on the phone first (offline-safe) and synced through the existing slot queue.
 */
export async function saveSlotPosition(sessionId: string, slotId: string, samples: ObsSample[]): Promise<void> {
  const pos = sessionPosition(samples);
  let slot = await getSlot(slotId);
  if (!slot) {
    const { data } = await supabase.from("slots").select("*").eq("slot_id", slotId).maybeSingle();
    slot = data;
  }
  if (!slot) throw new Error(`Slot ${slotId} not found on this phone. Open the app online once to download it.`);
  await saveSlotOffline({
    ...slot,
    latitude: pos.latitude,
    longitude: pos.longitude,
    accuracy: pos.accuracy,
    altitude: pos.altitude ?? slot.altitude ?? null,
    sync_status: "pending",
  });
  const sessions = await listSessions();
  await saveSetting(
    SESSIONS_KEY,
    sessions.map((s) => (s.session_id === sessionId ? { ...s, position_saved: true } : s)),
  );
}

/**
 * Uploads queued observations. Rows stay queued when offline or when the table does not exist yet
 * (migration not applied); the reason is returned for display.
 */
export async function syncObservations(): Promise<{ uploaded: number; remaining: number; error: string | null }> {
  const queue = await readList<ObservationRow>(QUEUE_KEY);
  if (!queue.length) return { uploaded: 0, remaining: 0, error: null };
  if (typeof navigator !== "undefined" && !navigator.onLine) return { uploaded: 0, remaining: queue.length, error: "Offline" };

  const table = supabase.from("plant_location_observations");
  let uploaded = 0;
  const kept: ObservationRow[] = [];
  let lastError: string | null = null;
  for (let i = 0; i < queue.length; i += 200) {
    const batch = queue.slice(i, i + 200);
    const { error } = await table.upsert(batch, { onConflict: "id" });
    if (!error) {
      uploaded += batch.length;
      continue;
    }
    if (/does not exist|schema cache|PGRST205|42P01/i.test(`${error.code} ${error.message}`)) {
      await saveSetting(QUEUE_KEY, [...kept, ...queue.slice(i)]);
      return {
        uploaded,
        remaining: kept.length + queue.length - i,
        error: "The plant_location_observations table is not installed yet (run the Module 2 migration).",
      };
    }
    // Retry row by row so one bad row (e.g. a slot not uploaded yet) does not hold back the rest.
    for (const row of batch) {
      const r = await table.upsert(row, { onConflict: "id" });
      if (r.error) {
        kept.push(row);
        lastError =
          r.error.code === "23503" ? "Some readings wait for their new plant slot to sync first." : r.error.message;
      } else uploaded++;
    }
  }
  await saveSetting(QUEUE_KEY, kept);
  return { uploaded, remaining: kept.length, error: lastError };
}

/** All queued + summarised data as CSV, so a session can be analysed even before upload. */
export async function exportQueueCsv(): Promise<string> {
  const rows = await readList<ObservationRow>(QUEUE_KEY);
  const head = ["id", "slot_id", "session_id", "latitude", "longitude", "altitude", "accuracy", "captured_at", "device", "captured_by"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [head.join(","), ...rows.map((r) => head.map((h) => esc(r[h as keyof ObservationRow])).join(","))].join("\n");
}
