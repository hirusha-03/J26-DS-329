// Plant and block status for the Digital Twin map in Vanilla Monitor.

import type { FeatureCollection } from "geojson";
import { BLOCK_RULES, STALE_AFTER_DAYS, VALID_GPS_BOUNDS } from "./mapConfig";
import { supabase } from "./supabaseClient";

export type PlantStatus = "healthy" | "moderate" | "high-risk" | "dead" | "not-inspected";
export type BlockLevel = "good" | "watch" | "concern" | "insufficient" | "no-data";

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
  planted: number;
  registered: number;
  located: number;
  inspected: number;
  counts: Record<PlantStatus, number>;
  riskShare: number | null;
  coverage: number | null;
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

export type DataSource = "supabase" | "offline_cache" | "local_demo";

export interface FetchResult {
  rows: PlantRow[];
  source: DataSource;
}

/** Demo mode (NEXT_PUBLIC_DEMO=1): fake plants and shapes from public/geo/demo/. Never use for results. */
export const DEMO_MODE = !!process.env.NEXT_PUBLIC_DEMO;

interface RawPlant {
  plant_id: string;
  zone: string | null;
  block: string | null;
  slot_id: string | null;
  status?: string | null;
  replaced_by_plant_id?: string | null;
}
interface RawSlot {
  slot_id: string;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
}
interface RawInspection {
  plant_id: string;
  inspection_date: string | null;
  foliage_color: string | null;
  soil_ph: number | null;
  moisture: number | null;
  vine_height_cm: number | null;
  notes: string | null;
}

/** Returns [lat, lng] only for a plausible fix inside VALID_GPS_BOUNDS (Add Plant stores 0 when no fix was taken). */
function validFix(lat: unknown, lng: unknown): [number, number] | null {
  if (lat == null || lng == null) return null;
  const y = Number(lat);
  const x = Number(lng);
  const b = VALID_GPS_BOUNDS;
  return y >= b.minLat && y <= b.maxLat && x >= b.minLng && x <= b.maxLng ? [y, x] : null;
}

/**
 * Joins the field app's own tables into one row per active plant:
 * plants -> slots (GPS captured in Add Plant) -> latest inspection.
 */
export function buildPlantRows(plants: RawPlant[], slots: RawSlot[], inspections: RawInspection[]): PlantRow[] {
  const slotById = new Map(slots.map((s) => [s.slot_id, s]));
  const latest = new Map<string, RawInspection>();
  for (const i of inspections) {
    if (!i.plant_id || !i.inspection_date) continue;
    const prev = latest.get(i.plant_id);
    if (!prev || String(i.inspection_date) > String(prev.inspection_date)) latest.set(i.plant_id, i);
  }

  return plants
    .filter((p) => p.plant_id && p.status !== "retired" && !p.replaced_by_plant_id)
    .map((p) => {
      const slot = p.slot_id ? slotById.get(p.slot_id) : undefined;
      const ins = latest.get(p.plant_id);
      const fix = validFix(slot?.latitude, slot?.longitude);
      return {
        plant_id: p.plant_id,
        zone: p.zone,
        block: p.block,
        block_id: p.zone && p.block ? `${p.zone}-${p.block}` : null,
        latitude: fix?.[0] ?? null,
        longitude: fix?.[1] ?? null,
        accuracy: slot?.accuracy != null ? Math.round(Number(slot.accuracy) * 10) / 10 : null,
        last_inspection_date: ins?.inspection_date ?? null,
        foliage_color: ins?.foliage_color ?? null,
        soil_ph: ins?.soil_ph ?? null,
        moisture: ins?.moisture ?? null,
        vine_height_cm: ins?.vine_height_cm ?? null,
        notes: ins?.notes ?? null,
      };
    });
}

/** Reads every row of a table, page by page (Supabase returns at most 1000 rows per request). */
async function selectAll<T>(table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < page) return out;
  }
}

/** Same join from the app's IndexedDB cache, for field use without connectivity. */
async function fromOfflineCache(): Promise<PlantRow[]> {
  const { getPlants, getSlots, getInspections } = await import("./offline-db");
  const [plants, slots, inspections] = await Promise.all([getPlants(), getSlots(), getInspections()]);
  return buildPlantRows(plants, slots, inspections);
}

export async function fetchPlantRows(): Promise<FetchResult> {
  if (DEMO_MODE) {
    const res = await fetch("/geo/demo/demo_plants.json");
    if (!res.ok) throw new Error("Demo data not found in public/geo/demo/.");
    return { rows: (await res.json()) as PlantRow[], source: "local_demo" };
  }
  try {
    const [plants, slots, inspections] = await Promise.all([
      selectAll<RawPlant>("plants", "plant_id, zone, block, slot_id, status, replaced_by_plant_id"),
      selectAll<RawSlot>("slots", "slot_id, latitude, longitude, accuracy"),
      selectAll<RawInspection>(
        "inspections",
        "plant_id, inspection_date, foliage_color, soil_ph, moisture, vine_height_cm, notes",
      ),
    ]);
    return { rows: buildPlantRows(plants, slots, inspections), source: "supabase" };
  } catch (err) {
    console.warn("Digital Twin: Supabase unavailable, using offline cache.", err);
    const rows = await fromOfflineCache();
    if (!rows.length) throw err;
    return { rows, source: "offline_cache" };
  }
}

export interface PlantationGeo {
  boundary: FeatureCollection | null;
  zones: FeatureCollection | null;
  blocks: FeatureCollection | null;
}

/**
 * Loads the boundary / zones / blocks GeoJSON exported from QGIS into public/geo/.
 * Missing files are tolerated: the map then shows plant points only.
 */
export async function loadGeo(): Promise<PlantationGeo> {
  const dir = DEMO_MODE ? "/geo/demo" : "/geo";
  const get = async (name: string) => {
    try {
      const res = await fetch(`${dir}/${name}.geojson`);
      return res.ok ? ((await res.json()) as FeatureCollection) : null;
    } catch {
      return null;
    }
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
