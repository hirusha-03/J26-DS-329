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
import { SATELLITE_TILES, STREET_TILES, SURVEY_PLAN_OVERLAY } from "@/lib/mapConfig";
import {
  BLOCK_COLOURS,
  BLOCK_LABELS,
  STATUS_COLOURS,
  STATUS_LABELS,
  type BlockSummary,
  type PlantationGeo,
  type PlantView,
} from "@/lib/plantStatus";

interface Props {
  geo: PlantationGeo;
  plants: PlantView[];
  blocks: Record<string, BlockSummary>;
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

  const onEachZone = (f: Feature, layer: L.Layer) => {
    const zone = f.properties?.zone;
    if (zone) layer.bindTooltip(`Zone ${zone}`, { permanent: true, direction: "center", className: "zone-label" });
  };

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

        {geo.zones && (
          <LayersControl.Overlay checked name="Zones">
            <GeoJSON
              data={geo.zones as FeatureCollection}
              style={{ color: "#ffffff", weight: 3, fill: false }}
              onEachFeature={onEachZone}
              interactive={false}
            />
          </LayersControl.Overlay>
        )}

        {geo.boundary && (
          <LayersControl.Overlay checked name="Plantation boundary">
            <GeoJSON data={geo.boundary} style={{ color: "#fde047", weight: 3, fill: false }} interactive={false} />
          </LayersControl.Overlay>
        )}

        <LayersControl.Overlay checked name="Plants (latest inspection)">
          <LayerGroup>
            {located.map((p) => {
              const selected = p.plant_id === selectedPlantId;
              return (
                <CircleMarker
                  key={p.plant_id}
                  center={[p.latitude as number, p.longitude as number]}
                  radius={selected ? 9 : 5}
                  pathOptions={{
                    color: selected ? "#ffffff" : "#111827",
                    weight: selected ? 3 : 1,
                    fillColor: STATUS_COLOURS[p.status],
                    fillOpacity: p.stale ? 0.35 : 0.95,
                  }}
                  eventHandlers={{ click: () => onSelectPlant(p.plant_id) }}
                >
                  <Tooltip>
                    <b>{p.plant_id}</b> · {STATUS_LABELS[p.status]}
                    {p.daysSinceInspection != null && ` · ${p.daysSinceInspection} days ago`}
                    {p.stale && " (stale)"}
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
