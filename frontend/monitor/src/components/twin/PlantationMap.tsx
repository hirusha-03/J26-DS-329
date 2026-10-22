"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import type { Feature, FeatureCollection } from "geojson";
import { useEffect, useMemo, useRef } from "react";
import {
  Circle,
  CircleMarker,
  GeoJSON,
  ImageOverlay,
  LayerGroup,
  LayersControl,
  MapContainer,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import { SATELLITE_TILES, STREET_TILES, SURVEY_PLAN_OVERLAY, ZONE_COLOURS } from "@/lib/mapConfig";
import {
  BLOCK_COLOURS,
  BLOCK_LABELS,
  HOTSPOT_CAUSE_COLOURS,
  HOTSPOT_CAUSE_LABELS,
  STATUS_COLOURS,
  STATUS_LABELS,
  showAsEstimated,
  type BlockSummary,
  type HotspotCluster,
  type PlantationGeo,
  type PlantView,
} from "@/lib/plantStatus";

interface Props {
  geo: PlantationGeo;
  plants: PlantView[];
  blocks: Record<string, BlockSummary>;
  hotspots?: HotspotCluster[];
  hotspotOnly?: boolean;
  /** Zone outlines: QGIS zones.geojson, or approximate outlines from plant GPS. */
  zones: FeatureCollection | null;
  zonesApproximate: boolean;
  /** Plant id -> why its GPS fix is doubtful (shown in the marker tooltip). */
  gpsNotes?: Record<string, string>;
  selectedPlantId: string | null;
  selectedBlockId: string | null;
  onSelectPlant: (id: string) => void;
  onSelectBlock: (id: string) => void;
}

/** Zooms to the plantation once data has loaded (not on every filter change). */
function FitToPlantation({ geo, plants }: { geo: PlantationGeo; plants: PlantView[] }) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    const layer = geo.boundary ?? geo.blocks;
    let bounds = layer ? L.geoJSON(layer).getBounds() : null;
    if (!bounds?.isValid()) {
      const pts = plants
        .filter((p) => p.latitude != null && p.longitude != null)
        .map((p) => [p.latitude, p.longitude] as [number, number]);
      bounds = pts.length ? L.latLngBounds(pts) : null;
    }
    if (bounds?.isValid()) {
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 19 });
      fitted.current = true;
    }
  }, [geo, plants, map]);
  return null;
}

