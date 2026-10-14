# M1: Disease detection

Detects vanilla leaf and stem disease from field photos (healthy, black spot, red spot, stem rot).

## Layout
- `configs/labels.yaml`: label mapping (source, local, evaluation, action)
- `src/m1/`: label and split code
- `splits/`: generated split files (committed)
- `docs/`: collection log and metadata schema
- `data/`, `runs/`: local only, gitignored (data is on Google Drive)

## Data
- **Source**: Kaggle `kaggle_small/vanilla dataset/{Healthy,black spots,red spots,rotten stem}`
- **Local**: field round 1 (`m1_local_2026-10-11`), see `docs/COLLECTION_LOG.md`. Ground truth comes only from `supervisor_label`.

## Setup
```
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
```

## Splits
```
.venv/Scripts/python -m src.m1.splits --metadata data/m1_local_2026-10-11/metadata.csv
```
Writes `splits/local_vine_folds.csv`. Folds are grouped by vine, so no vine appears in more than one fold, and the script fails if one does.
