"use client";

import { useState } from "react";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { HOTSPOT_CAUSE_COLOURS } from "@/lib/plantStatus";
import type { CycleChanges as Changes, Trend } from "@/lib/overview/cycleChanges";
import { SectionEmpty } from "./Section";

const TREND_STYLE: Record<Trend, { icon: typeof Minus; className: string; label: string }> = {
  declining: { icon: TrendingDown, className: "text-danger", label: "Declining" },
  improving: { icon: TrendingUp, className: "text-ok", label: "Improving" },
  stable: { icon: Minus, className: "text-text-secondary", label: "Stable" },
  insufficient: { icon: Minus, className: "text-text-secondary", label: "Not enough cycles" },
};

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export default function CycleChanges({ changes }: { changes: Changes }) {
  const { areas, hotspots } = changes;
  const [showAll, setShowAll] = useState(false);
  const declining = areas.filter((a) => a.trend === "declining");
  const others = areas.filter((a) => a.trend !== "declining");
  const shown = showAll ? areas : declining;
  const counts = others.reduce<Partial<Record<Trend, number>>>((c, a) => ({ ...c, [a.trend]: (c[a.trend] ?? 0) + 1 }), {});
  const summary = (Object.keys(counts) as Trend[]).map((t) => `${counts[t]} ${TREND_STYLE[t].label.toLowerCase()}`).join(", ");
  if (areas.length === 0 && hotspots.length === 0) {
    return <SectionEmpty>No trend results yet. They appear after the twin pipeline scores two or more cycles.</SectionEmpty>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div>
        {declining.length === 0 && !showAll && (
          <p className="mb-2 text-sm text-text-secondary">No block or zone is declining.</p>
        )}
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="area-trends">
          {shown.map((a) => {
            const style = TREND_STYLE[a.trend];
            const Icon = style.icon;
            return (
              <li key={`${a.level}:${a.entity_id}`} className="flex items-center gap-3 rounded-lg border border-border-light p-2.5">
                <Icon size={18} className={`shrink-0 ${style.className}`} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    {a.level === "zone" ? "Zone" : "Block"} {a.entity_id}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {style.label} · {pct(a.unhealthy_share)} unhealthy · {a.n_cycles} cycle{a.n_cycles === 1 ? "" : "s"}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        {others.length > 0 && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 text-sm font-medium text-secondary hover:underline">
            {showAll ? "Show declining only" : `Show the other ${others.length} (${summary})`}
          </button>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-text-primary">New or growing hotspots</h3>
        {hotspots.length === 0 ? (
          <p className="text-sm text-text-secondary">None this cycle.</p>
        ) : (
          <ul className="space-y-1.5">
            {hotspots.map((h) => (
              <li key={h.hotspot_id} className="flex items-center gap-2 text-sm text-text-primary">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: HOTSPOT_CAUSE_COLOURS[h.likely_cause] }} aria-hidden />
                {h.hotspot_id} · {h.status} · {h.member_plant_ids.length} plants
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
