"""Threshold baseline, Logistic Regression, XGBoost with repeated stratified
cross-validation and topic-held-out evaluation; results saved to
outputs/results/.

Run order: train_eval.py -> train_final.py"""

import json
import platform

import numpy as np
import pandas as pd
import sklearn
import xgboost
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from scipy.stats import t as t_dist

from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    balanced_accuracy_score,
    brier_score_loss,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import (
    LeaveOneGroupOut,
    RepeatedStratifiedKFold,
    StratifiedKFold,
    train_test_split,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from xgboost import XGBClassifier

import config

SEED = 42
N_SPLITS = 5
N_REPEATS = 10

RESULTS_DIR = config.OUTPUTS_DIR / "results"
FEATURES_CSV = config.OUTPUTS_DIR / "features.csv"
FEATURE_BLOCKS_JSON = config.OUTPUTS_DIR / "feature_blocks.json"
LABELS_CSV = config.DATA_DIR / "labels" / "labeling_sheet_labeled.csv"

# Selective-answering operating point (nested-CV threshold selection)
TARGET_COVERAGE = 0.20
TARGET_COVERAGE_REASON = (
    "safety-oriented operating point: answer confidently only for the most "
    "certain fifth of queries"
)

CATEGORICAL_COLS = ["qword"]

MODEL_CLASSIFIERS = {
    "Majority": ["Majority"],
    "M0": ["Threshold", "LR"],
    "M1": ["LR", "XGB"],
    "M2": ["LR", "XGB"],
    "M3": ["LR", "XGB"],
    "Q_only": ["LR", "XGB"],
    "M3+Q": ["LR", "XGB"],
    "M3+Q+R": ["LR", "XGB"],
}

# (name, model_a, model_b) -- for the XGB row, model_b="M0" always falls back
# to M0's LR model since M0 has no XGB variant.
COMPARISON_SPECS = [
    ("M2-M1", "M2", "M1"),
    ("M3-M2", "M3", "M2"),
    ("M3-M0", "M3", "M0"),
    ("M3-Qonly", "M3", "Q_only"),
    ("M3+Q-M3", "M3+Q", "M3"),
]

METRICS = [
    "macro_f1",
    "balanced_accuracy",
    "roc_auc",
    "pr_auc",
    "precision_1",
    "recall_1",
    "brier",
    "log_loss",
]


# --------------------------------------------------------------------------
# Data loading
# --------------------------------------------------------------------------
def load_data():
    feat = pd.read_csv(FEATURES_CSV, dtype=str, keep_default_na=False)
    labels = pd.read_csv(LABELS_CSV, dtype=str, keep_default_na=False)
    meta = pd.read_csv(config.QUERIES_MASTER_CSV, dtype=str, keep_default_na=False)

    df = feat.merge(labels[["query_id", "label"]], on="query_id", how="inner")
    df = df.merge(meta[["query_id", "topic", "intended_type"]], on="query_id", how="inner")

    assert len(df) == 400, f"expected 400 rows after join, got {len(df)}"

    df["label"] = df["label"].astype(int)
    counts = df["label"].value_counts()
    assert counts.get(1, 0) == 135 and counts.get(0, 0) == 265, (
        f"expected 135 ones / 265 zeros, got {counts.to_dict()}"
    )

    feature_cols = [c for c in feat.columns if c != "query_id"]
    for c in feature_cols:
        if c not in CATEGORICAL_COLS:
            df[c] = df[c].astype(float)

    return df, feature_cols


def load_feature_blocks():
    with open(FEATURE_BLOCKS_JSON, "r", encoding="utf-8") as f:
        blocks = json.load(f)
    blocks["Majority"] = []
    return blocks


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------
class MajorityClassifier:
    def fit(self, X, y):
        return self

    def predict(self, X):
        return np.zeros(len(X), dtype=int)

    def predict_proba(self, X):
        n = len(X)
        return np.column_stack([np.ones(n), np.zeros(n)])


class ThresholdClassifier:
    """Chooses the s1 threshold maximizing macro-F1 on the training fold."""

    def fit(self, s_train, y_train):
        s = np.asarray(s_train, dtype=float).ravel()
        uniq = np.unique(s)
        mids = (uniq[:-1] + uniq[1:]) / 2.0
        candidates = np.concatenate([[uniq[0] - 1e-6], mids, [uniq[-1] + 1e-6]])
        best_f1, best_t = -1.0, candidates[0]
        for t in candidates:
            pred = (s >= t).astype(int)
            f1 = f1_score(y_train, pred, average="macro", zero_division=0)
            if f1 > best_f1:
                best_f1, best_t = f1, t
        self.threshold_ = best_t
        return self

    def predict(self, s_test):
        s = np.asarray(s_test, dtype=float).ravel()
        return (s >= self.threshold_).astype(int)

    def predict_proba(self, s_test):
        s = np.clip(np.asarray(s_test, dtype=float).ravel(), 0.0, 1.0)
        return np.column_stack([1.0 - s, s])


def build_preprocessor(cols, scale):
    numeric_cols = [c for c in cols if c not in CATEGORICAL_COLS]
    cat_cols = [c for c in cols if c in CATEGORICAL_COLS]
    transformers = []
    if numeric_cols:
        transformers.append(
            ("num", StandardScaler() if scale else "passthrough", numeric_cols)
        )
    if cat_cols:
        transformers.append(
            ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), cat_cols)
        )
    return ColumnTransformer(transformers)


