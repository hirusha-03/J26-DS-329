# Module 2 — Digital Twin analytics

Scripts behind the GPS-referenced Digital Twin (Survey Plan No. 61 plantation). Outputs are written to
`results/` (gitignored) and, once the analyses run against the database, to the tables created by
`backend/migrations/2026-10-17_digital_twin.sql`.

| Script | Workstream | What it does |
|---|---|---|
| `health_index_pipeline.py` | Health Index + classification | Health Index (0–100), its validation, 13-model comparison with plant-grouped nested CV, locked-test evaluation. Writes PNG figures, CSV tables, confusion matrices and JSON |
| `audit_dataset.py` | Data audit | Descriptive dataset report without modifying observations (standard library only) |
| `gps_dispersion.py` | WS2 / E1 (RQ1) | Single fix vs mean / weighted mean / median / static Kalman, scored by cross-session repeatability; within-session CEP50 / CEP95 / RMS |

See [WORKFLOW.md](WORKFLOW.md) for the staged plan. The Health Index method (bands, weights,
selection rule, how to read the results) is documented in
`RP/M2_HealthIndex_Classification_Guide.md`; `health_index_pipeline.py` is the script version of
`RP/M2_HealthIndex_Classification_Colab.ipynb`.

## Health Index and classification

From the repository root:

```powershell
.\backend\.venv\Scripts\python.exe -m pip install -r backend/ml/digital_twin/requirements.txt

# Forecast task: plant state at inspection t -> HI class at t+1 (needs repeated visits)
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/health_index_pipeline.py "C:\Users\STZ\Desktop\RP\synthetic_inspections_with_gps.csv" --task forecast

# Symptom task: measurements only -> current foliage class (works with single visits)
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/health_index_pipeline.py "C:\Users\STZ\Desktop\RP\synthetic_inspections_with_gps.csv" --task symptom_now
```

A full run takes roughly 15–30 minutes on CPU (13 models × 15 folds with nested tuning, plus learning
curves). `--quick` runs a one-repeat smoke test. If a run is interrupted after cross-validation,
`--resume <run folder>` reuses its `tables/cv_fold_scores.csv`. For field data add `--data-status REAL`
and keep real and synthetic runs separate.

Each run creates `results/<experiment>_<YYYYMMDD-HHMM>/`:

| Folder / file | Contents |
|---|---|
| `EVIDENCE_SUMMARY.md` | Every table below in Markdown, with the figures embedded |
| `figures/01_hi_distribution.png` | HI histogram with class thresholds, HI by foliage, mean HI per inspection |
| `figures/02_model_comparison_boxplot.png` | Macro-F1 over the 15 CV folds per model, reference baseline line |
| `figures/03_learning_curves.png` | Macro-F1 against number of training plants |
| `figures/04_test_confusion.png` | Row-normalised confusion matrices (counts in brackets) on the locked test plants |
| `figures/05_permutation_importance.png`, `06_shap_poor.png` | What drives the prediction (SHAP needs `shap`) |
| `figures/07_hi_compensation_matrix.png` | Foliage × HI class counts, arithmetic vs geometric index |
| `figures/08_hi_robustness.png` | Weight-perturbation κ / Kendall τ, threshold-shift agreement |
| `figures/09_leaderboard_table.png`, `10_test_metrics_table.png` | Leaderboard and locked-test metrics as table images |
| `tables/leaderboard.csv`, `cv_fold_scores.csv`, `cv_macro_f1_matrix.csv` | CV results, p-values (corrected t-test, Holm, Wilcoxon) |
| `tables/test_metrics.csv`, `confusion_matrix_<model>.csv`, `per_class_report_<model>.csv` | Locked-test metrics with plant-bootstrap 95% CI |
| `tables/compensation_check.csv`, `threshold_sensitivity.csv`, `weight_sensitivity_draws.csv`, `hi_by_foliage.csv`, `hi_class_counts.csv` | Health Index validation |
| `tables/data_adequacy.csv`, `temporal_check.csv`, `learning_curves*.csv`, `permutation_importance.csv` | Remaining evidence |
| `*.json`, `provenance.json` | Same results for scripts; input SHA-256, package versions, configuration |
| `inspections_with_hi.csv`, `locked_test_plants.csv`, `locked_test_predictions.csv`, `best_model.joblib` | Data and model artifacts (load only locally generated joblib files) |

Synthetic-data scores test the pipeline only; they are not research findings.

## Dataset audit

```powershell
.\backend\.venv\Scripts\python.exe backend/ml/digital_twin/audit_dataset.py "C:\Users\STZ\Desktop\RP\synthetic_inspections_with_gps.csv" --provenance synthetic --as-of 2026-10-20 --out backend/ml/digital_twin/results/synthetic_audit
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
.\backend\.venv\Scripts\python.exe -m unittest discover -s backend/tests/twin -p "test_*.py" -v
```
