"""Local-only: backend inference must reproduce the training notebook's probabilities.

Needs the model, the training run's local_predictions.csv (M1_PARITY_CSV, default: next to the
model file) and the
local photos (M1_LOCAL_DATA, default ml/disease_detection/data/m1_local_2026-10-11).
Skipped in CI, where neither exists.
"""
import csv
import os
from pathlib import Path

import pytest
from app.services.disease.inference import ModelUnavailable, get_model, model_path
from PIL import Image

BACKEND = Path(__file__).resolve().parents[2]
DATA = Path(os.getenv("M1_LOCAL_DATA", BACKEND / "ml/disease_detection/data/m1_local_2026-10-11"))
TOL = 5e-4  # agree to 3 decimal places


def _rows():
    try:
        model = get_model()
    except ModelUnavailable as e:
        pytest.skip(str(e))
    csv_path = Path(os.getenv("M1_PARITY_CSV") or model_path().with_name("local_predictions.csv"))
    if not csv_path.is_file() or not DATA.is_dir():
        pytest.skip("local_predictions.csv or local photos not available")
    with csv_path.open(newline="") as f:
        rows = [r for r in csv.DictReader(f) if (DATA / r["path"]).is_file()]
    if not rows:
        pytest.skip("no local photos matching local_predictions.csv")
    return model, rows


def test_probabilities_match_notebook():
    model, rows = _rows()
    worst = 0.0
    for r in rows:
        got = model.class_probs(Image.open(DATA / r["path"]))
        for c, p in got.items():
            worst = max(worst, abs(p - float(r[f"p_{c}"])))
    assert worst < TOL, f"max prob diff {worst:.2e} over {len(rows)} photos"


def test_collapsed_prediction_matches_notebook():
    model, rows = _rows()
    mismatches = [r["path"] for r in rows if model.predict(Image.open(DATA / r["path"]))["prediction"] != r["pred3"]]
    assert not mismatches, mismatches[:5]
