// Plant and block status for the Digital Twin map.
//
// Status = rule-based reading of each plant's LATEST inspection. It is a
// periodic snapshot (updated when an inspection is synced), not a live or
// predicted value. The rule mirrors frontend/monitor (deriveHealth) so both
// apps show the same status. Replace with model output later.

import type { FeatureCollection } from "geojson";
import { BLOCK_RULES, STALE_AFTER_DAYS, VALID_GPS_BOUNDS } from "./mapConfig";
import { supabase } from "./supabase";

export type PlantStatus = "healthy" | "moderate" | "high-risk" | "dead" | "not-inspected";
export type BlockLevel = "good" | "watch" | "concern" | "insufficient" | "no-data";
/** "gps" = field GPS fix; "estimated" = placeholder position that still needs a field fix. */
export type LocationSource = "gps" | "estimated" | "smoothed" | "single_fix";

export interface HotspotCluster {
  hotspot_id: string;
  cluster_id: number;
  cycle: string;
  centroid_lat: number;
  centroid_lon: number;
  radius_m: number;
  n_members: number;
  area_m2: number;
  likely_cause: "likely_disease" | "likely_nutrient_deficiency" | "uncertain_expert_review";
  status: string;
  referred_to_module1: boolean;
  member_plant_ids: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evidence?: Record<string, any>;
}

export const HOTSPOT_CAUSE_COLOURS: Record<string, string> = {
  likely_disease: "#ef4444",
  likely_nutrient_deficiency: "#f59e0b",
  uncertain_expert_review: "#8b5cf6",
};

export const HOTSPOT_CAUSE_LABELS: Record<string, string> = {
  likely_disease: "Likely Disease (Module 1 Referral)",
  likely_nutrient_deficiency: "Likely Nutrient Deficiency",
  uncertain_expert_review: "Uncertain / Expert Review",
};

/** One active plant with its slot position and latest inspection (see buildPlantRows). */
export interface PlantRow {
  plant_id: string;
  zone: string | null;
  block: string | null;
  block_id: string | null;
  slot_id?: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  /** From slots.location_source or twin_state; null when not recorded. */
  location_source?: LocationSource | null;
  last_inspection_date: string | null;
  foliage_color: string | null;
  soil_ph: number | null;
  moisture: number | null;
  vine_height_cm: number | null;
  notes: string | null;
  // Module 2 ML & Spatial Analytics fields
  health_class?: string | null;
  health_probability?: number | null;
  health_model?: string | null;
  health_model_version?: string | null;
  in_hotspot?: boolean;
  hotspot_cluster_id?: number | null;
  hotspot_id?: string | null;
  hotspot_cause?: string | null;
  hotspot_status?: string | null;
  trend?: string | null;
  trend_slope?: number | null;
}

