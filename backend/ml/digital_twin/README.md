# Module 2 — Digital Twin analytics

Scripts behind the GPS-referenced Digital Twin (Survey Plan No. 61 plantation). Outputs go to
`results/` (gitignored) and, for live data, to the tables from
`backend/migrations/2026-10-17_digital_twin.sql`.

| Script | What it does |
|---|---|
| `inspection_prep.py` | Cleaning, imputation and features for inspection records, used by both scripts below |
| `train_health_model.py` | Trains the HealthIndex classifier on past inspections; writes figures, tables and the model |
| `score_new_inspections.py` | Classifies Supabase inspections that have not been scored yet |
| `audit_dataset.py` | Descriptive data-quality report, standard library only |
| `gps_dispersion.py` | E1: single fix vs averaged GPS positions, scored by repeatability |

See [WORKFLOW.md](WORKFLOW.md) for the staged plan.

## HealthIndex classification

`train_health_model.py` is the script version of `RP/HealthIndex_Classification.ipynb` and gives the
same numbers. HealthIndex comes from the recorded foliage colour: Green → Healthy, Mixed → Moderate,
Yellow/Brown → Poor. That label still has to be confirmed by Mr. Kodikara (research brief §9); it is
set in one place, `HEALTH_MAP` in `inspection_prep.py`.

Train (from the repository root, about 3 minutes):

```powershell
$RP = "C:\Users\STZ\Desktop\RP"
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/train_health_model.py "$RP\inspections_weekly_simulated.csv" `
    --ground-truth "$RP\inspections_weekly_ground_truth.csv" --defect-log "$RP\inspections_weekly_defect_log.csv" `
    --real "$RP\inspections_rows (6).csv"
```

`--ground-truth` and `--defect-log` score the cleaning steps (simulated data only). `--real` tests the
trained model on a Supabase export. Each run writes `results/health_model/<timestamp>/`:

- `figures/` — missing values, imputation error, class balance and weekly trend, block × week heatmap,
  feature correlation, model comparison, per-class F1, confusion matrices (cross-validation, test,
  real data), ROC/PR curves, feature importance, learning curve
- `tables/` — the numbers behind every figure, plus `00_results_summary.csv`, the data-quality audit,
  preprocessing summary and per-fold scores
- `health_index_model.joblib`, `inspections_cleaned.csv`

The model is also copied to `results/health_model/health_index_model.joblib` for scoring.

Current run (simulated weekly data, 82 plants): SVM (RBF) selected, CV macro-F1 0.614, held-out
plants 0.531 against 0.493 for the rule-based baseline, real export 0.354.

### Scoring new inspections

```powershell
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/score_new_inspections.py          # CSV only
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/score_new_inspections.py --write  # also store
```

It reads every inspection (earlier visits are needed for the temporal features), skips those already
in `health_classifications` for this model version and saves the rest to
`results/health_model/new_classifications_<time>.csv`. `--write` upserts them into
`health_classifications` (`cycle` = inspection date) and needs `SUPABASE_SERVICE_KEY`; the anon key
can read but not write. `--csv export.csv` scores a file instead of the database.

Read the output as a screen, not a diagnosis. On the 118 real inspections of 21 Oct 2026 it caught 7 of
the 9 plants with recorded yellow/brown/mixed foliage, but flagged 34 in total, mostly in blocks C02
and C03. Zone, shade and study week are among its strongest inputs, because those blocks were the
unhealthy ones in the simulated training data. Dropping those inputs cuts the false alarms but also
the real detections (readings only: 4 flagged, 0 of 9 caught).

## Dataset audit

```powershell
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/audit_dataset.py "C:\Users\STZ\Desktop\RP\inspections_weekly_simulated.csv" --provenance synthetic --as-of 2026-10-21 --out backend/ml/digital_twin/results/synthetic_audit
```

Writes `report.md`, `audit.json` and `issues.csv` without changing the source CSV.

## E1 field protocol

1. In the monitor app open **GPS Re-capture** (`/gps-capture`), pick the slot from its tag, take 10 readings.
2. Repeat at the same plant at a different time of day (second session). Target: ≥3 plants per block.
3. Readings upload to `plant_location_observations` (kept on the phone until the table exists; the
   download button exports them as CSV).

```bash
pip install -r requirements.txt
python gps_dispersion.py observations.csv --out results/e1_gps
# or straight from Supabase:
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python gps_dispersion.py --supabase
```

Results: `report.md` (tables for the dissertation), `summary.json`, `sessions.csv`.

## Checks

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest tests/twin -q
```
