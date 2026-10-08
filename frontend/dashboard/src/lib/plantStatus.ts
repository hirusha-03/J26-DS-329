// Plant and block status for the Digital Twin map.
//
// Status = rule-based reading of each plant's LATEST inspection. It is a
// periodic snapshot (updated when an inspection is synced), not a live or
// predicted value. The rule mirrors frontend/monitor (deriveHealth) so both
// apps show the same status. Replace with model output later.

import type { FeatureCollection } from "geojson";
import { BLOCK_RULES, STALE_AFTER_DAYS } from "./mapConfig";
import { supabase } from "./supabase";

export type PlantStatus = "healthy" | "moderate" | "high-risk" | "dead" | "not-inspected";
export type BlockLevel = "good" | "watch" | "concern" | "insufficient" | "no-data";

/** One row of the Supabase view `plant_latest_status` (Guide step 6). */
export interface PlantRow {
  plant_id: string;
  zone: string | null;
  block: string | null;
  block_id: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  last_inspection_date: string | null;
  foliage_color: string | null;
  soil_ph: number | null;
  moisture: number | null;
  vine_height_cm: number | null;
  notes: string | null;
}

export interface PlantView extends PlantRow {
  status: PlantStatus;
  daysSinceInspection: number | null;
  stale: boolean;
}

export interface BlockSummary {
  block_id: string;
  planted: number; // from blocks.geojson `planted_count`, else plants registered in the app
  registered: number;
  located: number; // have GPS
  inspected: number;
  counts: Record<PlantStatus, number>;
  riskShare: number | null; // (high-risk + dead) / inspected
  coverage: number | null; // inspected / planted
  level: BlockLevel;
  lastInspection: string | null;
}

export const STATUS_COLOURS: Record<PlantStatus, string> = {
  healthy: "#22c55e",
  moderate: "#f59e0b",
  "high-risk": "#ea580c",
  dead: "#b91c1c",
  "not-inspected": "#9ca3af",
};

export const STATUS_LABELS: Record<PlantStatus, string> = {
  healthy: "Healthy",
  moderate: "Moderate",
  "high-risk": "High risk",
  dead: "Dead",
  "not-inspected": "Not inspected",
};

export const BLOCK_COLOURS: Record<BlockLevel, string> = {
  good: "#22c55e",
  watch: "#facc15",
  concern: "#dc2626",
  insufficient: "#9ca3af",
  "no-data": "#6b7280",
};

export const BLOCK_LABELS: Record<BlockLevel, string> = {
  good: "Mostly healthy",
  watch: "Watch",
  concern: "Concern",
  insufficient: "Insufficient data",
  "no-data": "No inspections",
};

const DAY_MS = 86_400_000;

/** Same thresholds as the field app's deriveHealth(). */
export function deriveStatus(row: PlantRow): PlantStatus {
  if (!row.last_inspection_date) return "not-inspected";
  const f = row.foliage_color;
  const ph = row.soil_ph;
  if (f === "Red") return "dead";
  if (f === "Brown" || (ph != null && (ph < 5.5 || ph > 7.0))) return "high-risk";
  if (f === "Yellow" || f === "Mixed" || (ph != null && ((ph >= 5.5 && ph < 6.0) || (ph > 6.5 && ph <= 7.0))))
    return "moderate";
  return "healthy";
}

export function toPlantView(row: PlantRow, now: number): PlantView {
  const days = row.last_inspection_date
    ? Math.floor((now - new Date(row.last_inspection_date).getTime()) / DAY_MS)
    : null;
  return {
    ...row,
    status: deriveStatus(row),
    daysSinceInspection: days,
    stale: days != null && days > STALE_AFTER_DAYS,
  };
}

const emptyCounts = (): Record<PlantStatus, number> => ({
  healthy: 0,
  moderate: 0,
  "high-risk": 0,
  dead: 0,
  "not-inspected": 0,
});

export function summariseBlocks(
  plants: PlantView[],
  plantedCount: Record<string, number>,
): Record<string, BlockSummary> {
  const out: Record<string, BlockSummary> = {};
  const ids = new Set([...Object.keys(plantedCount), ...plants.map((p) => p.block_id).filter(Boolean)]);

  for (const id of ids as Set<string>) {
    const inBlock = plants.filter((p) => p.block_id === id);
    const counts = emptyCounts();
    inBlock.forEach((p) => counts[p.status]++);
    const inspected = inBlock.length - counts["not-inspected"];
    const planted = plantedCount[id] || inBlock.length;
    const riskShare = inspected ? (counts["high-risk"] + counts.dead) / inspected : null;
    const coverage = planted ? inspected / planted : null;

    let level: BlockLevel;
    if (inspected === 0) level = "no-data";
    else if (inspected < BLOCK_RULES.minInspectedPlants || (coverage ?? 0) < BLOCK_RULES.minCoverage)
      level = "insufficient";
    else if ((riskShare ?? 0) >= BLOCK_RULES.concernShare) level = "concern";
    else if ((riskShare ?? 0) >= BLOCK_RULES.watchShare) level = "watch";
    else level = "good";

    const dates = inBlock.map((p) => p.last_inspection_date).filter((d): d is string => !!d).sort();
    out[id] = {
      block_id: id,
      planted,
      registered: inBlock.length,
      located: inBlock.filter((p) => p.latitude != null && p.longitude != null).length,
      inspected,
      counts,
      riskShare,
      coverage,
      level,
      lastInspection: dates.at(-1) ?? null,
    };
  }
  return out;
}

export async function fetchPlantRows(): Promise<PlantRow[]> {
  if (process.env.NEXT_PUBLIC_DEMO) {
    const res = await fetch("/geo/demo_plants.json");
    if (res.ok) return (await res.json()) as PlantRow[];
  }
  if (!supabase) {
    const res = await fetch("/geo/demo_plants.json");
    if (res.ok) return (await res.json()) as PlantRow[];
    throw new Error("Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY).");
  }
  const rows: PlantRow[] = [];
  const page = 1000; // Supabase returns at most 1000 rows per request
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from("plant_latest_status")
      .select("*")
      .range(from, from + page - 1);
    if (error) {
      console.warn("Notice: plant_latest_status view not found or failed, falling back to local geo data:", error.message || error);
      const res = await fetch("/geo/demo_plants.json");
      if (res.ok) return (await res.json()) as PlantRow[];
      throw new Error(error.message || "Failed to fetch from plant_latest_status");
    }
    rows.push(...(data as PlantRow[]));
    if (!data || data.length < page) return rows;
  }
}

export interface PlantationGeo {
  boundary: FeatureCollection | null;
  zones: FeatureCollection | null;
  blocks: FeatureCollection | null;
}

/** Loads the GeoJSON exported from QGIS (Guide step 5). Missing files are tolerated. */
export async function loadGeo(): Promise<PlantationGeo> {
  const get = async (name: string) => {
    const res = await fetch(`/geo/${name}.geojson`);
    return res.ok ? ((await res.json()) as FeatureCollection) : null;
  };
  const [boundary, zones, blocks] = await Promise.all([get("boundary"), get("zones"), get("blocks")]);
  return { boundary, zones, blocks };
}

export function plantedCountsFrom(blocks: FeatureCollection | null): Record<string, number> {
  const out: Record<string, number> = {};
  blocks?.features.forEach((f) => {
    const id = f.properties?.block_id;
    const n = Number(f.properties?.planted_count);
    if (id && Number.isFinite(n) && n > 0) out[id] = n;
  });
  return out;
}
