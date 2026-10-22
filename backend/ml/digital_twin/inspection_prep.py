"""Cleaning, imputation and features for inspection records.

Shared by train_health_model.py and score_new_inspections.py so that training data and new
Supabase inspections go through exactly the same steps. Ported from
RP/HealthIndex_Classification.ipynb (sections 2, 3 and 5).
"""
from __future__ import annotations

from datetime import datetime
import re

import numpy as np
import pandas as pd
from scipy.stats import theilslopes

NUM_COLS = ["soil_ph", "soil_ec", "moisture", "temperature", "humidity", "vine_height_cm"]
CAT_COLS = ["foliage_color", "soil_type", "sunlight_level", "shade_level", "watering_status"]
PID_RE = re.compile(r"^[A-D]\d{2}-P\d{3}-G\d+$")
ISO_DT_RE = re.compile(r"^\d{4}-\d{2}-\d{2} 00:00:00\+00$")
PSEUDO_NULLS = {"n/a", "na", "-", "null", "none", "nan"}

CAT_MAPS = {
    "foliage_color": {"green": "Green", "yellow": "Yellow", "yelow": "Yellow", "mixed": "Mixed",
                      "brown": "Brown", "brwn": "Brown"},
    "soil_type": {"acidic": "Acidic", "standard": "Standard", "std": "Standard"},
    "sunlight_level": {"bright indirect": "bright_indirect", "bright": "bright", "medium": "medium", "low": "low"},
    "shade_level": {"light": "light", "moderate": "moderate", "partial": "partial", "heavy": "heavy"},
    "watering_status": {"keep moist": "Keep moist", "partially dry": "Partially dry",
                        "dry out": "Dry out", "high humidity": "High humidity"},
}
# Provisional limits; EC unit and moisture-meter scale still to be confirmed.
VALID_RANGE = {"soil_ph": (4.5, 8.0), "soil_ec": (0.0, 1.0), "moisture": (1, 10),
               "temperature": (18, 32), "humidity": (40, 100), "vine_height_cm": (1, 1500)}
FORM_DEFAULT_PH = 6.2
STUDY_START, STUDY_END = pd.Timestamp("2026-07-01"), pd.Timestamp("2026-10-31")

# HealthIndex target. Taken from foliage colour until Mr. Kodikara confirms a field label.
HEALTH_MAP = {"Green": 0, "Mixed": 1, "Yellow": 2, "Brown": 2}
CLASS_NAMES = ["Healthy", "Moderate", "Poor"]

NUMERIC_FEATS = ["soil_ph", "soil_ec", "moisture", "temperature", "humidity", "vine_height_cm",
                 "days_since_fert", "week", "moisture_prev", "soil_ph_prev", "soil_ec_prev", "humidity_prev",
                 "moisture_delta", "moisture_roll3", "height_growth_wk", "ph_out_of_range", "moisture_extreme",
                 "moisture_dev", "ph_dev", "ec_low", "moisture_dev_ewm", "ph_dev_ewm", "ec_low_ewm"]
CAT_FEATS = ["zone", "block", "sunlight_level", "shade_level"]
FEATURES = NUMERIC_FEATS + CAT_FEATS


def read_raw(path):
    """Everything as text first, so nothing is converted before it has been checked."""
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    return df.replace({"": np.nan})


def is_number(s):
    try:
        float(s)
        return True
    except (TypeError, ValueError):
        return False


def norm_plant_id(s):
    if pd.isna(s):
        return np.nan
    t = str(s).strip().upper().replace("_", "-")
    m = re.match(r"^([A-D])(\d{1,2})-P(\d{1,3})-G(\d+)$", t)
    if not m:
        return np.nan
    z, b, p, g = m.groups()
    return f"{z}{int(b):02d}-P{int(p):03d}-G{g}"


def to_number(s):
    if pd.isna(s):
        return np.nan
    t = re.sub(r"[^0-9.\-]", "", str(s).strip().replace(",", "."))
    try:
        return float(t)
    except ValueError:
        return np.nan


def norm_category(s, mapping):
    if pd.isna(s):
        return np.nan
    key = re.sub(r"[\s_]+", " ", str(s).strip().lower())
    return mapping.get(key, np.nan)


def parse_inspection_date(s, created_date, window):
    """Return (date, status). Ambiguous formats are resolved against created_at, which the app writes."""
    cands = []
    if pd.notna(s):
        t = str(s).strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}", t):
            cands.append(pd.Timestamp(t[:10]))
        for fmt in ("%d/%m/%Y", "%m/%d/%Y", "%d-%b-%Y"):
            try:
                cands.append(pd.Timestamp(datetime.strptime(t, fmt)))
            except ValueError:
                pass
    if pd.notna(created_date) and created_date in cands:
        return created_date, "ok"
    in_window = [c for c in cands if window[0] <= c <= window[1]]
    if in_window:
        return in_window[0], "parsed"
    return created_date, "reconciled_from_created_at"