def make_lr_pipeline(cols):
    pre = build_preprocessor(cols, scale=True)
    clf = LogisticRegression(
        penalty="l2", C=1.0, class_weight="balanced", max_iter=5000
    )
    return Pipeline([("pre", pre), ("clf", clf)])


def make_xgb_pipeline(cols, y_train):
    n_pos = int((y_train == 1).sum())
    n_neg = int((y_train == 0).sum())
    scale_pos_weight = n_neg / n_pos
    pre = build_preprocessor(cols, scale=False)
    clf = XGBClassifier(
        n_estimators=200,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        scale_pos_weight=scale_pos_weight,
        random_state=SEED,
        eval_metric="logloss",
    )
    return Pipeline([("pre", pre), ("clf", clf)])


def fit_predict(model_name, clf_name, cols, df_train, df_test):
    y_train = df_train["label"].values
    y_test = df_test["label"].values

    if clf_name == "Majority":
        est = MajorityClassifier().fit(df_train, y_train)
        proba = est.predict_proba(df_test)[:, 1]
        pred = est.predict(df_test)
    elif clf_name == "Threshold":
        est = ThresholdClassifier().fit(df_train["s1"].values, y_train)
        proba = est.predict_proba(df_test["s1"].values)[:, 1]
        pred = est.predict(df_test["s1"].values)
    elif clf_name == "LR":
        est = make_lr_pipeline(cols)
        est.fit(df_train[cols], y_train)
        proba = est.predict_proba(df_test[cols])[:, 1]
        pred = (proba >= 0.5).astype(int)
    elif clf_name == "XGB":
        est = make_xgb_pipeline(cols, y_train)
        est.fit(df_train[cols], y_train)
        proba = est.predict_proba(df_test[cols])[:, 1]
        pred = (proba >= 0.5).astype(int)
    else:
        raise ValueError(f"unknown classifier {clf_name}")

    return est, proba, pred, y_test


def compute_metrics(y_true, y_prob, y_pred):
    out = {}
    out["macro_f1"] = f1_score(y_true, y_pred, average="macro", zero_division=0)
    out["balanced_accuracy"] = balanced_accuracy_score(y_true, y_pred)
    try:
        out["roc_auc"] = roc_auc_score(y_true, y_prob)
    except ValueError:
        out["roc_auc"] = np.nan
    try:
        out["pr_auc"] = average_precision_score(y_true, y_prob)
    except ValueError:
        out["pr_auc"] = np.nan
    out["precision_1"] = precision_score(y_true, y_pred, pos_label=1, zero_division=0)
    out["recall_1"] = recall_score(y_true, y_pred, pos_label=1, zero_division=0)
    out["brier"] = brier_score_loss(y_true, y_prob)
    proba_clipped = np.clip(y_prob, 1e-7, 1 - 1e-7)
    out["log_loss"] = log_loss(y_true, proba_clipped, labels=[0, 1])
    return out


