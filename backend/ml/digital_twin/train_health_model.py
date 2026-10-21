"""Train the plant health classifier from past inspection records.

Script version of RP/HealthIndex_Classification.ipynb. Writes figures (PNG), tables (CSV) and the
model bundle that score_new_inspections.py uses.

    python train_health_model.py inspections_weekly_simulated.csv \
        --ground-truth inspections_weekly_ground_truth.csv --defect-log inspections_weekly_defect_log.csv \
        --real "inspections_rows (6).csv"
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import warnings

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import sklearn
from sklearn.base import BaseEstimator, ClassifierMixin, clone
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (ConfusionMatrixDisplay, accuracy_score, average_precision_score,
                             balanced_accuracy_score, classification_report, cohen_kappa_score, confusion_matrix,
                             f1_score, precision_recall_curve, precision_score, recall_score, roc_auc_score,
                             roc_curve)
from sklearn.model_selection import RandomizedSearchCV, StratifiedGroupKFold, learning_curve
from sklearn.neighbors import KNeighborsClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler, label_binarize
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier
from sklearn.utils.class_weight import compute_sample_weight
from xgboost import XGBClassifier

from inspection_prep import (CAT_COLS, CAT_FEATS, CLASS_NAMES, FEATURES, HEALTH_MAP, ISO_DT_RE, NUM_COLS,
                             NUMERIC_FEATS, PID_RE, PSEUDO_NULLS, build_features, clean_inspections, impute,
                             is_number, prepare, read_raw)

warnings.filterwarnings("ignore")
SEED = 42
HERE = Path(__file__).resolve().parent
COLOURS = ["#55A868", "#DD8452", "#C44E52"]


class RuleBasedHealth(BaseEstimator, ClassifierMixin):
    """Domain baseline: 0 stress points -> Healthy, 1 -> Moderate, 2 or more -> Poor."""

    def fit(self, X, y=None):
        self.classes_ = np.array([0, 1, 2])
        return self

    def _points(self, X):
        return (((X["moisture"] <= 3) | (X["moisture"] >= 10)).astype(int)
                + ((X["soil_ph"] < 5.5) | (X["soil_ph"] > 7.0)).astype(int)
                + (X["soil_ec"] < 0.03).astype(int)
                + (X["humidity"] > 85).astype(int)).values

    def predict(self, X):
        p = self._points(X)
        return np.select([p == 0, p == 1], [0, 1], 2)

    def predict_proba(self, X):
        return np.eye(3)[self.predict(X)]


def make_pre(scale=True):
    num = StandardScaler() if scale else "passthrough"
    return ColumnTransformer([("num", num, NUMERIC_FEATS),
                              ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), CAT_FEATS)])


MODELS = {
    "Majority (Dummy)": lambda: Pipeline([("pre", make_pre()), ("clf", DummyClassifier(strategy="most_frequent"))]),
    "Rule-based": lambda: RuleBasedHealth(),
    "Logistic Regression": lambda: Pipeline([("pre", make_pre()), ("clf", LogisticRegression(
        max_iter=3000, class_weight="balanced", random_state=SEED))]),
    "KNN": lambda: Pipeline([("pre", make_pre()), ("clf", KNeighborsClassifier(n_neighbors=15, weights="distance"))]),
    "SVM (RBF)": lambda: Pipeline([("pre", make_pre()), ("clf", SVC(
        probability=True, class_weight="balanced", random_state=SEED))]),
    "Decision Tree": lambda: Pipeline([("pre", make_pre(False)), ("clf", DecisionTreeClassifier(
        max_depth=6, min_samples_leaf=5, class_weight="balanced", random_state=SEED))]),
    "Random Forest": lambda: Pipeline([("pre", make_pre(False)), ("clf", RandomForestClassifier(
        n_estimators=400, min_samples_leaf=2, class_weight="balanced_subsample", random_state=SEED, n_jobs=-1))]),
    "XGBoost": lambda: Pipeline([("pre", make_pre(False)), ("clf", XGBClassifier(
        n_estimators=400, learning_rate=0.05, max_depth=4, subsample=0.8, colsample_bytree=0.8,
        eval_metric="mlogloss", random_state=SEED, n_jobs=-1))]),
}
BASELINES = ("Majority (Dummy)", "Rule-based")

PARAM_GRIDS = {
    "Random Forest": {"clf__n_estimators": [200, 400, 600], "clf__max_depth": [None, 6, 10, 16],
                      "clf__min_samples_leaf": [1, 2, 4], "clf__max_features": ["sqrt", 0.5]},
    "XGBoost": {"clf__n_estimators": [200, 400, 600], "clf__max_depth": [3, 4, 6],
                "clf__learning_rate": [0.03, 0.05, 0.1], "clf__subsample": [0.7, 0.9, 1.0],
                "clf__colsample_bytree": [0.6, 0.8, 1.0], "clf__min_child_weight": [1, 3, 5]},
    "Logistic Regression": {"clf__C": [0.01, 0.1, 1, 10]},
    "SVM (RBF)": {"clf__C": [0.3, 1, 3, 10], "clf__gamma": ["scale", 0.01, 0.1]},
    "KNN": {"clf__n_neighbors": [5, 9, 15, 25], "clf__weights": ["uniform", "distance"]},
    "Decision Tree": {"clf__max_depth": [3, 4, 6, 8, None], "clf__min_samples_leaf": [1, 3, 5, 10]},
}
MAIN = ["Accuracy", "Balanced Acc", "Precision (macro)", "Recall (macro)", "F1 (macro)",
        "F1 (weighted)", "Cohen kappa", "ROC-AUC (macro OvR)"]


def fit_model(name, model, X, y):
    if name == "XGBoost":
        return model.fit(X, y, clf__sample_weight=compute_sample_weight("balanced", y))
    return model.fit(X, y)


def full_proba(model, X):
    p = model.predict_proba(X)
    out = np.zeros((len(X), 3))
    out[:, getattr(model, "classes_", np.arange(3))] = p
    return out


def score_all(y_true, y_pred, proba):
    out = {"Accuracy": accuracy_score(y_true, y_pred),
           "Balanced Acc": balanced_accuracy_score(y_true, y_pred),
           "Precision (macro)": precision_score(y_true, y_pred, average="macro", zero_division=0),
           "Recall (macro)": recall_score(y_true, y_pred, average="macro", zero_division=0),
           "F1 (macro)": f1_score(y_true, y_pred, average="macro", zero_division=0),
           "F1 (weighted)": f1_score(y_true, y_pred, average="weighted", zero_division=0),
           "Cohen kappa": cohen_kappa_score(y_true, y_pred)}
    try:
        out["ROC-AUC (macro OvR)"] = roc_auc_score(y_true, proba, multi_class="ovr", average="macro", labels=[0, 1, 2])
    except ValueError:
        out["ROC-AUC (macro OvR)"] = np.nan
    for i, c in enumerate(CLASS_NAMES):
        out[f"F1 {c}"] = f1_score(y_true, y_pred, labels=[i], average="macro", zero_division=0)
    return out


class Report:
    """Collects figures and tables in one output folder."""

    def __init__(self, out):
        self.out, self.fig_dir, self.tab_dir = out, out / "figures", out / "tables"
        self.fig_dir.mkdir(parents=True, exist_ok=True)
        self.tab_dir.mkdir(exist_ok=True)

    def fig(self, name):
        plt.tight_layout()
        plt.savefig(self.fig_dir / f"{name}.png", dpi=150, bbox_inches="tight")
        plt.close("all")

    def table(self, df, name, index=False):
        df.to_csv(self.tab_dir / f"{name}.csv", index=index)
        return df


def heatmap(ax, data, title, fmt=".2f", cmap="YlGn", vmin=0, vmax=1, label=None):
    cmap = plt.get_cmap(cmap).copy()
    cmap.set_bad("#d9d9d9")  # no inspections in that cell
    im = ax.imshow(np.ma.masked_invalid(data.values.astype(float)), cmap=cmap, vmin=vmin, vmax=vmax, aspect="auto")
    ax.set_xticks(range(data.shape[1]), [str(c) for c in data.columns], rotation=45, ha="right")
    ax.set_yticks(range(data.shape[0]), [str(i) for i in data.index])
    if fmt:
        for (i, j), v in np.ndenumerate(data.values):
            if not np.isnan(v):
                ax.text(j, i, format(v, fmt), ha="center", va="center", fontsize=8)
    ax.set_title(title)
    plt.colorbar(im, ax=ax, label=label)


def audit(raw, rep):
    rows = [("Rows", len(raw)),
            ("Exact duplicate rows", int(raw.duplicated().sum())),
            ("Duplicate record IDs", int(raw["id"].duplicated().sum())),
            ("Malformed plant_id", int((~raw["plant_id"].fillna("").str.match(PID_RE)).sum())),
            ("Non-standard inspection_date format", int((~raw["inspection_date"].fillna("").str.match(ISO_DT_RE)).sum())),
            ("Inspection dates outside 2026", int((~raw["inspection_date"].fillna("").str.contains("2026")).sum()))]
    for c in NUM_COLS:
        v = raw[c].dropna()
        rows.append((f"{c}: missing", int(raw[c].isna().sum())))
        rows.append((f"{c}: non-numeric text (units, commas)", int((~v.map(is_number)).sum())))
    for c in CAT_COLS:
        rows.append((f"{c}: distinct spellings", int(raw[c].nunique())))
    rows.append(("notes: pseudo-null text (n/a, -, NULL)",
                 int(raw["notes"].fillna("").str.strip().str.lower().isin(PSEUDO_NULLS).sum())))
    rows.append(("sync_status = pending", int((raw["sync_status"] == "pending").sum())))
    rep.table(pd.DataFrame(rows, columns=["Check", "Count"]), "01_data_quality_audit")

    miss = raw[NUM_COLS + ["foliage_color"]].isna().mean().mul(100).sort_values()
    fig, ax = plt.subplots(figsize=(8, 4))
    miss.plot.barh(ax=ax, color="#4C72B0")
    for i, v in enumerate(miss):
        ax.text(v + 0.1, i, f"{v:.1f}%", va="center")
    ax.set_xlabel("% missing")
    ax.set_title("Missing values per column (raw data)")
    rep.fig("01_missing_values_raw")


def evaluate_preprocessing(clean, flag_log, clean_temporal, clean_median, gt_file, log_file, rep):
    """Only possible on simulated data, where the clean version and the injected defects are known."""
    gt = pd.read_csv(gt_file)
    gt["inspection_date"] = pd.to_datetime(gt["inspection_date"].str[:10])
    dlog = pd.read_csv(log_file)
    key = ["plant_id", "inspection_date"]

    expected = len(gt) - (dlog["defect_type"] == "missing_visit").sum()
    gt_keys = set(map(tuple, gt[key].astype(str).values))
    cl_keys = set(map(tuple, clean[key].astype(str).values))
    by_id = clean.merge(gt[["id", "plant_id", "inspection_date", "foliage_color", "sunlight_level"]],
                        on="id", suffixes=("", "_gt"))
    labelled = by_id.dropna(subset=["foliage_color"])
    rep.table(pd.DataFrame([
        ("Rows after cleaning vs expected", f"{len(clean)} / {expected}"),
        ("Cleaned records matching a true plant+date", f"{len(cl_keys & gt_keys)} / {len(cl_keys)}"),
        ("Plant IDs restored correctly", f"{(by_id.plant_id == by_id.plant_id_gt).mean():.1%}"),
        ("Inspection dates restored correctly", f"{(by_id.inspection_date == by_id.inspection_date_gt).mean():.1%}"),
        ("Foliage labels standardised correctly (non-missing)",
         f"{(labelled.foliage_color == labelled.foliage_color_gt).mean():.1%}"),
        ("Sunlight labels standardised correctly", f"{(by_id.sunlight_level == by_id.sunlight_level_gt).mean():.1%}"),
    ], columns=["Check", "Result"]), "04_record_restoration")

    invalid_types = ["outlier_probe_not_in_soil", "field_swap_ph_into_ec", "outlier_dropped_digit",
                     "outlier_meter_in_sun", "out_of_scale", "form_default_value", "height_zero_not_measured",
                     "height_negative", "height_unit_mm", "height_digit_swap"]
    truth = dlog[dlog.defect_type.isin(invalid_types)][["row_id", "column", "defect_type"]]
    truth = truth[truth.row_id.isin(set(clean["id"]))]
    truth_set = set(zip(truth.row_id, truth.column))
    flag_set = set(zip(flag_log.id, flag_log.column))
    tp = len(truth_set & flag_set)
    rep.table(pd.DataFrame([("Invalid values injected (rows kept)", len(truth_set)),
                            ("Values flagged by the rules", len(flag_set)),
                            ("Correctly flagged (TP)", tp),
                            ("Precision", round(tp / max(len(flag_set), 1), 3)),
                            ("Recall", round(tp / max(len(truth_set), 1), 3))], columns=["Metric", "Value"]),
              "04_invalid_value_detection")
    per_type = (truth.assign(found=[(r, c) in flag_set for r, c in zip(truth.row_id, truth.column)])
                .groupby("defect_type").found.agg(detected="sum", injected="count"))
    per_type["recall"] = (per_type.detected / per_type.injected).round(2)
    rep.table(per_type, "04_detection_by_defect_type", index=True)

    gt_k = gt.set_index(key)
    rows = []
    for c in NUM_COLS:
        k = clean_temporal.loc[clean_temporal[f"{c}_imputed"].values, key]
        idx = pd.MultiIndex.from_frame(k)
        ok = idx.isin(gt_k.index)
        truth_v = gt_k.loc[idx[ok], c].values
        for name, d in [("Global median", clean_median), ("Temporal (proposed)", clean_temporal)]:
            pred = d.set_index(key).loc[idx[ok], c].values
            rows.append((c, name, int(ok.sum()), np.mean(np.abs(pred - truth_v))))
    mae = rep.table(pd.DataFrame(rows, columns=["Variable", "Method", "Imputed cells", "MAE"]), "04_imputation_mae")
    pivot = mae.pivot(index="Variable", columns="Method", values="MAE")
    pivot["Improvement %"] = (1 - pivot["Temporal (proposed)"] / pivot["Global median"]) * 100
    rep.table(pivot.round(3), "04_imputation_mae_comparison", index=True)

    fig, axes = plt.subplots(1, len(NUM_COLS), figsize=(16, 3.6))
    for ax, c in zip(axes, NUM_COLS):
        sub = mae[mae.Variable == c]
        ax.bar(sub.Method, sub.MAE, color=["#C44E52", "#55A868"])
        ax.set_title(c)
        ax.tick_params(axis="x", rotation=30)
    axes[0].set_ylabel("MAE vs ground truth")
    fig.suptitle("Imputation error: global median vs temporal imputation", y=1.03)
    rep.fig("04_imputation_mae")
    return per_type, pivot


def describe_data(model_df, y, rep):
    fig, axes = plt.subplots(1, 2, figsize=(13, 4))
    counts = pd.Series(y).map(dict(enumerate(CLASS_NAMES))).value_counts().reindex(CLASS_NAMES)
    axes[0].bar(counts.index, counts.values, color=COLOURS)
    for i, v in enumerate(counts.values):
        axes[0].text(i, v, f"{v}\n({v / len(y):.0%})", ha="center", va="bottom")
    axes[0].set_title("HealthIndex class distribution")
    axes[0].set_ylabel("Inspections")
    trend = model_df.assign(unhealthy=model_df.health_index > 0).groupby(["week", "zone"]).unhealthy.mean().unstack()
    (trend * 100).plot(ax=axes[1], marker="o")
    axes[1].set_title("% Moderate/Poor inspections per week by zone")
    axes[1].set_xlabel("Study week (0 = 10 Jul)")
    axes[1].set_ylabel("%")
    rep.fig("05_class_distribution_and_trend")

    block_week = model_df.assign(unhealthy=model_df.health_index > 0).pivot_table(
        index="block", columns="week", values="unhealthy", aggfunc="mean") * 100
    rep.table(block_week.round(1), "05_block_week_unhealthy_pct", index=True)
    fig, ax = plt.subplots(figsize=(12, 4.5))
    heatmap(ax, block_week, "Temporal health by block", fmt=None, cmap="RdYlGn_r", vmax=100, label="% Moderate/Poor")
    ax.set_xlabel("Study week")
    rep.fig("05_block_week_heatmap")

    corr = model_df[NUMERIC_FEATS + ["health_index"]].corr(method="spearman")
    rep.table(corr.round(3), "05_feature_correlation", index=True)
    fig, ax = plt.subplots(figsize=(11, 9))
    heatmap(ax, corr, "Spearman correlation: features and HealthIndex", fmt=None, cmap="coolwarm", vmin=-1)
    rep.fig("05_feature_correlation")


def run(args):
    out = Path(args.out) if args.out else HERE / "results" / "health_model" / datetime.now().strftime("%Y%m%d-%H%M")
    rep = Report(out)
    print("output:", out)

    raw = read_raw(args.csv)
    print("raw rows:", len(raw))
    audit(raw, rep)

    clean, flag_log, prep_summary = clean_inspections(raw)
    rep.table(prep_summary, "02_preprocessing_summary")
    rep.table(flag_log, "02_values_set_missing")
    clean_temporal = impute(clean, "temporal")
    clean_median = impute(clean, "median")
    rep.table(clean_temporal[[f"{c}_imputed" for c in NUM_COLS]].sum().rename("values imputed")
              .rename_axis("column").reset_index(), "03_values_imputed")
    if args.ground_truth and args.defect_log:
        evaluate_preprocessing(clean, flag_log, clean_temporal, clean_median, args.ground_truth, args.defect_log, rep)

    data = build_features(clean_temporal)
    model_df = data.dropna(subset=["health_index"]).reset_index(drop=True)
    model_df["health_index"] = model_df["health_index"].astype(int)
    X, y, groups = model_df[FEATURES], model_df["health_index"].values, model_df["plant_id"].values
    print(f"modelling rows: {len(model_df)} | plants: {model_df.plant_id.nunique()} | "
          f"unlabelled rows left out: {int(data.health_index.isna().sum())}")
    describe_data(model_df, y, rep)

    # whole plants go to one side only; a plant's weekly rows would otherwise leak into the test set
    outer = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=SEED)
    tr, te = next(outer.split(X, y, groups))
    X_tr, X_te = X.iloc[tr].reset_index(drop=True), X.iloc[te].reset_index(drop=True)
    y_tr, y_te, g_tr, g_te = y[tr], y[te], groups[tr], groups[te]
    assert not set(g_tr) & set(g_te), "plant leakage"
    rep.table(pd.DataFrame({"Set": ["Train", "Test"], "Plants": [len(set(g_tr)), len(set(g_te))],
                            "Inspections": [len(y_tr), len(y_te)],
                            **{c: [f"{(y_tr == i).mean():.1%}", f"{(y_te == i).mean():.1%}"]
                               for i, c in enumerate(CLASS_NAMES)}}), "06_train_test_split")
    rep.table(pd.DataFrame({"plant_id": sorted(set(g_te))}), "06_test_plants")
    cv = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=SEED)

    fold_rows, oof = [], {}
    for name, factory in MODELS.items():
        pred, proba = np.zeros(len(y_tr), dtype=int), np.zeros((len(y_tr), 3))
        for k, (a, b) in enumerate(cv.split(X_tr, y_tr, g_tr)):
            m = fit_model(name, factory(), X_tr.iloc[a], y_tr[a])
            pred[b] = m.predict(X_tr.iloc[b])
            proba[b] = full_proba(m, X_tr.iloc[b])
            fold_rows.append({"Model": name, "Fold": k + 1, **score_all(y_tr[b], pred[b], proba[b])})
        oof[name] = pred
        print("  cv done:", name)
    folds = rep.table(pd.DataFrame(fold_rows), "07_cv_fold_scores")
    cv_mean = folds.groupby("Model")[MAIN].mean()
    cv_std = folds.groupby("Model")[MAIN].std()
    order = cv_mean.sort_values("F1 (macro)", ascending=False).index
    rep.table(cv_mean.loc[order].round(4), "07_cv_mean_scores", index=True)
    rep.table((cv_mean.round(3).astype(str) + " ± " + cv_std.round(3).astype(str)).loc[order],
              "07_cv_mean_sd", index=True)
    print(cv_mean.loc[order, ["F1 (macro)", "Balanced Acc", "ROC-AUC (macro OvR)"]].round(3).to_string())

    fig, ax = plt.subplots(figsize=(13, 5))
    show, w, xpos = ["Accuracy", "Balanced Acc", "F1 (macro)", "ROC-AUC (macro OvR)"], 0.2, np.arange(len(order))
    for j, metric in enumerate(show):
        ax.bar(xpos + (j - 1.5) * w, cv_mean.loc[order, metric], w, yerr=cv_std.loc[order, metric], capsize=2,
               label=metric)
    ax.set_xticks(xpos, order, rotation=25, ha="right")
    ax.set_ylim(0, 1.2)
    ax.set_ylabel("Score (mean ± sd, 5 grouped folds)")
    ax.set_title("Model comparison — cross-validation on training plants")
    ax.legend(ncol=4, loc="upper center")
    rep.fig("07_model_comparison_bars")

    fig, axes = plt.subplots(1, 2, figsize=(15, 4.8))
    axes[0].boxplot([folds.loc[folds.Model == m, "F1 (macro)"] for m in order])
    for i, m in enumerate(order, start=1):
        v = folds.loc[folds.Model == m, "F1 (macro)"]
        axes[0].scatter(np.full(len(v), i), v, color="k", s=10, zorder=3)
    axes[0].set_xticks(range(1, len(order) + 1), order, rotation=30, ha="right")
    axes[0].set_title("Macro-F1 across folds")
    per_class = folds.groupby("Model")[[f"F1 {c}" for c in CLASS_NAMES]].mean().loc[order]
    heatmap(axes[1], per_class, "Per-class F1 (CV mean)")
    rep.fig("07_f1_spread_and_per_class")

    fig, axes = plt.subplots(2, 4, figsize=(18, 8.5))
    for ax, name in zip(axes.ravel(), order):
        cm = confusion_matrix(y_tr, oof[name], labels=[0, 1, 2], normalize="true")
        ConfusionMatrixDisplay(cm, display_labels=CLASS_NAMES).plot(ax=ax, cmap="Blues", colorbar=False,
                                                                     values_format=".2f")
        ax.set_title(name)
        rep.table(pd.DataFrame(confusion_matrix(y_tr, oof[name], labels=[0, 1, 2]), index=CLASS_NAMES,
                               columns=CLASS_NAMES).rename_axis("true \\ predicted"),
                  f"07_oof_confusion_{re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')}", index=True)
    fig.suptitle("Out-of-fold confusion matrices (row-normalised)", y=1.01)
    rep.fig("07_confusion_matrices_all_models")

    # selection: highest mean CV macro-F1 among the learned models (accuracy would favour "always Healthy")
    candidates = [m for m in order if m not in BASELINES]
    best = candidates[0]
    gain = cv_mean.loc[best, "F1 (macro)"] - cv_mean.loc["Rule-based", "F1 (macro)"]
    print(f"selected: {best} (macro-F1 {cv_mean.loc[best, 'F1 (macro)']:.3f}), runner-up: {candidates[1]}, "
          f"gain over rule-based {gain:+.3f}")
    grid = PARAM_GRIDS[best]
    n_combo = int(np.prod([len(v) for v in grid.values()]))
    search = RandomizedSearchCV(MODELS[best](), grid, n_iter=min(25, n_combo), scoring="f1_macro", cv=cv,
                                random_state=SEED, n_jobs=-1, refit=True)
    fit_kw = {"clf__sample_weight": compute_sample_weight("balanced", y_tr)} if best == "XGBoost" else {}
    search.fit(X_tr, y_tr, groups=g_tr, **fit_kw)
    final_model = search.best_estimator_
    print(f"tuned {search.best_params_} -> CV macro-F1 {search.best_score_:.3f}")
    rep.table(pd.DataFrame(search.cv_results_).sort_values("rank_test_score")[
        ["params", "mean_test_score", "std_test_score"]].head(10), "08_tuning_top10")

    # held-out plants, used once
    y_pred, y_proba = final_model.predict(X_te), final_model.predict_proba(X_te)
    test_scores = pd.Series(score_all(y_te, y_pred, y_proba))
    rule = RuleBasedHealth().fit(X_tr, y_tr)
    rule_scores = pd.Series(score_all(y_te, rule.predict(X_te), rule.predict_proba(X_te)))
    rep.table(pd.DataFrame({f"{best} (tuned)": test_scores, "Rule-based baseline": rule_scores}).round(3),
              "09_test_scores", index=True)
    report = pd.DataFrame(classification_report(y_te, y_pred, target_names=CLASS_NAMES, output_dict=True,
                                                zero_division=0)).T
    rep.table(report.round(3), "09_test_classification_report", index=True)
    cm = confusion_matrix(y_te, y_pred, labels=[0, 1, 2])
    rep.table(pd.DataFrame(cm, index=CLASS_NAMES, columns=CLASS_NAMES).rename_axis("true \\ predicted"),
              "09_test_confusion_matrix", index=True)
    print(f"test macro-F1 {test_scores['F1 (macro)']:.3f} (rule-based {rule_scores['F1 (macro)']:.3f})")

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    ConfusionMatrixDisplay(cm, display_labels=CLASS_NAMES).plot(ax=axes[0], cmap="Blues", colorbar=False)
    axes[0].set_title("Test confusion matrix (counts)")
    ConfusionMatrixDisplay(confusion_matrix(y_te, y_pred, labels=[0, 1, 2], normalize="true"),
                           display_labels=CLASS_NAMES).plot(ax=axes[1], cmap="Blues", colorbar=False,
                                                            values_format=".2f")
    axes[1].set_title("Test confusion matrix (row-normalised = recall)")
    rep.fig("09_test_confusion_matrix")

    yb = label_binarize(y_te, classes=[0, 1, 2])
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    for i, c in enumerate(CLASS_NAMES):
        if yb[:, i].sum() == 0:
            continue
        fpr, tpr, _ = roc_curve(yb[:, i], y_proba[:, i])
        axes[0].plot(fpr, tpr, label=f"{c} (AUC {roc_auc_score(yb[:, i], y_proba[:, i]):.2f})")
        pr, rc, _ = precision_recall_curve(yb[:, i], y_proba[:, i])
        axes[1].plot(rc, pr, label=f"{c} (AP {average_precision_score(yb[:, i], y_proba[:, i]):.2f})")
    axes[0].plot([0, 1], [0, 1], "k--", lw=0.8)
    axes[0].set(xlabel="False positive rate", ylabel="True positive rate", title="ROC curves (one-vs-rest)")
    axes[1].set(xlabel="Recall", ylabel="Precision", title="Precision–recall curves")
    axes[0].legend()
    axes[1].legend()
    rep.fig("09_roc_pr_curves")

    perm = permutation_importance(final_model, X_te, y_te, scoring="f1_macro", n_repeats=15, random_state=SEED,
                                  n_jobs=-1)
    imp = pd.DataFrame({"feature": FEATURES, "importance": perm.importances_mean, "sd": perm.importances_std}) \
        .sort_values("importance")
    rep.table(imp.sort_values("importance", ascending=False).round(4), "09_permutation_importance")
    clf = final_model.named_steps["clf"]
    has_fi = hasattr(clf, "feature_importances_")
    fig, axes = plt.subplots(1, 2 if has_fi else 1, figsize=(15 if has_fi else 8, 6), squeeze=False)
    axes[0, 0].barh(imp.feature, imp.importance, xerr=imp.sd, color="#4C72B0")
    axes[0, 0].set_title("Permutation importance (drop in test macro-F1)")
    if has_fi:
        names = [n.split("__", 1)[1] for n in final_model.named_steps["pre"].get_feature_names_out()]
        fi = pd.Series(clf.feature_importances_, index=names).sort_values().tail(20)
        axes[0, 1].barh(fi.index, fi.values, color="#55A868")
        axes[0, 1].set_title(f"{best} built-in importance (top 20)")
    rep.fig("09_feature_importance")

    sizes, tr_sc, va_sc, *_ = learning_curve(clone(final_model), X_tr, y_tr, groups=g_tr, cv=cv, scoring="f1_macro",
                                         train_sizes=np.linspace(0.2, 1.0, 5), n_jobs=-1, random_state=SEED,
                                         shuffle=True)
    rep.table(pd.DataFrame({"train_inspections": sizes, "train_mean": tr_sc.mean(1), "train_sd": tr_sc.std(1),
                            "validation_mean": va_sc.mean(1), "validation_sd": va_sc.std(1)}).round(4),
              "09_learning_curve")
    plt.figure(figsize=(7, 4.5))
    for sc, lab in [(tr_sc, "Training"), (va_sc, "Validation")]:
        plt.plot(sizes, sc.mean(1), marker="o", label=lab)
        plt.fill_between(sizes, sc.mean(1) - sc.std(1), sc.mean(1) + sc.std(1), alpha=0.2)
    plt.xlabel("Training inspections")
    plt.ylabel("Macro-F1")
    plt.ylim(0, 1.05)
    plt.title(f"Learning curve — {best}")
    plt.legend()
    rep.fig("09_learning_curve")

    # real field inspections: same steps, model trained on the simulated plants only
    real_scores = None
    if args.real:
        real = prepare(read_raw(args.real))
        real = real.dropna(subset=["health_index"])
        yr = real.health_index.astype(int).values
        rp, rpr = final_model.predict(real[FEATURES]), final_model.predict_proba(real[FEATURES])
        real_scores = pd.Series(score_all(yr, rp, rpr))
        rep.table(real_scores.round(3).rename(f"{best} on real data").to_frame(), "10_real_data_scores", index=True)
        rcm = confusion_matrix(yr, rp, labels=[0, 1, 2])
        rep.table(pd.DataFrame(rcm, index=CLASS_NAMES, columns=CLASS_NAMES).rename_axis("true \\ predicted"),
                  "10_real_data_confusion_matrix", index=True)
        print(f"real inspections: {len(real)} on {real.plant_id.nunique()} plants, "
              f"labels {pd.Series(yr).map(dict(enumerate(CLASS_NAMES))).value_counts().to_dict()}, "
              f"macro-F1 {real_scores['F1 (macro)']:.3f}")
        ConfusionMatrixDisplay(rcm, display_labels=CLASS_NAMES).plot(cmap="Oranges", colorbar=False)
        plt.title("Real field inspections — confusion matrix")
        rep.fig("10_real_data_confusion_matrix")

    # refit on every labelled inspection for use on new records
    deploy = clone(final_model)
    fit_model(best, deploy, X, y)
    version = f"healthindex-{re.sub(r'[^a-z0-9]+', '-', best.lower()).strip('-')}-v1"
    bundle = {"model": deploy, "features": FEATURES, "numeric_features": NUMERIC_FEATS,
              "categorical_features": CAT_FEATS, "class_names": CLASS_NAMES, "health_map": HEALTH_MAP,
              "best_params": search.best_params_, "model_name": best, "version": version,
              "cv_macro_f1": float(search.best_score_), "test_scores": test_scores.round(4).to_dict(),
              "trained_on": str(Path(args.csv).name), "sklearn": sklearn.__version__,
              "trained_at": datetime.now().isoformat(timespec="seconds")}
    joblib.dump(bundle, out / "health_index_model.joblib")
    latest = HERE / "results" / "health_model" / "health_index_model.joblib"
    joblib.dump(bundle, latest)
    data.drop(columns=[c for c in data.columns if c.endswith("_imputed")]).to_csv(out / "inspections_cleaned.csv",
                                                                                  index=False)

    summary = pd.DataFrame([
        ("Selected model", best),
        ("Tuned parameters", json.dumps(search.best_params_, default=str)),
        ("CV macro-F1 (train plants, tuned)", f"{search.best_score_:.3f}"),
        ("Test macro-F1 (held-out plants)", f"{test_scores['F1 (macro)']:.3f}"),
        ("Test accuracy", f"{test_scores['Accuracy']:.3f}"),
        ("Test balanced accuracy", f"{test_scores['Balanced Acc']:.3f}"),
        ("Test ROC-AUC (macro OvR)", f"{test_scores['ROC-AUC (macro OvR)']:.3f}"),
        ("Rule-based baseline test macro-F1", f"{rule_scores['F1 (macro)']:.3f}"),
        ("Real-data macro-F1", f"{real_scores['F1 (macro)']:.3f}" if real_scores is not None else "not run"),
        ("Model version", version),
    ], columns=["Item", "Value"])
    rep.table(summary, "00_results_summary")
    print(summary.to_string(index=False))
    print("model saved:", latest)


def main():
    p = argparse.ArgumentParser(description="Train the HealthIndex classifier from past inspections.")
    p.add_argument("csv", help="past inspections (e.g. inspections_weekly_simulated.csv)")
    p.add_argument("--ground-truth", help="clean version of the CSV, to score the preprocessing")
    p.add_argument("--defect-log", help="injected defects, to score the preprocessing")
    p.add_argument("--real", help="real Supabase inspection export, for the field check")
    p.add_argument("--out", help="output folder (default results/health_model/<timestamp>)")
    run(p.parse_args())


if __name__ == "__main__":
    main()
