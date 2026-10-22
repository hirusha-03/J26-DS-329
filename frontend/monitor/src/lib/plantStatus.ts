// Plant and block status for the Digital Twin map in Vanilla Monitor.

import type { FeatureCollection } from "geojson";
import { BLOCK_RULES, HIDE_ESTIMATED_IN_ZONES, STALE_AFTER_DAYS, VALID_GPS_BOUNDS } from "./mapConfig";
import { supabase } from "./supabaseClient";

export type PlantStatus = "healthy" | "moderate" | "high-risk" | "dead" | "not-inspected";
export type BlockLevel = "good" | "watch" | "concern" | "insufficient" | "no-data";
/** "gps" = field GPS fix; "estimated" = placeholder position that still needs a field fix. */
export type LocationSource = "gps" | "estimated";

export interface PlantRow {
  plant_id: string;
  zone: string | null;
  block: string | null;
  block_id: string | null;
  slot_id?: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  /** From slots.location_source; null when not recorded (e.g. an older offline snapshot). */
  location_source?: LocationSource | null;
  last_inspection_date: string | null;
  foliage_color: string | null;
  soil_ph: number | null;
  moisture: number | null;
  vine_height_cm: number | null;
  notes: string | null;
}

export const isEstimated = (p: Pick<PlantRow, "location_source">) => p.location_source === "estimated";
/** Whether the UI marks the position as estimated (hollow marker, re-capture prompt); see HIDE_ESTIMATED_IN_ZONES. */
export const showAsEstimated = (p: Pick<PlantRow, "location_source" | "zone">) =>
  isEstimated(p) && !HIDE_ESTIMATED_IN_ZONES.includes(p.zone ?? "");
/** Field GPS fix. Analytics and evaluations use only these; estimated or unknown positions would bias them. */
export const isGpsFix = (p: Pick<PlantRow, "location_source">) => p.location_source === "gps";

export interface PlantView extends PlantRow {
  status: PlantStatus;
  daysSinceInspection: number | null;
  stale: boolean;
  /** Set by placeInZones when the map draws the plant away from its recorded position (metres). */
  movedIntoZoneM?: number | null;
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
  /** Every inspection, for plant histories (offline too). */
  inspections: InspectionRecord[];
  /** When the data was downloaded from Supabase (ISO); older for the offline snapshot. */
  savedAt: string | null;
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
  location_source?: string | null;
}
export interface InspectionRecord {
  plant_id: string;
  inspection_date: string | null;
  foliage_color: string | null;
  soil_ph: number | null;
  soil_ec?: number | null;
  moisture: number | null;
  temperature?: number | null;
  humidity?: number | null;
  vine_height_cm: number | null;
  notes: string | null;
}
type RawInspection = InspectionRecord;

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
        slot_id: p.slot_id,
        latitude: fix?.[0] ?? null,
        longitude: fix?.[1] ?? null,
        accuracy: slot?.accuracy != null ? Math.round(Number(slot.accuracy) * 10) / 10 : null,
        location_source:
          slot?.location_source === "gps" || slot?.location_source === "estimated" ? slot.location_source : null,
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

const SNAPSHOT_KEY = "twin_snapshot";

interface TwinSnapshot {
  savedAt: string;
  rows: PlantRow[];
  inspections: InspectionRecord[];
}

/**
 * Loads the twin's plant rows and inspection history. A successful Supabase load is saved on the
 * device as a snapshot; without connectivity that snapshot is used (then the older local tables).
 */
export async function fetchPlantRows(): Promise<FetchResult> {
  if (DEMO_MODE) {
    const res = await fetch("/geo/demo/demo_plants.json");
    if (!res.ok) throw new Error("Demo data not found in public/geo/demo/.");
    return { rows: (await res.json()) as PlantRow[], source: "local_demo", inspections: [], savedAt: null };
  }
  const { getSetting, saveSetting } = await import("./offline-db");
  try {
    const [plants, slots, inspections] = await Promise.all([
      selectAll<RawPlant>("plants", "plant_id, zone, block, slot_id, status, replaced_by_plant_id"),
      selectAll<RawSlot>("slots", "slot_id, latitude, longitude, accuracy, location_source"),
      selectAll<RawInspection>(
        "inspections",
        "plant_id, inspection_date, foliage_color, soil_ph, soil_ec, moisture, temperature, humidity, vine_height_cm, notes",
      ),
    ]);
    const snapshot: TwinSnapshot = {
      savedAt: new Date().toISOString(),
      rows: buildPlantRows(plants, slots, inspections),
      inspections,
    };
    await saveSetting(SNAPSHOT_KEY, snapshot).catch((e: unknown) => console.warn("Twin snapshot not saved.", e));
    return { ...snapshot, source: "supabase" };
  } catch (err) {
    console.warn("Digital Twin: Supabase unavailable, using offline cache.", err);
    const snapshot = (await getSetting(SNAPSHOT_KEY).catch(() => null)) as TwinSnapshot | null;
    if (snapshot?.rows?.length) return { ...snapshot, source: "offline_cache" };
    const rows = await fromOfflineCache();
    if (!rows.length) throw err;
    return { rows, source: "offline_cache", inspections: [], savedAt: null };
  }
}