# --------------------------------------------------------------------------
# run_config.json
# --------------------------------------------------------------------------
def write_run_config():
    cfg = {
        "seed": SEED,
        "cv": {
            "method": "RepeatedStratifiedKFold",
            "n_splits": N_SPLITS,
            "n_repeats": N_REPEATS,
            "random_state": SEED,
        },
        "topic_holdout": {
            "method": "LeaveOneGroupOut",
            "group": "topic",
            "n_groups": 12,
        },
        "feature_sets": "Majority, M0, M1, M2, M3, Q_only, M3+Q, M3+Q+R (see outputs/feature_blocks.json)",
        "classifiers": {
            "LR": {
                "pipeline": "StandardScaler + LogisticRegression",
                "penalty": "l2",
                "C": 1.0,
                "class_weight": "balanced",
                "max_iter": 5000,
                "decision_threshold": 0.5,
            },
            "XGB": {
                "n_estimators": 200,
                "max_depth": 3,
                "learning_rate": 0.05,
                "subsample": 0.8,
                "colsample_bytree": 0.8,
                "scale_pos_weight": "n_neg/n_pos computed on the training fold",
                "random_state": SEED,
                "decision_threshold": 0.5,
            },
            "Threshold_M0": {
                "rule": "s1 threshold maximizing macro-F1 on the training fold, applied to the test fold"
            },
            "Majority": {"rule": "always predicts 0"},
        },
        "comparisons": {
            "method": "Nadeau-Bengio corrected resampled t-test",
            "n_folds": N_SPLITS * N_REPEATS,
            "n_train": int(400 * (N_SPLITS - 1) / N_SPLITS),
            "n_test": int(400 / N_SPLITS),
            "pairs": COMPARISON_SPECS,
            "note": (
                "M0 has no XGB variant; M3-M0 comparisons for the XGB classifier "
                "row use M0's LR model as the baseline."
            ),
        },
        "versions": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scikit-learn": sklearn.__version__,
            "xgboost": xgboost.__version__,
            "matplotlib": matplotlib.__version__,
        },
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    with open(RESULTS_DIR / "run_config.json", "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, default=str)


# --------------------------------------------------------------------------
# Repeated stratified CV
# --------------------------------------------------------------------------
def generate_folds(df):
    rskf = RepeatedStratifiedKFold(
        n_splits=N_SPLITS, n_repeats=N_REPEATS, random_state=SEED
    )
    splits = list(rskf.split(df, df["label"]))
    rows = []
    for i, (_, test_idx) in enumerate(splits):
        repeat, fold = divmod(i, N_SPLITS)
        for idx in test_idx:
            rows.append(
                {"repeat": repeat, "fold": fold, "query_id": df.iloc[idx]["query_id"]}
            )
    fold_df = pd.DataFrame(rows)
    return splits, fold_df


def run_cv(df, blocks):
    splits, fold_df = generate_folds(df)
    fold_df.to_csv(RESULTS_DIR / "fold_assignments.csv", index=False, encoding="utf-8-sig")

    oof_rows = []
    fold_metric_rows = []
    cached_m3_xgb = []

    for i, (train_idx, test_idx) in enumerate(splits):
        repeat, fold = divmod(i, N_SPLITS)
        df_train = df.iloc[train_idx]
        df_test = df.iloc[test_idx]

        for model_name, cols in blocks.items():
            for clf_name in MODEL_CLASSIFIERS[model_name]:
                est, proba, pred, y_test = fit_predict(
                    model_name, clf_name, cols, df_train, df_test
                )
                m = compute_metrics(y_test, proba, pred)
                m.update({"repeat": repeat, "fold": fold, "model": model_name, "classifier": clf_name})
                fold_metric_rows.append(m)

                for qid, yt, yp, pr in zip(df_test["query_id"], y_test, pred, proba):
                    oof_rows.append(
                        {
                            "repeat": repeat,
                            "fold": fold,
                            "query_id": qid,
                            "model": model_name,
                            "classifier": clf_name,
                            "y_true": yt,
                            "y_prob": pr,
                            "y_pred": yp,
                        }
                    )

                if model_name == "M3" and clf_name == "XGB":
                    cached_m3_xgb.append((repeat, fold, est, df_test.copy(), y_test))

    fold_metrics_df = pd.DataFrame(fold_metric_rows)
    oof_df = pd.DataFrame(oof_rows)
    oof_df.to_csv(RESULTS_DIR / "oof_predictions.csv", index=False, encoding="utf-8-sig")
    return fold_metrics_df, oof_df, cached_m3_xgb


def aggregate_cv(fold_metrics_df):
    g = fold_metrics_df.groupby(["model", "classifier"])
    mean = g[METRICS].mean().add_suffix("_mean")
    std = g[METRICS].std().add_suffix("_std")
    out = mean.join(std).reset_index()
    out.to_csv(RESULTS_DIR / "results_cv.csv", index=False, encoding="utf-8-sig")
    return out


# --------------------------------------------------------------------------
# Topic-held-out (LeaveOneGroupOut)
# --------------------------------------------------------------------------
def run_topic_holdout(df, blocks):
    logo = LeaveOneGroupOut()
    groups = df["topic"].values
    splits = list(logo.split(df, df["label"], groups))

    oof_rows = []
    for train_idx, test_idx in splits:
        df_train = df.iloc[train_idx]
        df_test = df.iloc[test_idx]
        held_topic = df_test["topic"].iloc[0]

        for model_name, cols in blocks.items():
            for clf_name in MODEL_CLASSIFIERS[model_name]:
                _, proba, pred, y_test = fit_predict(
                    model_name, clf_name, cols, df_train, df_test
                )
                for qid, yt, yp, pr in zip(df_test["query_id"], y_test, pred, proba):
                    oof_rows.append(
                        {
                            "topic": held_topic,
                            "query_id": qid,
                            "model": model_name,
                            "classifier": clf_name,
                            "y_true": yt,
                            "y_prob": pr,
                            "y_pred": yp,
                        }
                    )

    oof_df = pd.DataFrame(oof_rows)
    rows = []
    for (model_name, clf_name), sub in oof_df.groupby(["model", "classifier"]):
        m = compute_metrics(sub["y_true"].values, sub["y_prob"].values, sub["y_pred"].values)
        m.update({"model": model_name, "classifier": clf_name, "n": len(sub)})
        rows.append(m)
    res = pd.DataFrame(rows)
    res.to_csv(RESULTS_DIR / "results_topic_holdout.csv", index=False, encoding="utf-8-sig")
    return res


# --------------------------------------------------------------------------
# Comparisons (Nadeau-Bengio corrected resampled t-test)
# --------------------------------------------------------------------------
def fold_scores(fold_metrics_df, model, clf, metric):
    sub = fold_metrics_df[(fold_metrics_df.model == model) & (fold_metrics_df.classifier == clf)]
    sub = sub.sort_values(["repeat", "fold"])
    return sub[metric].values


def corrected_resampled_ttest(diffs, n_train, n_test):
    n = len(diffs)
    mean_diff = float(diffs.mean())
    var = float(diffs.var(ddof=1))
    corrected_var = var * (1.0 / n + n_test / n_train)
    se = np.sqrt(corrected_var)
    df_ = n - 1
    if se == 0:
        t_stat = 0.0 if mean_diff == 0 else np.inf * np.sign(mean_diff)
        p = 0.0 if mean_diff != 0 else 1.0
        ci = (mean_diff, mean_diff)
    else:
        t_stat = mean_diff / se
        p = 2 * (1 - t_dist.cdf(abs(t_stat), df_))
        tcrit = t_dist.ppf(0.975, df_)
        ci = (mean_diff - tcrit * se, mean_diff + tcrit * se)
    return mean_diff, ci, p


def run_comparisons(fold_metrics_df):
    n_train = int(400 * (N_SPLITS - 1) / N_SPLITS)
    n_test = int(400 / N_SPLITS)
    rows = []
    for clf in ["LR", "XGB"]:
        for name, model_a, model_b in COMPARISON_SPECS:
            clf_b = "LR" if model_b == "M0" else clf
            for metric in ["macro_f1", "roc_auc", "brier"]:
                a = fold_scores(fold_metrics_df, model_a, clf, metric)
                b = fold_scores(fold_metrics_df, model_b, clf_b, metric)
                diffs = a - b
                mean_diff, ci, p = corrected_resampled_ttest(diffs, n_train, n_test)
                rows.append(
                    {
                        "classifier": clf,
                        "comparison": name,
                        "metric": metric,
                        "model_a": model_a,
                        "model_b": model_b,
                        "classifier_b": clf_b,
                        "mean_delta": mean_diff,
                        "ci_low": ci[0],
                        "ci_high": ci[1],
                        "p_value": p,
                    }
                )
    out = pd.DataFrame(rows)
    out.to_csv(RESULTS_DIR / "comparisons.csv", index=False, encoding="utf-8-sig")
    return out


# --------------------------------------------------------------------------
# Analyses
# --------------------------------------------------------------------------
def run_univariate_auc(df, feature_cols):
    y = df["label"].values
    rows = []
    for c in feature_cols:
        if c in CATEGORICAL_COLS:
            continue
        x = df[c].values
        try:
            auc = roc_auc_score(y, x)
        except ValueError:
            auc = np.nan
        rows.append({"feature": c, "roc_auc": auc})
    out = pd.DataFrame(rows).sort_values("roc_auc", ascending=False)
    out.to_csv(RESULTS_DIR / "univariate_auc.csv", index=False, encoding="utf-8-sig")
    return out


ATS_FEATURES = [
    "s1", "s2", "s3", "s_mean", "s_std", "gap12", "gap13", "gap23",
    "C_mean", "C_min", "C_p25",
    "C_single", "delta_C", "C_rank1", "C_weighted", "C_weighted_min",
]


def run_correlations(df):
    corr = df[ATS_FEATURES].corr(method="spearman")
    corr.to_csv(RESULTS_DIR / "correlations.csv", encoding="utf-8-sig")
    return corr


def run_hard_cases(df):
    thresh = df["s1"].quantile(2.0 / 3.0)
    sub = df[df["s1"] >= thresh]
    y = sub["label"].values
    rows = []
    for c in ["s1", "C_min", "C_p25", "C_weighted_min", "delta_C"]:
        x = sub[c].values
        try:
            auc = roc_auc_score(y, x)
        except ValueError:
            auc = np.nan
        rows.append({"feature": c, "roc_auc": auc, "n": len(sub)})
    out = pd.DataFrame(rows)
    out.to_csv(RESULTS_DIR / "hard_cases.csv", index=False, encoding="utf-8-sig")
    return out


def run_lr_coefficients(df, blocks):
    rows = []
    for model_name in ["M3", "M3+Q"]:
        cols = blocks[model_name]
        pipe = make_lr_pipeline(cols)
        pipe.fit(df[cols], df["label"].values)
        feature_names = pipe.named_steps["pre"].get_feature_names_out()
        coefs = pipe.named_steps["clf"].coef_.ravel()
        for fn, co in zip(feature_names, coefs):
            rows.append({"model": model_name, "feature": fn, "coefficient": co})
    out = pd.DataFrame(rows)
    out.to_csv(RESULTS_DIR / "lr_coefficients.csv", index=False, encoding="utf-8-sig")
    return out


def run_xgb_importance(cached_m3_xgb, m3_cols):
    rng = np.random.default_rng(SEED)
    drops = {f: [] for f in m3_cols}
    for _, _, est, df_test, y_test in cached_m3_xgb:
        X_test = df_test[m3_cols].copy()
        base_pred = est.predict(X_test)
        base_f1 = f1_score(y_test, base_pred, average="macro", zero_division=0)
        for f in m3_cols:
            X_perm = X_test.copy()
            X_perm[f] = rng.permutation(X_perm[f].values)
            pred = est.predict(X_perm)
            f1 = f1_score(y_test, pred, average="macro", zero_division=0)
            drops[f].append(base_f1 - f1)
    rows = [
        {"feature": f, "mean_f1_drop": np.mean(v), "std_f1_drop": np.std(v)}
        for f, v in drops.items()
    ]
    out = pd.DataFrame(rows).sort_values("mean_f1_drop", ascending=False)
    out.to_csv(RESULTS_DIR / "xgb_importance.csv", index=False, encoding="utf-8-sig")
    return out


def best_model_classifier(results_cv_df):
    sub = results_cv_df[results_cv_df.model != "Majority"]
    best = sub.loc[sub["macro_f1_mean"].idxmax()]
    return best["model"], best["classifier"]


def avg_oof_prob(oof_df, model, clf):
    sub = oof_df[(oof_df.model == model) & (oof_df.classifier == clf)]
    return sub.groupby("query_id")["y_prob"].mean()


def run_risk_coverage(df, oof_df, results_cv_df):
    best_model, best_clf = best_model_classifier(results_cv_df)
    entries = [
        ("M0_s1", None, None),
        ("M1_LR", "M1", "LR"),
        ("M3_LR", "M3", "LR"),
        (f"Best_{best_model}_{best_clf}", best_model, best_clf),
    ]
    y = df.set_index("query_id")["label"]

    curve_rows, summary_rows = [], []
    for label_name, model, clf in entries:
        probs = df.set_index("query_id")["s1"] if model is None else avg_oof_prob(oof_df, model, clf)
        probs = probs.reindex(y.index)
        order = probs.sort_values(ascending=False).index
        y_sorted = y.loc[order].values
        n = len(y_sorted)
        ks = np.arange(1, n + 1)
        risk = np.cumsum(y_sorted == 0) / ks
        coverage = ks / n

        for k, cov, r in zip(ks, coverage, risk):
            curve_rows.append({"model": label_name, "k": int(k), "coverage": cov, "risk": r})

        aurc = float(np.trapezoid(risk, coverage))

        def risk_at(cov_target, risk=risk, n=n):
            k = max(1, int(round(cov_target * n)))
            return float(risk[k - 1])

        summary_rows.append(
            {"model": label_name, "aurc": aurc, "risk_at_50": risk_at(0.5), "risk_at_70": risk_at(0.7)}
        )

    curve_df = pd.DataFrame(curve_rows)
    curve_df.to_csv(RESULTS_DIR / "risk_coverage.csv", index=False, encoding="utf-8-sig")
    summary_df = pd.DataFrame(summary_rows)
    summary_df.to_csv(RESULTS_DIR / "risk_coverage_summary.csv", index=False, encoding="utf-8-sig")

    plt.figure(figsize=(7, 5))
    for label_name in curve_df["model"].unique():
        sub = curve_df[curve_df.model == label_name]
        plt.plot(sub["coverage"], sub["risk"], label=label_name)
    plt.xlabel("Coverage (fraction answered)")
    plt.ylabel("Risk (share of answered with label 0)")
    plt.title("Risk-Coverage")
    plt.legend()
    plt.tight_layout()
    plt.savefig(RESULTS_DIR / "risk_coverage.png", dpi=150)
    plt.close()

    return curve_df, summary_df


def run_learning_curve(df, blocks):
    cols = blocks["M3"]
    rskf = RepeatedStratifiedKFold(n_splits=N_SPLITS, n_repeats=N_REPEATS, random_state=SEED)
    splits = list(rskf.split(df, df["label"]))
    fracs = [0.25, 0.5, 0.75, 1.0]

    rows = []
    for i, (train_idx, test_idx) in enumerate(splits):
        repeat, fold = divmod(i, N_SPLITS)
        df_train_full = df.iloc[train_idx]
        df_test = df.iloc[test_idx]
        y_test = df_test["label"].values

        for frac in fracs:
            if frac < 1.0:
                sub_idx, _ = train_test_split(
                    np.arange(len(df_train_full)),
                    train_size=frac,
                    stratify=df_train_full["label"].values,
                    random_state=SEED,
                )
                df_train = df_train_full.iloc[sub_idx]
            else:
                df_train = df_train_full

            pipe = make_lr_pipeline(cols)
            pipe.fit(df_train[cols], df_train["label"].values)
            proba = pipe.predict_proba(df_test[cols])[:, 1]
            pred = (proba >= 0.5).astype(int)
            m = compute_metrics(y_test, proba, pred)
            m.update({"repeat": repeat, "fold": fold, "frac": frac, "n_train": len(df_train)})
            rows.append(m)

    out = pd.DataFrame(rows)
    out.to_csv(RESULTS_DIR / "learning_curve.csv", index=False, encoding="utf-8-sig")

    fracs_sorted = sorted(out["frac"].unique())
    means = [out[out.frac == f]["macro_f1"].mean() for f in fracs_sorted]
    stds = [out[out.frac == f]["macro_f1"].std() for f in fracs_sorted]

    plt.figure(figsize=(7, 5))
    plt.errorbar(fracs_sorted, means, yerr=stds, marker="o", capsize=4)
    plt.xlabel("Fraction of training fold used")
    plt.ylabel("Macro-F1 (test fold)")
    plt.title("Learning Curve - M3 LR")
    plt.tight_layout()
    plt.savefig(RESULTS_DIR / "learning_curve.png", dpi=150)
    plt.close()

    return out


# --------------------------------------------------------------------------
# Selective-answering operating point (nested-CV threshold selection)
# --------------------------------------------------------------------------
def inner_oof_probs(train_df, cols):
    """Stratified 5-fold CV inside the training fold only -> OOF probabilities."""
    y_train = train_df["label"].values
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    oof = np.zeros(len(train_df))
    for inner_train_idx, inner_val_idx in skf.split(train_df, y_train):
        inner_train = train_df.iloc[inner_train_idx]
        inner_val = train_df.iloc[inner_val_idx]
        pipe = make_lr_pipeline(cols)
        pipe.fit(inner_train[cols], inner_train["label"].values)
        oof[inner_val_idx] = pipe.predict_proba(inner_val[cols])[:, 1]
    return oof


def run_nested_selective_cv(df, cols, model_label):
    fold_df = pd.read_csv(RESULTS_DIR / "fold_assignments.csv", dtype={"query_id": str})
    rows = []
    for (repeat, fold), group in fold_df.groupby(["repeat", "fold"]):
        test_ids = set(group["query_id"])
        test_df = df[df["query_id"].isin(test_ids)]
        train_df = df[~df["query_id"].isin(test_ids)]

        oof = inner_oof_probs(train_df, cols)
        threshold = float(np.percentile(oof, 80))

        pipe = make_lr_pipeline(cols)
        pipe.fit(train_df[cols], train_df["label"].values)
        test_proba = pipe.predict_proba(test_df[cols])[:, 1]
        test_y = test_df["label"].values

        answered = test_proba >= threshold
        n_answered = int(answered.sum())
        coverage = n_answered / len(test_df)
        precision = float((test_y[answered] == 1).mean()) if n_answered > 0 else np.nan
        n_pos = int((test_y == 1).sum())
        recall = float(((answered) & (test_y == 1)).sum() / n_pos) if n_pos > 0 else np.nan

        rows.append(
            {
                "model": model_label,
                "repeat": repeat,
                "fold": fold,
                "threshold": threshold,
                "coverage": coverage,
                "n_test": len(test_df),
                "n_answered": n_answered,
                "precision_sufficient": precision,
                "recall_sufficient": recall,
            }
        )
    return pd.DataFrame(rows)


def summarize_selective(nested_df):
    rows = []
    for model_label, sub in nested_df.groupby("model"):
        rows.append(
            {
                "model": model_label,
                "threshold_mean": sub["threshold"].mean(),
                "threshold_std": sub["threshold"].std(),
                "coverage_mean": sub["coverage"].mean(),
                "coverage_std": sub["coverage"].std(),
                "n_answered_mean": sub["n_answered"].mean(),
                "n_answered_std": sub["n_answered"].std(),
                "precision_sufficient_mean": sub["precision_sufficient"].mean(),
                "precision_sufficient_std": sub["precision_sufficient"].std(),
                "recall_sufficient_mean": sub["recall_sufficient"].mean(),
                "recall_sufficient_std": sub["recall_sufficient"].std(),
            }
        )
    return pd.DataFrame(rows)


def compute_final_selective_threshold(df, cols):
    y = df["label"].values
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    oof = np.zeros(len(df))
    for train_idx, val_idx in skf.split(df, y):
        train_sub = df.iloc[train_idx]
        val_sub = df.iloc[val_idx]
        pipe = make_lr_pipeline(cols)
        pipe.fit(train_sub[cols], train_sub["label"].values)
        oof[val_idx] = pipe.predict_proba(val_sub[cols])[:, 1]
    return float(np.percentile(oof, 80))


def run_selective_threshold(df, blocks):
    m3q_cols = blocks["M3+Q"]
    m0_cols = ["s1"]

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    nested_m3q = run_nested_selective_cv(df, m3q_cols, "M3+Q_LR")
    nested_m0 = run_nested_selective_cv(df, m0_cols, "M0_LR")
    nested_df = pd.concat([nested_m3q, nested_m0], ignore_index=True)
    nested_df.to_csv(RESULTS_DIR / "selective_nested.csv", index=False, encoding="utf-8-sig")

    summary_df = summarize_selective(nested_df)
    summary_df.to_csv(RESULTS_DIR / "selective_nested_summary.csv", index=False, encoding="utf-8-sig")

    final_threshold = compute_final_selective_threshold(df, m3q_cols)

    threshold_procedure = (
        "Stratified 5-fold CV (random_state=42) out-of-fold probabilities; "
        "threshold = 80th percentile, so ~20% of queries are answered"
    )

    m3q_summary = summary_df[summary_df.model == "M3+Q_LR"].iloc[0]
    m0_summary = summary_df[summary_df.model == "M0_LR"].iloc[0]

    selective_config = {
        "target_coverage": TARGET_COVERAGE,
        "reason": TARGET_COVERAGE_REASON,
        "final_threshold": final_threshold,
        "threshold_procedure": threshold_procedure,
        "nested_cv_selective": {
            "M3+Q_LR": {
                "coverage_mean": float(m3q_summary.coverage_mean),
                "coverage_std": float(m3q_summary.coverage_std),
                "precision_sufficient_mean": float(m3q_summary.precision_sufficient_mean),
                "precision_sufficient_std": float(m3q_summary.precision_sufficient_std),
                "recall_sufficient_mean": float(m3q_summary.recall_sufficient_mean),
                "recall_sufficient_std": float(m3q_summary.recall_sufficient_std),
            },
            "M0_LR": {
                "coverage_mean": float(m0_summary.coverage_mean),
                "coverage_std": float(m0_summary.coverage_std),
                "precision_sufficient_mean": float(m0_summary.precision_sufficient_mean),
                "precision_sufficient_std": float(m0_summary.precision_sufficient_std),
                "recall_sufficient_mean": float(m0_summary.recall_sufficient_mean),
                "recall_sufficient_std": float(m0_summary.recall_sufficient_std),
            },
        },
    }
    with open(RESULTS_DIR / "selective_config.json", "w", encoding="utf-8") as f:
        json.dump(selective_config, f, indent=2, default=str)

    print("\n=== Selective-answering (nested-CV) summary ===")
    print(summary_df.to_string(index=False))
    print(f"Final deployment threshold (M3+Q LR, all 400 queries, 80th pct of 5-fold OOF): {final_threshold:.4f}")

    return nested_df, summary_df, final_threshold


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------
def print_summary(results_cv_df, comparisons_df, hard_cases_df, risk_summary_df):
    print("\n=== CV summary (mean ± std over 50 folds) ===")
    disp = results_cv_df.copy()
    for m in ["macro_f1", "roc_auc", "pr_auc", "precision_1", "brier"]:
        disp[m] = disp[f"{m}_mean"].round(3).astype(str) + " ± " + disp[f"{m}_std"].round(3).astype(str)
    print(disp[["model", "classifier", "macro_f1", "roc_auc", "pr_auc", "precision_1", "brier"]].to_string(index=False))

    print("\n=== Comparisons (Nadeau-Bengio corrected resampled t-test) ===")
    print(comparisons_df.to_string(index=False))

    print("\n=== Hard cases (top third by s1) ===")
    print(hard_cases_df.to_string(index=False))

    print("\n=== Risk-coverage summary ===")
    print(risk_summary_df.to_string(index=False))


def main():
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    write_run_config()

    df, feature_cols = load_data()
    blocks = load_feature_blocks()

    fold_metrics_df, oof_df, cached_m3_xgb = run_cv(df, blocks)
    results_cv_df = aggregate_cv(fold_metrics_df)
    run_topic_holdout(df, blocks)
    comparisons_df = run_comparisons(fold_metrics_df)

    run_univariate_auc(df, feature_cols)
    run_correlations(df)
    hard_cases_df = run_hard_cases(df)
    run_lr_coefficients(df, blocks)
    run_xgb_importance(cached_m3_xgb, blocks["M3"])
    _, risk_summary_df = run_risk_coverage(df, oof_df, results_cv_df)
    run_learning_curve(df, blocks)
    run_selective_threshold(df, blocks)

    print_summary(results_cv_df, comparisons_df, hard_cases_df, risk_summary_df)


if __name__ == "__main__":
    main()
