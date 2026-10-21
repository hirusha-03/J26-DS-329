"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import type { Feature, FeatureCollection } from "geojson";
import { useEffect, useMemo, useRef } from "react";
import {
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
import { MIN_ZONE_SPOTS, SATELLITE_TILES, STREET_TILES, SURVEY_PLAN_OVERLAY, ZONE_COLOURS } from "@/lib/mapConfig";
import {
  BLOCK_COLOURS,
  BLOCK_LABELS,
  STATUS_COLOURS,
  STATUS_LABELS,
  isEstimated,
  type BlockSummary,
  type PlantationGeo,
  type PlantView,
} from "@/lib/plantStatus";

interface Props {
  geo: PlantationGeo;
  plants: PlantView[];
  blocks: Record<string, BlockSummary>;
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

  const zoneStyle = (f?: Feature) => {
    const colour = ZONE_COLOURS[f?.properties?.zone as string] ?? "#ffffff";
    return {
      color: colour,
      weight: 2.5,
      dashArray: zonesApproximate ? "8 6" : undefined,
      fillColor: colour,
      fillOpacity: 0.22,
    };
  };

  const onEachZone = (f: Feature, layer: L.Layer) => {
    const zone = f.properties?.zone;
    const spots = f.properties?.spots as number | undefined;
    const rough = spots != null && spots < MIN_ZONE_SPOTS ? `<br/><small>rough: ${spots} GPS spot${spots === 1 ? "" : "s"}</small>` : "";
    if (zone) layer.bindTooltip(`Zone ${zone}${rough}`, { permanent: true, direction: "center", className: "zone-label" });
  };

  // Remount when the outline set changes (react-leaflet's <GeoJSON> ignores new data).
  const zonesKey = useMemo(() => JSON.stringify(zones?.features.map((f) => f.geometry) ?? null), [zones]);
  const boundaryKey = useMemo(() => JSON.stringify(geo.boundary?.features.map((f) => f.geometry) ?? null), [geo.boundary]);

  return (
    <MapContainer center={[7.8731, 80.7718]} zoom={8} maxZoom={22} className="h-full w-full">
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

        {/* Boundary first (beneath the zones): a wide casing that stays visible around the zone fills. */}
        {geo.boundary && (
          <LayersControl.Overlay checked name="Plantation boundary">
            <GeoJSON
              key={boundaryKey}
              data={geo.boundary}
              style={(f) => ({
                color: "#fde047",
                weight: 7,
                opacity: 0.9,
                dashArray: f?.properties?.approximate ? "14 8" : undefined,
                fill: false,
              })}
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

        <LayersControl.Overlay checked name="Plants (latest inspection)">
          <LayerGroup>
            {located.map((p) => {
              const selected = p.plant_id === selectedPlantId;
              const note = gpsNotes[p.plant_id];
              const estimated = isEstimated(p);
              // Estimated positions: hollow dashed ring in the status colour (solid fill = GPS fix).
              const pathOptions = estimated
                ? {
                    color: selected ? "#ffffff" : note ? "#f97316" : STATUS_COLOURS[p.status],
                    weight: selected ? 3 : 2,
                    dashArray: "3 3",
                    fillColor: STATUS_COLOURS[p.status],
                    fillOpacity: 0.08,
                  }
                : {
                    color: selected ? "#ffffff" : note ? "#f97316" : "#111827",
                    weight: selected ? 3 : note ? 2 : 1,
                    fillColor: STATUS_COLOURS[p.status],
                    fillOpacity: p.stale ? 0.35 : 0.95,
                  };
              return (
                <CircleMarker
                  key={p.plant_id}
                  center={[p.latitude as number, p.longitude as number]}
                  radius={selected ? 9 : 5}
                  pathOptions={pathOptions}
                  eventHandlers={{ click: () => onSelectPlant(p.plant_id) }}
                >
                  <Tooltip>
                    <b>{p.plant_id}</b> · {STATUS_LABELS[p.status]}
                    {p.daysSinceInspection != null && ` · ${p.daysSinceInspection} days ago`}
                    {p.stale && " (stale)"}
                    {estimated && (
                      <>
                        <br />
                        Estimated position, needs GPS re-capture
                      </>
                    )}
                    {p.movedIntoZoneM != null && (
                      <>
                        <br />
                        Drawn inside Zone {p.zone}; recorded position is {p.movedIntoZoneM} m away
                      </>
                    )}
                    {note && (
                      <>
                        <br />
                        GPS doubtful: {note}
                      </>
                    )}
                  </Tooltip>
                </CircleMarker>
              );
            })}
          </LayerGroup>
        </LayersControl.Overlay>
      </LayersControl>
    </MapContainer>
  );
}
