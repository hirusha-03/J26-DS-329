"""Checks on the plant health classifier that the notebook does not cover.

train_health_model.py reproduces RP/HealthIndex_Classification.ipynb. This script asks how far its
result can be trusted:

  1. block/zone consistency of the plant ids (and of the plants/slots tables with --supabase)
  2. nested CV: every model tuned inside each outer fold, then compared tuned against tuned
  3. feature selection: full set vs correlation-pruned vs model-based selection, chosen inside each fold
  4. class imbalance: class weights vs SMOTE vs random undersampling, resampled inside each fold only
  5. validation schemes: plant-grouped CV vs leave-one-block-out vs time-forward

    python validate_health_model.py inspections_weekly_simulated.csv [--supabase] [--quick]
"""
from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import re
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from imblearn.over_sampling import SMOTE
from imblearn.pipeline import Pipeline as ImbPipeline
from imblearn.under_sampling import RandomUnderSampler
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_selection import SelectFromModel
from sklearn.metrics import f1_score
from sklearn.model_selection import LeaveOneGroupOut, RandomizedSearchCV, StratifiedGroupKFold
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.utils.class_weight import compute_sample_weight

from inspection_prep import CAT_FEATS, NUMERIC_FEATS, build_features, clean_inspections, impute, read_raw
from train_health_model import BASELINES, MODELS, PARAM_GRIDS, SEED, Report, fit_model

warnings.filterwarnings("ignore")
HERE = Path(__file__).resolve().parent
# Plantation layout (blocks x plants per block), as in verify_twin_state.py
LAYOUT = {"A": (5, 5), "B": (4, 8), "C": (3, 8), "D": (2, 10)}
ML_MODELS = [m for m in MODELS if m not in BASELINES]


def macro_f1(y, p):
    return f1_score(y, p, average="macro", labels=[0, 1, 2], zero_division=0)


def layout_check(df):
    """Every plant id must name a zone, block and plant that exist in the layout."""
    rows = []
    for pid in sorted(df.plant_id.unique()):
        m = re.match(r"^([A-D])(\d{2})-P(\d{3})-G\d+$", pid)
        zone, block, plant = m.group(1), int(m.group(2)), int(m.group(3))
        n_blocks, n_plants = LAYOUT[zone]
        problem = []
        if block > n_blocks:
            problem.append(f"block {block} > {n_blocks} blocks in zone {zone}")
        if plant > n_plants:
            problem.append(f"plant {plant} > {n_plants} plants per block")
        rows.append((pid, zone, f"{zone}-{block:02d}", "; ".join(problem) or "ok"))
    return pd.DataFrame(rows, columns=["plant_id", "zone", "block", "result"])


def supabase_check():
    """plants.zone/block and slots.zone/block must agree with the ids they belong to."""
    from score_new_inspections import Supabase
    db = Supabase()
    rows = []
    for p in db.select("plants", "plant_id,zone,block,slot_id"):
        pid, issues = p["plant_id"], []
        if p["zone"] != pid[0]:
            issues.append(f"zone {p['zone']} != id zone {pid[0]}")
        if p["block"] != pid[1:3]:
            issues.append(f"block {p['block']} != id block {pid[1:3]}")
        if p["slot_id"] and not pid.startswith(p["slot_id"]):
            issues.append(f"slot {p['slot_id']} is not this plant's slot")
        rows.append(("plants", pid, "; ".join(issues) or "ok"))
    for s in db.select("slots", "slot_id,zone,block,active_plant_id"):
        sid, issues = s["slot_id"], []
        if s["zone"] != sid[0] or s["block"] != sid[1:3]:
            issues.append(f"zone/block {s['zone']}/{s['block']} != id {sid[0]}/{sid[1:3]}")
        if s["active_plant_id"] and not s["active_plant_id"].startswith(sid):
            issues.append(f"active plant {s['active_plant_id']} belongs to another slot")
        rows.append(("slots", sid, "; ".join(issues) or "ok"))
    return pd.DataFrame(rows, columns=["table", "id", "result"])