export default function PlantationMap({
  geo,
  plants,
  blocks,
  hotspots = [],
  hotspotOnly = false,
  zones,
  zonesApproximate,
  gpsNotes = {},
  selectedPlantId,
  selectedBlockId,
  onSelectPlant,
  onSelectBlock,
}: Props) {
  const located = plants.filter((p) => p.latitude != null && p.longitude != null);

  const blockKey = useMemo(
    () => Object.values(blocks).map((b) => `${b.block_id}:${b.level}`).join("|") + `|${selectedBlockId}`,
    [blocks, selectedBlockId],
  );

  const blockStyle = (f?: Feature) => {
    const id = f?.properties?.block_id as string | undefined;
    const level = (id && blocks[id]?.level) || "no-data";
    const insufficient = level === "insufficient" || level === "no-data";
    return {
      color: id === selectedBlockId ? "#ffffff" : "#f8fafc",
      weight: id === selectedBlockId ? 3 : 1.2,
      dashArray: insufficient ? "4 4" : undefined,
      fillColor: BLOCK_COLOURS[level],
      fillOpacity: insufficient ? 0.15 : 0.45,
    };
  };

  const onEachBlock = (f: Feature, layer: L.Layer) => {
    const id = f.properties?.block_id as string | undefined;
    if (!id) return;
    const s = blocks[id];
    const detail = s
      ? `${BLOCK_LABELS[s.level]} · ${s.inspected}/${s.planted} inspected` +
        (s.riskShare != null ? ` · ${Math.round(s.riskShare * 100)}% high risk/dead` : "")
      : "No data";
    layer.bindTooltip(`<b>Block ${id}</b><br/>${detail}`, { sticky: true });
    layer.on("click", () => onSelectBlock(id));
  };

  const zonesKey = useMemo(
    () => (zones?.features ?? []).map((f) => `${f.properties?.zone}:${f.geometry?.type}`).join("|"),
    [zones],
  );

  const zoneStyle = (f?: Feature) => {
    const name = f?.properties?.zone as string | undefined;
    const colour = (name && ZONE_COLOURS[name]) || "#ffffff";
    return {
      color: colour,
      weight: 2.5,
      dashArray: "6 6",
      fillColor: colour,
      fillOpacity: 0.06,
    };
  };

  const onEachZone = (f: Feature, layer: L.Layer) => {
    const name = f.properties?.zone;
    if (!name) return;
    layer.bindTooltip(`Zone ${name}`, { permanent: true, direction: "center", className: "zone-label" });
  };

  return (
    <MapContainer center={[7.8731, 80.7718]} zoom={8} maxZoom={22} className="h-full min-h-[480px] w-full rounded-xl">
      <FitToPlantation geo={geo} plants={plants} />

      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Satellite">
          <TileLayer {...SATELLITE_TILES} maxZoom={22} />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Street map">
          <TileLayer {...STREET_TILES} maxZoom={22} />
        </LayersControl.BaseLayer>

        {SURVEY_PLAN_OVERLAY && (
          <LayersControl.Overlay name="Survey Plan No. 61">
            <ImageOverlay url={SURVEY_PLAN_OVERLAY.url} bounds={SURVEY_PLAN_OVERLAY.bounds} opacity={0.7} />
          </LayersControl.Overlay>
        )}

        {geo.blocks && (
          <LayersControl.Overlay checked name="Blocks (status)">
            <GeoJSON key={blockKey} data={geo.blocks} style={blockStyle} onEachFeature={onEachBlock} />
          </LayersControl.Overlay>
        )}

        {geo.boundary && (
          <LayersControl.Overlay checked name="Plantation boundary">
            <GeoJSON
              data={geo.boundary}
              style={{ color: "#fde047", weight: 3, fill: false }}
              interactive={false}
            />
          </LayersControl.Overlay>
        )}

        {zones && (
          <LayersControl.Overlay checked name={zonesApproximate ? "Zones (approx. from GPS)" : "Zones"}>
            <GeoJSON
              key={`${zonesKey}-${zonesApproximate}`}
              data={zones}
              style={zoneStyle}
              onEachFeature={onEachZone}
              interactive={false}
            />
          </LayersControl.Overlay>
        )}

        {/* Spatial Health Hotspots Layer (DBSCAN + Cause Triage) */}
        {hotspotOnly && hotspots.length > 0 && (
          <LayersControl.Overlay checked name="Health Risk Clusters">
            <LayerGroup>
              {hotspots.map((h) => {
                const color = HOTSPOT_CAUSE_COLOURS[h.likely_cause] || "#ef4444";
                return (
                  <LayerGroup key={h.hotspot_id}>
                    <Circle
                      center={[h.centroid_lat, h.centroid_lon]}
                      radius={h.radius_m}
                      pathOptions={{
                        color: color,
                        fillColor: color,
                        fillOpacity: 0.18,
                        weight: 2.5,
                        dashArray: "6 6",
                      }}
                    >
                      {/* Hotspot banner: shows permanently ONLY when Hotspots Only button is clicked */}
                      {hotspotOnly ? (
                        <Tooltip key={`tt-${h.hotspot_id}-perm`} permanent direction="top" opacity={0.95}>
                          <div className="rounded bg-white/95 px-2 py-1 shadow-md border border-slate-200 text-xs">
                            <span className="font-bold flex items-center gap-1 text-slate-900">
                              🔥 {h.hotspot_id}: {HOTSPOT_CAUSE_LABELS[h.likely_cause] || h.likely_cause}
                            </span>
                            <span className="text-[10px] text-slate-600 block">
                              {h.n_members} vines · {h.status} ({Math.round(h.area_m2)} m²)
                              {h.referred_to_module1 && (
                                <strong className="text-rose-600 font-bold block mt-0.5">
                                  ⚠️ Referred to Module 1 (Disease Diagnosis)
                                </strong>
                              )}
                            </span>
                          </div>
                        </Tooltip>
                      ) : (
                        <Tooltip key={`tt-${h.hotspot_id}-hover`} direction="top" opacity={0.95}>
                          <div className="rounded bg-white/95 px-2 py-1 shadow-md border border-slate-200 text-xs">
                            <span className="font-bold flex items-center gap-1 text-slate-900">
                              🔥 {h.hotspot_id}: {HOTSPOT_CAUSE_LABELS[h.likely_cause] || h.likely_cause}
                            </span>
                            <span className="text-[10px] text-slate-600 block">
                              {h.n_members} vines · {h.status} ({Math.round(h.area_m2)} m²)
                              {h.referred_to_module1 && (
                                <strong className="text-rose-600 font-bold block mt-0.5">
                                  ⚠️ Referred to Module 1 (Disease Diagnosis)
                                </strong>
                              )}
                            </span>
                          </div>
                        </Tooltip>
                      )}
                    </Circle>
                  </LayerGroup>
                );
              })}
            </LayerGroup>
          </LayersControl.Overlay>
        )}

        <LayersControl.Overlay checked name="Plants (latest inspection)">
          <LayerGroup>
            {located.map((p) => {
              const selected = p.plant_id === selectedPlantId;
              const note = gpsNotes[p.plant_id];
              const estimated = showAsEstimated(p);
              const hotspotColor = HOTSPOT_CAUSE_COLOURS[p.hotspot_cause || "likely_disease"] || "#ef4444";

              const pathOptions = estimated
                ? {
                    color: selected ? "#ffffff" : note ? "#f97316" : p.in_hotspot ? hotspotColor : STATUS_COLOURS[p.status],
                    weight: selected ? 3 : 2,
                    dashArray: "3 3",
                    fillColor: STATUS_COLOURS[p.status],
                    fillOpacity: 0.08,
                  }
                : {
                    color: selected ? "#ffffff" : note ? "#f97316" : p.in_hotspot ? hotspotColor : "#111827",
                    weight: selected ? 3 : p.in_hotspot ? 2 : note ? 2 : 1,
                    fillColor: STATUS_COLOURS[p.status],
                    fillOpacity: p.stale ? 0.35 : 0.95,
                  };

              return (
                <LayerGroup key={p.plant_id}>
                  {hotspotOnly && p.in_hotspot && (
                    <CircleMarker
                      center={[p.latitude as number, p.longitude as number]}
                      radius={selected ? 13 : 9}
                      pathOptions={{
                        color: hotspotColor,
                        weight: 2,
                        dashArray: "3 3",
                        fillColor: hotspotColor,
                        fillOpacity: 0.25,
                      }}
                      interactive={false}
                    />
                  )}

                  <CircleMarker
                    center={[p.latitude as number, p.longitude as number]}
                    radius={selected ? 9 : p.in_hotspot ? 6 : 5}
                    pathOptions={pathOptions}
                    eventHandlers={{ click: () => onSelectPlant(p.plant_id) }}
                  >
                    <Tooltip>
                      <div className="space-y-0.5 text-xs">
                        <div className="font-bold flex items-center gap-1">
                          {p.in_hotspot && <span>🔥</span>}
                          {p.plant_id} · {STATUS_LABELS[p.status]}
                        </div>
                        {p.in_hotspot && (
                          <div className="text-[10px] font-bold text-rose-600">
                            Spatial Hotspot #{p.hotspot_cluster_id}: {HOTSPOT_CAUSE_LABELS[p.hotspot_cause || ""] || "Active Cluster"}
                          </div>
                        )}
                        {p.health_class && (
                          <div className="text-[10px] text-slate-600">
                            ML Model: {p.health_class} ({Math.round((p.health_probability || 0) * 100)}% conf)
                          </div>
                        )}
                        {p.trend && (
                          <div className="text-[10px] text-slate-500">
                            Trend: {p.trend} {p.trend_slope != null ? `(${p.trend_slope > 0 ? "+" : ""}${p.trend_slope})` : ""}
                          </div>
                        )}
                        {p.daysSinceInspection != null && (
                          <div className="text-[10px] text-slate-400">
                            {p.daysSinceInspection} days ago {p.stale ? "(stale)" : ""}
                          </div>
                        )}
                        {estimated && (
                          <div className="text-[10px] text-amber-600">
                            Estimated position, needs GPS re-capture
                          </div>
                        )}
                        {p.movedIntoZoneM != null && (
                          <div className="text-[10px] text-slate-500">
                            Drawn inside Zone {p.zone}; recorded position is {p.movedIntoZoneM} m away
                          </div>
                        )}
                        {note && (
                          <div className="text-[10px] text-orange-600 font-semibold">
                            GPS doubtful: {note}
                          </div>
                        )}
                      </div>
                    </Tooltip>
                  </CircleMarker>
                </LayerGroup>
              );
            })}
          </LayerGroup>
        </LayersControl.Overlay>
      </LayersControl>
    </MapContainer>
  );
}
