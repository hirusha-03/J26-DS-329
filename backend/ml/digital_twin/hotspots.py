"""Spatial plant health hotspots: anomalies → spatial test → Haversine-DBSCAN → tracking → cause triage.

Module 2 detects and triages; it does not diagnose. Hotspots triaged as likely disease are referred
to Module 1 for image-based identification. Every threshold here is a starting proposal to be agreed
with Mr. Kodikara, and the triage keeps an "uncertain" class because yellowing is not unique to
nutrient deficiency and no nutrient was measured directly.
"""
from __future__ import annotations

from math import comb

import numpy as np
import pandas as pd
from pyproj import Transformer
from scipy.spatial import ConvexHull, QhullError
from scipy.stats import mannwhitneyu
from sklearn.cluster import DBSCAN
from sklearn.ensemble import IsolationForest

R_EARTH = 6_371_000.0
FOLIAGE_ORD = {"Green": 0, "Mixed": 1, "Yellow": 2, "Brown": 3}
SELF_VARS = ["soil_ph", "soil_ec", "moisture", "growth_cm_wk"]
# Smallest change worth calling a change (meter resolution). Stops a perfectly flat history (MAD = 0)
# from turning a 0.1 pH step into an infinite z-score.
MAD_FLOOR = {"soil_ph": 0.1, "soil_ec": 0.01, "moisture": 1.0, "growth_cm_wk": 2.0}
Z_LIMIT = 3.0
SOIL_OK = {"soil_ph": (5.5, 7.0), "soil_ec_min": 0.03, "moisture": (4, 9)}
_TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32644", always_xy=True)   # UTM 44N covers Sri Lanka


# ── distances ────────────────────────────────────────────────────────────────

