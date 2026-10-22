"use client";

import { useState } from "react";
import Link from "next/link";
import { ClipboardCheck, History, Microscope } from "lucide-react";
import { STATUS_COLOURS, STATUS_LABELS } from "@/lib/plantStatus";
import { MONITOR_URL } from "@/lib/overview/data";
import { REASON_LABELS, type PlanItem } from "@/lib/overview/fieldPlan";
import { SectionEmpty } from "./Section";

const TOP_N = 10;

function lastSeen(days: number | null): string {
  if (days == null) return "Never inspected";
  if (days <= 0) return "Inspected today";
  return `Inspected ${days} day${days === 1 ? "" : "s"} ago`;
}

export default function FieldPlan({ items }: { items: PlanItem[] }) {
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return <SectionEmpty>Nothing needs a visit right now.</SectionEmpty>;
  const shown = showAll ? items : items.slice(0, TOP_N);

  return (
    <div>
      <ol className="divide-y divide-border-light" data-testid="field-plan">
        {shown.map(({ plant, reasons, hotspot }, i) => (
          <li key={plant.plant_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
            <span className="hidden w-6 shrink-0 text-right text-sm font-semibold text-text-secondary sm:block">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold text-text-primary">{plant.plant_id}</span>
                <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                  <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOURS[plant.status] }} aria-hidden />
                  {STATUS_LABELS[plant.status]}
                </span>
                <span className="text-xs text-text-secondary">
                  {plant.block_id ? `Block ${plant.block_id} · ` : ""}
                  {lastSeen(plant.daysSinceInspection)}
                </span>
              </p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {reasons.map((r) => (
                  <li key={r} className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-primary">
                    {REASON_LABELS[r]}
                    {hotspot && (r === "disease_hotspot" || r === "uncertain_hotspot") ? ` ${hotspot.hotspot_id}` : ""}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {hotspot && (reasons.includes("disease_hotspot") || reasons.includes("uncertain_hotspot")) && (
                <Link
                  href={`/disease-detection?plant=${encodeURIComponent(plant.plant_id)}&hotspot=${encodeURIComponent(hotspot.hotspot_id)}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border-light px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface focus-visible:outline-2 focus-visible:outline-secondary"
                >
                  <Microscope size={14} aria-hidden /> Photo check
                </Link>
              )}
              <a
                href={`${MONITOR_URL}/new-inspection?plant_id=${encodeURIComponent(plant.plant_id)}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-secondary"
              >
                <ClipboardCheck size={14} aria-hidden /> Inspect
              </a>
              <a
                href={`${MONITOR_URL}/history?plant_id=${encodeURIComponent(plant.plant_id)}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-light px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface focus-visible:outline-2 focus-visible:outline-secondary"
              >
                <History size={14} aria-hidden /> History
              </a>
            </div>
          </li>
        ))}
      </ol>
      {items.length > TOP_N && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 text-sm font-medium text-secondary hover:underline"
        >
          {showAll ? "Show top 10" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
