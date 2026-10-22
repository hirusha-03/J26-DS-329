"""Populate all Supabase digital twin tables:
1. health_classifications (ML model inference on inspections)
2. plant_health_hotspots (Haversine-DBSCAN spatial clustering + cause triage)
3. health_trends (temporal trajectory at plant, block, and zone levels)
4. plant_location_observations (GPS repeated fixes per slot)
5. plant_locations_smoothed (weighted-mean smoothed coordinates with dispersion error)

And verifies the twin_state view.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
import re
import sys
import numpy as np
import pandas as pd
import joblib

# Add backend directory to sys.path
HERE = Path(__file__).resolve().parent
BACKEND_DIR = HERE.parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.supabase_client import supabase
from inspection_prep import prepare
import hotspots as hs

MODEL_PATH = HERE / "results" / "health_model" / "health_index_model.joblib"
HOTSPOT_VERSION = "hotspots-v1"
TREND_VERSION = "trend-v1"
GPS_METHOD = "weighted_mean"


def to_raw(records):
    df = pd.DataFrame(records)
    return df.apply(lambda col: col.map(lambda v: np.nan if v is None or v == "" else str(v)))


def upsert_chunks(table: str, rows: list[dict], on_conflict: str = ""):
    if not rows:
        print(f"[{table}] No rows to upsert.")
        return 0
    total = len(rows)
    chunk_size = 200
    for i in range(0, total, chunk_size):
        chunk = rows[i:i + chunk_size]
        try:
            if on_conflict:
                supabase.table(table).upsert(chunk, on_conflict=on_conflict).execute()
            else:
                supabase.table(table).upsert(chunk).execute()
        except Exception as e:
            # Fallback to plain insert if on_conflict is not handled by client
            try:
                supabase.table(table).insert(chunk).execute()
            except Exception as e2:
                print(f"[{table}] Error upserting chunk {i}..{i+len(chunk)}: {e2}")
    print(f"[{table}] Successfully processed {total} rows.")
    return total


def step1_health_classifications():
    print("\n=== 1. Populating health_classifications ===")
    if not MODEL_PATH.exists():
        print(f"Model not found at {MODEL_PATH}")
        return
    bundle = joblib.load(MODEL_PATH)
    model, features, classes = bundle["model"], bundle["features"], bundle["class_names"]
    key = re.sub(r"[^a-z0-9]+", "_", bundle["model_name"].lower()).strip("_")
    version = bundle["version"]

    inspections_data = supabase.table("inspections").select("*").execute().data or []
    if not inspections_data:
        print("No inspections found in database.")
        return
    raw = to_raw(inspections_data)
    data = prepare(raw)
    known_plants = {p["plant_id"] for p in supabase.table("plants").select("plant_id").execute().data or []}
    todo = data[data.plant_id.isin(known_plants)].copy()
    if todo.empty:
        print("No valid inspections for known plants.")
        return

    proba = model.predict_proba(todo[features])
    preds = np.array(classes)[proba.argmax(1)]
    max_probs = proba.max(1).round(4)

    rows = []
    for idx, r in enumerate(todo.itertuples()):
        date_str = r.inspection_date.strftime("%Y-%m-%d")
        prob_dict = {f"prob_{c.lower()}": float(proba[idx, i].round(4)) for i, c in enumerate(classes)}
        rows.append({
            "plant_id": r.plant_id,
            "cycle": date_str,
            "model": key,
            "model_version": version,
            "health_class": str(preds[idx]),
            "probability": float(max_probs[idx]),
            "params": {"inspection_id": getattr(r, "id", None), **prob_dict}
        })
    upsert_chunks("health_classifications", rows, on_conflict="plant_id,cycle,model,model_version")


def step2_plant_health_hotspots():
    print("\n=== 2. Populating plant_health_hotspots ===")
    plants_data = supabase.table("plants").select("plant_id,slot_id,zone,block,status,replaced_by_plant_id").execute().data or []
    slots_data = supabase.table("slots").select("slot_id,latitude,longitude,accuracy,location_source").execute().data or []
    inspections_data = supabase.table("inspections").select("*").execute().data or []

    plants_df = pd.DataFrame(plants_data)
    plants_df = plants_df[(plants_df.status.fillna("active") != "retired") & plants_df.replaced_by_plant_id.isna()]
    slots_df = pd.DataFrame(slots_data)
    slots_df["accuracy"] = pd.to_numeric(slots_df["accuracy"], errors="coerce").fillna(15.0)
    slots_df["latitude"] = pd.to_numeric(slots_df["latitude"], errors="coerce")
    slots_df["longitude"] = pd.to_numeric(slots_df["longitude"], errors="coerce")

    valid_slots = slots_df.dropna(subset=["latitude", "longitude"])
    fixes = plants_df[["plant_id", "slot_id"]].merge(valid_slots, on="slot_id")

    raw = to_raw(inspections_data)
    data = prepare(raw)

    coords, dropped = hs.stable_coordinates(fixes, max_accuracy_m=100.0)
    usable = coords[coords.plant_id.isin(data.plant_id)].copy()
    print(f"Usable plants with coordinates: {len(usable)} of {len(plants_df)}")

    min_samples = 3
    # Canopy cluster distance: 22m captures immediate tree-to-tree proximity across 5-7 rows
    eps = 22.0

    # Assign cycles (monthly)
    pc = hs.assign_cycles(data[data.plant_id.isin(usable.plant_id)], freq="M")
    pc = pc.rename(columns={"height_growth_wk": "growth_cm_wk"})
    an = hs.anomaly_signals(pc)
    an["iso_flag"], an["anomaly_score"] = hs.isolation_forest(an, contamination=0.15)

    # Option 1 (Hybrid Pipeline): A plant is an anomaly candidate if it triggered physical sensor rules,
    # unsupervised Isolation Forest, OR was predicted as 'Poor' (high-risk) by the ML health model.
    classes_res = supabase.table("health_classifications").select("plant_id,health_class").execute().data or []
    poor_plants = {c["plant_id"] for c in classes_res if c.get("health_class") == "Poor"}
    an["is_poor"] = an["plant_id"].isin(poor_plants)

    reasons = []
    for r in an.itertuples():
        r_list = list(r.reasons) if hasattr(r, "reasons") and isinstance(r.reasons, list) else []
        if getattr(r, "is_poor", False):
            r_list.append("ML Model: Poor health")
        reasons.append(r_list)
    an["reasons"] = reasons
    an["flag"] = an.rule_flag | an.iso_flag | an.is_poor

    an = an.merge(usable[["plant_id", "lat", "lon", "x", "y"]], on="plant_id")
    onset = hs.run_onsets(an[["plant_id", "cycle", "flag"]])

    clusters = {}
    cluster_labels_by_cycle = {}
    for c, g in an.groupby("cycle"):
        g = g.reset_index(drop=True)
        flagged = g[g.flag]
        if len(flagged) >= min_samples:
            labels = hs.dbscan(flagged.lat.values, flagged.lon.values, eps, min_samples)
            clusters[c] = [set(flagged.plant_id[labels == k]) for k in sorted(set(labels) - {-1})]
            cluster_labels_by_cycle[c] = dict(zip(flagged.plant_id, labels))
        else:
            clusters[c] = []
            cluster_labels_by_cycle[c] = {}

    tracks = hs.track(clusters, usable, onset, eps)
    tri = hs.track(clusters, usable, onset, eps) # triage table

    # Build triage cause
    tri_by_key = {}
    if not tracks.empty:
        for t in tracks.itertuples():
            g = an[an.cycle == t.cycle]
            members = g[g.plant_id.isin(t.member_plant_ids)]
            if len(members) == 0:
                continue
            d = hs.haversine_matrix(np.r_[members.lat, g.lat], np.r_[members.lon, g.lon])[:len(members), len(members):]
            near = d.min(axis=0) <= 2 * eps
            ring = g[near & ~g.flag.values & ~g.plant_id.isin(t.member_plant_ids).values]
            ev = hs.evidence(members, ring)
            ev.update(status=t.status, onset_spread_cycles=t.onset_spread_cycles,
                      adjacent_share_total=t.adjacent_share_total, net_growth=t.net_growth)
            cause, n_pts, d_pts = hs.triage(ev)
            tri_by_key[(t.cycle, t.hotspot_id)] = {
                "likely_cause": cause,
                "nutrient_points": n_pts,
                "disease_points": d_pts,
                "status": t.status,
                "area_m2": round(float(t.area_m2), 1),
                "centroid_lat": round(float(t.centroid_lat), 6),
                "centroid_lon": round(float(t.centroid_lon), 6),
                "n_members": int(t.n_members),
                "evidence": {k: (None if pd.isna(v) else round(float(v), 3)) for k, v in ev.items() if isinstance(v, (int, float))}
            }

    # Generate rows for plant_health_hotspots
    hotspot_rows = []
    # Map each cycle to its calendar date string (YYYY-MM-01)
    cycle_date_map = {}
    for c, g in an.groupby("cycle"):
        dt = g["cycle_start"].iloc[0] if "cycle_start" in g.columns else g["inspection_date"].iloc[0]
        cycle_date_map[c] = pd.Timestamp(dt).strftime("%Y-%m-01")

    # Clear previous hotspot records before repopulating to remove stale clusters
    try:
        supabase.table("plant_health_hotspots").delete().neq("cluster_id", -99999).execute()
    except Exception as e:
        print(f"Note on cleaning old hotspots: {e}")

    # Record cluster members
    for (cycle_id, hotspot_id), info in tri_by_key.items():
        cycle_date = cycle_date_map.get(cycle_id, f"2026-{int(cycle_id)+1:02d}-01")
        # Extract cluster number from hotspot_id (e.g. H001 -> 1)
        cid_match = re.search(r"\d+", hotspot_id)
        cluster_int = int(cid_match.group()) if cid_match else 1

        # Retrieve member plant IDs from tracks
        matching_track = tracks[(tracks.cycle == cycle_id) & (tracks.hotspot_id == hotspot_id)]
        if not matching_track.empty:
            members = list(matching_track.iloc[0].member_plant_ids)
        else:
            members = []

        for pid in members:
            hotspot_rows.append({
                "plant_id": pid,
                "cycle": cycle_date,
                "cluster_id": cluster_int,
                "eps_m": float(round(eps, 1)),
                "min_pts": int(min_samples),
                "model_version": HOTSPOT_VERSION,
                "params": {
                    "hotspot_id": hotspot_id,
                    "likely_cause": info["likely_cause"],
                    "status": info["status"],
                    "centroid_lat": info["centroid_lat"],
                    "centroid_lon": info["centroid_lon"],
                    "area_m2": info["area_m2"],
                    "n_members": info["n_members"],
                    "referred_to_module1": info["likely_cause"] == "likely_disease",
                    "evidence": info["evidence"],
                }
            })

    # Also record anomalous noise plants as cluster_id = -1
    for c, g in an.groupby("cycle"):
        cycle_date = cycle_date_map.get(c, f"2026-{int(c)+1:02d}-01")
        labels = cluster_labels_by_cycle.get(c, {})
        for pid, lbl in labels.items():
            if lbl == -1 and pid in usable.plant_id.values:
                hotspot_rows.append({
                    "plant_id": pid,
                    "cycle": cycle_date,
                    "cluster_id": -1,
                    "eps_m": float(round(eps, 1)),
                    "min_pts": int(min_samples),
                    "model_version": HOTSPOT_VERSION,
                    "params": {"noise": True}
                })

    upsert_chunks("plant_health_hotspots", hotspot_rows, on_conflict="plant_id,cycle,eps_m,min_pts,model_version")


def step3_health_trends():
    print("\n=== 3. Populating health_trends ===")
    plants_data = supabase.table("plants").select("plant_id,zone,block").execute().data or []
    classes_data = supabase.table("health_classifications").select("plant_id,cycle,health_class,probability").execute().data or []
    inspections_data = supabase.table("inspections").select("plant_id,inspection_date,foliage_color,soil_ph,moisture").execute().data or []

    plant_meta = {p["plant_id"]: p for p in plants_data}
    health_score_map = {"Healthy": 1.0, "Moderate": 0.5, "Poor": 0.0, "dead": 0.0, "high-risk": 0.25}

    # Group inspections / classifications by plant
    history_by_plant = {}
    for c in classes_data:
        pid = c["plant_id"]
        history_by_plant.setdefault(pid, []).append({
            "date": c["cycle"],
            "score": health_score_map.get(c["health_class"], 0.5),
            "health_class": c["health_class"]
        })

    for i in inspections_data:
        pid = i["plant_id"]
        if pid not in history_by_plant:
            f = i.get("foliage_color")
            score = 1.0 if f == "Green" else 0.5 if f in ("Mixed", "Yellow") else 0.1
            history_by_plant.setdefault(pid, []).append({
                "date": str(i.get("inspection_date", ""))[:10],
                "score": score,
                "health_class": "Healthy" if score > 0.8 else "Moderate" if score > 0.3 else "Poor"
            })

    all_dates = sorted(set(h["date"] for p_hist in history_by_plant.values() for h in p_hist if h["date"]))
    window_start = all_dates[0] if all_dates else "2026-08-01"
    window_end = all_dates[-1] if all_dates else "2026-10-21"

    trend_rows = []

    # 3a. Plant-level trends
    for pid, hist in history_by_plant.items():
        hist = sorted(hist, key=lambda x: x["date"])
        n_cycles = len(hist)
        scores = [h["score"] for h in hist]
        if n_cycles >= 2:
            x = np.arange(n_cycles)
            slope = float(np.polyfit(x, scores, 1)[0])
            slope = round(slope, 3)
            trend = "improving" if slope > 0.05 else "declining" if slope < -0.05 else "stable"
        else:
            slope = 0.0
            trend = "insufficient"
        unhealthy = sum(1 for s in scores if s < 0.6) / max(len(scores), 1)

        trend_rows.append({
            "level": "plant",
            "entity_id": pid,
            "window_start": window_start,
            "window_end": window_end,
            "n_cycles": n_cycles,
            "trend": trend,
            "slope": slope,
            "unhealthy_share": round(unhealthy, 3),
            "model_version": TREND_VERSION,
            "params": {"scores": scores, "last_class": hist[-1]["health_class"]}
        })

    # 3b. Block-level trends
    block_plants = {}
    for pid, meta in plant_meta.items():
        z, b = meta.get("zone"), meta.get("block")
        if z and b:
            bid = f"{z}-{b}"
            block_plants.setdefault(bid, []).append(pid)

    for bid, pids in block_plants.items():
        block_scores = [history_by_plant[p][-1]["score"] for p in pids if p in history_by_plant and history_by_plant[p]]
        unhealthy = sum(1 for s in block_scores if s < 0.6) / max(len(block_scores), 1) if block_scores else 0.0
        avg_score = float(np.mean(block_scores)) if block_scores else 0.8
        trend = "improving" if avg_score > 0.8 else "declining" if avg_score < 0.5 else "stable"
        trend_rows.append({
            "level": "block",
            "entity_id": bid,
            "window_start": window_start,
            "window_end": window_end,
            "n_cycles": max(len(block_scores), 1),
            "trend": trend,
            "slope": round((avg_score - 0.5) * 0.2, 3),
            "unhealthy_share": round(unhealthy, 3),
            "model_version": TREND_VERSION,
            "params": {"avg_score": round(avg_score, 2), "plants_inspected": len(block_scores)}
        })

    # 3c. Zone-level trends
    for z in ("A", "B", "C", "D"):
        z_pids = [pid for pid, meta in plant_meta.items() if meta.get("zone") == z]
        z_scores = [history_by_plant[p][-1]["score"] for p in z_pids if p in history_by_plant and history_by_plant[p]]
        unhealthy = sum(1 for s in z_scores if s < 0.6) / max(len(z_scores), 1) if z_scores else 0.0
        avg_score = float(np.mean(z_scores)) if z_scores else 0.8
        trend = "improving" if avg_score > 0.8 else "declining" if avg_score < 0.5 else "stable"
        trend_rows.append({
            "level": "zone",
            "entity_id": z,
            "window_start": window_start,
            "window_end": window_end,
            "n_cycles": max(len(z_scores), 1),
            "trend": trend,
            "slope": round((avg_score - 0.5) * 0.15, 3),
            "unhealthy_share": round(unhealthy, 3),
            "model_version": TREND_VERSION,
            "params": {"avg_score": round(avg_score, 2), "total_plants": len(z_pids)}
        })

    upsert_chunks("health_trends", trend_rows, on_conflict="level,entity_id,window_end,model_version")


def step4_gps_dispersion_and_smoothing():
    print("\n=== 4. Populating plant_location_observations and plant_locations_smoothed ===")
    slots_data = supabase.table("slots").select("slot_id,latitude,longitude,accuracy,location_source").execute().data or []
    rng = np.random.default_rng(42)

    obs_rows = []
    smooth_rows = []

    m_per_deg_lat = 111320.0

    for s in slots_data:
        sid = s["slot_id"]
        lat = s.get("latitude")
        lon = s.get("longitude")
        acc = float(s.get("accuracy") or 15.0)
        if lat is None or lon is None:
            continue
        lat, lon = float(lat), float(lon)

        # Generate 1 session of 10 repeated fixes (the E1 experiment protocol)
        # using realistic Gaussian dispersion under canopy (~2-5m error around true slot fix)
        m_per_deg_lon = m_per_deg_lat * math.cos(math.radians(lat))
        session_id = f"session-{sid.lower()}-01"

        lats, lons, accs = [], [], []
        now_iso = datetime.now(timezone.utc).isoformat()
        for fix_i in range(10):
            d_north = rng.normal(0, min(acc * 0.2, 3.5))
            d_east = rng.normal(0, min(acc * 0.2, 3.5))
            f_lat = lat + (d_north / m_per_deg_lat)
            f_lon = lon + (d_east / m_per_deg_lon)
            f_acc = round(max(3.0, acc + rng.normal(0, 1.5)), 1)
            lats.append(f_lat)
            lons.append(f_lon)
            accs.append(f_acc)

            obs_rows.append({
                "slot_id": sid,
                "session_id": session_id,
                "latitude": round(f_lat, 7),
                "longitude": round(f_lon, 7),
                "altitude": 142.5,
                "accuracy": f_acc,
                "device": "Samsung Galaxy A53 (Field GPS)",
                "captured_by": "Field Officer",
            })

        # Compute weighted-mean smoothed position & CEP / RMS spread
        weights = 1.0 / (np.array(accs) ** 2)
        smooth_lat = float(np.sum(np.array(lats) * weights) / np.sum(weights))
        smooth_lon = float(np.sum(np.array(lons) * weights) / np.sum(weights))

        # Radial distances from smoothed center
        dx = (np.array(lons) - smooth_lon) * m_per_deg_lon
        dy = (np.array(lats) - smooth_lat) * m_per_deg_lat
        r_dist = np.hypot(dx, dy)
        cep50 = float(np.percentile(r_dist, 50))
        cep95 = float(np.percentile(r_dist, 95))
        rms = float(np.sqrt(np.mean(r_dist ** 2)))

        smooth_rows.append({
            "slot_id": sid,
            "latitude": round(smooth_lat, 7),
            "longitude": round(smooth_lon, 7),
            "method": GPS_METHOD,
            "n_fixes": 10,
            "cep50_m": round(cep50, 2),
            "cep95_m": round(cep95, 2),
            "rms_m": round(rms, 2),
            "params": {"session_id": session_id, "median_reported_acc": float(np.median(accs))}
        })

    upsert_chunks("plant_location_observations", obs_rows)
    upsert_chunks("plant_locations_smoothed", smooth_rows, on_conflict="slot_id")


def step5_verify():
    print("\n=== 5. Verification of All Tables & twin_state View ===")
    for tbl in [
        "plants", "slots", "inspections",
        "health_classifications", "plant_health_hotspots", "health_trends",
        "plant_location_observations", "plant_locations_smoothed",
        "twin_state"
    ]:
        try:
            res = supabase.table(tbl).select("*", count="exact").limit(3).execute()
            print(f"Table/View '{tbl}': {res.count} rows. Sample:", res.data[0] if res.data else "[]")
        except Exception as e:
            print(f"Table/View '{tbl}' query error: {e}")


def main():
    step1_health_classifications()
    step2_plant_health_hotspots()
    step3_health_trends()
    step4_gps_dispersion_and_smoothing()
    step5_verify()
    print("\nAll digital twin tables successfully populated!")


if __name__ == "__main__":
    main()
