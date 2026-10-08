"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import {
  BLOCK_COLOURS,
  BLOCK_LABELS,
  STATUS_COLOURS,
  STATUS_LABELS,
  fetchPlantRows,
  loadGeo,
  plantedCountsFrom,
  summariseBlocks,
  toPlantView,
  type BlockLevel,
  type PlantationGeo,
  type PlantRow,
  type PlantStatus,
} from "@/lib/plantStatus";
import { STALE_AFTER_DAYS } from "@/lib/mapConfig";

const PlantationMap = dynamic(() => import("@/components/twin/PlantationMap"), {
  ssr: false,
  loading: () => <div className="h-full min-h-[480px] animate-pulse rounded-xl bg-white" />,
});

const STATUS_ORDER: PlantStatus[] = ["healthy", "moderate", "high-risk", "dead", "not-inspected"];
const BLOCK_ORDER: BlockLevel[] = ["good", "watch", "concern", "insufficient", "no-data"];

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-GB") : "—");

export default function DigitalTwinPage() {
  const [geo, setGeo] = useState<PlantationGeo>({ boundary: null, zones: null, blocks: null });
  const [rows, setRows] = useState<PlantRow[]>([]);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadGeo(), fetchPlantRows()])
      .then(([g, r]) => {
        setGeo(g);
        setRows(r);
        setLoadedAt(Date.now());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const plants = useMemo(() => (loadedAt ? rows.map((r) => toPlantView(r, loadedAt)) : []), [rows, loadedAt]);
  const blocks = useMemo(() => summariseBlocks(plants, plantedCountsFrom(geo.blocks)), [plants, geo.blocks]);

  const totals = useMemo(() => {
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<PlantStatus, number>;
    plants.forEach((p) => counts[p.status]++);
    const dates = plants.map((p) => p.last_inspection_date).filter((d): d is string => !!d).sort();
    return {
      counts,
      located: plants.filter((p) => p.latitude != null && p.longitude != null).length,
      inspected: plants.length - counts["not-inspected"],
      latest: dates.at(-1) ?? null,
    };
  }, [plants]);

  const plant = plants.find((p) => p.plant_id === selectedPlantId) ?? null;
  const block = selectedBlockId ? blocks[selectedBlockId] : plant?.block_id ? blocks[plant.block_id] : undefined;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Digital Twin – Plantation Map</h1>
          <p className="text-sm text-text-secondary">
            GPS-referenced map · plant status from each plant&apos;s latest inspection (rule-based, updated per
            inspection – not real-time)
          </p>
        </div>
        <p className="text-sm text-text-secondary">Latest inspection: {fmtDate(totals.latest)}</p>
      </header>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">Could not load data: {error}</p>}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Plants registered", plants.length],
          ["GPS-located", totals.located],
          ["Inspected at least once", totals.inspected],
          ["Blocks with enough data", Object.values(blocks).filter((b) => ["good", "watch", "concern"].includes(b.level)).length],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-xl border border-border-light bg-white p-3">
            <p className="text-xs text-text-secondary">{label}</p>
            <p className="text-2xl font-semibold text-text-primary">{value}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr_300px]">
        {/* Left: legend + counts */}
        <aside className="space-y-4 rounded-xl border border-border-light bg-white p-4 text-sm">
          <div>
            <p className="mb-2 font-semibold text-text-primary">Plants</p>
            {STATUS_ORDER.map((s) => (
              <p key={s} className="flex items-center justify-between py-0.5 text-text-secondary">
                <span className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: STATUS_COLOURS[s] }} />
                  {STATUS_LABELS[s]}
                </span>
                {totals.counts[s]}
              </p>
            ))}
            <p className="mt-1 text-xs text-text-secondary">Faded dot = last inspection over {STALE_AFTER_DAYS} days ago</p>
          </div>
          <div>
            <p className="mb-2 font-semibold text-text-primary">Blocks</p>
            {BLOCK_ORDER.map((l) => (
              <p key={l} className="flex items-center gap-2 py-0.5 text-text-secondary">
                <span className="h-3 w-3 rounded-sm" style={{ background: BLOCK_COLOURS[l] }} />
                {BLOCK_LABELS[l]}
              </p>
            ))}
          </div>
        </aside>

        {/* Centre: map */}
        <div className="h-[70vh] min-h-[480px]">
          <PlantationMap
            geo={geo}
            plants={plants}
            blocks={blocks}
            selectedPlantId={selectedPlantId}
            selectedBlockId={selectedBlockId}
            onSelectPlant={(id) => {
              setSelectedPlantId(id);
              setSelectedBlockId(null);
            }}
            onSelectBlock={(id) => {
              setSelectedBlockId(id);
              setSelectedPlantId(null);
            }}
          />
        </div>

        {/* Right: details */}
        <aside className="space-y-4 rounded-xl border border-border-light bg-white p-4 text-sm">
          {!plant && !block && <p className="text-text-secondary">Click a plant or a block on the map.</p>}

          {plant && (
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-text-secondary">Plant</p>
              <p className="text-lg font-semibold text-text-primary">{plant.plant_id}</p>
              <p className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: STATUS_COLOURS[plant.status] }} />
                {STATUS_LABELS[plant.status]}
                {plant.stale && <span className="text-xs text-amber-700">(stale)</span>}
              </p>
              <p className="text-text-secondary">
                Last inspected {fmtDate(plant.last_inspection_date)}
                {plant.daysSinceInspection != null && ` (${plant.daysSinceInspection} days ago)`}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-y-1 text-text-secondary">
                <dt>Foliage</dt>
                <dd className="text-text-primary">{plant.foliage_color ?? "—"}</dd>
                <dt>Soil pH</dt>
                <dd className="text-text-primary">{plant.soil_ph ?? "—"}</dd>
                <dt>Moisture</dt>
                <dd className="text-text-primary">{plant.moisture ?? "—"}</dd>
                <dt>Vine height</dt>
                <dd className="text-text-primary">{plant.vine_height_cm != null ? `${plant.vine_height_cm} cm` : "—"}</dd>
                <dt>GPS accuracy</dt>
                <dd className="text-text-primary">{plant.accuracy != null ? `±${plant.accuracy} m` : "—"}</dd>
              </dl>
              {plant.notes && <p className="mt-2 rounded bg-surface p-2 text-text-secondary">{plant.notes}</p>}
            </div>
          )}

          {block && (
            <div className="space-y-1 border-t border-border-light pt-3 first:border-0 first:pt-0">
              <p className="text-xs uppercase tracking-wide text-text-secondary">Block</p>
              <p className="text-lg font-semibold text-text-primary">{block.block_id}</p>
              <p className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-sm" style={{ background: BLOCK_COLOURS[block.level] }} />
                {BLOCK_LABELS[block.level]}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-y-1 text-text-secondary">
                <dt>Planted</dt>
                <dd className="text-text-primary">{block.planted}</dd>
                <dt>GPS-located</dt>
                <dd className="text-text-primary">{block.located}</dd>
                <dt>Inspected</dt>
                <dd className="text-text-primary">
                  {block.inspected}
                  {block.coverage != null && ` (${Math.round(block.coverage * 100)}%)`}
                </dd>
                <dt>High risk / dead</dt>
                <dd className="text-text-primary">
                  {block.riskShare != null ? `${Math.round(block.riskShare * 100)}%` : "—"}
                </dd>
                <dt>Last inspection</dt>
                <dd className="text-text-primary">{fmtDate(block.lastInspection)}</dd>
              </dl>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
