"""Module 2 Health Index and health classification (J26-DS-329, IT23366404).

Script version of RP/M2_HealthIndex_Classification_Colab.ipynb; the method is described in
RP/M2_HealthIndex_Classification_Guide.md. Every result is written to a run folder as PNG
figures, CSV/Markdown tables, confusion matrices and JSON. No database writes, no HTML.

    python health_index_pipeline.py synthetic_inspections_with_gps.csv --task forecast
    python health_index_pipeline.py synthetic_inspections_with_gps.csv --task symptom_now

SYNTHETIC inputs only test the pipeline; their scores are not research findings.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import time
import warnings

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scipy
from scipy.stats import friedmanchisquare, kendalltau, spearmanr, t as tdist, wilcoxon
import sklearn
from sklearn.base import BaseEstimator, ClassifierMixin, clone
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (balanced_accuracy_score, cohen_kappa_score, confusion_matrix, f1_score,
                             matthews_corrcoef, precision_recall_fscore_support, recall_score, roc_auc_score)
from sklearn.model_selection import GroupKFold, RandomizedSearchCV, StratifiedGroupKFold
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier
from sklearn.utils.class_weight import compute_sample_weight

try:
    import xgboost
    from xgboost import XGBClassifier
except ImportError:
    xgboost = None
try:
    import lightgbm
    from lightgbm import LGBMClassifier
except ImportError:
    lightgbm = None

warnings.filterwarnings("ignore")

HERE = Path(__file__).resolve().parent
DEFAULTS = dict(
    data_status="SYNTHETIC",            # "REAL" once field data replaces the synthetic panel
    task="forecast",                    # "forecast": state at t -> HI class at t+1
                                        # "symptom_now": measurements only -> current foliage class
    hi_aggregation="geometric",         # non-compensatory (chosen) | "arithmetic" (comparison)
    test_plant_fraction=0.20,
    outer_folds=5, repeats=3, inner_folds=3, n_iter=8,
    seeds=[0, 1, 2], split_seed=42,
    n_boot=1000, n_weight_draws=1000,
    hi_thresholds=[50, 80],             # Poor < 50 <= At-risk < 80 <= Healthy
    min_plants_per_class=5,             # data-adequacy gate
    temporal_cutoff="2026-09-25",
)
QUICK = dict(repeats=1, n_iter=3, n_boot=200, n_weight_draws=200)

# ---------------------------------------------------------------- Health Index
# Bands and weights are A-PRIORI ASSUMPTIONS to be confirmed by Mr. Kodikara.
HI_SPEC = {
    #  var              (tol_low, opt_low, opt_high, tol_high)  weight
    "soil_ph":         ((4.5, 5.8, 7.0, 8.0),                  0.15),
    "moisture":        ((1.0, 4.0, 8.0, 11.0),                 0.15),  # 1-10 analogue meter assumed
    "temperature":     ((15., 21., 30., 35.),                  0.05),
    "humidity":        ((40., 70., 90., 100.),                 0.10),
    "soil_ec":         ((0.0, 0.02, 0.30, 1.00),               0.05),  # unit unconfirmed
    "growth_cm_wk":    ((-1.0, 1.0, 15.0, 40.0),               0.10),
}
FOLIAGE_SCORE = {"Green": 1.0, "Mixed": 0.5, "Yellow": 0.25, "Brown": 0.0}
D_FLOOR = 0.01            # keeps log() finite; Brown (0) -> HI ~ 16 -> Poor
W_FOLIAGE = 0.40
assert abs(W_FOLIAGE + sum(w for _, w in HI_SPEC.values()) - 1) < 1e-9
CLASSES = ["Poor", "At-risk", "Healthy"]          # ordinal 0 < 1 < 2
REQUIRED = ["inspection_date", "plant_id", "soil_ph", "soil_ec", "moisture", "temperature",
            "humidity", "vine_height_cm", "foliage_color"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_inspections(path):
    df = pd.read_csv(path, parse_dates=["inspection_date"])
    missing = set(REQUIRED) - set(df.columns)
    if missing:
        raise ValueError(f"Required columns missing: {sorted(missing)}")
    if df.duplicated(["plant_id", "inspection_date"]).any():
        raise ValueError("Duplicate plant/date rows")
    unknown = set(df.foliage_color.dropna()) - set(FOLIAGE_SCORE)
    if unknown:
        raise ValueError(f"Unknown foliage categories: {sorted(unknown)}")
    df = df.sort_values(["plant_id", "inspection_date"]).reset_index(drop=True)
    if "zone" not in df:
        df["zone"] = df["plant_id"].str[0]
    return df


def desirability(x, tl, ol, oh, th):
    """1 inside the optimal band, falling linearly to 0 at the tolerance limits."""
    x = np.asarray(x, float)
    d = np.ones_like(x)
    d = np.where(x < ol, (x - tl) / (ol - tl), d)
    d = np.where(x > oh, (th - x) / (th - oh), d)
    return np.clip(d, 0, 1)


def add_growth(d):
    d = d.sort_values(["plant_id", "inspection_date"]).copy()
    dt = d.groupby("plant_id")["inspection_date"].diff().dt.days
    d["growth_cm_wk"] = d.groupby("plant_id")["vine_height_cm"].diff() / dt * 7
    d["growth_cm_wk"] = d["growth_cm_wk"].fillna(d["growth_cm_wk"].median())  # first visit: neutral
    return d


def health_index(d, weights=None, how="geometric"):
    """Arithmetic: HI = 100*sum(w*d) -> compensatory (good soil can hide a rotting plant).
    Geometric (Derringer & Suich 1980): HI = 100*prod(d**w) -> non-compensatory (any severe
    problem pulls HI down). Geometric is the chosen definition; arithmetic kept for comparison."""
    d = d.copy()
    names = list(HI_SPEC) + ["foliage"]
    w = (dict(zip(names, weights)) if weights is not None
         else {**{k: v[1] for k, v in HI_SPEC.items()}, "foliage": W_FOLIAGE})
    for k, (band, _) in HI_SPEC.items():
        d[f"d_{k}"] = desirability(d[k], *band)
    d["d_foliage"] = d["foliage_color"].map(FOLIAGE_SCORE)
    if how == "geometric":
        d["HI"] = 100 * np.exp(sum(w[k] * np.log(np.clip(d[f"d_{k}"], D_FLOOR, 1)) for k in names))
    else:
        d["HI"] = 100 * sum(w[k] * d[f"d_{k}"] for k in names)
    return d


def hi_class(hi, thresholds=(50, 80)):
    return np.digitize(hi, thresholds)          # 0 Poor, 1 At-risk, 2 Healthy


def class_counts(classes):
    return pd.Series(classes).map(dict(enumerate(CLASSES))).value_counts().reindex(CLASSES, fill_value=0)


def validate_hi(df, cfg, real_ref=None):
    """No ground truth, so check construct validity and robustness. Returns (json, tables)."""
    val, tables = {}, {}
    thr = cfg["hi_thresholds"]
    # Convergent validity without circularity: HI rebuilt without foliage vs observed foliage
    w_nf = {k: v[1] / (1 - W_FOLIAGE) for k, v in HI_SPEC.items()}
    hi_nf = 100 * sum(w_nf[k] * df[f"d_{k}"] for k in HI_SPEC)
    rho, p = spearmanr(hi_nf, df.foliage_color.map(FOLIAGE_SCORE))
    val["spearman_HI_without_foliage_vs_foliage"] = dict(rho=round(float(rho), 3), p=float(p))
    # Weight sensitivity: Dirichlet perturbations around the chosen weights
    w0 = np.array([HI_SPEC[k][1] for k in HI_SPEC] + [W_FOLIAGE])
    rng = np.random.default_rng(0)
    kap, tau = [], []
    last = df.sort_values("inspection_date").groupby("plant_id").tail(1)
    for _ in range(cfg["n_weight_draws"]):
        w = rng.dirichlet(w0 * 50)                 # concentration 50 ~ +/- 20-30 % relative change
        alt = health_index(df, weights=w, how=cfg["hi_aggregation"])
        kap.append(cohen_kappa_score(df.hi_class, hi_class(alt.HI, thr), weights="linear"))
        tau.append(kendalltau(last.HI, alt.loc[last.index, "HI"])[0])
    val["weight_sensitivity"] = dict(kappa_mean=round(np.mean(kap), 3), kappa_p05=round(np.percentile(kap, 5), 3),
                                     kendall_tau_mean=round(np.mean(tau), 3),
                                     kendall_tau_p05=round(np.percentile(tau, 5), 3))
    tables["weight_sensitivity_draws"] = pd.DataFrame({"linear_kappa": kap, "kendall_tau": tau})
    # Compensation check: does a Brown/Yellow plant still look Healthy?
    ari = health_index(df, how="arithmetic")
    geo = health_index(df, how="geometric")
    comp = []
    for how, h in [("geometric", geo), ("arithmetic", ari)]:
        for c in ["Mixed", "Yellow", "Brown"]:
            n = class_counts(hi_class(h.HI[df.foliage_color == c], thr))
            comp.append(dict(aggregation=how, foliage=c, **n.to_dict()))
    tables["compensation_check"] = pd.DataFrame(comp)
    val["compensation_check"] = {how: {r["foliage"]: {c: int(r[c]) for c in CLASSES} for _, r in g.iterrows()}
                                 for how, g in tables["compensation_check"].groupby("aggregation")}
    # Threshold sensitivity
    shifts = {f"{s:+d}": round(float((hi_class(df.HI, [t + s for t in thr]) == df.hi_class).mean()), 3)
              for s in (-5, -2, 2, 5)}
    val["threshold_shift_class_agreement"] = shifts
    tables["threshold_sensitivity"] = pd.DataFrame({"shift": list(shifts), "class_agreement": list(shifts.values())})
    # Real observations (optional): does the index behave sensibly on real data?
    if real_ref and os.path.exists(real_ref):
        real = pd.read_csv(real_ref, parse_dates=["inspection_date"])
        real["growth_cm_wk"] = df.growth_cm_wk.median()
        real = real.dropna(subset=["soil_ph", "moisture", "temperature", "humidity", "soil_ec", "foliage_color"])
        real = health_index(real, how=cfg["hi_aggregation"])
        real["hi_class"] = hi_class(real.HI, thr)
        val["real_obs"] = dict(n=len(real), HI_by_foliage=real.groupby("foliage_color").HI.median().round(1).to_dict(),
                               classes=class_counts(real.hi_class).to_dict())
    return val, tables


# ------------------------------------------------------------ Classification task
def build_transitions(d):
    """Features from the state at t; target is the HI class at the plant's NEXT inspection."""
    d = d.sort_values(["plant_id", "inspection_date"]).copy()
    g = d.groupby("plant_id")
    d["foliage_ord"] = d.foliage_color.map({"Green": 0, "Mixed": 1, "Yellow": 2, "Brown": 3})
    d["hi_prev"] = g.HI.shift(1)
    d["delta_hi"] = (d.HI - d.hi_prev).fillna(0)
    d["delta_moisture"] = g.moisture.diff().fillna(0)
    d["delta_ph"] = g.soil_ph.diff().fillna(0)
    d["hi_roll3"] = g.HI.transform(lambda s: s.rolling(3, min_periods=1).mean())
    d["hi_min_so_far"] = g.HI.cummin()
    d["weeks_observed"] = g.cumcount()
    d["days_to_next"] = (g.inspection_date.shift(-1) - d.inspection_date).dt.days
    d["y"] = g.hi_class.shift(-1)                       # TARGET = next class
    d["target_date"] = g.inspection_date.shift(-1)
    d = pd.get_dummies(d, columns=["zone"], prefix="zone", dtype=int)
    return d.dropna(subset=["y"]).astype({"y": int}).reset_index(drop=True)


