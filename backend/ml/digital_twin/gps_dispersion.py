"""E1 — GPS dispersion under canopy (RQ1): does repeated-fix averaging beat a single smartphone fix?

Input: rows of plant_location_observations (slot_id, session_id, latitude, longitude, accuracy,
captured_at), from a CSV exported by the GPS Re-capture page or downloaded from Supabase.

There is no surveyed ground truth for each vine, so accuracy is measured as *repeatability*: a position
estimated from one session is compared with the position from a *different* session of the same slot
(taken at another time). An estimator that is closer to the independent session is more reliable.

Per slot with >= 2 sessions, for every ordered pair (A, B):
    reference  = accuracy-weighted mean of all fixes in session B
    error(est) = distance(est(session A), reference)
for est in: raw (first fix), mean, weighted_mean, median, kalman (static, see below), and the mean of
the first k fixes (convergence curve). The slot's original single fix ("legacy-<slot>" session) is
scored against the weighted mean of all of the slot's real sessions.

Within-session spread (CEP50 / CEP95 / RMS around the session mean) uses the same definitions as
frontend/monitor/src/lib/gpsStats.ts.

Rule from the plan: a filter (e.g. Kalman) is kept only if it lowers the error compared with the
plain mean / weighted mean.

Usage:
    python gps_dispersion.py observations.csv [--out results_dir]
    python gps_dispersion.py --supabase [--out results_dir]     # needs SUPABASE_URL + SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

M_PER_DEG_LAT = 111_320.0
ESTIMATORS = ("raw", "mean", "weighted_mean", "median", "kalman")


@dataclass
class Fix:
    lat: float
    lng: float
    acc: float
    t: str


# ── Geometry and estimators (mirror gpsStats.ts) ──────────────────────────────


def to_local(lat: np.ndarray, lng: np.ndarray, lat0: float, lng0: float) -> np.ndarray:
    mx = M_PER_DEG_LAT * math.cos(math.radians(lat0))
    return np.column_stack(((np.asarray(lng) - lng0) * mx, (np.asarray(lat) - lat0) * M_PER_DEG_LAT))


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    xy = to_local(np.array([a[0]]), np.array([a[1]]), b[0], b[1])[0]
    return float(np.hypot(*xy))


def estimate(fixes: list[Fix], method: str, kalman_q: float = 0.0) -> tuple[float, float]:
    lat = np.array([f.lat for f in fixes])
    lng = np.array([f.lng for f in fixes])
    acc = np.maximum(np.array([f.acc for f in fixes]), 1.0)
    if method == "raw":
        return float(lat[0]), float(lng[0])
    if method == "mean":
        return float(lat.mean()), float(lng.mean())
    if method == "weighted_mean":
        w = 1.0 / acc**2
        return float((w * lat).sum() / w.sum()), float((w * lng).sum() / w.sum())
    if method == "median":
        return float(np.median(lat)), float(np.median(lng))
    if method == "kalman":
        # Static-position Kalman filter in local metres: state = position, measurement variance =
        # reported accuracy², process noise q (m² per step) lets the estimate drift. With q = 0 it is
        # exactly the accuracy-weighted mean, so it can only differ (and only be kept) when q > 0 helps.
        xy = to_local(lat, lng, lat[0], lng[0])
        x, p = xy[0].copy(), acc[0] ** 2
        for z, r in zip(xy[1:], acc[1:] ** 2):
            p += kalman_q
            k = p / (p + r)
            x = x + k * (z - x)
            p = (1 - k) * p
        mx = M_PER_DEG_LAT * math.cos(math.radians(lat[0]))
        return float(lat[0] + x[1] / M_PER_DEG_LAT), float(lng[0] + x[0] / mx)
    raise ValueError(method)


def spread(fixes: list[Fix]) -> dict[str, float]:
    c = estimate(fixes, "mean")
    xy = to_local(np.array([f.lat for f in fixes]), np.array([f.lng for f in fixes]), *c)
    d = np.hypot(xy[:, 0], xy[:, 1])
    return {
        "n": len(fixes),
        "cep50_m": float(np.percentile(d, 50)),
        "cep95_m": float(np.percentile(d, 95)),
        "rms_m": float(np.sqrt((d**2).mean())),
        "median_reported_accuracy_m": float(np.median([f.acc for f in fixes])),
    }


def summarise(errors: list[float]) -> dict[str, float | int | None]:
    if not errors:
        return {"n": 0, "median_m": None, "cep50_m": None, "cep95_m": None, "rms_m": None}
    e = np.array(errors)
    return {
        "n": len(e),
        "median_m": float(np.median(e)),
        "cep50_m": float(np.percentile(e, 50)),
        "cep95_m": float(np.percentile(e, 95)),
        "rms_m": float(np.sqrt((e**2).mean())),
    }


# ── Loading ───────────────────────────────────────────────────────────────────


def load_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_supabase() -> list[dict]:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY).")
    rows, page = [], 1000
    while True:
        req = urllib.request.Request(
            f"{url}/rest/v1/plant_location_observations?select=slot_id,session_id,latitude,longitude,accuracy,captured_at"
            f"&order=captured_at&offset={len(rows)}&limit={page}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req) as r:
            batch = json.load(r)
        rows += batch
        if len(batch) < page:
            return rows


def group(rows: list[dict]) -> dict[str, dict[str, list[Fix]]]:
    """slot -> session -> fixes (time order)."""
    out: dict[str, dict[str, list[Fix]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        try:
            fix = Fix(float(r["latitude"]), float(r["longitude"]), float(r["accuracy"] or 999), str(r.get("captured_at", "")))
        except (TypeError, ValueError):
            continue
        out[r["slot_id"]][r["session_id"]].append(fix)
    for sessions in out.values():
        for fixes in sessions.values():
            fixes.sort(key=lambda f: f.t)
    return out


# ── Analysis ──────────────────────────────────────────────────────────────────


def analyse(data: dict[str, dict[str, list[Fix]]], kalman_q: float, max_k: int) -> dict:
    session_rows = []
    errors: dict[str, list[float]] = {m: [] for m in ESTIMATORS}
    by_k: dict[int, list[float]] = defaultdict(list)
    legacy_err: list[float] = []
    paired = []  # (slot, A, B, raw_err, weighted_err)

    for slot, sessions in sorted(data.items()):
        real = {s: f for s, f in sessions.items() if not s.startswith("legacy-")}
        for s, fixes in real.items():
            session_rows.append({"slot_id": slot, "session_id": s, **spread(fixes)})

        if len(real) >= 2:
            for a, fa in real.items():
                for b, fb in real.items():
                    if a == b:
                        continue
                    ref = estimate(fb, "weighted_mean")
                    errs = {m: dist_m(estimate(fa, m, kalman_q), ref) for m in ESTIMATORS}
                    for m, e in errs.items():
                        errors[m].append(e)
                    for k in range(1, min(max_k, len(fa)) + 1):
                        by_k[k].append(dist_m(estimate(fa[:k], "mean"), ref))
                    paired.append((slot, a, b, errs["raw"], errs["weighted_mean"]))

        legacy = [f for s, fs in sessions.items() if s.startswith("legacy-") for f in fs]
        if legacy and real:
            ref = estimate([f for fs in real.values() for f in fs], "weighted_mean")
            legacy_err.append(dist_m((legacy[0].lat, legacy[0].lng), ref))

    result = {
        "slots": len(data),
        "slots_with_2plus_sessions": sum(1 for s in data.values() if sum(not k.startswith("legacy-") for k in s) >= 2),
        "sessions": len(session_rows),
        "within_session_spread": summarise_spread(session_rows),
        "cross_session_error": {m: summarise(errors[m]) for m in ESTIMATORS},
        "mean_of_first_k": {k: summarise(v) for k, v in sorted(by_k.items())},
        "legacy_single_fix_error": summarise(legacy_err),
        "kalman_q_m2": kalman_q,
    }
    result["paired_raw_vs_weighted"] = paired_test(paired)
    best_plain = min(("mean", "weighted_mean"), key=lambda m: result["cross_session_error"][m]["median_m"] or math.inf)
    k_med = result["cross_session_error"]["kalman"]["median_m"]
    p_med = result["cross_session_error"][best_plain]["median_m"]
    result["keep_kalman"] = bool(k_med is not None and p_med is not None and k_med < p_med)
    return result | {"_session_rows": session_rows}


def summarise_spread(rows: list[dict]) -> dict:
    if not rows:
        return {}
    return {k: float(np.median([r[k] for r in rows])) for k in ("cep50_m", "cep95_m", "rms_m", "median_reported_accuracy_m")}


def paired_test(paired: list[tuple]) -> dict:
    """Wilcoxon signed-rank (raw error − weighted error) if SciPy is available; otherwise sign counts."""
    if not paired:
        return {"n": 0}
    diff = np.array([p[3] - p[4] for p in paired])
    out = {"n": len(diff), "median_improvement_m": float(np.median(diff)), "weighted_better_share": float((diff > 0).mean())}
    try:
        from scipy.stats import wilcoxon

        if np.any(diff != 0):
            stat, p = wilcoxon(diff, alternative="greater")
            out |= {"wilcoxon_statistic": float(stat), "p_value": float(p)}
    except ImportError:
        out["note"] = "Install scipy for the Wilcoxon signed-rank test."
    return out


def report(res: dict) -> str:
    def fmt(v):
        return "—" if v is None else f"{v:.2f}"

    lines = [
        "# E1 — GPS dispersion results",
        "",
        f"Slots: {res['slots']} · with ≥2 sessions: {res['slots_with_2plus_sessions']} · sessions: {res['sessions']}",
        "",
        "## Within-session spread (median over sessions)",
        "",
    ]
    for k, v in res["within_session_spread"].items():
        lines.append(f"- {k}: {v:.2f}")
    lines += ["", "## Cross-session error by estimator (m)", "", "| Estimator | n | median | CEP95 | RMS |", "|---|---|---|---|---|"]
    for m, s in res["cross_session_error"].items():
        lines.append(f"| {m} | {s['n']} | {fmt(s['median_m'])} | {fmt(s['cep95_m'])} | {fmt(s['rms_m'])} |")
    lines += ["", "## Mean of the first k fixes (m)", "", "| k | median | CEP95 |", "|---|---|---|"]
    for k, s in res["mean_of_first_k"].items():
        lines.append(f"| {k} | {fmt(s['median_m'])} | {fmt(s['cep95_m'])} |")
    lg = res["legacy_single_fix_error"]
    pt = res["paired_raw_vs_weighted"]
    lines += [
        "",
        f"Original single fix vs re-captured position: n={lg['n']}, median {fmt(lg['median_m'])} m, CEP95 {fmt(lg['cep95_m'])} m",
        "",
        f"Paired raw − weighted: n={pt.get('n', 0)}, median improvement {fmt(pt.get('median_improvement_m'))} m, "
        f"weighted better in {fmt((pt.get('weighted_better_share') or 0) * 100)}% of pairs"
        + (f", Wilcoxon p={pt['p_value']:.4f}" if "p_value" in pt else ""),
        "",
        f"Kalman (q={res['kalman_q_m2']} m²/step) kept: {'yes' if res['keep_kalman'] else 'no — not better than the plain mean'}",
    ]
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="?", type=Path)
    ap.add_argument("--supabase", action="store_true")
    ap.add_argument("--out", type=Path, default=Path("results/e1_gps"))
    ap.add_argument("--kalman-q", type=float, default=0.5)
    ap.add_argument("--max-k", type=int, default=10)
    a = ap.parse_args()
    if not a.csv and not a.supabase:
        ap.error("give a CSV file or --supabase")

    rows = load_supabase() if a.supabase else load_csv(a.csv)
    res = analyse(group(rows), a.kalman_q, a.max_k)
    a.out.mkdir(parents=True, exist_ok=True)
    session_rows = res.pop("_session_rows")
    with (a.out / "sessions.csv").open("w", newline="", encoding="utf-8") as f:
        if session_rows:
            w = csv.DictWriter(f, fieldnames=list(session_rows[0]))
            w.writeheader()
            w.writerows(session_rows)
    (a.out / "summary.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    text = report(res)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    (a.out / "report.md").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
