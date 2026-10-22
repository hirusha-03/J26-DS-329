// On-device log of retrieval attempts, for the retrieval experiment (E2): recall@k, wrong-plant rate,
// distance error and latency. Each record keeps the raw GPS samples and the 10 nearest plants, so any
// radius / k combination can be scored afterwards from the same walk-up trials.

import { getSetting, saveSetting } from "./offline-db";
import type { Candidate, Fix } from "./retrieval";

const KEY = "retrieval_trials";

export interface RetrievalRecord {
  id: string;
  at: string;
  /** "trial": the tester entered the plant they stand at beforehand; "use": normal field use. */
  mode: "trial" | "use";
  intended_plant_id: string | null;
  confirmed_plant_id: string | null;
  radius_m: number;
  k: number;
  fix: { latitude: number; longitude: number; accuracy: number; samples: number };
  raw_samples: Fix["samples"];
  nearest: { plant_id: string; distance_m: number }[];
  fix_ms: number;
  compute_ms: number;
}

export async function listRecords(): Promise<RetrievalRecord[]> {
  return ((await getSetting(KEY)) as RetrievalRecord[] | null) ?? [];
}

export async function addRecord(r: Omit<RetrievalRecord, "id" | "at" | "nearest"> & { ranked: Candidate[] }) {
  const { ranked, ...rest } = r;
  const record: RetrievalRecord = {
    ...rest,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    nearest: ranked.slice(0, 10).map((c) => ({ plant_id: c.plant.plant_id, distance_m: Math.round(c.distanceM * 100) / 100 })),
  };
  await saveSetting(KEY, [...(await listRecords()), record]);
  return record;
}

export async function setConfirmed(id: string, plantId: string) {
  const all = await listRecords();
  await saveSetting(
    KEY,
    all.map((r) => (r.id === id ? { ...r, confirmed_plant_id: plantId } : r)),
  );
}

export async function clearRecords() {
  await saveSetting(KEY, []);
}

/** Rank (1-based) of the intended plant among the nearest plants, or null if not among them. */
export function intendedRank(r: RetrievalRecord): number | null {
  const i = r.nearest.findIndex((n) => n.plant_id === r.intended_plant_id);
  return i >= 0 ? i + 1 : null;
}

export function toCsv(records: RetrievalRecord[]): string {
  const head = [
    "id", "at", "mode", "intended_plant_id", "confirmed_plant_id", "radius_m", "k",
    "fix_lat", "fix_lng", "fix_accuracy_m", "samples", "fix_ms", "compute_ms",
    "intended_rank", "intended_distance_m", "nearest", "raw_samples",
  ];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = records.map((r) => {
    const rank = intendedRank(r);
    return [
      r.id, r.at, r.mode, r.intended_plant_id, r.confirmed_plant_id, r.radius_m, r.k,
      r.fix.latitude.toFixed(7), r.fix.longitude.toFixed(7), r.fix.accuracy.toFixed(1), r.fix.samples, r.fix_ms, r.compute_ms,
      rank, rank ? r.nearest[rank - 1].distance_m : "",
      r.nearest.map((n) => `${n.plant_id}:${n.distance_m}`).join(";"),
      r.raw_samples.map((s) => `${s.latitude.toFixed(7)}/${s.longitude.toFixed(7)}/${s.accuracy.toFixed(1)}/${s.t}`).join(";"),
    ].map(esc).join(",");
  });
  return [head.join(","), ...rows].join("\n");
}