def build_task(df, task):
    """A classifier predicting the CURRENT HI class from the variables that define HI only re-learns
    the formula. Both tasks keep the target out of the same-time inputs."""
    if task == "forecast":
        tr = build_transitions(df)
        features = (["soil_ph", "soil_ec", "moisture", "temperature", "humidity", "vine_height_cm",
                     "growth_cm_wk", "foliage_ord", "HI", "hi_class", "delta_hi", "delta_moisture",
                     "delta_ph", "hi_roll3", "hi_min_so_far", "weeks_observed", "days_to_next"]
                    + [c for c in tr if c.startswith("zone_")])
    elif task == "symptom_now":   # label from foliage ONLY, features exclude foliage/HI
        tr = pd.get_dummies(df.copy(), columns=["zone"], prefix="zone", dtype=int)
        tr["y"] = tr.foliage_color.map({"Green": 2, "Mixed": 1, "Yellow": 1, "Brown": 0})
        tr["target_date"] = tr["inspection_date"]
        features = (["soil_ph", "soil_ec", "moisture", "temperature", "humidity", "vine_height_cm", "growth_cm_wk"]
                    + [c for c in tr if c.startswith("zone_")])
    else:
        raise ValueError(f"Unknown task: {task}")
    return tr, features


def locked_test_split(tr, fraction, seed):
    """Hold out whole plants, stratified by the worst class each plant reaches."""
    worst = tr.groupby("plant_id").y.min()
    dev_idx, test_idx = next(StratifiedGroupKFold(round(1 / fraction), shuffle=True, random_state=seed)
                             .split(tr, tr.plant_id.map(worst), tr.plant_id))
    dev, test = tr.iloc[dev_idx].reset_index(drop=True), tr.iloc[test_idx].reset_index(drop=True)
    assert not set(dev.plant_id) & set(test.plant_id)
    return dev, test