def correlated_to_drop(X, threshold=0.9):
    """Numeric features with |Spearman| above the threshold to an earlier feature. Computed on training rows only."""
    corr = X[NUMERIC_FEATS].corr(method="spearman").abs()
    drop = []
    for i, a in enumerate(NUMERIC_FEATS):
        if a in drop:
            continue
        drop += [b for b in NUMERIC_FEATS[i + 1:] if b not in drop and corr.loc[a, b] > threshold]
    return drop


def pipeline(name, numeric=NUMERIC_FEATS, sampler=None, select=False):
    """The notebook model, optionally with a resampler and a model-based selector inside it."""
    base = MODELS[name]()
    pre = ColumnTransformer([("num", StandardScaler() if name in ("Logistic Regression", "KNN", "SVM (RBF)")
                              else "passthrough", list(numeric)),
                             ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), CAT_FEATS)])
    steps = [("pre", pre)]
    if select:
        steps.append(("select", SelectFromModel(RandomForestClassifier(n_estimators=200, random_state=SEED,
                                                                       n_jobs=-1), threshold="median")))
    if sampler is not None:
        steps.append(("sample", sampler))
    clf = clone(base.named_steps["clf"])
    if sampler is not None and hasattr(clf, "class_weight"):
        clf.set_params(class_weight=None)          # resampled data is already balanced
    steps.append(("clf", clf))
    return ImbPipeline(steps)


def fit(name, model, X, y, weighted=True):
    if name == "XGBoost" and weighted:
        return model.fit(X, y, clf__sample_weight=compute_sample_weight("balanced", y))
    return model.fit(X, y)


def nested_cv(X, y, g, rep, n_iter):
    """Outer plant-grouped folds score; inner plant-grouped folds tune. Tuning never sees the outer test plants."""
    outer = StratifiedGroupKFold(5, shuffle=True, random_state=SEED)
    rows, params = [], []
    for name in ML_MODELS:
        grid = PARAM_GRIDS[name]
        n_combo = int(np.prod([len(v) for v in grid.values()]))
        for k, (a, b) in enumerate(outer.split(X, y, g)):
            inner = StratifiedGroupKFold(3, shuffle=True, random_state=SEED + k)
            search = RandomizedSearchCV(MODELS[name](), grid, n_iter=min(n_iter, n_combo), scoring="f1_macro",
                                        cv=inner, random_state=SEED, n_jobs=-1, refit=True)
            kw = {"clf__sample_weight": compute_sample_weight("balanced", y[a])} if name == "XGBoost" else {}
            search.fit(X.iloc[a], y[a], groups=g[a], **kw)
            pred = search.best_estimator_.predict(X.iloc[b])
            train_f1 = macro_f1(y[a], search.best_estimator_.predict(X.iloc[a]))
            rows.append({"Model": name, "Fold": k + 1, "Test macro-F1": macro_f1(y[b], pred),
                         "Train macro-F1": train_f1})
            params.append({"Model": name, "Fold": k + 1, "params": str(search.best_params_)})
        print(f"  nested CV done: {name}")
    folds = rep.table(pd.DataFrame(rows), "11_nested_cv_folds")
    rep.table(pd.DataFrame(params), "11_nested_cv_chosen_params")
    summary = folds.groupby("Model").agg(mean=("Test macro-F1", "mean"), sd=("Test macro-F1", "std"),
                                         train=("Train macro-F1", "mean"))
    summary["overfit_gap"] = summary["train"] - summary["mean"]
    summary = rep.table(summary.sort_values("mean", ascending=False).round(3), "11_nested_cv_summary", index=True)

    order = summary.index
    fig, ax = plt.subplots(figsize=(9, 4.5))
    ax.boxplot([folds.loc[folds.Model == m, "Test macro-F1"] for m in order])
    for i, m in enumerate(order, start=1):
        v = folds.loc[folds.Model == m, "Test macro-F1"]
        ax.scatter(np.full(len(v), i), v, color="k", s=10, zorder=3)
    ax.set_xticks(range(1, len(order) + 1), order, rotation=25, ha="right")
    ax.set_ylabel("Outer-fold macro-F1")
    ax.set_title("Nested CV: every model tuned inside each outer fold")
    rep.fig("11_nested_cv")
    return summary