export interface PlantView extends PlantRow {
  status: PlantStatus;
  daysSinceInspection: number | null;
  stale: boolean;
  movedIntoZoneM?: number | null;
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

/** Status from ML model health_class when available, else rule-based deriveHealth(). */
export function deriveStatus(row: PlantRow): PlantStatus {
  if (row.health_class) {
    const hc = row.health_class.toLowerCase();
    if (hc === "poor") return "high-risk";
    if (hc === "moderate") return "moderate";
    if (hc === "healthy") return "healthy";
  }
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

export interface FetchResult {
  rows: PlantRow[];
  source: "supabase" | "local_demo";
  hotspots: HotspotCluster[];
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
 * Joins the field app's tables into one row per active plant:
 * plants -> slots (GPS captured in Add Plant) -> latest inspection.
 * Same join as frontend/monitor/src/lib/plantStatus.ts, so both maps show the same plants.
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
          slot?.location_source === "gps" || slot?.location_source === "estimated" || slot?.location_source === "smoothed"
            ? (slot.location_source as LocationSource)
            : null,
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
async function selectAll<T>(client: NonNullable<typeof supabase>, table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await client.from(table).select(columns).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < page) return out;
  }
}

/** Real plants and spatial health hotspots from Supabase twin_state & plant_health_hotspots. */
export async function fetchPlantRows(): Promise<FetchResult> {
  if (DEMO_MODE) {
    const res = await fetch("/geo/demo/demo_plants.json");
    if (!res.ok) throw new Error("Demo data not found in public/geo/demo/.");
    return { rows: (await res.json()) as PlantRow[], source: "local_demo", hotspots: [] };
  }
  if (!supabase) throw new Error("Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)");

  // 1. Fetch Hotspots
  let hotspots: HotspotCluster[] = [];
  try {
    const { data: hotspotData } = await supabase
      .from("plant_health_hotspots")
      .select("*")
      .order("created_at", { ascending: false });

    if (hotspotData && hotspotData.length > 0) {
      // Group by the latest cycle available
      const cycles = Array.from(new Set(hotspotData.map((h) => h.cycle))).sort().reverse();
      const latestCycle = cycles[0];
      const activeHotspots = hotspotData.filter((h) => h.cycle === latestCycle);

      const clusterMap = new Map<number, HotspotCluster>();
      for (const h of activeHotspots) {
        const cid = Number(h.cluster_id);
        if (cid <= 0) continue; // skip noise (-1)
        const p = h.params || {};
        if (!clusterMap.has(cid)) {
          clusterMap.set(cid, {
            hotspot_id: p.hotspot_id || `H${String(cid).padStart(3, "0")}`,
            cluster_id: cid,
            cycle: h.cycle,
            centroid_lat: Number(p.centroid_lat || 0),
            centroid_lon: Number(p.centroid_lon || 0),
            radius_m: Math.max(Math.sqrt((Number(p.area_m2) || 400) / Math.PI), 22),
            n_members: Number(p.n_members || 1),
            area_m2: Number(p.area_m2 || 0),
            likely_cause: p.likely_cause || "uncertain_expert_review",
            status: p.status || "persistent",
            referred_to_module1: !!p.referred_to_module1,
            member_plant_ids: [h.plant_id],
            evidence: p.evidence || {},
          });
        } else {
          const cl = clusterMap.get(cid)!;
          if (!cl.member_plant_ids.includes(h.plant_id)) {
            cl.member_plant_ids.push(h.plant_id);
          }
        }
      }
      hotspots = Array.from(clusterMap.values());
    }
  } catch (e) {
    console.warn("Could not fetch plant_health_hotspots:", e);
  }

  // 2. Try fetching from twin_state view
  try {
    const { data: twinData, error: twinError } = await supabase.from("twin_state").select("*");
    if (!twinError && twinData && twinData.length > 0) {
      const hsByPlant = new Map<string, HotspotCluster>();
      for (const cl of hotspots) {
        for (const pid of cl.member_plant_ids) {
          hsByPlant.set(pid, cl);
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: PlantRow[] = twinData.map((r: any) => {
        const cl = hsByPlant.get(r.plant_id);
        const in_hotspot = Boolean(r.in_hotspot || cl != null);
        return {
          plant_id: r.plant_id,
          zone: r.zone,
          block: r.block,
          block_id: r.block_id || (r.zone && r.block ? `${r.zone}-${r.block}` : null),
          slot_id: r.slot_id,
          latitude: r.latitude != null ? Number(r.latitude) : null,
          longitude: r.longitude != null ? Number(r.longitude) : null,
          accuracy: r.location_error_m != null ? Math.round(Number(r.location_error_m) * 10) / 10 : null,
          location_source: r.location_source as LocationSource,
          last_inspection_date: r.last_inspection_date,
          foliage_color: r.foliage_color,
          soil_ph: r.soil_ph != null ? Number(r.soil_ph) : null,
          moisture: r.moisture != null ? Number(r.moisture) : null,
          vine_height_cm: r.vine_height_cm != null ? Number(r.vine_height_cm) : null,
          notes: null,
          health_class: r.health_class,
          health_probability: r.health_probability != null ? Number(r.health_probability) : null,
          health_model: r.health_model,
          health_model_version: r.health_model_version,
          in_hotspot,
          hotspot_cluster_id: r.hotspot_cluster_id ?? cl?.cluster_id ?? null,
          hotspot_id: cl?.hotspot_id,
          hotspot_cause: cl?.likely_cause,
          hotspot_status: cl?.status,
          trend: r.trend,
          trend_slope: r.trend_slope != null ? Number(r.trend_slope) : null,
        };
      });
      return { rows, source: "supabase", hotspots };
    }
  } catch (e) {
    console.warn("twin_state query failed, falling back to base tables:", e);
  }

  // 3. Fallback to base tables
  const [plants, slots, inspections] = await Promise.all([
    selectAll<RawPlant>(supabase, "plants", "plant_id, zone, block, slot_id, status, replaced_by_plant_id"),
    selectAll<RawSlot>(supabase, "slots", "slot_id, latitude, longitude, accuracy, location_source"),
    selectAll<RawInspection>(
      supabase,
      "inspections",
      "plant_id, inspection_date, foliage_color, soil_ph, moisture, vine_height_cm, notes",
    ),
  ]);
  return { rows: buildPlantRows(plants, slots, inspections), source: "supabase", hotspots };
}

export interface PlantationGeo {
  boundary: FeatureCollection | null;
  zones: FeatureCollection | null;
  blocks: FeatureCollection | null;
}

/**
 * Loads the GeoJSON exported from QGIS into public/geo/ (Guide step 5).
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

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Display positions: a plant whose recorded position lies outside its own zone outline is drawn inside
 * that zone, next to the block-mates that are inside it (else around the zone's centre), on a small
 * spiral so the moved plants do not overlap. Phone GPS here is about ±70 m while zones B, C and D are
 * close together, so the zone label is more reliable than the fix. Only the map uses these positions;
 * recorded coordinates in Supabase are unchanged.
 */
export function placeInZones<T extends PlantView>(plants: T[], zones: FeatureCollection | null): T[] {
  const zoneRings = new Map<string, LngLat[][]>();
  zones?.features.forEach((f) => {
    const g = f.geometry;
    const z = f.properties?.zone ? String(f.properties.zone) : null;
    if (!z || !g) return;
    const rings: LngLat[][] = [];
    if (g.type === "Polygon") rings.push(g.coordinates[0] as LngLat[]);
    else if (g.type === "MultiPolygon") g.coordinates.forEach((poly) => rings.push(poly[0] as LngLat[]));
    if (rings.length) {
      zoneRings.set(z, [...(zoneRings.get(z) ?? []), ...rings]);
    }
  });
  if (!zoneRings.size) return plants;

  const pos = (p: T): LngLat | null => (p.latitude != null && p.longitude != null ? [p.longitude, p.latitude] : null);
  const fits = (p: T) => {
    const rings = p.zone ? zoneRings.get(p.zone) : undefined;
    const at = pos(p);
    return !rings || !at || rings.some((ring) => inRing(at, ring));
  };

  // Anchor per block: median position of its plants already inside any of the zone's rings.
  const anchors = new Map<string, LngLat>();
  const byBlock = new Map<string, LngLat[]>();
  for (const p of plants) {
    const at = pos(p);
    if (p.block_id && at && p.zone && zoneRings.has(p.zone) && fits(p)) {
      byBlock.set(p.block_id, [...(byBlock.get(p.block_id) ?? []), at]);
    }
  }
  for (const [block, pts] of byBlock) {
    anchors.set(block, [median(pts.map((q) => q[0])), median(pts.map((q) => q[1]))]);
  }

  const used = new Map<string, number>();
  return plants.map((p) => {
    const at = pos(p);
    if (!at || fits(p)) return p;
    const rings = zoneRings.get(p.zone as string) ?? [];
    if (!rings.length) return p;

    // Pick target ring: ring containing the block anchor, or closest ring
    const key = p.block_id && anchors.has(p.block_id) ? p.block_id : `zone:${p.zone}`;
    const anchor = anchors.get(key);
    let targetRing = rings[0];
    if (anchor) {
      const containingRing = rings.find((r) => inRing(anchor, r));
      if (containingRing) targetRing = containingRing;
      else {
        targetRing = rings.reduce((best, r) => {
          const c = ringCentroid(r);
          const dist = Math.hypot(c[0] - anchor[0], c[1] - anchor[1]);
          const bestDist = Math.hypot(ringCentroid(best)[0] - anchor[0], ringCentroid(best)[1] - anchor[1]);
          return dist < bestDist ? r : best;
        }, rings[0]);
      }
    } else {
      targetRing = rings.reduce((best, r) => {
        const c = ringCentroid(r);
        const dist = Math.hypot(c[0] - at[0], c[1] - at[1]);
        const bestDist = Math.hypot(ringCentroid(best)[0] - at[0], ringCentroid(best)[1] - at[1]);
        return dist < bestDist ? r : best;
      }, rings[0]);
    }

    const centre = ringCentroid(targetRing);
    const chosenAnchor = anchor && inRing(anchor, targetRing) ? anchor : centre;
    const i = used.get(key) ?? 0;
    used.set(key, i + 1);

    const mLat = 111_320;
    const mLng = 111_320 * Math.cos((chosenAnchor[1] * Math.PI) / 180);
    const r = 3 * Math.sqrt(i + 1); // metres
    const t = i * 2.39996; // golden angle
    let target: LngLat = [chosenAnchor[0] + (r * Math.cos(t)) / mLng, chosenAnchor[1] + (r * Math.sin(t)) / mLat];
    for (let k = 1; k <= 10 && !inRing(target, targetRing); k++) {
      const f = k / 10;
      target = [target[0] + (centre[0] - target[0]) * f, target[1] + (centre[1] - target[1]) * f];
    }
    if (!inRing(target, targetRing)) target = centre;

    const moved = Math.hypot((target[0] - at[0]) * mLng, (target[1] - at[1]) * mLat);
    return { ...p, longitude: target[0], latitude: target[1], movedIntoZoneM: Math.round(moved) };
  });
}
