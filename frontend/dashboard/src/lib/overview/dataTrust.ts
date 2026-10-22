import type { PlantView } from "@/lib/plantStatus";

export type LocationKind = "gps" | "smoothed" | "single_fix" | "estimated" | "none";

export interface DataTrust {
  total: number;
  inspected: number;
  coverage: number | null; // inspected / total
  stale: number;
  staleShare: number | null; // stale / inspected
  latestInspection: string | null;
  locations: Record<LocationKind, number>;
}

function locationKind(p: PlantView): LocationKind {
  if (p.latitude == null || p.longitude == null) return "none";
  return p.location_source ?? "gps";
}

export function buildDataTrust(plants: PlantView[]): DataTrust {
  const locations: Record<LocationKind, number> = { gps: 0, smoothed: 0, single_fix: 0, estimated: 0, none: 0 };
  let inspected = 0;
  let stale = 0;
  let latestInspection: string | null = null;
  for (const p of plants) {
    locations[locationKind(p)] += 1;
    if (!p.last_inspection_date) continue;
    inspected += 1;
    if (p.stale) stale += 1;
    if (latestInspection == null || p.last_inspection_date > latestInspection) latestInspection = p.last_inspection_date;
  }
  return {
    total: plants.length,
    inspected,
    coverage: plants.length ? inspected / plants.length : null,
    stale,
    staleShare: inspected ? stale / inspected : null,
    latestInspection,
    locations,
  };
}