/** Inspections of one plant, newest first. */
export function historyOf(inspections: InspectionRecord[], plantId: string): InspectionRecord[] {
  return inspections
    .filter((i) => i.plant_id === plantId && i.inspection_date)
    .sort((a, b) => String(b.inspection_date).localeCompare(String(a.inspection_date)));
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

// ── Drawing plants inside their own zone ──────────────────────────────────────

type LngLat = [number, number];

function outerRing(f: FeatureCollection["features"][number]): LngLat[] | null {
  const g = f.geometry;
  if (g?.type === "Polygon") return g.coordinates[0] as LngLat[];
  if (g?.type === "MultiPolygon") return g.coordinates[0][0] as LngLat[];
  return null;
}

/** Ray casting; lng/lat is fine at plantation scale. */
function inRing([x, y]: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringCentroid(ring: LngLat[]): LngLat {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const k = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += k;
    cx += (ring[j][0] + ring[i][0]) * k;
    cy += (ring[j][1] + ring[i][1]) * k;
  }
  return a ? [cx / (3 * a), cy / (3 * a)] : ring[0];
}

/**
 * Display positions: a plant whose recorded position lies outside its own zone outline is drawn inside
 * that zone, next to the block-mates that are inside it (else around the zone's centre), on a small
 * spiral so the moved plants do not overlap. Phone GPS here is about ±70 m while zones B, C and D are
 * 15-36 m apart, so the zone label is more reliable than the fix. Only the map uses these positions;
 * the recorded coordinates (Near Me, GPS studies, analytics) are unchanged.
 */
export function placeInZones<T extends PlantView>(plants: T[], zones: FeatureCollection | null): T[] {
  const rings = new Map<string, LngLat[]>();
  zones?.features.forEach((f) => {
    const ring = outerRing(f);
    if (f.properties?.zone && ring) rings.set(String(f.properties.zone), ring);
  });
  if (!rings.size) return plants;

  const pos = (p: T): LngLat | null => (p.latitude != null && p.longitude != null ? [p.longitude, p.latitude] : null);
  const fits = (p: T) => {
    const ring = p.zone ? rings.get(p.zone) : undefined;
    const at = pos(p);
    return !ring || !at || inRing(at, ring);
  };

  // Anchor per block: median position of its plants already inside the zone.
  const anchors = new Map<string, LngLat>();
  const byBlock = new Map<string, LngLat[]>();
  for (const p of plants) {
    const at = pos(p);
    if (p.block_id && at && p.zone && rings.has(p.zone) && fits(p)) byBlock.set(p.block_id, [...(byBlock.get(p.block_id) ?? []), at]);
  }
  for (const [block, pts] of byBlock) anchors.set(block, [median(pts.map((q) => q[0])), median(pts.map((q) => q[1]))]);

  const used = new Map<string, number>();
  return plants.map((p) => {
    const at = pos(p);
    if (!at || fits(p)) return p;
    const ring = rings.get(p.zone as string) as LngLat[];
    const centre = ringCentroid(ring);
    const key = p.block_id && anchors.has(p.block_id) ? p.block_id : `zone:${p.zone}`;
    const anchor = anchors.get(key) ?? centre;
    const i = used.get(key) ?? 0;
    used.set(key, i + 1);

    const mLat = 111_320;
    const mLng = 111_320 * Math.cos((anchor[1] * Math.PI) / 180);
    const r = 3 * Math.sqrt(i + 1); // metres
    const t = i * 2.39996; // golden angle
    let target: LngLat = [anchor[0] + (r * Math.cos(t)) / mLng, anchor[1] + (r * Math.sin(t)) / mLat];
    for (let k = 1; k <= 10 && !inRing(target, ring); k++) {
      const f = k / 10;
      target = [target[0] + (centre[0] - target[0]) * f, target[1] + (centre[1] - target[1]) * f];
    }
    if (!inRing(target, ring)) target = centre;

    const moved = Math.hypot((target[0] - at[0]) * mLng, (target[1] - at[1]) * mLat);
    return { ...p, longitude: target[0], latitude: target[1], movedIntoZoneM: Math.round(moved) };
  });
}

// ── Approximate layout from GPS (used only until QGIS GeoJSON exists) ──────────

type XY = [number, number];

/** Convex hull (Andrew's monotone chain), open ring. */
function convexHull(points: XY[]): XY[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XY[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: XY[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Keeps the part of `poly` on the side of the line through `m` facing away from `dir`. */
function clipHalfPlane(poly: XY[], m: XY, dir: XY): XY[] {
  const side = (p: XY) => (p[0] - m[0]) * dir[0] + (p[1] - m[1]) * dir[1];
  const out: XY[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if (sa * sb < 0) {
      const t = sa / (sa - sb);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export interface GpsIssue {
  plant_id: string;
  reason: string;
}

export interface ApproxLayout {
  boundary: FeatureCollection | null;
  zones: FeatureCollection | null;
  /** Fixes too poor to place: not drawn, listed for re-capture. */
  unplaced: GpsIssue[];
  /** Drawn, but worth re-capturing (far from their zone, or a fix shared by several plants). */
  doubtful: GpsIssue[];
}

/**
 * Estimates the plantation layout from plant GPS until surveyed GeoJSON exists:
 * - fixes worse than MAX_GPS_ACCURACY_M are network guesses and are not placed;
 * - fixes far from the rest of their zone are left out of the outlines;
 * - the boundary is the padded hull of the remaining fixes;
 * - each zone gets the part of the boundary closest to its plants (no overlaps).
 */
export function buildApproxLayout(
  plants: PlantRow[],
  opts: { paddingM: number; maxAccuracyM: number; outlierM: number },
): ApproxLayout {
  const located = plants.filter((p) => p.latitude != null && p.longitude != null);
  const unplaced: GpsIssue[] = [];
  const doubtful: GpsIssue[] = [];
  const placed = located.filter((p) => {
    if (p.accuracy != null && p.accuracy > opts.maxAccuracyM) {
      unplaced.push({ plant_id: p.plant_id, reason: `GPS accuracy ±${Math.round(p.accuracy)} m` });
      return false;
    }
    return true;
  });

  const shared = new Map<string, string[]>();
  for (const p of placed) {
    const key = `${p.latitude},${p.longitude}`;
    shared.set(key, [...(shared.get(key) ?? []), p.plant_id]);
  }
  for (const ids of shared.values()) {
    if (ids.length > 1) ids.forEach((id) => doubtful.push({ plant_id: id, reason: `same GPS fix as ${ids.length - 1} other plant${ids.length > 2 ? "s" : ""}` }));
  }
  if (!placed.length) return { boundary: null, zones: null, unplaced, doubtful };

  // Local metric frame (metres east / north of the median fix).
  const lat0 = median(placed.map((p) => p.latitude as number));
  const lng0 = median(placed.map((p) => p.longitude as number));
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const toXY = (p: PlantRow): XY => [((p.longitude as number) - lng0) * mx, ((p.latitude as number) - lat0) * 111_320];
  const toLngLat = ([x, y]: XY): XY => [lng0 + x / mx, lat0 + y / 111_320];

  // A fix is isolated when no other fix of its zone (at a different spot) lies within outlierM.
  const used: XY[] = [];
  const zones = new Map<string, XY[]>();
  for (const p of placed) {
    const xy = toXY(p);
    const gaps = placed
      .filter((q) => q.zone === p.zone && (q.latitude !== p.latitude || q.longitude !== p.longitude))
      .map((q) => {
        const o = toXY(q);
        return Math.hypot(o[0] - xy[0], o[1] - xy[1]);
      });
    const nearest = gaps.length ? Math.min(...gaps) : Infinity;
    if (p.zone && nearest > opts.outlierM) {
      doubtful.push({
        plant_id: p.plant_id,
        reason: Number.isFinite(nearest) ? `${Math.round(nearest)} m from any other zone ${p.zone} plant` : "only fix in its zone",
      });
      continue;
    }
    used.push(xy);
    if (p.zone) zones.set(p.zone, [...(zones.get(p.zone) ?? []), xy]);
  }
  if (used.length < 3) return { boundary: null, zones: null, unplaced, doubtful };
  const centres = new Map<string, XY>();
  for (const [zone, pts] of zones) centres.set(zone, [median(pts.map((q) => q[0])), median(pts.map((q) => q[1]))]);

  // Boundary: hull of the fixes, each grown into a small circle so the margin is even.
  const grown: XY[] = [];
  for (const [x, y] of used) {
    for (let k = 0; k < 16; k++) {
      const t = (k / 16) * 2 * Math.PI;
      grown.push([x + opts.paddingM * Math.cos(t), y + opts.paddingM * Math.sin(t)]);
    }
  }
  const hull = convexHull(grown);
  const ring = (pts: XY[]) => [...pts.map(toLngLat), toLngLat(pts[0])];
  const boundary: FeatureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { approximate: true }, geometry: { type: "Polygon", coordinates: [ring(hull)] } }],
  };

  // Zones: split the boundary between zone centres (each point goes to the nearest zone).
  const zoneFeatures: FeatureCollection["features"] = [];
  for (const [zone, c] of [...centres.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let cell = hull;
    for (const [other, o] of centres) {
      if (other === zone) continue;
      cell = clipHalfPlane(cell, [(c[0] + o[0]) / 2, (c[1] + o[1]) / 2], [o[0] - c[0], o[1] - c[1]]);
      if (cell.length < 3) break;
    }
    if (cell.length >= 3) {
      // Distinct GPS spots behind this outline: with only a few, its shape is a rough guess.
      const spots = new Set((zones.get(zone) ?? []).map(([x, y]) => `${x},${y}`)).size;
      zoneFeatures.push({ type: "Feature", properties: { zone, approximate: true, spots }, geometry: { type: "Polygon", coordinates: [ring(cell)] } });
    }
  }

  return {
    boundary,
    zones: { type: "FeatureCollection", features: zoneFeatures },
    unplaced,
    doubtful,
  };
}