def compare_variants(X, y, g, variants, name_prefix, rep, title):
    """Same plant-grouped folds for every variant; anything fitted (selection, resampling) is fitted per fold."""
    cv = StratifiedGroupKFold(5, shuffle=True, random_state=SEED)
    rows = []
    for label, (model_name, make, weighted) in variants.items():
        for k, (a, b) in enumerate(cv.split(X, y, g)):
            m = fit(model_name, make(X.iloc[a]), X.iloc[a], y[a], weighted)
            rows.append({"Variant": label, "Model": model_name, "Fold": k + 1,
                         "macro-F1": macro_f1(y[b], m.predict(X.iloc[b]))})
    folds = rep.table(pd.DataFrame(rows), f"{name_prefix}_folds")
    summary = folds.groupby(["Model", "Variant"])["macro-F1"].agg(["mean", "std"]).round(3)
    rep.table(summary, f"{name_prefix}_summary", index=True)

    pivot = summary["mean"].unstack("Variant")
    err = summary["std"].unstack("Variant")
    ax = pivot.plot.bar(yerr=err, capsize=3, figsize=(10, 4.5), rot=0)
    ax.set_ylabel("macro-F1 (5 plant-grouped folds)")
    ax.set_ylim(0, 1)
    ax.set_title(title)
    ax.legend(fontsize=8)
    rep.fig(name_prefix)
    return summary


def validation_schemes(d, X, y, g, rep, svm_params, week_cut):
    """Plant-grouped CV is the optimistic case. Blocks and later weeks the model never saw are harder."""
    blocks = d["block"].values
    weeks = d["week"].values
    schemes = {}

    cv = StratifiedGroupKFold(5, shuffle=True, random_state=SEED)
    schemes["Plant-grouped 5-fold"] = [(a, b) for a, b in cv.split(X, y, g)]
    schemes["Leave-one-block-out"] = list(LeaveOneGroupOut().split(X, y, blocks))
    a = np.where(weeks <= week_cut)[0]
    b = np.where(weeks > week_cut)[0]
    schemes[f"Time-forward (weeks 0-{week_cut} to later)"] = [(a, b)]
    # later weeks of plants never seen at all: the strictest case
    test_plants = set(g[schemes["Plant-grouped 5-fold"][0][1]])
    a2 = np.where((weeks <= week_cut) & ~np.isin(g, list(test_plants)))[0]
    b2 = np.where((weeks > week_cut) & np.isin(g, list(test_plants)))[0]
    schemes["Time-forward, new plants only"] = [(a2, b2)]

    models = {m: (lambda m=m: MODELS[m]()) for m in ML_MODELS}
    models["SVM (RBF) tuned"] = lambda: MODELS["SVM (RBF)"]().set_params(**svm_params)
    rows, per_block = [], []
    for scheme, splits in schemes.items():
        for name, make in models.items():
            pred = np.full(len(y), -1)
            for a, b in splits:
                m = fit_model(name.replace(" tuned", ""), make(), X.iloc[a], y[a])
                pred[b] = m.predict(X.iloc[b])
            tested = pred >= 0
            rows.append({"Scheme": scheme, "Model": name, "Test rows": int(tested.sum()),
                         "macro-F1": macro_f1(y[tested], pred[tested])})
            if scheme == "Leave-one-block-out" and name == "SVM (RBF) tuned":
                for blk in sorted(set(blocks)):
                    sel = blocks == blk
                    per_block.append({"block": blk, "rows": int(sel.sum()),
                                      "share not Healthy": round(float((y[sel] > 0).mean()), 3),
                                      "accuracy": round(float((pred[sel] == y[sel]).mean()), 3)})
        print(f"  scheme done: {scheme}")
    res = rep.table(pd.DataFrame(rows).round(3), "14_validation_schemes")
    rep.table(pd.DataFrame(per_block), "14_leave_one_block_out_per_block")

    pivot = res.pivot(index="Model", columns="Scheme", values="macro-F1")[list(schemes)]
    ax = pivot.plot.bar(figsize=(12, 4.8), rot=20)
    ax.set_ylabel("macro-F1 (pooled out-of-fold)")
    ax.set_ylim(0, 1)
    ax.set_title("Same models, stricter splits")
    ax.legend(fontsize=8)
    rep.fig("14_validation_schemes")
    return res