def clean_inspections(raw_df, window=None):
    """Returns (clean rows, log of values set to missing, summary table). Bad values become NaN, not deleted rows."""
    df = raw_df.copy()
    actions, summary = [], {}
    if window is None:
        # inspections added after the study period still need a valid date window
        last = pd.to_datetime(df["created_at"], utc=True, errors="coerce").max()
        end = STUDY_END if pd.isna(last) else max(STUDY_END, last.tz_convert(None).normalize() + pd.Timedelta(days=1))
        window = (STUDY_START, end)

    n = 0
    for c in df.columns:
        m = df[c].notna() & df[c].astype(str).str.strip().str.lower().isin(PSEUDO_NULLS)
        n += int(m.sum())
        df.loc[m, c] = np.nan
    summary["pseudo-null text -> NaN"] = n

    n0 = len(df)
    df = df.drop_duplicates().copy()
    summary["exact duplicate rows removed"] = n0 - len(df)

    before = df["plant_id"].copy()
    df["plant_id"] = df["plant_id"].map(norm_plant_id)
    summary["plant_id standardised"] = int((before.fillna("") != df["plant_id"].fillna("")).sum())
    bad = df["plant_id"].isna()
    summary["rows dropped: unparseable plant_id"] = int(bad.sum())
    df = df[~bad].copy()

    created = pd.to_datetime(df["created_at"], utc=True, errors="coerce").dt.tz_convert(None).dt.normalize()
    parsed = [parse_inspection_date(s, c, window) for s, c in zip(df["inspection_date"], created)]
    raw_dates = df["inspection_date"].fillna("").astype(str)
    df["inspection_date"] = pd.to_datetime([p[0] for p in parsed])
    status = pd.Series([p[1] for p in parsed], index=df.index)
    iso = raw_dates.str.match(ISO_DT_RE)
    summary["dates re-formatted"] = int(((status != "reconciled_from_created_at") & ~iso).sum())
    summary["dates reconciled from created_at"] = int((status == "reconciled_from_created_at").sum())
    df["created_at"] = pd.to_datetime(df["created_at"], utc=True, errors="coerce")
    df["last_fertilized"] = pd.to_datetime(df["last_fertilized"], errors="coerce")

    n = 0
    for c in NUM_COLS:
        txt = df[c].notna() & ~df[c].map(lambda v: is_number(v) if pd.notna(v) else True)
        n += int(txt.sum())
        df[c] = df[c].map(to_number).astype(float)
    summary["numeric text cleaned (units, commas)"] = n

    n = 0
    for c, mp in CAT_MAPS.items():
        if c in df:
            before = df[c].copy()
            df[c] = df[c].map(lambda v: norm_category(v, mp))
            n += int((before.notna() & (before != df[c])).sum())
    summary["category labels standardised"] = n

    # same plant re-measured on the same day: keep the latest record
    df = df.sort_values(["plant_id", "inspection_date", "created_at", "id"])
    dup = df.duplicated(["plant_id", "inspection_date"], keep="last")
    summary["near-duplicate rows removed"] = int(dup.sum())
    df = df[~dup].copy()

    # pH left at the form default while the other meter fields are empty was never measured
    meter = ["soil_ec", "moisture", "temperature", "humidity"]
    fd = (df["soil_ph"] == FORM_DEFAULT_PH) & df[meter].isna().all(axis=1)
    actions += [(i, "soil_ph", "form_default") for i in df.loc[fd, "id"]]
    df.loc[fd, "soil_ph"] = np.nan
    summary["pH form-default values -> NaN"] = int(fd.sum())

    n = 0
    for c, (lo, hi) in VALID_RANGE.items():
        bad = df[c].notna() & ~df[c].between(lo, hi)
        n += int(bad.sum())
        actions += [(i, c, "out_of_range") for i in df.loc[bad, "id"]]
        df.loc[bad, c] = np.nan
    summary["out-of-range values -> NaN"] = n

    # weather is shared by the whole plantation on a day; height should follow the plant's own trend
    n = 0
    for c, tol in [("temperature", 2.5), ("humidity", 12)]:
        med = df.groupby("inspection_date")[c].transform("median")
        bad = df[c].notna() & ((df[c] - med).abs() > tol)
        n += int(bad.sum())
        actions += [(i, c, "contextual_outlier") for i in df.loc[bad, "id"]]
        df.loc[bad, c] = np.nan
    for _, g in df.groupby("plant_id"):
        g = g.dropna(subset=["vine_height_cm"])
        if len(g) < 4:
            continue
        x = (g["inspection_date"] - STUDY_START).dt.days.values.astype(float)
        y = g["vine_height_cm"].values
        slope, intercept, _, _ = theilslopes(y, x)
        resid = y - (intercept + slope * x)
        mad = np.median(np.abs(resid - np.median(resid))) * 1.4826
        bad_idx = g.index[np.abs(resid) > max(25.0, 4 * mad)]
        actions += [(i, "vine_height_cm", "contextual_outlier") for i in df.loc[bad_idx, "id"]]
        df.loc[bad_idx, "vine_height_cm"] = np.nan
        n += len(bad_idx)
    summary["contextual outliers -> NaN"] = n

    df = df.sort_values(["plant_id", "inspection_date"]).reset_index(drop=True)
    summary["rows after cleaning"] = len(df)
    log = pd.DataFrame(actions, columns=["id", "column", "action"])
    table = pd.DataFrame(list(summary.items()), columns=["Preprocessing step", "Records / values affected"])
    return df, log, table


