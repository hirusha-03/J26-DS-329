// Location-aware plant retrieval for the Digital Twin: which registered plants is the user standing near?
// Runs entirely on the device against cached plant coordinates, so it works offline.

import { MAX_GPS_ACCURACY_M } from "./mapConfig";
import type { PlantView } from "./plantStatus";

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface GpsSample {
  latitude: number;
  longitude: number;
  accuracy: number;
  /** ms since the capture started */
  t: number;
}

export interface Fix {
  latitude: number;
  longitude: number;
  /** Reported accuracy of the combined fix (metres, ~68%). */
  accuracy: number;
  samples: GpsSample[];
  /** Time from start to the fix being ready (ms). */
  elapsedMs: number;
}

/**
 * Combines repeated fixes: inverse-variance (1/accuracy²) weighted mean of the samples no worse than
 * twice the best one. The raw samples are kept so raw / mean / weighted can be compared later (E1).
 */
export function combineSamples(samples: GpsSample[]): Omit<Fix, "elapsedMs"> | null {
  if (!samples.length) return null;
  const best = Math.min(...samples.map((s) => s.accuracy));
  const used = samples.filter((s) => s.accuracy <= Math.max(2 * best, best + 2));
  let wSum = 0;
  let lat = 0;
  let lng = 0;
  for (const s of used) {
    const w = 1 / Math.max(s.accuracy, 1) ** 2;
    wSum += w;
    lat += w * s.latitude;
    lng += w * s.longitude;
  }
  return { latitude: lat / wSum, longitude: lng / wSum, accuracy: Math.sqrt(1 / wSum), samples };
}

export interface CaptureOptions {
  /** Stop once this many samples are at least this accurate. */
  targetAccuracyM: number;
  targetSamples: number;
  /** Give up waiting after this long and use what was collected. */
  maxWaitMs: number;
  onSample?: (s: GpsSample, all: GpsSample[]) => void;
  signal?: AbortSignal;
}

/**
 * Collects GPS samples in the foreground only (no background tracking) and combines them.
 * Resolves early when enough accurate samples arrived, or when `signal` aborts ("use now").
 */
export function captureFix(opts: CaptureOptions): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("This device has no GPS / location support."));
      return;
    }
    const start = performance.now();
    const samples: GpsSample[] = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      navigator.geolocation.clearWatch(watchId);
      clearTimeout(timer);
      const fix = combineSamples(samples);
      if (fix) resolve({ ...fix, elapsedMs: Math.round(performance.now() - start) });
      else reject(new Error("No GPS position yet. Step into the open for a moment and try again."));
    };

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const s: GpsSample = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          t: Math.round(performance.now() - start),
        };
        samples.push(s);
        opts.onSample?.(s, samples);
        if (samples.filter((x) => x.accuracy <= opts.targetAccuracyM).length >= opts.targetSamples) finish();
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          done = true;
          navigator.geolocation.clearWatch(watchId);
          clearTimeout(timer);
          reject(new Error("Location permission was denied. Allow location for this app and try again."));
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: opts.maxWaitMs },
    );
    const timer = setTimeout(finish, opts.maxWaitMs);
    opts.signal?.addEventListener("abort", finish);
  });
}

export interface Candidate {
  plant: PlantView;
  distanceM: number;
}

/** All plants with a usable stored coordinate, nearest first. */
export function rankPlants(fix: { latitude: number; longitude: number }, plants: PlantView[]): Candidate[] {
  return plants
    .filter(
      (p) =>
        p.latitude != null && p.longitude != null && (p.accuracy == null || p.accuracy <= MAX_GPS_ACCURACY_M),
    )
    .map((p) => ({ plant: p, distanceM: haversineM(fix.latitude, fix.longitude, p.latitude as number, p.longitude as number) }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

/** Top-k candidates within the tolerance radius; the user confirms which one they are at. */
export function candidatesWithin(ranked: Candidate[], radiusM: number, k: number): Candidate[] {
  return ranked.filter((c) => c.distanceM <= radiusM).slice(0, k);
}

/** Radius / k grid to evaluate (E2). The final values are chosen from the field trials, not assumed. */
export const RADIUS_OPTIONS_M = [3, 5, 8, 12] as const;
export const TOP_K_OPTIONS = [1, 3, 5] as const;