# ------------------------------------------------------------- Models
class Persistence(BaseEstimator, ClassifierMixin):
    """Next class = current class. The baseline every temporal model must beat."""
    def fit(self, X, y):
        self.classes_ = np.arange(len(CLASSES))
        return self

    def predict(self, X):
        return np.asarray(X["hi_class"], int)

    def predict_proba(self, X):
        return np.eye(len(CLASSES))[self.predict(X)]


class TrendRule(Persistence):
    """Rule baseline: current class, moved one level down if HI fell > `drop` points since last visit."""
    def __init__(self, drop=5.0):
        self.drop = drop

    def predict(self, X):
        c = np.asarray(X["hi_class"], int)
        return np.where(np.asarray(X["delta_hi"]) < -self.drop, np.maximum(c - 1, 0), c)


class XGBBalanced(BaseEstimator, ClassifierMixin):
    """XGBoost + balanced sample weights; re-encodes labels so folds missing a class still work."""
    def __init__(self, max_depth=3, learning_rate=0.1, subsample=1.0, min_child_weight=1, reg_lambda=1.0,
                 n_estimators=200):
        self.max_depth, self.learning_rate, self.subsample = max_depth, learning_rate, subsample
        self.min_child_weight, self.reg_lambda, self.n_estimators = min_child_weight, reg_lambda, n_estimators

    def fit(self, X, y):
        self.classes_, yy = np.unique(y, return_inverse=True)
        self.m_ = XGBClassifier(max_depth=self.max_depth, learning_rate=self.learning_rate, subsample=self.subsample,
                                min_child_weight=self.min_child_weight, reg_lambda=self.reg_lambda,
                                n_estimators=self.n_estimators, eval_metric="mlogloss", n_jobs=2,
                                random_state=0, verbosity=0)
        self.m_.fit(X, yy, sample_weight=compute_sample_weight("balanced", yy))
        self.feature_importances_ = self.m_.feature_importances_
        return self

    def predict_proba(self, X):
        return self.m_.predict_proba(X)

    def predict(self, X):
        return self.classes_[self.predict_proba(X).argmax(1)]


def build_models(task):
    """name -> (estimator, search space, complexity rank: lower = simpler / more interpretable)."""
    models = {
        "Majority":      (DummyClassifier(strategy="most_frequent"), {}, 0),
        "Persistence":   (Persistence(), {}, 0),
        "TrendRule":     (TrendRule(), {"drop": [3, 5, 8]}, 0),
        "LogReg":        (make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000, class_weight="balanced")),
                          {"logisticregression__C": [0.01, 0.1, 1, 10]}, 1),
        "DecisionTree":  (DecisionTreeClassifier(class_weight="balanced", random_state=0),
                          {"max_depth": [2, 3, 4, 6], "min_samples_leaf": [5, 10, 20]}, 2),
        "GaussianNB":    (make_pipeline(StandardScaler(), GaussianNB()), {}, 2),
        "kNN":           (make_pipeline(StandardScaler(), KNeighborsClassifier()),
                          {"kneighborsclassifier__n_neighbors": [5, 11, 21, 31],
                           "kneighborsclassifier__weights": ["uniform", "distance"]}, 3),
        "SVM-RBF":       (make_pipeline(StandardScaler(), SVC(class_weight="balanced", probability=True, random_state=0)),
                          {"svc__C": [0.1, 1, 10], "svc__gamma": ["scale", 0.01, 0.1]}, 3),
        "RandomForest":  (RandomForestClassifier(n_estimators=300, class_weight="balanced_subsample", n_jobs=-1,
                                                 random_state=0),
                          {"max_depth": [3, 5, 8, None], "min_samples_leaf": [1, 5, 10], "max_features": ["sqrt", 0.5]}, 4),
        "ExtraTrees":    (ExtraTreesClassifier(n_estimators=300, class_weight="balanced", n_jobs=-1, random_state=0),
                          {"max_depth": [3, 5, 8, None], "min_samples_leaf": [1, 5, 10]}, 4),
        "HistGB":        (HistGradientBoostingClassifier(class_weight="balanced", random_state=0),
                          {"learning_rate": [0.03, 0.1], "max_depth": [2, 3, None], "min_samples_leaf": [10, 20, 40]}, 5),
    }
    if xgboost is not None:
        models["XGBoost"] = (XGBBalanced(),
                             {"max_depth": [2, 3, 4], "learning_rate": [0.03, 0.1], "subsample": [0.7, 1.0],
                              "min_child_weight": [1, 5], "reg_lambda": [1, 5]}, 5)
    if lightgbm is not None:
        models["LightGBM"] = (LGBMClassifier(n_estimators=200, class_weight="balanced", random_state=0, verbose=-1,
                                             n_jobs=2),
                              {"num_leaves": [4, 8, 15], "learning_rate": [0.03, 0.1],
                               "min_child_samples": [10, 20, 40]}, 5)
    baselines = ["Majority", "Persistence", "TrendRule"]
    if task != "forecast":            # no "previous state" exists -> Majority is the reference baseline
        for b in ("Persistence", "TrendRule"):
            models.pop(b)
        baselines = ["Majority"]
    ref = "Persistence" if task == "forecast" else "Majority"   # the baseline ML must beat
    return models, baselines, ref


# ------------------------------------------------------------- Evaluation
def full_proba(model, X):
    """Probabilities as 3 columns in CLASSES order, even if a class was absent in training."""
    if not hasattr(model, "predict_proba"):
        return None
    p = model.predict_proba(X)
    out = np.zeros((len(X), len(CLASSES)))
    for j, c in enumerate(getattr(model, "classes_", np.arange(p.shape[1]))):
        out[:, int(c)] = p[:, j]
    return out


def metrics(y, pred, proba=None):
    y, pred = np.asarray(y), np.asarray(pred)
    labs = np.unique(y)
    m = dict(macro_f1=f1_score(y, pred, average="macro", labels=labs, zero_division=0),
             bal_acc=balanced_accuracy_score(y, pred), mcc=matthews_corrcoef(y, pred),
             recall_poor=recall_score(y, pred, labels=[0], average="macro", zero_division=0),
             recall_atrisk=recall_score(y, pred, labels=[1], average="macro", zero_division=0))
    if proba is not None and len(labs) >= 2:
        try:
            m["roc_auc_ovr"] = (roc_auc_score(y == labs[-1], proba[:, labs[-1]]) if len(labs) == 2 else
                                roc_auc_score(y, proba[:, labs] / proba[:, labs].sum(1, keepdims=True).clip(1e-12),
                                              multi_class="ovr", average="macro", labels=labs))
        except ValueError:
            pass
    return m


def macro_f1_scorer(est, X, y):
    return metrics(y, est.predict(X))["macro_f1"]


def fit_tuned(models, name, X, y, groups, seed, cfg):
    """Nested tuning: hyperparameters are searched on plant-grouped inner folds of X only."""
    est, space, _ = models[name]
    est = clone(est)
    if not space:
        return est.fit(X, y), {}
    n_combo = int(np.prod([len(v) for v in space.values()]))
    s = RandomizedSearchCV(est, space, n_iter=min(cfg["n_iter"], n_combo), scoring=macro_f1_scorer,
                           cv=GroupKFold(cfg["inner_folds"]), random_state=seed, n_jobs=1, refit=True)
    s.fit(X, y, groups=groups)
    return s.best_estimator_, s.best_params_


