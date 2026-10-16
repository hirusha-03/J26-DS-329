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

/** Zone outline colours on the map. */
export const ZONE_COLOURS: Record<string, string> = {
  A: "#DC2626", // red
  B: "#FACC15", // yellow
  C: "#16A34A", // green
  D: "#2563EB", // blue
};

/**
 * Until boundary/zone GeoJSON is exported from QGIS, the layout is estimated from plant GPS:
 * the boundary hugs the trustworthy fixes with this margin (metres). APPROXIMATE, not surveyed.
 */
export const APPROX_BOUNDARY_PADDING_M = 12;

/** Fixes reported less accurate than this (metres) are network guesses, not GPS: not placed on the map. */
export const MAX_GPS_ACCURACY_M = 100;

/** A fix with no other fix of its zone within this many metres is left out of the outlines (flagged). */
export const ZONE_OUTLIER_M = 75;

/** An estimated zone outline backed by fewer distinct GPS spots than this is labelled low confidence. */
export const MIN_ZONE_SPOTS = 5;
