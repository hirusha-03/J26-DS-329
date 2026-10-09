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

export const SURVEY_PLAN_OVERLAY: { url: string; bounds: [[number, number], [number, number]] } | null = null;

export const STALE_AFTER_DAYS = 45;

export const BLOCK_RULES = {
  minInspectedPlants: 5,
  minCoverage: 0.2,
  watchShare: 0.1,
  concernShare: 0.3,
};

/**
 * GPS fixes outside this box (Sri Lanka) are treated as invalid and not drawn,
 * e.g. test entries or swapped latitude/longitude (Guide step 2 check).
 */
export const VALID_GPS_BOUNDS = { minLat: 5.9, maxLat: 9.9, minLng: 79.5, maxLng: 82.0 };
