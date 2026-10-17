// Map settings for the Digital Twin plantation map.
// Values marked PROVISIONAL must be agreed with the agronomist before they are reported.

export const SATELLITE_TILES = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  maxNativeZoom: 19, // Esri has no real imagery deeper than this in most rural areas
};

export const STREET_TILES = {
  url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "&copy; OpenStreetMap contributors",
  maxNativeZoom: 19,
};

/**
 * Georeferenced Survey Plan No. 61, exported from QGIS (Guide step 5.3).
 * bounds = [[south, west], [north, east]] in decimal degrees (EPSG:4326).
 * Leave as null until you have exported the PNG.
 */
export const SURVEY_PLAN_OVERLAY: { url: string; bounds: [[number, number], [number, number]] } | null = null;
// Example: { url: "/geo/survey_plan_61.png", bounds: [[7.12345, 80.12345], [7.12789, 80.12999]] }

/** A plant whose latest inspection is older than this is drawn faded ("stale"). */
export const STALE_AFTER_DAYS = 45;

/** Block colouring rules (PROVISIONAL). */
export const BLOCK_RULES = {
  minInspectedPlants: 5, // fewer inspected plants than this -> "insufficient data"
  minCoverage: 0.2, // inspected / planted below this -> "insufficient data"
  watchShare: 0.1, // high-risk + dead share at or above this -> "watch"
  concernShare: 0.3, // ... at or above this -> "concern"
};