def fit_fixed(models, name, X, y, params):
    est = clone(models[name][0])
    return est.set_params(**params).fit(X, y)


def cross_validate(dev, features, models, cfg):
    """Repeated, plant-grouped, nested CV on DEV plants only."""
    rows, t_all = [], time.time()
    for seed in cfg["seeds"][:cfg["repeats"]]:
        outer = StratifiedGroupKFold(cfg["outer_folds"], shuffle=True, random_state=seed)
        for fold, (a, b) in enumerate(outer.split(dev, dev.y, dev.plant_id)):
            Xa, ya, Xb, yb = dev.loc[a, features], dev.y[a], dev.loc[b, features], dev.y[b]
            for name in models:
                t0 = time.time()
                m, bp = fit_tuned(models, name, Xa, ya, dev.plant_id[a], seed, cfg)
                sc = metrics(yb, m.predict(Xb), full_proba(m, Xb))
                train_f1 = f1_score(ya, m.predict(Xa), average="macro", labels=np.unique(ya), zero_division=0)
                rows.append(dict(model=name, seed=seed, fold=fold, n_train=len(a), n_test=len(b),
                                 train_macro_f1=train_f1, fit_s=time.time() - t0,
                                 params=json.dumps(bp, default=str), **sc))
            print(f"  seed {seed} fold {fold} done ({time.time() - t_all:.0f}s)")
    return pd.DataFrame(rows)


def corrected_ttest(a, b, n_tr, n_te):
    """Nadeau & Bengio (2003) corrected resampled t-test for repeated k-fold CV."""
    d = np.asarray(a) - np.asarray(b)
    J = len(d)
    var = d.var(ddof=1)
    if var == 0:
        return 0.0, 1.0
    t = d.mean() / np.sqrt((1 / J + n_te / n_tr) * var)
    return t, 2 * tdist.sf(abs(t), J - 1)


def holm(pvals):
    p = np.asarray(pvals, float)
    o = np.argsort(p)
    adj = np.empty_like(p)
    adj[o] = np.maximum.accumulate(np.minimum(1, (len(p) - np.arange(len(p))) * p[o]))
    return adj


def select_model(cv, models, baselines, ref):
    """Leaderboard, statistical tests and the selection rule fixed BEFORE looking at results:
    1) a candidate must beat the reference baseline: higher mean macro-F1 AND corrected p < 0.05;
    2) among candidates statistically tied with the top model (Holm p >= 0.05) choose the lowest
       complexity rank; ties broken by lower SD, then higher mean macro-F1;
    3) if none beats the baseline, the baseline is the selected predictor.
    The best ML model for this data size (rule 2 over ML models only) is always reported."""
    lb = (cv.groupby("model").agg(macro_f1=("macro_f1", "mean"), macro_f1_sd=("macro_f1", "std"),
                                  bal_acc=("bal_acc", "mean"), mcc=("mcc", "mean"),
                                  recall_poor=("recall_poor", "mean"), recall_atrisk=("recall_atrisk", "mean"),
                                  roc_auc=("roc_auc_ovr", "mean"), train_f1=("train_macro_f1", "mean"),
                                  fit_s=("fit_s", "mean"))
          .assign(overfit_gap=lambda d: d.train_f1 - d.macro_f1,
                  complexity=lambda d: d.index.map(lambda n: models[n][2]))
          .sort_values("macro_f1", ascending=False))
    P = cv.pivot_table(index=["seed", "fold"], columns="model", values="macro_f1")
    n_tr, n_te = cv.n_train.mean(), cv.n_test.mean()
    ttest = lambda a, b: corrected_ttest(P[a], P[b], n_tr, n_te)

    fr = friedmanchisquare(*[P[c] for c in P.columns])
    stat = {"friedman": dict(chi2=float(fr[0]), p=float(fr[1]))}
    top = lb.index[0]
    cmp_rows = []
    for name in lb.index[1:]:
        _, p_nb = ttest(top, name)
        try:
            p_w = wilcoxon(P[top], P[name]).pvalue
        except ValueError:
            p_w = 1.0
        cmp_rows.append(dict(model=name, diff_vs_top=P[top].mean() - P[name].mean(), p_corrected_t=p_nb,
                             p_wilcoxon=1.0 if np.isnan(p_w) else p_w))
    cmp = pd.DataFrame(cmp_rows)
    cmp["p_holm"] = holm(cmp.p_corrected_t)
    lb = lb.join(cmp.set_index("model"))
    # signed p: negative = model is WORSE than the baseline on average
    lb["p_vs_ref"] = [np.nan if n == ref else ttest(n, ref)[1] * np.sign(P[n].mean() - P[ref].mean())
                      for n in lb.index]

    beats = [n for n in lb.index if n not in baselines and P[n].mean() > P[ref].mean() and ttest(n, ref)[1] < 0.05]
    tied = [n for n in beats if n == top or lb.loc[n, "p_holm"] >= 0.05]
    parsimony = ["complexity", "macro_f1_sd", "macro_f1"]
    if tied:
        best = lb.loc[tied].sort_values(parsimony, ascending=[True, True, False]).index[0]
        reason = f"beats {ref}; statistically tied with top ({top}); simplest/most stable among {tied}"
    else:
        best = ref
        reason = f"no ML model significantly beat the {ref} baseline -> report this honestly"
    ml = [n for n in lb.index if n not in baselines]
    top_ml = ml[0]
    p_ml = holm([ttest(top_ml, n)[1] for n in ml[1:]])
    tied_ml = [top_ml] + [n for n, p in zip(ml[1:], p_ml) if p >= 0.05]
    best_ml = lb.loc[tied_ml].sort_values(parsimony, ascending=[True, True, False]).index[0]
    stat.update(reference_baseline=ref, top_by_mean=top, candidates_beating_reference=beats, tied_with_top=tied,
                selected=best, reason=reason, best_ml_model=best_ml, ml_tied_with_top_ml=tied_ml)
    return lb, P, stat


def learning_curves(dev, features, models, names, modal, cfg):
    """Retrain on 20..100 % of the training plants of each outer fold; score on the held-out fold."""
    fracs, rows = [0.2, 0.4, 0.6, 0.8, 1.0], []
    for seed in cfg["seeds"][:cfg["repeats"]]:
        outer = StratifiedGroupKFold(cfg["outer_folds"], shuffle=True, random_state=seed)
        r = np.random.default_rng(seed)
        for fold, (a, b) in enumerate(outer.split(dev, dev.y, dev.plant_id)):
            plants = dev.plant_id[a].unique()
            for f in fracs:
                keep = r.choice(plants, max(3, int(round(f * len(plants)))), replace=False)
                aa = a[dev.plant_id[a].isin(keep).values]
                if dev.y[aa].nunique() < 2:
                    continue
                for name in names:
                    m = fit_fixed(models, name, dev.loc[aa, features], dev.y[aa], modal.get(name, {}))
                    rows.append(dict(model=name, frac=f, n_plants=len(keep), seed=seed, fold=fold,
                                     macro_f1=metrics(dev.y[b], m.predict(dev.loc[b, features]))["macro_f1"]))
    return pd.DataFrame(rows)


