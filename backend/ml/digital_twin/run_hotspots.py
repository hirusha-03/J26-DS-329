"""Spatial plant health hotspots, per inspection cycle. See hotspots.py for the method.

    python run_hotspots.py --simulate inspections_weekly_simulated.csv     # known-answer validation
    python run_hotspots.py --supabase                                       # real data, monthly cycles
    python run_hotspots.py --supabase --write                               # also store (service key)
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import hotspots as hs
from inspection_prep import build_features, clean_inspections, impute, prepare, read_raw
from train_health_model import Report

warnings.filterwarnings("ignore")
HERE = Path(__file__).resolve().parent
CAUSE_COLOURS = {"likely_nutrient_deficiency": "#DD8452", "likely_disease": "#C44E52",
                 "uncertain_expert_review": "#8172B2"}
VERSION = "hotspots-v1"


# ── data ────────────────────────────────────────────────────────────────────

def load_simulated(csv, seed):
    import simulate_hotspots as sim
    rng = np.random.default_rng(seed)
    clean, _, _ = clean_inspections(read_raw(csv))
    imputed = impute(clean, "temporal")
    lay = sim.layout(sorted(imputed.plant_id.unique()))
    planted, truth = sim.plant_hotspots(imputed, lay, rng)
    return build_features(planted), sim.gps_fixes(lay, rng), truth, lay


def load_supabase():
    from score_new_inspections import Supabase, as_raw
    db = Supabase()
    data = prepare(as_raw(db.select("inspections")))
    plants = pd.DataFrame(db.select("plants", "plant_id,slot_id,status,replaced_by_plant_id"))
    plants = plants[(plants.status.fillna("active") != "retired") & plants.replaced_by_plant_id.isna()]
    slots = pd.DataFrame(db.select("slots", "slot_id,latitude,longitude,accuracy,location_source"))
    obs = pd.DataFrame(db.select("plant_location_observations", "slot_id,latitude,longitude,accuracy"))
    # repeated fixes where they exist, otherwise the slot's single fix; placeholder positions never count
    gps_slots = slots[slots.location_source == "gps"]
    fixes = gps_slots[["slot_id", "latitude", "longitude", "accuracy"]]
    if len(obs):
        fixes = pd.concat([obs, fixes[~fixes.slot_id.isin(obs.slot_id)]])
    fixes = plants[["plant_id", "slot_id"]].merge(fixes, on="slot_id")
    return data, fixes.drop(columns="slot_id"), None, None


def coverage(data, fixes, coords):
    insp = set(data.plant_id)
    repeat = data.groupby("plant_id").size()
    return pd.DataFrame([
        ("plants with inspections", len(insp)),
        ("plants with 2+ inspections", int((repeat >= 2).sum())),
        ("plants with any GPS fix", fixes.plant_id.nunique()),
        ("plants with inspections and any GPS fix", len(insp & set(fixes.plant_id))),
        ("plants with a usable coordinate (accuracy filter)", len(coords)),
        ("usable for hotspot detection (coordinate and inspections)", len(insp & set(coords.plant_id))),
    ], columns=["Count", "Plants"])


# ── one run of steps 2-7 ────────────────────────────────────────────────────

def detect(data, coords, args, freq, eps, ms, detector=None, n_perm=None):
    detector = detector or args.detector
    n_perm = args.permutations if n_perm is None else n_perm
    pc = hs.assign_cycles(data[data.plant_id.isin(coords.plant_id)], freq, args.start)
    pc = pc.rename(columns={"height_growth_wk": "growth_cm_wk"})
    an = hs.anomaly_signals(pc)
    an["iso_flag"], an["anomaly_score"] = hs.isolation_forest(an, args.contamination)
    an["flag"] = {"rule": an.rule_flag, "iso": an.iso_flag, "either": an.rule_flag | an.iso_flag}[detector]
    an = an.merge(coords[["plant_id", "lat", "lon", "x", "y"]], on="plant_id")
    onset = hs.run_onsets(an[["plant_id", "cycle", "flag"]])

    clusters, tests = {}, []
    for c, g in an.groupby("cycle"):
        g = g.reset_index(drop=True)
        w = hs.band_weights(g.lat, g.lon, eps)
        jc = hs.join_count(g.flag, w, n_perm, groups=g.zone.values) if n_perm else {}
        mi = hs.morans_i(g.anomaly_score, w, n_perm) if n_perm else {}
        pt = hs.permutation_test(g.lat, g.lon, g.flag, g.zone, eps, ms, n_perm) if n_perm else {}
        flagged = g[g.flag]
        labels = hs.dbscan(flagged.lat.values, flagged.lon.values, eps, ms)
        clusters[c] = [set(flagged.plant_id[labels == k]) for k in sorted(set(labels) - {-1})]
        tests.append({"cycle": c, "plants": len(g), "anomalous": int(g.flag.sum()),
                      "noise_anomalies": int((labels == -1).sum()), "hotspots": len(clusters[c]),
                      "join_count_bb": jc.get("bb_joins"), "join_count_expected": jc.get("expected"),
                      "join_count_p": jc.get("p"), "morans_I": mi.get("I"), "morans_p": mi.get("p"),
                      "clustered_share": pt.get("clustered_share"), "clustered_share_expected": pt.get("expected"),
                      "permutation_p": pt.get("p")})
    tests = pd.DataFrame(tests)
    tracks = hs.track(clusters, coords, onset, eps)
    return an, tests, tracks


def add_triage(an, tracks, eps):
    rows = []
    for t in tracks.itertuples():
        if t.status == "resolved":
            rows.append({})
            continue
        g = an[an.cycle == t.cycle]
        members = g[g.plant_id.isin(t.member_plant_ids)]
        d = hs.haversine_matrix(np.r_[members.lat, g.lat], np.r_[members.lon, g.lon])[:len(members), len(members):]
        near = d.min(axis=0) <= 2 * eps
        ring = g[near & ~g.flag.values & ~g.plant_id.isin(t.member_plant_ids).values]
        ev = hs.evidence(members, ring)
        ev.update(status=t.status, onset_spread_cycles=t.onset_spread_cycles,
                  adjacent_share_total=t.adjacent_share_total, net_growth=t.net_growth)
        cause, n, dpts = hs.triage(ev)
        rows.append({**{k: ev[k] for k in ("n_ring", "soil_out_of_range_share", "soil_vs_ring_p", "yellow_share",
                                             "brown_mixed_share", "growth_suppressed")},
                     "nutrient_points": n, "disease_points": dpts, "likely_cause": cause})
    return pd.concat([tracks.reset_index(drop=True), pd.DataFrame(rows)], axis=1)


# ── evaluation on the known answer ──────────────────────────────────────────

def truth_frame(an, truth, freq_start):
    t = truth.set_index("plant_id")
    week = an.cycle  # weekly cycles start on the simulation's week 0
    cause = an.plant_id.map(t.cause)
    onset = an.plant_id.map(t.onset_week)
    return cause.where(week >= onset)


def eval_detectors(an, truth):
    """Zones A and B only: there the planted hotspots are the only health problems by construction."""
    truth_cause = truth_frame(an, truth, None)
    sel = an.zone.isin(["A", "B"])
    y = truth_cause[sel].notna()
    rows = []
    for name, flag in [("Rule / robust z-score", an.rule_flag), ("Isolation Forest", an.iso_flag),
                       ("Either", an.rule_flag | an.iso_flag)]:
        f = flag[sel]
        tp, fp, fn = int((f & y).sum()), int((f & ~y).sum()), int((~f & y).sum())
        prec, rec = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
        rows.append({"Detector": name, "TP": tp, "FP": fp, "FN": fn, "Precision": round(prec, 3),
                     "Recall": round(rec, 3), "F1": round(2 * prec * rec / max(prec + rec, 1e-9), 3),
                     "False alarms per cycle": round(fp / an.cycle.nunique(), 2)})
    return pd.DataFrame(rows)


def eval_hotspots(an, tri, truth):
    """For each planted hotspot and cycle after onset: best-matching detected hotspot and its triage."""
    truth_cause = truth_frame(an, truth, None)
    rows = []
    for cause in ["nutrient", "disease"]:
        for c in sorted(an.cycle.unique()):
            affected = set(an.loc[(an.cycle == c) & (truth_cause == cause), "plant_id"])
            if not affected:
                continue
            best, best_j = None, 0.0
            for h in tri[(tri.cycle == c) & (tri.status != "resolved")].itertuples():
                m = set(h.member_plant_ids)
                j = len(m & affected) / len(m | affected)
                if j > best_j:
                    best, best_j = h, j
            rows.append({"planted": cause, "cycle": c, "affected": len(affected),
                         "matched_hotspot": best.hotspot_id if best is not None and best_j >= 0.3 else None,
                         "jaccard": round(best_j, 2),
                         "triage": best.likely_cause if best is not None and best_j >= 0.3 else "not found"})
    return pd.DataFrame(rows)


# ── figures ─────────────────────────────────────────────────────────────────

def fig_kdist(rep, kd, nn, elbow, eps, gps_err, k):
    fig, ax = plt.subplots(1, 2, figsize=(12, 4))
    ax[0].plot(np.sort(kd), marker=".")
    ax[0].axhline(elbow, ls="--", c="grey", label=f"elbow {elbow:.1f} m")
    ax[0].axhline(2 * gps_err, ls=":", c="#C44E52", label=f"2 × GPS error {2 * gps_err:.1f} m")
    ax[0].axhline(eps, c="k", label=f"eps used {eps:.1f} m")
    ax[0].set(title=f"k-distance plot (k = {k})", xlabel="plants, sorted", ylabel="distance (m)")
    ax[0].legend()
    ax[1].hist(nn, bins=30, color="#4C72B0")
    ax[1].set(title="Nearest-neighbour distance between GPS-tagged plants", xlabel="m", ylabel="plants")
    rep.fig("02_kdistance_and_nearest_neighbour")


def fig_maps(rep, an, tri, eps, cycles):
    cycles = list(cycles)
    cols = min(5, len(cycles))
    rows = int(np.ceil(len(cycles) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(3.6 * cols, 3.4 * rows), squeeze=False)
    x0, y0 = an.x.min(), an.y.min()
    for ax, c in zip(axes.ravel(), cycles):
        g = an[an.cycle == c]
        ax.scatter(g.x - x0, g.y - y0, s=8, c="#cccccc", label="inspected")
        f = g[g.flag]
        ax.scatter(f.x - x0, f.y - y0, s=14, c="#444444", marker="x", label="anomalous (no hotspot)")
        for h in tri[(tri.cycle == c) & (tri.status != "resolved")].itertuples():
            m = g[g.plant_id.isin(h.member_plant_ids)]
            ax.scatter(m.x - x0, m.y - y0, s=24, c=CAUSE_COLOURS[h.likely_cause])
            ax.annotate(h.hotspot_id, (m.x.mean() - x0, m.y.mean() - y0), fontsize=7,
                        xytext=(4, 4), textcoords="offset points")
        ax.set_title(f"cycle {c}", fontsize=9)
        ax.set_xlim(-5, an.x.max() - x0 + 5)
        ax.set_ylim(-5, an.y.max() - y0 + 5)
        ax.set_aspect("equal")
        ax.tick_params(labelsize=6)
    for ax in axes.ravel()[len(cycles):]:
        ax.axis("off")
    handles = [plt.Line2D([], [], marker="o", ls="", color=v, label=k.replace("_", " ")) for k, v in
               CAUSE_COLOURS.items()]
    fig.legend(handles=handles, loc="lower center", ncol=3, fontsize=8)
    fig.suptitle(f"Hotspots per cycle (UTM 44N metres from the south-west plant, eps {eps:.1f} m)", y=1.0)
    rep.fig("06_hotspot_maps")


def fig_timeline(rep, tri):
    live = tri[tri.status != "resolved"]
    if live.empty:
        return
    fig, ax = plt.subplots(figsize=(10, 4))
    for hid, g in live.groupby("hotspot_id"):
        ax.plot(g.cycle, g.n_members, marker="o", color=CAUSE_COLOURS[g.likely_cause.iloc[-1]])
        ax.annotate(hid, (g.cycle.iloc[-1], g.n_members.iloc[-1]), fontsize=7, xytext=(3, 2),
                    textcoords="offset points")
    ax.set(xlabel="cycle", ylabel="members", title="Hotspot size over time (colour = latest triage)")
    rep.fig("07_hotspot_timeline")


# ── main ────────────────────────────────────────────────────────────────────

def run(args):
    label = "simulated" if args.simulate else "real"
    out = Path(args.out) if args.out else HERE / "results" / "hotspots" / f"{label}_{datetime.now():%Y%m%d-%H%M}"
    rep = Report(out)
    print("output:", out)
    freq = "W" if args.simulate else "M"
    if args.simulate:
        args.start = args.start or "2026-07-10"
        data, fixes, truth, lay = load_simulated(args.simulate, args.seed)
        rep.table(truth, "00_planted_truth")
    else:
        data, fixes, truth, lay = load_supabase()

    # 1. coordinates
    coords, dropped = hs.stable_coordinates(fixes, args.max_accuracy)
    rep.table(dropped.groupby("reason").size().rename("fixes").reset_index(), "01_gps_fixes_dropped")
    if args.zones:
        coords = hs.zone_check(coords, json.loads(Path(args.zones).read_text()))
    rep.table(coords, "01_plant_coordinates")
    cov = rep.table(coverage(data, fixes, coords), "01_gps_coverage")
    print(cov.to_string(index=False))
    usable = coords[coords.plant_id.isin(data.plant_id)]
    if len(usable) < 2 * args.min_samples:
        msg = (f"only {len(usable)} plants have both inspections and a coordinate within {args.max_accuracy} m; "
               "hotspot detection needs more GPS coverage (re-capture with the GPS page, or relax --max-accuracy "
               "knowing positions will be too uncertain to separate neighbouring plants)")
        rep.table(pd.DataFrame([("stopped", msg)], columns=["Item", "Value"]), "00_summary")
        print("STOP:", msg)
        return

    gps_err = float(usable.spread_m.median()) if (usable.n_fixes > 1).any() else float(usable.median_accuracy_m.median())
    eps_auto, elbow, kd = hs.choose_eps(usable, args.min_samples, gps_err)
    eps = args.eps or eps_auto
    nn = hs.nearest_neighbour_m(usable)
    rep.table(pd.DataFrame({"nearest_neighbour_m": np.round(nn, 2)}).describe().round(2), "02_nearest_neighbour",
              index=True)
    rep.table(pd.DataFrame([("k (min_samples - 1)", max(args.min_samples - 1, 1)), ("k-distance elbow (m)", elbow),
                            ("GPS error used (m)", gps_err), ("2 x GPS error (m)", 2 * gps_err),
                            ("eps chosen (m)", eps_auto), ("eps used (m)", eps)], columns=["Item", "Value"]).round(2),
              "02_eps_choice")
    fig_kdist(rep, kd, nn, elbow, eps, gps_err, max(args.min_samples - 1, 1))

    # 2-6
    an, tests, tracks = detect(data, usable, args, freq, eps, args.min_samples)
    tri = add_triage(an, tracks, eps)
    an_out = an[["plant_id", "inspection_date", "cycle", "block", "zone", "foliage_color", "anomaly_score",
                 "iso_flag", "rule_flag", "flag", "reasons"]]
    rep.table(an_out, "03_plant_anomalies")
    rep.table(tests, "04_spatial_tests_per_cycle")
    rep.table(tri, "06_hotspots")

    counts = an.groupby("cycle")[["rule_flag", "iso_flag"]].sum()
    ax = counts.rename(columns={"rule_flag": "rule / z-score", "iso_flag": "Isolation Forest"}).plot.bar(
        figsize=(10, 4), rot=0)
    ax.set(ylabel="anomalous plants", title="Anomalous plants per cycle by detector")
    rep.fig("03_anomalies_per_cycle")
    if args.permutations:
        fig, ax = plt.subplots(figsize=(10, 4))
        for col, lab in [("join_count_p", "join count (flags)"), ("morans_p", "Moran's I (anomaly score)"),
                         ("permutation_p", "DBSCAN clustered share")]:
            ax.plot(tests.cycle, tests[col], marker="o", label=lab)
        ax.axhline(0.05, ls="--", c="grey")
        ax.set(ylabel="permutation p-value", xlabel="cycle", ylim=(0, 1.02),
               title=f"Is there more spatial clustering than chance? ({args.permutations} shuffles within zone)")
        ax.legend()
        rep.fig("04_spatial_tests")

    # 4. sensitivity of DBSCAN parameters (no permutations, same anomalies)
    grid = []
    for e in args.eps_grid:
        for m in args.ms_grid:
            _, t2, tr2 = detect(data, usable, args, freq, e, m, n_perm=0)
            live = tr2[tr2.status != "resolved"] if len(tr2) else tr2
            row = {"eps_m": e, "min_samples": m, "hotspot-cycles": len(live),
                   "mean size": round(float(live.n_members.mean()), 2) if len(live) else 0,
                   "noise share": round(float(t2.noise_anomalies.sum() / max(t2.anomalous.sum(), 1)), 3),
                   "distinct hotspots": live.hotspot_id.nunique() if len(live) else 0}
            if truth is not None and len(live):
                an2 = an.copy()
                ev = eval_hotspots(an2, add_triage(an2, tr2, e), truth)
                row["planted found (share of cycles)"] = round(float(ev.matched_hotspot.notna().mean()), 3)
            grid.append(row)
    grid = rep.table(pd.DataFrame(grid), "05_dbscan_sensitivity")
    piv = grid.pivot(index="min_samples", columns="eps_m",
                     values="planted found (share of cycles)" if truth is not None else "distinct hotspots")
    fig, ax = plt.subplots(figsize=(7, 3.5))
    im = ax.imshow(piv.values, cmap="YlGn", aspect="auto")
    ax.set_xticks(range(piv.shape[1]), piv.columns)
    ax.set_yticks(range(piv.shape[0]), piv.index)
    for (i, j), v in np.ndenumerate(piv.values):
        ax.text(j, i, f"{v:.2f}" if truth is not None else f"{v:.0f}", ha="center", va="center")
    ax.set(xlabel="eps (m)", ylabel="min_samples",
           title="Planted hotspots found (share of cycles)" if truth is not None else "Distinct hotspots")
    plt.colorbar(im, ax=ax)
    rep.fig("05_dbscan_sensitivity")

    cycles = sorted(an.cycle.unique())
    fig_maps(rep, an, tri, eps, cycles[-10:] if len(cycles) > 10 else cycles)
    fig_timeline(rep, tri)

    # 8. referral list for Module 1: latest cycle of each hotspot triaged as likely disease
    live = tri[tri.status != "resolved"]
    latest = live.sort_values("cycle").groupby("hotspot_id").tail(1)
    referral = latest[latest.likely_cause == "likely_disease"]
    rep.table(pd.DataFrame([{"hotspot_id": r.hotspot_id, "cycle": r.cycle, "plant_id": p,
                             "request": "capture leaf and stem images for Module 1 disease identification"}
                            for r in referral.itertuples() for p in r.member_plant_ids]), "08_module1_referrals")

    summary = [("cycles", len(cycles)), ("plants analysed", an.plant_id.nunique()), ("eps (m)", round(eps, 2)),
               ("min_samples", args.min_samples), ("detector used for clustering", args.detector),
               ("cycles with significant join count (p < 0.05)", int((tests.join_count_p < 0.05).sum())),
               ("cycles with significant DBSCAN permutation test", int((tests.permutation_p < 0.05).sum())),
               ("distinct hotspots", live.hotspot_id.nunique()),
               ("latest triage", latest.likely_cause.value_counts().to_dict()),
               ("hotspots referred to Module 1", len(referral))]

    if truth is not None:
        det = rep.table(eval_detectors(an, truth), "09_detector_evaluation")
        hot = rep.table(eval_hotspots(an, tri, truth), "09_planted_hotspot_recovery")
        cm = pd.crosstab(hot.planted, hot.triage).reindex(columns=list(CAUSE_COLOURS) + ["not found"], fill_value=0)
        rep.table(cm, "09_triage_confusion", index=True)
        fig, ax = plt.subplots(figsize=(8, 3))
        ax.imshow(cm.values, cmap="Blues")
        ax.set_xticks(range(cm.shape[1]), [c.replace("_", "\n") for c in cm.columns], fontsize=8)
        ax.set_yticks(range(cm.shape[0]), cm.index)
        for (i, j), v in np.ndenumerate(cm.values):
            ax.text(j, i, v, ha="center", va="center")
        ax.set(title="Triage of planted hotspots (cycle by cycle)", xlabel="pipeline says", ylabel="planted cause")
        rep.fig("09_triage_confusion")

        cont = []
        for cval in [0.05, 0.1, 0.15, 0.2]:
            a2 = an.copy()
            a2["iso_flag"], _ = hs.isolation_forest(a2, cval)
            r = eval_detectors(a2, truth).iloc[1]
            cont.append({"contamination": cval, "Precision": r.Precision, "Recall": r.Recall, "F1": r.F1})
        rep.table(pd.DataFrame(cont), "09_isolation_forest_contamination")
        print(det.to_string(index=False))
        print(cm.to_string())
        summary += [("planted nutrient hotspot found (share of cycles)",
                     round(float(hot[hot.planted == "nutrient"].matched_hotspot.notna().mean()), 3)),
                    ("planted disease hotspot found (share of cycles)",
                     round(float(hot[hot.planted == "disease"].matched_hotspot.notna().mean()), 3))]

    s = rep.table(pd.DataFrame(summary, columns=["Item", "Value"]), "00_summary")
    print(s.to_string(index=False))

    if args.write:
        write(an_out, tri, data if not args.simulate else None)


def write(an_out, tri, data):
    if data is None:
        raise SystemExit("--write stores real data only; simulated runs stay in results/")
    from score_new_inspections import Supabase
    db = Supabase(write=True)
    db.upsert("plant_health_anomalies", [
        {"plant_id": r.plant_id, "inspection_date": r.inspection_date.strftime("%Y-%m-%d"), "cycle": int(r.cycle),
         "anomaly_score": float(r.anomaly_score), "iso_flag": bool(r.iso_flag), "rule_flag": bool(r.rule_flag),
         "reasons": list(r.reasons), "model_version": VERSION} for r in an_out.itertuples()],
        "plant_id,inspection_date")
    live = tri[tri.status != "resolved"]
    db.upsert("health_hotspots", [
        {"hotspot_id": r.hotspot_id, "cycle": int(r.cycle), "member_plant_ids": list(r.member_plant_ids),
         "n_members": int(r.n_members), "centroid_lat": float(r.centroid_lat), "centroid_lon": float(r.centroid_lon),
         "area_m2": float(r.area_m2), "status": r.status, "likely_cause": r.likely_cause,
         "evidence": {k: (None if pd.isna(getattr(r, k)) else float(getattr(r, k))) for k in
                      ("soil_out_of_range_share", "soil_vs_ring_p", "yellow_share", "brown_mixed_share",
                       "onset_spread_cycles", "adjacent_share_total", "net_growth", "nutrient_points",
                       "disease_points")},
         "referred_to_module1": r.likely_cause == "likely_disease", "model_version": VERSION}
        for r in live.itertuples()], "hotspot_id,cycle")
    print(f"written: {len(an_out)} anomaly rows, {len(live)} hotspot rows")


def main():
    p = argparse.ArgumentParser(description="Spatial plant health hotspots with cause triage.")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--simulate", metavar="CSV", help="weekly simulated inspections; plants two labelled hotspots")
    src.add_argument("--supabase", action="store_true", help="real inspections and GPS from Supabase")
    p.add_argument("--max-accuracy", type=float, default=10.0, help="drop GPS fixes reported worse than this (m)")
    p.add_argument("--eps", type=float, help="DBSCAN radius in metres (default: k-distance elbow vs 2 x GPS error)")
    p.add_argument("--min-samples", type=int, default=3)
    p.add_argument("--eps-grid", type=float, nargs="+", default=[5, 8, 12, 15])
    p.add_argument("--ms-grid", type=int, nargs="+", default=[3, 4, 5])
    p.add_argument("--detector", choices=["rule", "iso", "either"], default="rule")
    p.add_argument("--contamination", type=float, default=0.15)
    p.add_argument("--permutations", type=int, default=999)
    p.add_argument("--start", help="first cycle date (default: first inspection)")
    p.add_argument("--zones", help="zones.geojson; flags plants outside their own zone")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--write", action="store_true", help="upsert anomalies and hotspots (needs SUPABASE_SERVICE_KEY)")
    p.add_argument("--out")
    run(p.parse_args())


if __name__ == "__main__":
    main()