def run(args):
    out = Path(args.out) if args.out else HERE / "results" / "health_validation" / datetime.now().strftime("%Y%m%d-%H%M")
    rep = Report(out)
    print("output:", out)

    clean, _, _ = clean_inspections(read_raw(args.csv))
    d = build_features(impute(clean, "temporal")).dropna(subset=["health_index"]).reset_index(drop=True)
    d["health_index"] = d["health_index"].astype(int)
    X, y, g = d[NUMERIC_FEATS + CAT_FEATS], d["health_index"].values, d["plant_id"].values

    lay = rep.table(layout_check(d), "10_layout_check")
    print(f"layout check: {int((lay.result != 'ok').sum())} of {len(lay)} plant ids outside the layout")
    if args.supabase:
        db = rep.table(supabase_check(), "10_supabase_consistency")
        print(f"supabase check: {int((db.result != 'ok').sum())} of {len(db)} rows disagree with their id")

    # hold out the same 20 % of plants as train_health_model.py, so nothing here is fitted on them
    tr, _ = next(StratifiedGroupKFold(5, shuffle=True, random_state=SEED).split(X, y, g))
    Xt, yt, gt = X.iloc[tr].reset_index(drop=True), y[tr], g[tr]

    nested = nested_cv(Xt, yt, gt, rep, n_iter=3 if args.quick else 10)
    print(nested.to_string())

    drop = correlated_to_drop(Xt)
    rep.table(pd.DataFrame({"dropped (|rho| > 0.9 to an earlier feature)": drop}), "12_correlated_features")
    kept = [f for f in NUMERIC_FEATS if f not in drop]
    variants = {}
    for m in ("SVM (RBF)", "Random Forest", "XGBoost"):
        variants[f"{m}: all {len(NUMERIC_FEATS)} numeric"] = (m, lambda X_, m=m: pipeline(m), True)
        variants[f"{m}: correlation-pruned ({len(kept)})"] = (m, lambda X_, m=m: pipeline(m, kept), True)
        variants[f"{m}: model-selected (inside fold)"] = (m, lambda X_, m=m: pipeline(m, select=True), True)
    fs = compare_variants(Xt, yt, gt, variants, "12_feature_selection", rep,
                          "Feature selection, decided inside each training fold")
    print(fs.to_string())

    samplers = {}
    for m in ("SVM (RBF)", "Random Forest", "XGBoost"):
        samplers[f"{m}: class weights"] = (m, lambda X_, m=m: pipeline(m), True)
        samplers[f"{m}: SMOTE"] = (m, lambda X_, m=m: pipeline(m, sampler=SMOTE(random_state=SEED)), False)
        samplers[f"{m}: undersampling"] = (m, lambda X_, m=m: pipeline(m, sampler=RandomUnderSampler(
            random_state=SEED)), False)
    rs = compare_variants(Xt, yt, gt, samplers, "13_resampling", rep,
                          "Class imbalance: weights vs SMOTE vs undersampling (resampled in training folds only)")
    print(rs.to_string())

    vs = validation_schemes(d, X, y, g, rep, {"clf__C": 3, "clf__gamma": 0.01}, args.week_cut)
    print(vs.pivot(index="Model", columns="Scheme", values="macro-F1").round(3).to_string())


def main():
    p = argparse.ArgumentParser(description="Robustness checks for the plant health classifier.")
    p.add_argument("csv", help="past inspections (e.g. inspections_weekly_simulated.csv)")
    p.add_argument("--supabase", action="store_true", help="also check zone/block in the plants and slots tables")
    p.add_argument("--week-cut", type=int, default=10, help="time-forward split: train on weeks 0..N")
    p.add_argument("--quick", action="store_true", help="fewer tuning iterations")
    p.add_argument("--out")
    run(p.parse_args())


if __name__ == "__main__":
    main()
