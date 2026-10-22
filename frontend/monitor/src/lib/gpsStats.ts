// Position estimates and dispersion for a session of repeated GPS fixes (WS2 / experiment E1).
// The same definitions are used by backend/ml/digital_twin/gps_dispersion.py.

export interface LatLngAcc {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export type Estimator = "raw" | "mean" | "weighted_mean" | "median";

export const ESTIMATOR_LABELS: Record<Estimator, string> = {
  raw: "Single fix (first)",
  mean: "Mean",
  weighted_mean: "Accuracy-weighted mean",
  median: "Median",
};

const M_PER_DEG_LAT = 111_320;

/** Metres east / north of `origin` (equirectangular; exact enough within a plantation). */
export function toLocal(p: { latitude: number; longitude: number }, origin: { latitude: number; longitude: number }): [number, number] {
  const mx = M_PER_DEG_LAT * Math.cos((origin.latitude * Math.PI) / 180);
  return [(p.longitude - origin.longitude) * mx, (p.latitude - origin.latitude) * M_PER_DEG_LAT];
}

export function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const [x, y] = toLocal(a, b);
  return Math.hypot(x, y);
}

const medianOf = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Linear-interpolated percentile (q in 0..1). */
export function percentile(v: number[], q: number): number {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function estimate(samples: LatLngAcc[], method: Estimator): { latitude: number; longitude: number } {
  if (!samples.length) throw new Error("No samples");
  switch (method) {
    case "raw":
      return { latitude: samples[0].latitude, longitude: samples[0].longitude };
    case "mean":
      return {
        latitude: samples.reduce((a, s) => a + s.latitude, 0) / samples.length,
        longitude: samples.reduce((a, s) => a + s.longitude, 0) / samples.length,
      };
    case "weighted_mean": {
      let w = 0;
      let lat = 0;
      let lng = 0;
      for (const s of samples) {
        const wi = 1 / Math.max(s.accuracy, 1) ** 2;
        w += wi;
        lat += wi * s.latitude;
        lng += wi * s.longitude;
      }
      return { latitude: lat / w, longitude: lng / w };
    }
    case "median":
      return { latitude: medianOf(samples.map((s) => s.latitude)), longitude: medianOf(samples.map((s) => s.longitude)) };
  }
}

export interface Dispersion {
  n: number;
  /** Radius around the session mean holding 50% / 95% of the fixes (m). */
  cep50: number;
  cep95: number;
  /** Root-mean-square distance from the session mean (m). */
  rms: number;
  /** Median of the accuracies the phone reported (m). */
  medianReportedAccuracy: number;
}

export function dispersion(samples: LatLngAcc[]): Dispersion {
  const c = estimate(samples, "mean");
  const d = samples.map((s) => distanceM(s, c));
  return {
    n: samples.length,
    cep50: percentile(d, 0.5),
    cep95: percentile(d, 0.95),
    rms: Math.sqrt(d.reduce((a, x) => a + x * x, 0) / d.length),
    medianReportedAccuracy: medianOf(samples.map((s) => s.accuracy)),
  };
}
