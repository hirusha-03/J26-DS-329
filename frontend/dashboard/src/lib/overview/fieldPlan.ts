import type { HotspotCluster, PlantView } from "@/lib/plantStatus";

// Ranked "visit today" list. Reasons are summed so a plant with several problems ranks higher.
export type PlanReason =
  | "disease_hotspot"
  | "high_risk_stale"
  | "uncertain_hotspot"
  | "moderate_stale"
  | "never_inspected"
  | "weak_location";

export const REASON_WEIGHTS: Record<PlanReason, number> = {
  disease_hotspot: 100,
  high_risk_stale: 80,
  uncertain_hotspot: 60,
  moderate_stale: 50,
  never_inspected: 40,
  weak_location: 15,
};

export const REASON_LABELS: Record<PlanReason, string> = {
  disease_hotspot: "In a likely-disease hotspot",
  high_risk_stale: "High risk, inspection overdue",
  uncertain_hotspot: "In a hotspot needing expert review",
  moderate_stale: "Moderate, inspection overdue",
  never_inspected: "Never inspected",
  weak_location: "Location not confirmed by GPS",
};

export interface PlanItem {
  plant: PlantView;
  score: number;
  reasons: PlanReason[];
  hotspot: HotspotCluster | null;
}

function reasonsFor(plant: PlantView, hotspot: HotspotCluster | null): PlanReason[] {
  const reasons: PlanReason[] = [];
  if (hotspot?.likely_cause === "likely_disease") reasons.push("disease_hotspot");
  if (plant.status === "high-risk" && plant.stale) reasons.push("high_risk_stale");
  if (hotspot?.likely_cause === "uncertain_expert_review") reasons.push("uncertain_hotspot");
  if (plant.status === "moderate" && plant.stale) reasons.push("moderate_stale");
  if (plant.status === "not-inspected") reasons.push("never_inspected");
  const weak =
    plant.latitude == null ||
    plant.longitude == null ||
    plant.location_source === "estimated" ||
    plant.location_source === "single_fix";
  if (weak) reasons.push("weak_location");
  return reasons;
}

export function buildFieldPlan(plants: PlantView[], hotspots: HotspotCluster[]): PlanItem[] {
  const byPlant = new Map<string, HotspotCluster>();
  for (const cluster of hotspots) {
    for (const id of cluster.member_plant_ids) byPlant.set(id, cluster);
  }
  const items: PlanItem[] = [];
  for (const plant of plants) {
    if (plant.status === "dead") continue; // needs replacing, not inspecting
    const hotspot = byPlant.get(plant.plant_id) ?? null;
    const reasons = reasonsFor(plant, hotspot);
    if (reasons.length === 0) continue;
    const score = reasons.reduce((sum, r) => sum + REASON_WEIGHTS[r], 0);
    items.push({ plant, score, reasons, hotspot });
  }
  return items.sort(
    (a, b) =>
      b.score - a.score ||
      (b.plant.daysSinceInspection ?? Infinity) - (a.plant.daysSinceInspection ?? Infinity) ||
      a.plant.plant_id.localeCompare(b.plant.plant_id),
  );
}
