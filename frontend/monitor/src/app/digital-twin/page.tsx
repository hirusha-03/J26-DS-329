"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Droplets,
  Layers,
  MapPin,
  RefreshCw,
  Search,
  Sprout,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
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
  type DataSource,
  type PlantationGeo,
  type PlantRow,
  type PlantStatus,
} from "@/lib/plantStatus";
import { STALE_AFTER_DAYS } from "@/lib/mapConfig";

const PlantationMap = dynamic(() => import("@/components/twin/PlantationMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[480px] w-full items-center justify-center rounded-xl bg-slate-900/10 backdrop-blur">
      <div className="flex flex-col items-center gap-2 text-slate-500">
        <RefreshCw className="h-8 w-8 animate-spin text-emerald-600" />
        <span className="text-sm font-medium">Initializing Plantation Map Engine...</span>
      </div>
    </div>
  ),
});

const STATUS_ORDER: PlantStatus[] = ["healthy", "moderate", "high-risk", "dead", "not-inspected"];
const BLOCK_ORDER: BlockLevel[] = ["good", "watch", "concern", "insufficient", "no-data"];

/** Route of the existing block registry page, e.g. "A-01" -> /blocks/A/01. */
const blockHref = (blockId: string) => {
  const i = blockId.indexOf("-");
  return i > 0 ? `/blocks/${blockId.slice(0, i)}/${blockId.slice(i + 1)}` : null;
};

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

