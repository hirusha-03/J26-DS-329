"""Classify inspections that have not been scored yet, using the model from train_health_model.py.

Reads all inspections from Supabase (each plant's earlier visits are needed for the temporal
features), keeps the ones with no health_classifications row for this model version, and writes
the predictions to a CSV. With --write they are also upserted into health_classifications.

    python score_new_inspections.py                      # Supabase -> CSV only
    python score_new_inspections.py --write              # also store them (needs SUPABASE_SERVICE_KEY)
    python score_new_inspections.py --csv export.csv     # score a CSV export instead
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request

import joblib
import numpy as np
import pandas as pd

from inspection_prep import prepare, read_raw

HERE = Path(__file__).resolve().parent
DEFAULT_MODEL = HERE / "results" / "health_model" / "health_index_model.joblib"


def env(name):
    """os.environ first, then backend/.env."""
    if os.environ.get(name):
        return os.environ[name]
    path = HERE.parents[1] / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            k, _, v = line.partition("=")
            if k.strip() == name:
                return v.strip().strip('"')
    return None


class Supabase:
    def __init__(self, write=False):
        self.url = env("SUPABASE_URL")
        self.key = env("SUPABASE_SERVICE_KEY") if write else (env("SUPABASE_SERVICE_KEY") or env("SUPABASE_ANON_KEY"))
        if not self.url or not self.key:
            sys.exit("SUPABASE_URL and SUPABASE_SERVICE_KEY" + ("" if write else " (or SUPABASE_ANON_KEY)")
                     + " must be set (environment or backend/.env)")

    def _req(self, path, data=None, headers=None):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        h.update(headers or {})
        req = urllib.request.Request(f"{self.url}/rest/v1/{path}", data=data, headers=h,
                                     method="POST" if data is not None else "GET")
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
        return json.loads(body) if body else None

    def select(self, table, columns="*", page=1000, **filters):
        rows, start = [], 0
        query = "&".join([f"select={columns}"] + [f"{k}=eq.{urllib.parse.quote(str(v))}" for k, v in filters.items()])
        while True:
            chunk = self._req(f"{table}?{query}", headers={"Range": f"{start}-{start + page - 1}"})
            rows += chunk
            if len(chunk) < page:
                return rows
            start += page

    def upsert(self, table, rows, on_conflict):
        for i in range(0, len(rows), 500):
            self._req(f"{table}?on_conflict={on_conflict}", data=json.dumps(rows[i:i + 500]).encode(),
                      headers={"Prefer": "resolution=merge-duplicates,return=minimal"})


def as_raw(records):
    """API rows -> the all-text frame read_raw() gives for a CSV export."""
    df = pd.DataFrame(records)
    return df.apply(lambda col: col.map(lambda v: np.nan if v is None or v == "" else str(v)))


def model_key(bundle):
    return re.sub(r"[^a-z0-9]+", "_", bundle["model_name"].lower()).strip("_")


def main():
    p = argparse.ArgumentParser(description="Classify inspections not yet in health_classifications.")
    p.add_argument("--model", default=str(DEFAULT_MODEL))
    p.add_argument("--csv", help="score this inspection export instead of reading Supabase")
    p.add_argument("--all", action="store_true", help="score every inspection, not only unscored ones")
    p.add_argument("--write", action="store_true", help="upsert the results into health_classifications")
    p.add_argument("--out", help="CSV for the results (default results/health_model/new_classifications_<time>.csv)")
    a = p.parse_args()

    bundle = joblib.load(a.model)
    model, features, classes = bundle["model"], bundle["features"], bundle["class_names"]
    key, version = model_key(bundle), bundle["version"]
    print(f"model: {bundle['model_name']} ({version}), trained {bundle['trained_at']}")

    db = None
    if a.csv:
        raw = read_raw(a.csv)
    else:
        db = Supabase(write=a.write)
        raw = as_raw(db.select("inspections"))
    print("inspections read:", len(raw))
    data = prepare(raw)

    todo = data
    if db is not None and not a.all:
        done = {(r["plant_id"], r["cycle"]) for r in
                db.select("health_classifications", "plant_id,cycle", model=key, model_version=version)}
        todo = data[[(pid, d.strftime("%Y-%m-%d")) not in done
                     for pid, d in zip(data.plant_id, data.inspection_date)]]
        print(f"already classified: {len(done)} | new: {len(todo)}")
    if todo.empty:
        print("nothing new to classify")
        return

    proba = model.predict_proba(todo[features])
    res = pd.DataFrame({
        "plant_id": todo.plant_id.values,
        "inspection_date": todo.inspection_date.dt.strftime("%Y-%m-%d").values,
        "inspection_id": todo["id"].values,
        "health_class": np.array(classes)[proba.argmax(1)],
        "probability": proba.max(1).round(4),
        **{f"prob_{c.lower()}": proba[:, i].round(4) for i, c in enumerate(classes)},
        "observed_class": todo.health_index.map(lambda v: classes[int(v)] if pd.notna(v) else None).values,
        "model": key,
        "model_version": version,
    })
    out = Path(a.out) if a.out else HERE / "results" / "health_model" / \
        f"new_classifications_{datetime.now():%Y%m%d-%H%M}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    res.to_csv(out, index=False)

    latest = res.sort_values("inspection_date").groupby("plant_id").tail(1)
    print(f"classified {len(res)} inspections on {res.plant_id.nunique()} plants -> {out}")
    print("latest class per plant:", latest.health_class.value_counts().reindex(classes, fill_value=0).to_dict())
    labelled = res.dropna(subset=["observed_class"])
    if len(labelled):
        print(f"agrees with the recorded foliage class on {(labelled.health_class == labelled.observed_class).mean():.0%}"
              f" of {len(labelled)} inspections")
    flagged = latest[latest.health_class != "Healthy"].sort_values(["health_class", "probability"],
                                                                     ascending=[False, False])
    if len(flagged):
        print("\nplants to look at:")
        print(flagged[["plant_id", "inspection_date", "health_class", "probability", "observed_class"]]
              .to_string(index=False))

    if a.write:
        known = {r["plant_id"] for r in db.select("plants", "plant_id")}
        rows = [{"plant_id": r.plant_id, "cycle": r.inspection_date, "model": key, "model_version": version,
                 "health_class": r.health_class, "probability": float(r.probability),
                 "params": {"inspection_id": r.inspection_id,
                            **{f"prob_{c.lower()}": float(getattr(r, f"prob_{c.lower()}")) for c in classes}}}
                for r in res.itertuples() if r.plant_id in known]
        skipped = len(res) - len(rows)
        db.upsert("health_classifications", rows, "plant_id,cycle,model,model_version")
        print(f"\nwritten to health_classifications: {len(rows)}" + (f" (skipped {skipped} unknown plant ids)"
                                                                      if skipped else ""))


if __name__ == "__main__":
    main()