def plant_bootstrap(d, pred_col, n, seed=0):
    """95 % CI of macro-F1, resampling whole plants (rows of one plant are not independent)."""
    r = np.random.default_rng(seed)
    plants = d.plant_id.unique()
    idx = {p: np.where(d.plant_id.values == p)[0] for p in plants}
    out = []
    for _ in range(n):
        ii = np.concatenate([idx[p] for p in r.choice(plants, len(plants))])
        out.append(metrics(d.y.values[ii], d[pred_col].values[ii])["macro_f1"])
    return np.percentile(out, [2.5, 97.5]).round(3).tolist()


def per_class_report(y, pred):
    p, r, f, s = precision_recall_fscore_support(y, pred, labels=[0, 1, 2], zero_division=0)
    return pd.DataFrame({"class": CLASSES, "precision": p, "recall": r, "f1": f, "support": s})


# ------------------------------------------------------------- Output helpers
def fmt_cell(v, digits=3):
    """Whole numbers (counts, ranks) without decimals, everything else to a fixed precision."""
    if isinstance(v, str):
        return v
    if pd.isna(v):
        return ""
    if float(v).is_integer() and abs(v) >= 1:
        return str(int(v))
    text = f"{float(v):.{digits}f}"
    return text[1:] if text.startswith("-") and float(text) == 0 else text


def row_label(idx):
    return " / ".join(map(str, idx)) if isinstance(idx, tuple) else str(idx)


def md_table(df, digits=3):
    names = [n for n in df.index.names if n]
    cols = [" / ".join(names)] + [str(c) for c in df.columns]
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for idx, row in df.iterrows():
        lines.append("| " + " | ".join([row_label(idx)] + [fmt_cell(v, digits) for v in row]) + " |")
    return "\n".join(lines)


def save_table_png(df, path, title, highlight=None, digits=3):
    """Render a table as a figure so it can go straight into slides or the dissertation."""
    shown = df.map(lambda v: fmt_cell(v, digits))
    n_rows, n_cols = shown.shape
    fig, ax = plt.subplots(figsize=(max(6, 1.15 * (n_cols + 1)), 0.27 * (n_rows + 1) + 0.6))
    ax.axis("off")
    tbl = ax.table(cellText=shown.values, rowLabels=[str(i) for i in shown.index],
                   colLabels=[str(c) for c in shown.columns], loc="center", cellLoc="center")
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(8.5)
    tbl.scale(1, 1.3)
    for (r, c), cell in tbl.get_celld().items():
        if r == 0:
            cell.set_facecolor("#DDE4EE")
            cell.set_text_props(fontweight="bold")
        elif highlight is not None and shown.index[r - 1] == highlight:
            cell.set_facecolor("#FBE3E4")
            cell.set_text_props(fontweight="bold")
    ax.set_title(title, fontsize=10, pad=8)
    plt.tight_layout()
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()


def plot_matrix(ax, counts, rows, cols, title, normalise=True):
    mat = counts / counts.sum(1, keepdims=True).clip(1) if normalise else counts
    ax.imshow(mat, cmap="Blues", vmin=0, vmax=1 if normalise else max(counts.max(), 1))
    ax.set_xticks(range(len(cols)), cols)
    ax.set_yticks(range(len(rows)), rows)
    ax.set_title(title, fontsize=10)
    hi = mat.max() if mat.size else 1
    for (i, j), v in np.ndenumerate(mat):
        text = f"{v:.2f}\n({counts[i, j]})" if normalise else f"{counts[i, j]}"
        ax.text(j, i, text, ha="center", va="center", color="white" if v > 0.6 * hi else "black")


def write_json(path, obj):
    path.write_text(json.dumps(obj, indent=2, default=float), encoding="utf-8")