def impute(df, method="temporal"):
    """temporal: weather from same-day plants, soil and height interpolated in each plant's own series.
    median: global column median (the baseline it is compared with). The target is never imputed."""
    out = df.sort_values(["plant_id", "inspection_date"]).copy()
    for c in NUM_COLS:
        out[f"{c}_imputed"] = out[c].isna()
    if method == "median":
        for c in NUM_COLS:
            out[c] = out[c].fillna(out[c].median())
    else:
        for c in ["temperature", "humidity"]:
            out[c] = out[c].fillna(out.groupby("inspection_date")[c].transform("median"))
        parts = []
        for _, g in out.groupby("plant_id", sort=False):
            g = g.copy()
            idx = pd.DatetimeIndex(g["inspection_date"])
            for c in ["soil_ph", "soil_ec", "moisture", "vine_height_cm"]:
                s = pd.Series(g[c].values, index=idx)
                if s.notna().any():
                    g[c] = s.interpolate(method="time", limit_direction="both").values
            parts.append(g)
        out = pd.concat(parts)
        out["block"] = out["plant_id"].str[:3]
        for c in NUM_COLS:
            out[c] = out[c].fillna(out.groupby(["block", "inspection_date"])[c].transform("median"))
            out[c] = out[c].fillna(out.groupby("block")[c].transform("median"))
            out[c] = out[c].fillna(out[c].median())
        out = out.drop(columns="block")
    out["moisture"] = out["moisture"].round().clip(1, 10)
    out["soil_ph"] = out["soil_ph"].round(1)
    out["soil_ec"] = out["soil_ec"].round(2)
    out["vine_height_cm"] = out["vine_height_cm"].round()
    return out.reset_index(drop=True)


def build_features(df, week0="2026-07-10"):
    d = df.sort_values(["plant_id", "inspection_date"]).copy()
    d["zone"] = d["plant_id"].str[0]
    d["block"] = d["plant_id"].str[:3]
    d["days_since_fert"] = (d["inspection_date"] - pd.to_datetime(d["last_fertilized"])).dt.days
    d["days_since_fert"] = d["days_since_fert"].fillna(d["days_since_fert"].median()).fillna(0)
    d["week"] = (d["inspection_date"] - pd.Timestamp(week0)).dt.days // 7
    g = d.groupby("plant_id")
    for c in ["moisture", "soil_ph", "soil_ec", "humidity"]:
        d[f"{c}_prev"] = g[c].shift(1).fillna(d[c])
    d["moisture_delta"] = d["moisture"] - d["moisture_prev"]
    d["moisture_roll3"] = g["moisture"].transform(lambda s: s.rolling(3, min_periods=1).mean())
    gap_wk = g["inspection_date"].diff().dt.days / 7
    d["height_growth_wk"] = (g["vine_height_cm"].diff() / gap_wk).fillna(0)
    d["ph_out_of_range"] = ((d["soil_ph"] < 5.5) | (d["soil_ph"] > 7.0)).astype(int)
    d["moisture_extreme"] = ((d["moisture"] <= 3) | (d["moisture"] >= 10)).astype(int)
    # foliage reacts to stress over several weeks, so keep a decaying memory of it per plant
    d["moisture_dev"] = (d["moisture"] - 7).abs()
    d["ph_dev"] = (5.6 - d["soil_ph"]).clip(lower=0) + (d["soil_ph"] - 7.0).clip(lower=0)
    d["ec_low"] = (d["soil_ec"] < 0.03).astype(int)
    g = d.groupby("plant_id")
    for c in ["moisture_dev", "ph_dev", "ec_low"]:
        d[f"{c}_ewm"] = g[c].transform(lambda s: s.ewm(alpha=0.4).mean())
    for c in CAT_FEATS:
        d[c] = d[c].fillna("unknown")
    d["health_index"] = d["foliage_color"].map(HEALTH_MAP)
    return d


def prepare(raw_df, window=None):
    """raw text rows -> cleaned, imputed rows with features."""
    clean, _, _ = clean_inspections(raw_df, window)
    return build_features(impute(clean, "temporal"))
