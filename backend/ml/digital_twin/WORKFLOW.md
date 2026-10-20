# Digital Twin ML workflow

## 1. Audit data (implemented)

Run from the repository root using the existing backend environment. No extra
packages are needed for this stage:

```powershell
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/audit_dataset.py "C:\Users\STZ\Desktop\RP\synthetic_inspections_with_gps.csv" --provenance synthetic --as-of 2026-10-20 --out backend/ml/digital_twin/results/synthetic_audit
```

Outputs are local and gitignored: `report.md`, `audit.json` and `issues.csv`.
The audit preserves the source CSV and records its SHA-256. Supply `field` only
for real field observations; `unknown` if provenance has not been established.
An audit is descriptive and never certifies a dataset as research-ready.
`--as-of` records the date boundary explicitly for reproducible future-date checks;
without it, the command uses today's UTC date.

The RP dataset contains simulated weekly observations. The research proposal
describes monthly field inspections: preserve actual observation dates and define
the aggregation cycle explicitly before publishing results to monthly API tables.
Keep real and synthetic observations in separate runs and artifacts.

Numeric ranges are provisional assumptions from the RP generator, not confirmed
agronomic limits. EC and moisture units need confirmation. No values are imputed,
clipped, deduplicated or removed by this command. GPS accuracy above 10 metres is
flagged for review; reported accuracy is not observed positional error.

## 2. Confirm target and prepare data (next)

- Obtain original inspection, inventory and slot exports with source identifiers.
- Preserve original plant generations: do not transfer predecessor measurements
  to replacement plants as genuine observations. RP's simulation rekeys anchors
  to current plants; this must not become the field-data cleaning policy.
- Agree health classes, annotation instructions, reviewer and label date with the
  domain expert. Foliage categories alone do not establish disease diagnoses.
- Record which measurements define the target. Exclude these from predictors;
  record whether the task is current-state classification or future prediction.
- Produce a data dictionary, reversible cleaning log, EDA, missingness and
  class-balance reports. Keep unresolved readings flagged/missing.

## 3. Build features and validation splits

Construct historical features from past observations only. Fit imputation and
encoding inside training folds. Group by physical slot when multiple generations
occupy the same location; assert no plant/slot overlap across grouped folds.
Evaluate block holdouts and forward-time holdouts separately, stating whether the
time holdout includes previously observed plants. Preserve split manifests and
source hashes. Never randomly split repeated inspection rows.

## 4. Health Index and model comparison (implemented)

`health_index_pipeline.py` builds the geometric Health Index, validates it
(compensation, weight and threshold robustness) and compares Majority,
Persistence and TrendRule baselines with ten ML models, XGBoost included, on
identical plant-grouped nested CV folds with a locked test set. Selection
follows the pre-registered parsimony rule. Results are PNG figures, CSV tables
and confusion matrices in `results/<experiment>_<timestamp>/`; see
[README.md](README.md). Synthetic experiments must be labelled pipeline
demonstrations.

## 5. Spatial and temporal analysis

Run Haversine DBSCAN per inspection cycle on independently defined unhealthy or
high-risk plants. Convert degrees to radians and epsilon metres to angular
distance. Report parameter sensitivity, noise and expert review; compare block
prevalence. Generate plant/block/zone trends with explicit denominators and
missing-cycle handling. Evaluate repeated GPS fixes using `gps_dispersion.py`.

## 6. Integrate and evaluate

Export versioned analytical artifacts first. Publish approved field outputs via
the existing `health_classifications`, `plant_health_hotspots`, and `health_trends`
contracts, retaining source, cycle, model version and evaluation metadata.
Evaluate top-k retrieval, offline task success/latency and field usability.
Training and dataset preparation remain outside API request handlers.

## Verification

```powershell
.\backend\.venv\Scripts\python.exe -m unittest discover -s backend/tests/twin -p test_dataset_audit.py -v
```