# ------------------------------------------------------------- Pipeline
def run(csv_path, cfg, out_root, real_ref=None, resume=None):
    csv_path = Path(csv_path)
    run_dir = Path(resume) if resume else Path(out_root) / f"{cfg['experiment']}_{time.strftime('%Y%m%d-%H%M')}"
    fig_dir, tab_dir = run_dir / "figures", run_dir / "tables"
    fig_dir.mkdir(parents=True, exist_ok=True)
    tab_dir.mkdir(exist_ok=True)
    print(f"run folder: {run_dir}")
    t_all = time.time()
    thr = cfg["hi_thresholds"]

    # 1. Load + Health Index
    df = load_inspections(csv_path)
    print(f"rows={len(df)} plants={df.plant_id.nunique()} dates={df.inspection_date.nunique()}")
    df = health_index(add_growth(df), how=cfg["hi_aggregation"])
    df["hi_class"] = hi_class(df["HI"], thr)
    df.to_csv(run_dir / "inspections_with_hi.csv", index=False)
    hi_counts = class_counts(df.hi_class)
    hi_by_foliage = (df.groupby("foliage_color").HI.describe()[["count", "mean", "50%", "min", "max"]]
                     .rename(columns={"50%": "median"}).reindex([c for c in FOLIAGE_SCORE if c in set(df.foliage_color)]))
    hi_by_foliage.to_csv(tab_dir / "hi_by_foliage.csv")
    hi_counts.rename_axis("class").rename("rows").to_csv(tab_dir / "hi_class_counts.csv")
    print("HI classes:", hi_counts.to_dict())

    fig, ax = plt.subplots(1, 3, figsize=(15, 3.8))
    ax[0].hist(df.HI, bins=40, color="#4C72B0")
    for t in thr:
        ax[0].axvline(t, ls="--", c="k")
    ax[0].set_title("Health Index distribution")
    ax[0].set_xlabel("HI (0-100)")
    present = [c for c in FOLIAGE_SCORE if c in set(df.foliage_color)]
    ax[1].boxplot([df.HI[df.foliage_color == c] for c in present])
    ax[1].set_xticks(range(1, len(present) + 1), present)
    ax[1].set_title("HI by foliage colour")
    df.groupby("inspection_date").HI.mean().plot(ax=ax[2], marker="o")
    ax[2].set_title("Mean HI per inspection")
    ax[2].set_xlabel("")
    plt.tight_layout()
    plt.savefig(fig_dir / "01_hi_distribution.png", dpi=130)
    plt.close()

    # 2. Validate the Health Index
    val, val_tables = validate_hi(df, cfg, real_ref)
    write_json(run_dir / "hi_validation.json", val)
    for name, table in val_tables.items():
        table.to_csv(tab_dir / f"{name}.csv", index=False)
    comp = val_tables["compensation_check"]
    fig, ax = plt.subplots(1, 2, figsize=(10, 3.6))
    for a_, how in zip(ax, ["arithmetic", "geometric"]):
        g = comp[comp.aggregation == how].set_index("foliage")[CLASSES]
        plot_matrix(a_, g.values, list(g.index), CLASSES, f"{how} HI" + (" (chosen)" if how == cfg["hi_aggregation"] else ""),
                    normalise=False)
        a_.set_xlabel("HI class")
        a_.set_ylabel("observed foliage")
    plt.suptitle("Compensation check: rows with symptomatic foliage per HI class", fontsize=11)
    plt.tight_layout()
    plt.savefig(fig_dir / "07_hi_compensation_matrix.png", dpi=130)
    plt.close()
    draws = val_tables["weight_sensitivity_draws"]
    fig, ax = plt.subplots(1, 3, figsize=(14, 3.6))
    ax[0].hist(draws.linear_kappa, bins=30, color="#4C72B0")
    ax[0].axvline(0.6, ls="--", c="#C44E52", label="target 0.6")
    ax[0].set_title("Weight perturbation: class agreement")
    ax[0].set_xlabel("linear-weighted kappa")
    ax[0].legend()
    ax[1].hist(draws.kendall_tau, bins=30, color="#55A868")
    ax[1].axvline(0.8, ls="--", c="#C44E52", label="target 0.8")
    ax[1].set_title("Weight perturbation: plant ranking")
    ax[1].set_xlabel("Kendall tau (latest inspection)")
    ax[1].legend()
    ts = val_tables["threshold_sensitivity"]
    ax[2].bar(ts["shift"], ts.class_agreement, color="#8172B2")
    ax[2].axhline(0.9, ls="--", c="#C44E52", label="target 0.9")
    ax[2].set_ylim(0, 1)
    ax[2].set_title("Threshold shift: class agreement")
    ax[2].set_xlabel("shift of both thresholds (HI points)")
    ax[2].legend(loc="lower right")
    plt.tight_layout()
    plt.savefig(fig_dir / "08_hi_robustness.png", dpi=130)
    plt.close()

    # 3. Classification task + data-adequacy gate
    tr, features = build_task(df, cfg["task"])
    target_counts = class_counts(tr.y)
    print(f"samples={len(tr)} plants={tr.plant_id.nunique()} features={len(features)} target={target_counts.to_dict()}")
    change_rate = float((tr.y != tr.hi_class).mean()) if cfg["task"] == "forecast" else None
    gate = tr.groupby("y").plant_id.nunique().reindex(range(3), fill_value=0)
    gate.index = CLASSES
    adequate = bool((gate[gate > 0] >= cfg["min_plants_per_class"]).all() and (gate > 0).sum() >= 2)
    if not adequate:
        print("WARNING: too few plants in some class -> results are exploratory only; say so in the report.")
    write_json(run_dir / "data_adequacy.json",
               {"plants_per_class": gate.to_dict(), "adequate": adequate, "class_change_rate": change_rate})
    pd.DataFrame({"class": CLASSES, "samples": target_counts.values, "plants": gate.values}).to_csv(
        tab_dir / "data_adequacy.csv", index=False)

    # 4. Locked test plants
    dev, test = locked_test_split(tr, cfg["test_plant_fraction"], cfg["split_seed"])
    print(f"dev: {len(dev)} rows / {dev.plant_id.nunique()} plants | "
          f"test: {len(test)} rows / {test.plant_id.nunique()} plants")
    pd.DataFrame({"plant_id": sorted(test.plant_id.unique())}).to_csv(run_dir / "locked_test_plants.csv", index=False)

    # 5. Nested, repeated, plant-grouped CV on DEV
    models, baselines, ref = build_models(cfg["task"])
    skipped = [n for n, mod in (("XGBoost", xgboost), ("LightGBM", lightgbm)) if mod is None]
    if skipped:
        print(f"WARNING: {skipped} not installed -> left out of the comparison")
    cv_file = tab_dir / "cv_fold_scores.csv"
    if resume and cv_file.exists():
        cv = pd.read_csv(cv_file)
        print("resumed CV scores from", cv_file)
    else:
        print(f"cross-validating {len(models)} models ...")
        cv = cross_validate(dev, features, models, cfg)
        cv.to_csv(cv_file, index=False)

    # 6. Leaderboard + statistics + selection rule
    lb, P, stat = select_model(cv, models, baselines, ref)
    best, best_ml = stat["selected"], stat["best_ml_model"]
    lb.round(4).to_csv(tab_dir / "leaderboard.csv", index_label="model")
    write_json(run_dir / "model_selection.json", stat)
    P.round(4).to_csv(tab_dir / "cv_macro_f1_matrix.csv")
    lb_cols = ["macro_f1", "macro_f1_sd", "bal_acc", "mcc", "recall_poor", "overfit_gap", "complexity", "p_holm",
               "p_vs_ref"]
    print(lb[lb_cols].round(3).to_string())
    print(f"selected: {best} | best ML model: {best_ml}")
    save_table_png(lb[lb_cols].rename_axis("model"), fig_dir / "09_leaderboard_table.png",
                   f"CV leaderboard ({cfg['outer_folds']}-fold x {cfg['repeats']} repeats, plant-grouped) "
                   f"- selected: {best}", highlight=best)

    order = lb.index[::-1]
    fig, ax = plt.subplots(figsize=(8, 0.42 * len(order) + 1))
    ax.boxplot([P[n] for n in order], vert=False)
    ax.set_yticks(range(1, len(order) + 1), order)
    ax.axvline(P[ref].mean(), ls="--", c="grey", label=f"{ref} mean")
    ax.set_xlabel(f"macro-F1 ({cfg['outer_folds']}-fold x {cfg['repeats']} repeats, plant-grouped)")
    ax.set_title(f"Model comparison - selected: {best}")
    for lbl in ax.get_yticklabels():
        if lbl.get_text() == best:
            lbl.set_fontweight("bold")
            lbl.set_color("#C44E52")
    ax.legend(loc="lower right")
    plt.tight_layout()
    plt.savefig(fig_dir / "02_model_comparison_boxplot.png", dpi=130)
    plt.close()

    # 7. Learning curves with the most-chosen tuned parameters
    ml = [n for n in lb.index if n not in baselines]
    modal = {n: json.loads(s) for n, s in cv.groupby("model").params.agg(lambda s: s.value_counts().index[0]).items()}
    lc_models = list(dict.fromkeys([ref, best, best_ml] + ml[:2]))
    print("learning curves ...")
    lc = learning_curves(dev, features, models, lc_models, modal, cfg)
    lc.to_csv(tab_dir / "learning_curves.csv", index=False)
    lc_summary = (lc.groupby(["model", "frac"]).agg(n_plants=("n_plants", "mean"), macro_f1=("macro_f1", "mean"),
                                                    sd=("macro_f1", "std")).round(3))
    lc_summary.to_csv(tab_dir / "learning_curves_summary.csv")
    fig, ax = plt.subplots(figsize=(7, 4.2))
    for name, g in lc_summary.groupby(level="model"):
        ax.errorbar(g["n_plants"], g["macro_f1"], yerr=g["sd"].fillna(0), marker="o", capsize=3, label=name,
                    lw=2.5 if name == best else 1.2)
    ax.set_xlabel("training plants")
    ax.set_ylabel("macro-F1")
    ax.set_title("Learning curves (plant-grouped CV)")
    ax.legend(fontsize=8)
    plt.tight_layout()
    plt.savefig(fig_dir / "03_learning_curves.png", dpi=130)
    plt.close()

    # 8. Final fit on all DEV -> ONE evaluation on the locked test plants
    print("locked test ...")
    fitted, test_res, params = {}, {}, {}
    evaluated = list(dict.fromkeys([best, best_ml] + baselines))
    for name in evaluated:
        fitted[name], params[name] = fit_tuned(models, name, dev[features], dev.y, dev.plant_id, cfg["split_seed"], cfg)
        test[f"pred_{name}"] = fitted[name].predict(test[features])
        test_res[name] = {**metrics(test.y, test[f"pred_{name}"], full_proba(fitted[name], test[features])),
                          "macro_f1_ci95_plant_bootstrap": plant_bootstrap(test, f"pred_{name}", cfg["n_boot"])}
        cm = confusion_matrix(test.y, test[f"pred_{name}"], labels=[0, 1, 2])
        pd.DataFrame(cm, index=[f"true_{c}" for c in CLASSES], columns=[f"pred_{c}" for c in CLASSES]).to_csv(
            tab_dir / f"confusion_matrix_{name}.csv")
        per_class_report(test.y, test[f"pred_{name}"]).round(3).to_csv(
            tab_dir / f"per_class_report_{name}.csv", index=False)
    write_json(run_dir / "test_results.json",
               {"selected": best, "best_ml_model": best_ml, "params": params[best], "test": test_res})
    test_table = pd.DataFrame(test_res).T
    ci = test_table.pop("macro_f1_ci95_plant_bootstrap")
    test_table.insert(1, "ci95_low", ci.map(lambda c: c[0]))
    test_table.insert(2, "ci95_high", ci.map(lambda c: c[1]))
    test_table = test_table.astype(float).rename_axis("model")
    test_table.round(4).to_csv(tab_dir / "test_metrics.csv")
    test.to_csv(run_dir / "locked_test_predictions.csv", index=False)
    print(test_table.round(3).to_string())
    save_table_png(test_table, fig_dir / "10_test_metrics_table.png",
                   f"Locked test: {test.plant_id.nunique()} unseen plants, {len(test)} rows (95% CI: plant bootstrap)",
                   highlight=best)

    fig, ax = plt.subplots(1, len(evaluated), figsize=(4.6 * len(evaluated), 4.2), squeeze=False)
    for a_, name in zip(ax[0], evaluated):
        cm = confusion_matrix(test.y, test[f"pred_{name}"], labels=[0, 1, 2])
        tag = " (selected)" if name == best else " (best ML)" if name == best_ml else ""
        plot_matrix(a_, cm, CLASSES, CLASSES, f"{name}{tag}\nrow-normalised (n in brackets)")
        a_.set_xlabel("predicted")
        a_.set_ylabel("true")
    plt.suptitle("Locked test confusion matrices", fontsize=11)
    plt.tight_layout()
    plt.savefig(fig_dir / "04_test_confusion.png", dpi=130)
    plt.close()

    # 9. Temporal robustness: early weeks of dev plants -> later weeks of test plants
    cutoff = pd.Timestamp(cfg["temporal_cutoff"])
    early, late = dev[dev.target_date <= cutoff], test[test.target_date > cutoff]
    temporal = {}
    if early.y.nunique() >= 2 and len(late):
        for name in dict.fromkeys([best, best_ml, ref]):
            m = fit_fixed(models, name, early[features], early.y, modal.get(name, {}))
            temporal[name] = metrics(late.y, m.predict(late[features]))
    temporal["n_train"], temporal["n_test"] = len(early), len(late)
    write_json(run_dir / "temporal_check.json", temporal)
    pd.DataFrame({k: v for k, v in temporal.items() if isinstance(v, dict)}).T.rename_axis("model").round(4).to_csv(
        tab_dir / "temporal_check.csv")

    # 10. Explainability: permutation importance (+ SHAP for tree/linear models)
    explain = best if best not in baselines else best_ml
    expl = fitted[explain]
    pi = permutation_importance(expl, test[features], test.y, n_repeats=30, random_state=0, scoring=macro_f1_scorer)
    imp = pd.DataFrame({"feature": features, "mean": pi.importances_mean, "sd": pi.importances_std}).sort_values("mean")
    imp.round(5).to_csv(tab_dir / "permutation_importance.csv", index=False)
    top12 = imp.tail(12)
    fig, ax = plt.subplots(figsize=(7, 4.5))
    ax.barh(top12.feature, top12["mean"], xerr=top12["sd"], color="#55A868")
    ax.set_title(f"Permutation importance on locked test ({explain})")
    ax.set_xlabel("drop in macro-F1")
    plt.tight_layout()
    plt.savefig(fig_dir / "05_permutation_importance.png", dpi=130)
    plt.close()
    try:
        import shap
        inner = expl[-1] if hasattr(expl, "steps") else expl
        inner = getattr(inner, "m_", inner)                         # unwrap XGBBalanced
        Xs = (test[features] if not hasattr(expl, "steps")
              else pd.DataFrame(expl[:-1].transform(test[features]), columns=features))
        if hasattr(inner, "feature_importances_"):
            sv = shap.TreeExplainer(inner).shap_values(Xs)
        elif hasattr(inner, "coef_"):
            sv = shap.LinearExplainer(inner, Xs).shap_values(Xs)
        else:
            sv = None
        if sv is not None:
            sv_poor = sv[..., 0] if np.ndim(sv) == 3 else (sv[0] if isinstance(sv, list) else sv)
            shap.summary_plot(sv_poor, Xs, show=False, max_display=12)
            plt.title(f"SHAP ({explain}) - push towards 'Poor'")
            plt.tight_layout()
            plt.savefig(fig_dir / "06_shap_poor.png", dpi=130)
            plt.close()
    except Exception as e:
        print("SHAP skipped:", e)

    # 11. Model, provenance and evidence summary
    joblib.dump({"model": fitted[best], "selected_name": best, "best_ml_model": fitted[best_ml],
                 "best_ml_name": best_ml, "features": features, "classes": CLASSES, "hi_spec": HI_SPEC,
                 "foliage_score": FOLIAGE_SCORE, "w_foliage": W_FOLIAGE, "thresholds": thr},
                run_dir / "best_model.joblib")
    versions = dict(python=platform.python_version(), numpy=np.__version__, pandas=pd.__version__,
                    sklearn=sklearn.__version__, scipy=scipy.__version__,
                    xgboost=getattr(xgboost, "__version__", None), lightgbm=getattr(lightgbm, "__version__", None))
    prov = dict(created_utc=datetime.now(timezone.utc).isoformat(), cfg=cfg, input=str(csv_path),
                inputs_sha256={csv_path.name: sha256(csv_path)}, versions=versions, skipped_models=skipped,
                n_dev=len(dev), n_test=len(test), selected=best, best_ml_model=best_ml,
                selected_params=params[best], runtime_s=round(time.time() - t_all))
    write_json(run_dir / "provenance.json", prov)
    write_summary(run_dir, cfg, dev, test, gate, adequate, stat, lb[lb_cols], test_table, temporal, val,
                  hi_counts, hi_by_foliage, comp, imp, skipped)
    print(f"saved -> {run_dir} ({prov['runtime_s']}s)")
    return run_dir


