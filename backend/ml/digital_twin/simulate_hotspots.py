"""Known-answer data for the hotspot pipeline.

No real hotspot has a confirmed cause yet, so the pipeline is scored on the weekly simulated
inspections with two labelled hotspots planted into healthy blocks:

  nutrient  B01, plants 1-4: from week 6 low EC and acidic soil, uniform yellowing, growth stops,
            all at once, footprint stays put
  disease   B03, starts at plant 4 in week 5: soil unchanged, Mixed then Brown foliage, each week a
            neighbour of an infected plant is infected with probability 0.6

The sampled plants get a planting layout and noisy GPS fixes. Spacing and GPS error are assumptions
(see the constants), not survey values; results on this data are simulated validation only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

ORIGIN = (7.3388, 80.6957)
SPACING_M = 6.0        # between sampled plants along a row (they are a subset of the planted vines)
ROW_GAP_M = 6.0
BLOCK_GAP_M = 40.0
GPS_SIGMA_M = 4.0      # per-fix error under canopy; 3-8 m is typical for phones, to be measured in the field
FIXES_PER_PLANT = 5
WEEK0 = pd.Timestamp("2026-07-10")
NUTRIENT = {"block": "B01", "plants": [1, 2, 3, 4], "onset": 6}
DISEASE = {"block": "B03", "seed": 4, "onset": 5, "p_spread": 0.6}


def layout(plant_ids):
    """True positions: blocks of a zone side by side, zones stacked, two rows of plants per block."""
    rows = []
    lat0, lon0 = ORIGIN
    m_lng = 111_320 * np.cos(np.radians(lat0))
    for pid in plant_ids:
        zone, block, n = pid[0], int(pid[1:3]), int(pid[5:8])
        x = (block - 1) * BLOCK_GAP_M + (n - 1) // 2 * SPACING_M
        y = "ABCD".index(zone) * BLOCK_GAP_M + (n - 1) % 2 * ROW_GAP_M
        rows.append({"plant_id": pid, "true_x": x, "true_y": y,
                     "true_lat": lat0 + y / 111_320, "true_lon": lon0 + x / m_lng})
    return pd.DataFrame(rows)


def gps_fixes(lay, rng, sigma=GPS_SIGMA_M, n=FIXES_PER_PLANT):
    m_lng = 111_320 * np.cos(np.radians(ORIGIN[0]))
    rows = []
    for r in lay.itertuples():
        e = rng.normal(0, sigma, (n, 2))
        for dx, dy in e:
            rows.append({"plant_id": r.plant_id, "latitude": r.true_lat + dy / 111_320,
                         "longitude": r.true_lon + dx / m_lng, "accuracy": round(float(rng.uniform(3, 9)), 1)})
    return pd.DataFrame(rows)


def plant_hotspots(df, lay, rng):
    """df: cleaned, imputed inspections. Returns the modified copy and the truth (plant, cause, onset week)."""
    d = df.copy()
    d["week"] = (d.inspection_date - WEEK0).dt.days // 7
    truth = []

    nut = [p for p in d.plant_id.unique() if p.startswith(NUTRIENT["block"]) and int(p[5:8]) in NUTRIENT["plants"]]
    for p in nut:
        sel = (d.plant_id == p) & (d.week >= NUTRIENT["onset"])
        frozen = d.loc[(d.plant_id == p) & (d.week < NUTRIENT["onset"]), "vine_height_cm"].iloc[-1]
        d.loc[sel, "soil_ec"] = rng.uniform(0.005, 0.02, sel.sum()).round(2)
        d.loc[sel, "soil_ph"] = rng.uniform(5.0, 5.3, sel.sum()).round(1)
        d.loc[sel, "foliage_color"] = "Yellow"
        d.loc[sel, "vine_height_cm"] = frozen
        truth.append((p, "nutrient", NUTRIENT["onset"]))

    block = lay[lay.plant_id.str.startswith(DISEASE["block"])].set_index("plant_id")
    seed = next(p for p in block.index if int(p[5:8]) == DISEASE["seed"])
    infected = {seed: DISEASE["onset"]}
    for w in range(DISEASE["onset"] + 1, int(d.week.max()) + 1):
        for p in block.index:
            if p in infected:
                continue
            near = [q for q, wq in infected.items() if wq < w and np.hypot(
                block.at[p, "true_x"] - block.at[q, "true_x"], block.at[p, "true_y"] - block.at[q, "true_y"])
                <= SPACING_M * 1.1]
            if near and rng.random() < DISEASE["p_spread"]:
                infected[p] = w
    for p, w in infected.items():
        later = (d.plant_id == p) & (d.week >= w)
        d.loc[later, "foliage_color"] = np.where(d.loc[later, "week"] == w, "Mixed", "Brown")
        frozen = d.loc[(d.plant_id == p) & (d.week <= w), "vine_height_cm"].iloc[-1]
        d.loc[(d.plant_id == p) & (d.week > w), "vine_height_cm"] = frozen
        truth.append((p, "disease", w))
    return d.drop(columns="week"), pd.DataFrame(truth, columns=["plant_id", "cause", "onset_week"])