export default function DigitalTwinPage() {
  const [geo, setGeo] = useState<PlantationGeo>({ boundary: null, zones: null, blocks: null });
  const [rows, setRows] = useState<PlantRow[]>([]);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>("supabase");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters state
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedZone, setSelectedZone] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [freshnessFilter, setFreshnessFilter] = useState<"all" | "fresh" | "stale">("all");

  // Map selection state
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [g, res] = await Promise.all([loadGeo(), fetchPlantRows()]);
      setGeo(g);
      setRows(res.rows);
      setDataSource(res.source);
      setLoadedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer to a microtask so the initial load doesn't set state synchronously in the effect.
    queueMicrotask(loadData);
  }, [loadData]);

  const allPlants = useMemo(
    () => (loadedAt ? rows.map((r) => toPlantView(r, loadedAt)) : []),
    [rows, loadedAt],
  );

  const filteredPlants = useMemo(() => {
    return allPlants.filter((p) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesId = p.plant_id.toLowerCase().includes(q);
        const matchesBlock = p.block_id?.toLowerCase().includes(q);
        if (!matchesId && !matchesBlock) return false;
      }

      if (selectedZone !== "all" && p.zone !== selectedZone) {
        return false;
      }

      if (selectedStatus !== "all" && p.status !== selectedStatus) {
        return false;
      }

      if (freshnessFilter === "fresh" && p.stale) return false;
      if (freshnessFilter === "stale" && !p.stale && p.last_inspection_date !== null) return false;

      return true;
    });
  }, [allPlants, searchQuery, selectedZone, selectedStatus, freshnessFilter]);

  const blocks = useMemo(
    () => summariseBlocks(allPlants, plantedCountsFrom(geo.blocks)),
    [allPlants, geo.blocks],
  );

  const totals = useMemo(() => {
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<PlantStatus, number>;
    allPlants.forEach((p) => counts[p.status]++);
    const dates = allPlants.map((p) => p.last_inspection_date).filter((d): d is string => !!d).sort();
    return {
      counts,
      located: allPlants.filter((p) => p.latitude != null && p.longitude != null).length,
      inspected: allPlants.length - counts["not-inspected"],
      latest: dates.at(-1) ?? null,
    };
  }, [allPlants]);

  const activeFiltersCount =
    (searchQuery ? 1 : 0) +
    (selectedZone !== "all" ? 1 : 0) +
    (selectedStatus !== "all" ? 1 : 0) +
    (freshnessFilter !== "all" ? 1 : 0);

  const resetFilters = () => {
    setSearchQuery("");
    setSelectedZone("all");
    setSelectedStatus("all");
    setFreshnessFilter("all");
  };

  const selectedPlant = useMemo(
    () => (selectedPlantId ? allPlants.find((p) => p.plant_id === selectedPlantId) ?? null : null),
    [allPlants, selectedPlantId],
  );

  const selectedBlock = useMemo(
    () =>
      selectedBlockId
        ? blocks[selectedBlockId]
        : selectedPlant?.block_id
        ? blocks[selectedPlant.block_id]
        : undefined,
    [blocks, selectedBlockId, selectedPlant],
  );

  const availableZones = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => {
      if (r.zone) set.add(r.zone);
    });
    return Array.from(set).sort();
  }, [rows]);

  return (
    <div className="space-y-4 p-4 lg:p-0">
      {/* Top Header with Offline & Cloud Sync Indicator */}
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <Sprout className="h-6 w-6 text-emerald-600" />
            <h1 className="text-xl font-bold text-slate-900">Digital Twin – Plantation Map</h1>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            GPS vine locator & periodic inspection health status overlay
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div
            className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
              dataSource === "supabase"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-800 border border-amber-200"
            }`}
          >
            {dataSource === "supabase" ? (
              <>
                <Wifi className="h-3.5 w-3.5 text-emerald-600 animate-pulse" />
                <span>Cloud Sync Active (Supabase)</span>
              </>
            ) : (
              <>
                <WifiOff className="h-3.5 w-3.5 text-amber-600" />
                <span>{dataSource === "offline_cache" ? "Offline cache (this device)" : "DEMO data – not real"}</span>
              </>
            )}
          </div>

          <span className="text-xs text-slate-500">
            Latest: <strong className="text-slate-700">{fmtDate(totals.latest)}</strong>
          </span>

          <button
            onClick={loadData}
            disabled={isLoading}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin text-emerald-600" : ""}`} />
            <span>{isLoading ? "Syncing..." : "Refresh"}</span>
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Could not load plant data: {error}</span>
        </div>
      )}

      {!isLoading && !geo.blocks && (
        <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
          <Layers className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <span>
            Showing GPS-tagged plants on the satellite map. Block and zone outlines will appear once the
            georeferenced Survey Plan No. 61 shapes are exported from QGIS to <code>public/geo/</code>.
          </span>
        </div>
      )}

      {/* Stats Cards */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Total Vines</span>
            <Sprout className="h-4 w-4 text-emerald-600" />
          </div>
          <p className="mt-1 text-2xl font-bold text-slate-900">{allPlants.length}</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>GPS Mapped</span>
            <MapPin className="h-4 w-4 text-blue-600" />
          </div>
          <p className="mt-1 text-2xl font-bold text-slate-900">{totals.located}</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Inspected</span>
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          </div>
          <p className="mt-1 text-2xl font-bold text-slate-900">{totals.inspected}</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Healthy Blocks</span>
            <Layers className="h-4 w-4 text-indigo-600" />
          </div>
          <p className="mt-1 text-2xl font-bold text-slate-900">
            {Object.values(blocks).filter((b) => ["good", "watch"].includes(b.level)).length}
          </p>
        </div>
      </section>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search Plant ID (e.g. A-1-001)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-9 pr-3 text-xs text-slate-900 placeholder-slate-400 focus:border-emerald-500 focus:bg-white focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-2 text-slate-400 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <select
            value={selectedZone}
            onChange={(e) => setSelectedZone(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 focus:border-emerald-500 focus:outline-none"
          >
            <option value="all">All Zones ({availableZones.length})</option>
            {availableZones.map((z) => (
              <option key={z} value={z}>
                Zone {z}
              </option>
            ))}
          </select>

          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 focus:border-emerald-500 focus:outline-none"
          >
            <option value="all">All Health Statuses</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]} ({totals.counts[s]})
              </option>
            ))}
          </select>

          <select
            value={freshnessFilter}
            onChange={(e) => setFreshnessFilter(e.target.value as "all" | "fresh" | "stale")}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 focus:border-emerald-500 focus:outline-none"
          >
            <option value="all">All Inspection Ages</option>
            <option value="fresh">Fresh (&lt;{STALE_AFTER_DAYS} days)</option>
            <option value="stale">Stale (&gt;{STALE_AFTER_DAYS} days)</option>
          </select>

          {activeFiltersCount > 0 && (
            <button
              onClick={resetFilters}
              className="flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
            >
              <X className="h-3.5 w-3.5" />
              <span>Clear filters ({activeFiltersCount})</span>
            </button>
          )}
        </div>

        <div className="text-xs text-slate-500">
          Showing <strong className="text-slate-800">{filteredPlants.length}</strong> of {allPlants.length} vines
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid gap-4 lg:grid-cols-[200px_1fr_300px] xl:grid-cols-[220px_1fr_320px]">
        {/* Left: Legend */}
        <aside className="order-3 space-y-4 rounded-xl border border-slate-200 bg-white p-4 text-xs shadow-sm lg:order-none">
          <div>
            <p className="mb-2 font-bold text-slate-900 flex items-center justify-between">
              <span>Vine Statuses</span>
              <span className="text-[10px] text-slate-400 font-normal">Count</span>
            </p>
            <div className="space-y-1.5">
              {STATUS_ORDER.map((s) => (
                <button
                  key={s}
                  onClick={() => setSelectedStatus(selectedStatus === s ? "all" : s)}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1 transition ${
                    selectedStatus === s
                      ? "bg-slate-100 font-semibold text-slate-900"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOURS[s] }} />
                    {STATUS_LABELS[s]}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                    {totals.counts[s]}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-slate-400">
              Faded markers = last inspection older than {STALE_AFTER_DAYS} days
            </p>
          </div>

          <div className="border-t border-slate-100 pt-3">
            <p className="mb-2 font-bold text-slate-900">Block Classifications</p>
            <div className="space-y-1">
              {BLOCK_ORDER.map((l) => (
                <div key={l} className="flex items-center gap-2 py-0.5 text-slate-600">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: BLOCK_COLOURS[l] }} />
                  <span>{BLOCK_LABELS[l]}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Center: Map */}
        {/* z-0 isolates Leaflet's internal z-indexes below the app header and bottom nav */}
        <div className="relative z-0 order-1 h-[55vh] min-h-[360px] overflow-hidden rounded-xl border border-slate-200 shadow-sm lg:order-none lg:h-[65vh] lg:min-h-[480px]">
          <PlantationMap
            geo={geo}
            plants={filteredPlants}
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

        {/* Right: Vine Detail Drawer */}
        <aside className="order-2 space-y-4 rounded-xl border border-slate-200 bg-white p-4 text-xs shadow-sm lg:order-none lg:max-h-[65vh] lg:overflow-y-auto">
          {!selectedPlant && !selectedBlock && (
            <div className="flex flex-col items-center justify-center text-center py-12 text-slate-400">
              <MapPin className="h-10 w-10 text-slate-300 mb-2 stroke-1" />
              <p className="font-semibold text-slate-700">No Vine Selected</p>
              <p className="text-xs mt-1 text-slate-500">
                Click any vine marker or block boundary on the map to inspect live metrics.
              </p>
            </div>
          )}

          {selectedPlant && (
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Vine Inspection Card
                </span>
                <button
                  onClick={() => setSelectedPlantId(null)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div>
                <h3 className="text-lg font-bold text-slate-900">{selectedPlant.plant_id}</h3>
                <div className="mt-1 flex items-center gap-2">
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ background: STATUS_COLOURS[selectedPlant.status] }}
                  />
                  <span className="font-semibold text-slate-800">
                    {STATUS_LABELS[selectedPlant.status]}
                  </span>
                  {selectedPlant.stale && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                      Stale
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-lg bg-slate-50 p-2.5 text-slate-600">
                <div className="flex items-center gap-1.5 text-slate-500">
                  <Calendar className="h-3.5 w-3.5 text-slate-400" />
                  <span>
                    Inspected {fmtDate(selectedPlant.last_inspection_date)}
                    {selectedPlant.daysSinceInspection != null && (
                      <strong className="text-slate-700"> ({selectedPlant.daysSinceInspection}d ago)</strong>
                    )}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <p className="font-bold text-slate-900">Agronomic Metrics</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2">
                    <span className="text-[10px] text-slate-500">Foliage Color</span>
                    <p className="font-semibold text-slate-800">{selectedPlant.foliage_color ?? "—"}</p>
                  </div>

                  <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2">
                    <span className="text-[10px] text-slate-500">Soil pH</span>
                    <p className="font-semibold text-slate-800">{selectedPlant.soil_ph ?? "—"}</p>
                  </div>

                  <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2">
                    <div className="flex items-center gap-1 text-[10px] text-slate-500">
                      <Droplets className="h-3 w-3 text-blue-500" />
                      <span>Moisture</span>
                    </div>
                    <p className="font-semibold text-slate-800">
                      {selectedPlant.moisture != null ? `${selectedPlant.moisture}%` : "—"}
                    </p>
                  </div>

                  <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2">
                    <div className="flex items-center gap-1 text-[10px] text-slate-500">
                      <Activity className="h-3 w-3 text-emerald-500" />
                      <span>Vine Height</span>
                    </div>
                    <p className="font-semibold text-slate-800">
                      {selectedPlant.vine_height_cm != null ? `${selectedPlant.vine_height_cm} cm` : "—"}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2 flex justify-between items-center text-xs">
                  <span className="text-slate-500">GPS Accuracy</span>
                  <span className="font-mono text-slate-700">
                    {selectedPlant.accuracy != null ? `±${selectedPlant.accuracy} m` : "—"}
                  </span>
                </div>
              </div>

              <Link
                href={`/plant/${encodeURIComponent(selectedPlant.plant_id)}`}
                className="flex items-center justify-between rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
              >
                <span>Open full plant record</span>
                <ChevronRight className="h-4 w-4" />
              </Link>

              {selectedPlant.notes && (
                <div>
                  <p className="mb-1 font-bold text-slate-900">Inspector Notes</p>
                  <p className="rounded-lg bg-amber-50/60 p-2.5 text-xs text-amber-900 border border-amber-100">
                    {selectedPlant.notes}
                  </p>
                </div>
              )}
            </div>
          )}

          {selectedBlock && (
            <div className="space-y-3 border-t border-slate-100 pt-3 first:border-0 first:pt-0">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Block Summary
                </span>
                {selectedBlockId && (
                  <button
                    onClick={() => setSelectedBlockId(null)}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div>
                <h4 className="text-base font-bold text-slate-900">Block {selectedBlock.block_id}</h4>
                <div className="mt-1 flex items-center gap-2">
                  <span
                    className="h-3 w-3 rounded-sm"
                    style={{ background: BLOCK_COLOURS[selectedBlock.level] }}
                  />
                  <span className="font-semibold text-slate-800">
                    {BLOCK_LABELS[selectedBlock.level]}
                  </span>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-y-2 text-xs text-slate-600 border-t border-slate-100 pt-2">
                <div>
                  <dt className="text-[10px] text-slate-400">Total Planted</dt>
                  <dd className="font-bold text-slate-800">{selectedBlock.planted}</dd>
                </div>

                <div>
                  <dt className="text-[10px] text-slate-400">GPS Mapped</dt>
                  <dd className="font-bold text-slate-800">{selectedBlock.located}</dd>
                </div>

                <div>
                  <dt className="text-[10px] text-slate-400">Inspected Count</dt>
                  <dd className="font-bold text-slate-800">
                    {selectedBlock.inspected}
                    {selectedBlock.coverage != null && ` (${Math.round(selectedBlock.coverage * 100)}%)`}
                  </dd>
                </div>

                <div>
                  <dt className="text-[10px] text-slate-400">High Risk / Dead</dt>
                  <dd className="font-bold text-red-600">
                    {selectedBlock.riskShare != null ? `${Math.round(selectedBlock.riskShare * 100)}%` : "—"}
                  </dd>
                </div>
              </dl>

              {blockHref(selectedBlock.block_id) && (
                <Link
                  href={blockHref(selectedBlock.block_id)!}
                  className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                >
                  <span>Open block {selectedBlock.block_id} registry</span>
                  <ChevronRight className="h-4 w-4" />
                </Link>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