def write_summary(run_dir, cfg, dev, test, gate, adequate, stat, lb, test_table, temporal, val, hi_counts,
                  hi_by_foliage, comp, imp, skipped):
    best, best_ml = stat["selected"], stat["best_ml_model"]
    figures = sorted(p.name for p in (run_dir / "figures").glob("*.png"))
    temporal_rows = pd.DataFrame({k: v for k, v in temporal.items() if isinstance(v, dict)}).T
    ws = val["weight_sensitivity"]
    rho = val["spearman_HI_without_foliage_vs_foliage"]
    out = [
        f"# Model selection evidence - {cfg['experiment']}", "",
        f"**Data status:** {cfg['data_status']} | **Task:** {cfg['task']} | dev {len(dev)} rows / "
        f"{dev.plant_id.nunique()} plants, locked test {len(test)} rows / {test.plant_id.nunique()} plants", "",
    ]
    if cfg["data_status"] != "REAL":
        out += ["> Synthetic data: these numbers test the pipeline. They are not research results.", ""]
    out += [
        f"**Data adequacy:** plants per class {gate.to_dict()} -> adequate = {adequate}", "",
        *([f"**Models not installed (left out):** {', '.join(skipped)}", ""] if skipped else []),
        "## Health Index", "",
        "![HI distribution](figures/01_hi_distribution.png)", "",
        md_table(hi_counts.rename("rows").to_frame().rename_axis("HI class")), "",
        md_table(hi_by_foliage.rename_axis("foliage")), "",
        "### Compensation check (rows per HI class)", "",
        "![Compensation matrix](figures/07_hi_compensation_matrix.png)", "",
        md_table(comp.set_index(["aggregation", "foliage"])), "",
        "### Robustness", "",
        "![HI robustness](figures/08_hi_robustness.png)", "",
        md_table(pd.DataFrame({"value": [rho["rho"], rho["p"], ws["kappa_mean"], ws["kappa_p05"],
                                         ws["kendall_tau_mean"], ws["kendall_tau_p05"],
                                         *val["threshold_shift_class_agreement"].values()]},
                              index=["Spearman rho (HI without foliage vs foliage)", "Spearman p",
                                     "weight kappa mean", "weight kappa p05", "Kendall tau mean", "Kendall tau p05",
                                     *[f"threshold shift {k}" for k in val["threshold_shift_class_agreement"]]])
                 .rename_axis("check")), "",
        f"## Selected model: **{best}**", "", f"Rule: {stat['reason']}.", "",
        f"Best ML model for this data size (simplest model statistically tied with the top ML model): "
        f"**{best_ml}** (tied set: {', '.join(stat['ml_tied_with_top_ml'])})", "",
        f"## Cross-validated leaderboard (dev, {cfg['outer_folds']}-fold x {cfg['repeats']} repeats, "
        f"plant-grouped, nested tuning)", "",
        "![Model comparison](figures/02_model_comparison_boxplot.png)", "",
        md_table(lb), "",
        f"Friedman test across models: chi2={stat['friedman']['chi2']:.2f}, p={stat['friedman']['p']:.2e}", "",
        "![Learning curves](figures/03_learning_curves.png)", "",
        "## Locked test (evaluated once)", "",
        "![Confusion matrices](figures/04_test_confusion.png)", "",
        md_table(test_table), "",
    ]
    for name in test_table.index:
        cm = pd.read_csv(run_dir / "tables" / f"confusion_matrix_{name}.csv", index_col=0)
        out += [f"Confusion matrix - {name} (rows true, columns predicted)", "", md_table(cm), ""]
    out += [f"## Temporal check (train <= {cfg['temporal_cutoff']} on dev plants, later weeks of test plants; "
            f"n_train={temporal['n_train']}, n_test={temporal['n_test']})", ""]
    out += [md_table(temporal_rows) if len(temporal_rows) else "Not enough data on one side of the cutoff.", ""]
    out += ["## Explainability", "", "![Permutation importance](figures/05_permutation_importance.png)", ""]
    if "06_shap_poor.png" in figures:
        out += ["![SHAP](figures/06_shap_poor.png)", ""]
    out += [md_table(imp.iloc[::-1].head(12).set_index("feature"), digits=4), "",
            "## Files", "", "- figures/: " + ", ".join(figures),
            "- tables/: " + ", ".join(sorted(p.name for p in (run_dir / "tables").glob("*.csv"))), ""]
    (run_dir / "EVIDENCE_SUMMARY.md").write_text("\n".join(out), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("csv", type=Path, help="inspection CSV (e.g. synthetic_inspections_with_gps.csv)")
    parser.add_argument("--task", choices=["forecast", "symptom_now"], default=DEFAULTS["task"])
    parser.add_argument("--data-status", choices=["SYNTHETIC", "REAL"], default=DEFAULTS["data_status"])
    parser.add_argument("--experiment", help="run name prefix (default depends on the task)")
    parser.add_argument("--aggregation", choices=["geometric", "arithmetic"], default=DEFAULTS["hi_aggregation"])
    parser.add_argument("--temporal-cutoff", default=DEFAULTS["temporal_cutoff"])
    parser.add_argument("--real-ref", type=Path, help="optional cleaned real inspections for the HI sanity check")
    parser.add_argument("--out-root", type=Path, default=HERE / "results")
    parser.add_argument("--resume", type=Path, help="earlier run folder; reuses its tables/cv_fold_scores.csv")
    parser.add_argument("--quick", action="store_true", help="1 repeat, small search: smoke test only")
    args = parser.parse_args()

    cfg = dict(DEFAULTS, task=args.task, data_status=args.data_status, hi_aggregation=args.aggregation,
               temporal_cutoff=args.temporal_cutoff,
               experiment=args.experiment or ("m2_hi_cls_v1" if args.task == "forecast" else "m2_symptom_now_v1"))
    if args.quick:
        cfg.update(QUICK, experiment=cfg["experiment"] + "_quick")
    run(args.csv, cfg, args.out_root, args.real_ref, args.resume)


if __name__ == "__main__":
    main()
