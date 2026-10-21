# Module 2 — Digital Twin analytics

Scripts behind the GPS-referenced Digital Twin (Survey Plan No. 61 plantation). Outputs go to
`results/` (gitignored) and, for live data, to the tables from
`backend/migrations/2026-10-17_digital_twin.sql`.

| Script | What it does |
|---|---|
| `inspection_prep.py` | Cleaning, imputation and features for inspection records, used by training and scoring scripts |
| `train_health_model.py` | Trains the plant health classifier on past inspections; writes figures, tables and the model |
| `score_new_inspections.py` | Classifies Supabase inspections that have not been scored yet |
| `validate_health_model.py` | Nested CV, feature selection, resampling, block and time holdouts, zone/block checks |
| `hotspots.py`, `run_hotspots.py` | Plant anomalies → spatial test → Haversine-DBSCAN → tracking → cause triage → Module 1 referrals |
| `simulate_hotspots.py` | Plants two labelled hotspots (nutrient, disease) into the simulated data to score the pipeline |
| `audit_dataset.py` | Descriptive data-quality report, standard library only |
| `gps_dispersion.py` | E1: single fix vs averaged GPS positions, scored by repeatability |

See [WORKFLOW.md](WORKFLOW.md) for the staged plan.

> **Note on Pipeline Clean-up:** The earlier experimental geometric composite Health Index script (`health_index_pipeline.py`) and its legacy output runs have been removed. The active, clean ML pipeline uses supervised plant health classification validated against `HealthIndex_Classification.ipynb`.

## Plant Health Classification

`train_health_model.py` is the script version of `RP/HealthIndex_Classification.ipynb` and gives the
same numbers. Health classification comes from the recorded foliage colour: Green → Healthy, Mixed → Moderate,
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

### How far the classifier can be trusted

```powershell
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/validate_health_model.py "$RP\inspections_weekly_simulated.csv" --supabase
```

About 10 minutes; writes `results/health_validation/<timestamp>/`. On the simulated data (21 Oct 2026):

- Nested CV, every model tuned inside each outer fold: SVM 0.604, XGBoost 0.595 (train 0.91, so it
  overfits most), Logistic Regression 0.558, Random Forest 0.540.
- Feature selection inside the folds never helped: SVM 0.609 with all features, 0.599 after dropping
  `soil_ph_prev`, `moisture_roll3`, `ph_dev` (|ρ| > 0.9), 0.573 with model-based selection.
- SMOTE inside the folds ties class weights (SVM 0.609 both); undersampling is worse for every model.
- Stricter splits score lower, as they should: SVM 0.577 plant-grouped, 0.531 leave-one-block-out,
  0.414 on later weeks of plants never seen. Report the last two as the honest estimates.
- All 82 plant ids fit the layout, and none of the 202 `plants`/`slots` rows disagrees with its id.

## Spatial plant health hotspots

Module 2 detects and triages; Module 1 diagnoses. Per inspection cycle (weekly simulated, monthly real):

1. one coordinate per plant: fixes worse than `--max-accuracy` (10 m) dropped, then strays more than
   3 robust SD from the plant's other fixes; median of the rest; spread kept as its uncertainty
2. anomalies: robust z of pH, EC, moisture and growth against the plant's last 4 cycles and against its
   block (zone when the block has fewer than 8 other sampled plants), each scaled by the pooled
   spread for that cycle; foliage worsening or Yellow/Brown. Rule baseline vs Isolation Forest.
3. join count (flags) and Moran's I (anomaly score) in a distance band of eps, 999 shuffles within zone
4. Haversine-DBSCAN on anomalous plants only; eps = max(k-distance elbow, 2 × GPS error)
5. permutation test: flags shuffled within zone, share of anomalous plants that end up clustered
6. tracking by member overlap (Jaccard ≥ 0.3) or centroid within eps: new / persistent / expanding /
   shrinking / resolved, area (UTM 44N hull), movement, adjacency of new members, onset spread
7. triage: points for nutrient (soil out of range, soil differs from the healthy ring, yellow,
   simultaneous onset, suppressed growth) against disease (brown/mixed, staggered onset, adjacent
   spread, net growth ≥ 2); a margin of 2 decides, otherwise `uncertain_expert_review`. The soil
   test only counts when the group sizes can reach p < 0.05.
8. `likely_disease` hotspots go to `tables/08_module1_referrals.csv`

```powershell
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/run_hotspots.py --simulate "$RP\inspections_weekly_simulated.csv"
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/run_hotspots.py --supabase --zones frontend/monitor/public/geo/zones.geojson
```

`--write` stores real runs in `plant_health_anomalies` and `health_hotspots`
(`backend/migrations/2026-10-21_health_hotspots.sql`, service key). Thresholds and triage points are
proposals until Mr. Kodikara agrees them.

Simulated validation (two planted hotspots, 6 m sample spacing and 4 m per-fix GPS error assumed):

- anomaly detection in zones A and B: rule precision 0.64, recall 1.00, 3.5 false alarms per cycle;
  Isolation Forest precision 0.45, recall 0.49 at contamination 0.15 (best of 0.05–0.20)
- eps 9.5 m chosen from the k-distance elbow; the nutrient hotspot was found in 9 of 9 cycles and
  triaged nutrient every time; the disease hotspot in 7 of 10 (the first 3 have fewer than 3 infected
  plants), triaged disease 6 times and uncertain once
- the sensitivity grid shows why eps matters: at 5 m neither planted hotspot is found, at 12–15 m
  both are in about 9 of 10 cycles, at the cost of more noise merging into clusters

Real data cannot support hotspots yet. Of 78 plants with a GPS fix, 1 is within 10 m (median ±71 m).
Relaxed to 100 m (`results/hotspots/real_relaxed_100m_illustration`), eps becomes 140 m, one
"hotspot" mixes blocks B02, C01, C03 and D01, the permutation test gives p = 1, and 19 of 78 plants
sit outside their own zone. GPS re-capture (E1) comes before any real hotspot claim.

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
