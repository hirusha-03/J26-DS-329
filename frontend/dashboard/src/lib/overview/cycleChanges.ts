import type { HotspotCluster } from "@/lib/plantStatus";

export type Trend = "improving" | "stable" | "declining" | "insufficient";

/** One row of the `health_trends` table (Module 2). */
export interface TrendRow {
  level: "plant" | "block" | "zone";
  entity_id: string;
  window_start: string;
  window_end: string;
  n_cycles: number;
  trend: Trend;
  slope: number | null;
  unhealthy_share: number | null;
  model_version: string;
  created_at: string;
}

export interface CycleChanges {
  areas: TrendRow[]; // latest block + zone trends, declining first
  windowEnd: string | null;
  hotspots: HotspotCluster[]; // new or expanding
}

const TREND_ORDER: Record<Trend, number> = { declining: 0, improving: 1, stable: 2, insufficient: 3 };

/** Keeps the newest trend per block/zone so re-runs of the twin pipeline don't double count. */
export function latestAreaTrends(rows: TrendRow[]): TrendRow[] {
  const latest = new Map<string, TrendRow>();
  for (const row of rows) {
    if (row.level === "plant") continue;
    const key = `${row.level}:${row.entity_id}`;
    const seen = latest.get(key);
    if (!seen || row.window_end > seen.window_end || (row.window_end === seen.window_end && row.created_at > seen.created_at)) {
      latest.set(key, row);
    }
  }
  return [...latest.values()].sort(
    (a, b) =>
      TREND_ORDER[a.trend] - TREND_ORDER[b.trend] ||
      (b.unhealthy_share ?? 0) - (a.unhealthy_share ?? 0) ||
      a.entity_id.localeCompare(b.entity_id),
  );
}

export function buildCycleChanges(rows: TrendRow[], hotspots: HotspotCluster[]): CycleChanges {
  const areas = latestAreaTrends(rows);
  const windowEnd = areas.reduce<string | null>((max, r) => (max == null || r.window_end > max ? r.window_end : max), null);
  return {
    areas,
    windowEnd,
    hotspots: hotspots.filter((h) => h.status === "new" || h.status === "expanding"),
  };
}