def haversine_matrix(lat, lon):
    la, lo = np.radians(np.asarray(lat, float))[:, None], np.radians(np.asarray(lon, float))[:, None]
    a = np.sin((la - la.T) / 2) ** 2 + np.cos(la) * np.cos(la.T) * np.sin((lo - lo.T) / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def haversine_m(lat1, lon1, lat2, lon2):
    return float(haversine_matrix([lat1, lat2], [lon1, lon2])[0, 1])


def to_utm(lat, lon):
    x, y = _TO_UTM.transform(np.asarray(lon, float), np.asarray(lat, float))
    return np.asarray(x), np.asarray(y)


# ── 1. one stable coordinate per plant ──────────────────────────────────────

def stable_coordinates(fixes, max_accuracy_m=10.0, outlier_sd=3.0):
    """fixes: plant_id, latitude, longitude, accuracy (one or more rows per plant).

    Drops fixes reported worse than max_accuracy_m, then fixes more than outlier_sd robust SDs from the
    plant's median position, and returns the median of what is left plus its spread (median distance of
    the kept fixes from that point). Also returns a log of what was dropped and why."""
    f = fixes.dropna(subset=["latitude", "longitude"]).copy()
    log = []
    poor = f["accuracy"].isna() | (f["accuracy"] > max_accuracy_m)
    log += [(p, "accuracy worse than limit or unknown") for p in f.loc[poor, "plant_id"]]
    f = f[~poor]
    rows = []
    for pid, g in f.groupby("plant_id"):
        lat0, lon0 = g.latitude.median(), g.longitude.median()
        d = np.array([haversine_m(lat0, lon0, a, b) for a, b in zip(g.latitude, g.longitude)])
        mad = 1.4826 * np.median(np.abs(d - np.median(d)))
        keep = d <= np.median(d) + outlier_sd * max(mad, 1.0) if len(g) >= 3 else np.ones(len(g), bool)
        log += [(pid, "fix far from the plant's other fixes")] * int((~keep).sum())
        g = g[keep]
        lat, lon = g.latitude.median(), g.longitude.median()
        spread = np.median([haversine_m(lat, lon, a, b) for a, b in zip(g.latitude, g.longitude)])
        rows.append({"plant_id": pid, "lat": lat, "lon": lon, "n_fixes": len(g), "spread_m": round(spread, 2),
                     "median_accuracy_m": round(float(g.accuracy.median()), 1)})
    coords = pd.DataFrame(rows, columns=["plant_id", "lat", "lon", "n_fixes", "spread_m", "median_accuracy_m"])
    if len(coords):
        coords["x"], coords["y"] = to_utm(coords.lat, coords.lon)
    return coords, pd.DataFrame(log, columns=["plant_id", "reason"])


def inside(point, ring):
    """Ray casting on [lon, lat] rings (plantation scale)."""
    x, y = point
    hit = False
    for i in range(len(ring)):
        (x1, y1), (x2, y2) = ring[i - 1], ring[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def zone_check(coords, zones_geojson):
    """Flags plants whose stable coordinate is outside their own zone outline."""
    rings = {f["properties"]["zone"]: f["geometry"]["coordinates"][0] for f in zones_geojson["features"]}
    ok = [inside((r.lon, r.lat), rings[r.plant_id[0]]) if r.plant_id[0] in rings else np.nan
          for r in coords.itertuples()]
    return coords.assign(inside_own_zone=ok)


def nearest_neighbour_m(coords, k=1):
    d = haversine_matrix(coords.lat, coords.lon)
    np.fill_diagonal(d, np.inf)
    return np.sort(d, axis=1)[:, k - 1] if len(coords) > k else np.array([])


def kdist_elbow(kdist):
    """Elbow of a sorted k-distance curve: the point furthest from the line joining its ends."""
    y = np.sort(kdist)
    if len(y) < 3:
        return float(y[-1]) if len(y) else np.nan
    x = np.linspace(0, 1, len(y))
    yn = (y - y[0]) / max(y[-1] - y[0], 1e-9)
    return float(y[np.argmax(np.abs(yn - x))])


def choose_eps(coords, min_samples, gps_error_m):
    """eps must exceed both the spacing between sampled plants and the GPS error, or noise splits clusters."""
    kd = nearest_neighbour_m(coords, k=max(min_samples - 1, 1))
    elbow = kdist_elbow(kd)
    return max(elbow, 2 * gps_error_m), elbow, kd


# ── cycles ──────────────────────────────────────────────────────────────────

def assign_cycles(df, freq="W", start=None):
    """Weekly (simulated data) or monthly (real data) inspection cycles; latest record per plant per cycle."""
    d = df.copy()
    start = pd.Timestamp(start) if start is not None else d.inspection_date.min().normalize()
    if freq == "W":
        d["cycle"] = (d.inspection_date - start).dt.days // 7
        d["cycle_start"] = start + pd.to_timedelta(d.cycle * 7, unit="D")
    else:
        d["cycle"] = (d.inspection_date.dt.year - start.year) * 12 + d.inspection_date.dt.month - start.month
        d["cycle_start"] = d.inspection_date.dt.to_period("M").dt.start_time
    d = d.sort_values(["plant_id", "inspection_date"]).groupby(["plant_id", "cycle"]).tail(1)
    return d.reset_index(drop=True)


# ── 2. plant-level anomaly detection ───────────────────────────────────────

def pooled_scale(dev, floor):
    """1.4826 × median |deviation| over many plants: a stable spread where a plant's own 4 visits or a
    block of 5-8 sampled plants would give a noisy one."""
    dev = np.abs(np.asarray(dev, float))
    dev = dev[~np.isnan(dev)]
    return max(1.4826 * np.median(dev), floor) if len(dev) else floor


def anomaly_signals(pc, history=4, min_block_peers=8):
    """pc: one row per plant per cycle with soil_ph, soil_ec, moisture, growth_cm_wk, foliage_color, block, zone.

    self z: deviation from the median of the plant's own previous `history` cycles (2 needed).
    peer z: deviation from the median of the other plants in the block that cycle, or the zone when the
    block has fewer than `min_block_peers` others (a hotspot covering half a small block moves its median).
    Both are divided by the pooled robust spread of that deviation. foliage: ordinal 0-3, flagged when it
    worsens or reaches Yellow. Growth only counts when it falls."""
    d = pc.sort_values(["plant_id", "cycle"]).reset_index(drop=True)
    d["foliage_ord"] = d.foliage_color.map(FOLIAGE_ORD)
    d["foliage_prev"] = d.groupby("plant_id").foliage_ord.shift(1)
    d["foliage_worse"] = (d.foliage_ord > d.foliage_prev).fillna(False)
    block_size = d.groupby(["block", "cycle"]).plant_id.transform("size")
    d["peer_group"] = np.where(block_size - 1 >= min_block_peers, d.block, d.zone)
    for v in SELF_VARS:
        dev = np.full(len(d), np.nan)
        for _, g in d.groupby("plant_id", sort=False):
            vals = g[v].to_numpy(float)
            for i, idx in enumerate(g.index):
                ref = vals[max(0, i - history):i]
                ref = ref[~np.isnan(ref)]
                if len(ref) >= 2:
                    dev[idx] = vals[i] - np.median(ref)
        d[f"self_z_{v}"] = dev / pooled_scale(dev, MAD_FLOOR[v])
        peer = np.full(len(d), np.nan)
        for _, g in d.groupby(["peer_group", "cycle"]):
            vals = g[v].to_numpy(float)
            if len(vals) < 4:
                continue
            for j, idx in enumerate(g.index):
                peer[idx] = vals[j] - np.nanmedian(np.delete(vals, j))
        for _, g in d.groupby("cycle"):
            peer[g.index] = peer[g.index] / pooled_scale(peer[g.index], MAD_FLOOR[v])
        d[f"peer_z_{v}"] = peer
        d[f"delta_{v}"] = d.groupby("plant_id")[v].diff()

    zcols = [c for c in d if c.startswith(("self_z_", "peer_z_"))]
    reasons = []
    for r in d.itertuples(index=False):
        why = []
        if r.foliage_ord >= 2:
            why.append(f"foliage {r.foliage_color}")
        if r.foliage_worse:
            why.append("foliage worsened")
        for c in zcols:
            z = getattr(r, c)
            if np.isnan(z) or abs(z) <= Z_LIMIT or (c.endswith("growth_cm_wk") and z > 0):
                continue
            why.append(f"{c} {z:+.1f}")
        reasons.append(why)
    d["reasons"] = reasons
    d["rule_flag"] = d.reasons.map(bool)
    return d


ISO_FEATURES = (["soil_ph", "soil_ec", "moisture", "growth_cm_wk", "foliage_ord"]
                + [f"delta_{v}" for v in SELF_VARS] + [f"peer_z_{v}" for v in SELF_VARS])


def isolation_forest(d, contamination=0.15, seed=42):
    X = d[ISO_FEATURES].astype(float).fillna(0).clip(-20, 20)
    iso = IsolationForest(n_estimators=300, contamination=contamination, random_state=seed).fit(X)
    return iso.predict(X) == -1, -iso.score_samples(X)


# ── 3. is there spatial structure at all? ───────────────────────────────────

def band_weights(lat, lon, band_m):
    w = (haversine_matrix(lat, lon) <= band_m).astype(float)
    np.fill_diagonal(w, 0)
    return w


def join_count(flags, w, n_perm=999, groups=None, seed=0):
    """Anomaly–anomaly joins within the distance band vs flags shuffled (within groups) n_perm times."""
    x = np.asarray(flags, float)
    if w.sum() == 0 or x.sum() < 2:
        return {"bb_joins": 0.0, "expected": np.nan, "p": np.nan, "pairs_in_band": int(w.sum() / 2)}
    rng = np.random.default_rng(seed)
    obs = 0.5 * x @ w @ x
    sims = np.array([0.5 * (s := _shuffle(x, groups, rng)) @ w @ s for _ in range(n_perm)])
    return {"bb_joins": obs, "expected": round(float(sims.mean()), 2),
            "p": (np.sum(sims >= obs) + 1) / (n_perm + 1), "pairs_in_band": int(w.sum() / 2)}


def morans_i(values, w, n_perm=999, seed=0):
    z = np.asarray(values, float) - np.mean(values)
    s0 = w.sum()
    if s0 == 0 or not z.any():
        return {"I": np.nan, "p": np.nan}
    stat = lambda v: len(v) / s0 * (v @ w @ v) / (v @ v)
    rng = np.random.default_rng(seed)
    obs = stat(z)
    sims = np.array([stat(rng.permutation(z)) for _ in range(n_perm)])
    return {"I": round(float(obs), 4), "expected": round(-1 / (len(z) - 1), 4),
            "p": (np.sum(sims >= obs) + 1) / (n_perm + 1)}


def _shuffle(x, groups, rng):
    if groups is None:
        return rng.permutation(x)
    out = x.copy()
    for gv in np.unique(groups):
        idx = np.where(groups == gv)[0]
        out[idx] = rng.permutation(x[idx])
    return out


# ── 4. Haversine-DBSCAN on anomalous plants only ────────────────────────────

def dbscan(lat, lon, eps_m, min_samples):
    if len(lat) == 0:
        return np.array([], int)
    coords = np.radians(np.column_stack([lat, lon]))
    return DBSCAN(eps=eps_m / R_EARTH, min_samples=min_samples, metric="haversine",
                  algorithm="ball_tree").fit_predict(coords)


# ── 5. are the clusters more than chance? ───────────────────────────────────

def clustered_share(lat, lon, flags, eps_m, min_samples):
    sel = np.asarray(flags, bool)
    if sel.sum() == 0:
        return 0.0
    return float((dbscan(lat[sel], lon[sel], eps_m, min_samples) >= 0).mean())


def permutation_test(lat, lon, flags, zones, eps_m, min_samples, n_perm=999, seed=0):
    """Locations fixed, flags shuffled within each zone; statistic = share of anomalous plants in a cluster."""
    lat, lon, flags = np.asarray(lat, float), np.asarray(lon, float), np.asarray(flags, bool)
    obs = clustered_share(lat, lon, flags, eps_m, min_samples)
    if flags.sum() < min_samples:
        return {"clustered_share": obs, "p": np.nan}
    rng = np.random.default_rng(seed)
    zones = np.asarray(zones)
    sims = np.array([clustered_share(lat, lon, _shuffle(flags.astype(float), zones, rng).astype(bool),
                                     eps_m, min_samples) for _ in range(n_perm)])
    return {"clustered_share": round(obs, 3), "expected": round(float(sims.mean()), 3),
            "p": (np.sum(sims >= obs) + 1) / (n_perm + 1)}


# ── 6. tracking across cycles ───────────────────────────────────────────────

def hull_area(x, y):
    if len(x) < 3:
        return 0.0
    try:
        return float(ConvexHull(np.column_stack([x, y])).volume)   # .volume is the area in 2-D
    except QhullError:                                              # collinear points
        return 0.0


def run_onsets(flags):
    """flags: plant_id, cycle, flag. Returns {(plant, cycle): first cycle of the plant's current run of flags},
    so one stray alarm weeks earlier does not count as the start of today's problem."""
    out = {}
    for pid, g in flags.sort_values("cycle").groupby("plant_id"):
        start = None
        for c, f in zip(g.cycle, g.flag):
            start = (c if start is None else start) if f else None
            if f:
                out[(pid, c)] = start
    return out


def track(clusters, coords, onset, eps_m, jaccard_min=0.3):
    """clusters: {cycle: [set(plant_id), ...]}; onset: {(plant, cycle): run start}. Matches each hotspot to the
    previous cycle's by member overlap (Jaccard >= jaccard_min) or centroid distance <= eps_m, and records size,
    movement and spread. net_growth and adjacent_share_total look at the hotspot's whole history: a disease
    hotspot that has already covered its block stops growing but has still spread."""
    xy = coords.set_index("plant_id")[["x", "y", "lat", "lon"]]
    rows, active, next_id = [], {}, 1
    for c in sorted(clusters):
        cur = []
        for members in clusters[c]:
            p = xy.loc[sorted(members)]
            cur.append({"members": set(members), "x": p.x.mean(), "y": p.y.mean(),
                        "lat": p.lat.mean(), "lon": p.lon.mean(), "area": hull_area(p.x.values, p.y.values)})
        pairs = []
        for i, h in enumerate(cur):
            for tid, prev in active.items():
                jac = len(h["members"] & prev["members"]) / len(h["members"] | prev["members"])
                dist = float(np.hypot(h["x"] - prev["x"], h["y"] - prev["y"]))
                if jac >= jaccard_min or dist <= eps_m:
                    pairs.append((jac, -dist, i, tid))
        assigned, used = {}, set()
        for jac, nd, i, tid in sorted(pairs, reverse=True):
            if i not in assigned and tid not in used:
                assigned[i] = tid
                used.add(tid)
        new_active = {}
        for i, h in enumerate(cur):
            prev = active.get(assigned.get(i))
            if prev is None:
                tid, first, first_n, added_total, adjacent_total = f"H{next_id:03d}", c, len(h["members"]), 0, 0.0
                next_id += 1
            else:
                tid, first, first_n = assigned[i], prev["first"], prev["first_n"]
                added_total, adjacent_total = prev["added_total"], prev["adjacent_total"]
            n = len(h["members"])
            status = "new" if prev is None else (
                "expanding" if n > len(prev["members"]) else "shrinking" if n < len(prev["members"]) else "persistent")
            added = h["members"] - prev["members"] if prev else set()
            if prev and added:
                old = xy.loc[sorted(prev["members"])]
                adjacent = np.mean([haversine_matrix(np.r_[xy.loc[a, "lat"], old.lat],
                                                     np.r_[xy.loc[a, "lon"], old.lon])[0, 1:].min() <= eps_m
                                    for a in added])
            else:
                adjacent = np.nan
            if added:
                added_total += len(added)
                adjacent_total += adjacent * len(added)
            onsets = [onset[(m, c)] for m in h["members"]]
            rows.append({"hotspot_id": tid, "cycle": c, "status": status, "n_members": n,
                         "member_plant_ids": sorted(h["members"]), "centroid_lat": h["lat"], "centroid_lon": h["lon"],
                         "area_m2": round(h["area"], 1),
                         "centroid_shift_m": round(float(np.hypot(h["x"] - prev["x"], h["y"] - prev["y"])), 1)
                         if prev else np.nan,
                         "new_members": len(added), "new_members_adjacent": adjacent,
                         "net_growth": n - first_n,
                         "adjacent_share_total": adjacent_total / added_total if added_total >= 2 else np.nan,
                         "onset_spread_cycles": round(float(np.std(onsets)), 2),
                         "persistence": c - first + 1})
            new_active[tid] = {**h, "first": first, "first_n": first_n, "added_total": added_total,
                               "adjacent_total": adjacent_total}
        for tid, prev in active.items():
            if tid not in used:
                rows.append({"hotspot_id": tid, "cycle": c, "status": "resolved", "n_members": 0,
                             "member_plant_ids": [], "persistence": c - prev["first"]})
        active = new_active
    return pd.DataFrame(rows)


# ── 7. cause triage ─────────────────────────────────────────────────────────

def soil_out_of_range(r):
    lo, hi = SOIL_OK["soil_ph"]
    mlo, mhi = SOIL_OK["moisture"]
    return bool(not lo <= r.soil_ph <= hi or r.soil_ec < SOIL_OK["soil_ec_min"] or not mlo <= r.moisture <= mhi)


def evidence(members, ring):
    """members / ring: rows (current cycle) of hotspot plants and of healthy plants around them."""
    ev = {"n_members": len(members), "n_ring": len(ring),
          "soil_out_of_range_share": float(np.mean([soil_out_of_range(r) for r in members.itertuples()])),
          "yellow_share": float((members.foliage_color == "Yellow").mean()),
          "brown_mixed_share": float(members.foliage_color.isin(["Brown", "Mixed"]).mean())}
    # Only a test that could reach p < 0.05 counts, for or against. 4 members vs 4 ring plants cannot
    # (smallest two-sided p 2/70, ×3 for the three soil variables = 0.086), and "not significant" from
    # such a test is no evidence that soil is normal.
    smallest_p = 3 * 2 / comb(len(members) + len(ring), len(members)) if len(members) and len(ring) else 1.0
    if len(members) >= 3 and len(ring) >= 3 and smallest_p < 0.05:
        ps = []
        for v in ["soil_ph", "soil_ec", "moisture"]:
            a, b = members[v].dropna(), ring[v].dropna()
            if len(a) >= 3 and len(b) >= 3 and pd.concat([a, b]).nunique() > 1:
                ps.append(mannwhitneyu(a, b, alternative="two-sided").pvalue)
        ev["soil_vs_ring_p"] = min(1.0, min(ps) * len(ps)) if ps else np.nan   # Bonferroni over the three
    else:
        ev["soil_vs_ring_p"] = np.nan
    if len(ring) >= 3:
        ring_growth = ring.growth_cm_wk.median()
        ev["growth_suppressed"] = bool(ring_growth > 0 and members.growth_cm_wk.median() <= 0.5 * ring_growth)
    else:
        ev["growth_suppressed"] = False
    return ev


def triage(h):
    """Stationary and simultaneous points to soil/nutrient; a point source spreading outward to disease."""
    p = h.get("soil_vs_ring_p", np.nan)
    tested = not np.isnan(p)
    nut = [h["soil_out_of_range_share"] > 0.5, tested and p < 0.05, h["yellow_share"] > 0.5,
           h["onset_spread_cycles"] <= 1, bool(h.get("growth_suppressed"))]
    adj = h.get("adjacent_share_total", np.nan)
    dis = [tested and p >= 0.05, h["brown_mixed_share"] > 0.5, h["onset_spread_cycles"] > 1,
           not np.isnan(adj) and adj > 0.5, h.get("net_growth", 0) >= 2]
    n, d = int(sum(nut)), int(sum(dis))
    if n - d >= 2:
        cause = "likely_nutrient_deficiency"
    elif d - n >= 2:
        cause = "likely_disease"
    else:
        cause = "uncertain_expert_review"
    return cause, n, d
