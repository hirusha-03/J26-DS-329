import Link from "next/link";
import { Map, Microscope } from "lucide-react";
import { HOTSPOT_CAUSE_COLOURS, HOTSPOT_CAUSE_LABELS, type HotspotCluster } from "@/lib/plantStatus";
import { SectionEmpty } from "./Section";

const MAX_CHIPS = 8;

export function needsDiseaseCheck(hotspots: HotspotCluster[]): HotspotCluster[] {
  return hotspots
    .filter((h) => h.likely_cause === "likely_disease" || h.likely_cause === "uncertain_expert_review")
    .sort((a, b) => Number(b.referred_to_module1) - Number(a.referred_to_module1) || b.n_members - a.n_members);
}

function checkHref(plantId: string, hotspotId: string): string {
  return `/disease-detection?plant=${encodeURIComponent(plantId)}&hotspot=${encodeURIComponent(hotspotId)}`;
}

export default function HotspotChecks({ hotspots }: { hotspots: HotspotCluster[] }) {
  const list = needsDiseaseCheck(hotspots);
  if (list.length === 0) return <SectionEmpty>No hotspots need a disease check this cycle.</SectionEmpty>;

  return (
    <ul className="space-y-3" data-testid="hotspot-checks">
      {list.map((h) => {
        const members = [...h.member_plant_ids].sort();
        return (
          <li key={h.hotspot_id} className="rounded-lg border border-border-light p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-text-primary">{h.hotspot_id}</span>
              <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                <span className="h-2 w-2 rounded-full" style={{ background: HOTSPOT_CAUSE_COLOURS[h.likely_cause] }} aria-hidden />
                {HOTSPOT_CAUSE_LABELS[h.likely_cause] ?? h.likely_cause}
              </span>
              {h.referred_to_module1 && (
                <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">Referred</span>
              )}
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              {members.length} plant{members.length === 1 ? "" : "s"} · {h.status}
              {h.area_m2 ? ` · ${Math.round(h.area_m2)} m²` : ""} · cycle {h.cycle}
            </p>
            <p className="mt-2 text-xs text-text-secondary">Photograph a leaf or stem from:</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {members.slice(0, MAX_CHIPS).map((id) => (
                <li key={id}>
                  <Link
                    href={checkHref(id, h.hotspot_id)}
                    className="inline-flex items-center gap-1 rounded-full border border-border-light px-2 py-0.5 text-xs text-text-primary hover:bg-surface focus-visible:outline-2 focus-visible:outline-secondary"
                  >
                    <Microscope size={12} aria-hidden /> {id}
                  </Link>
                </li>
              ))}
              {members.length > MAX_CHIPS && (
                <li className="px-1 py-0.5 text-xs text-text-secondary">+{members.length - MAX_CHIPS} more</li>
              )}
            </ul>
            <Link href="/digital-twin" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-secondary hover:underline">
              <Map size={12} aria-hidden /> View on the map
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
