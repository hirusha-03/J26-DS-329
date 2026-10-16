# M1: Disease detection

Detects vanilla leaf and stem disease from field photos (healthy, black spot, red spot, stem rot).

## Approach
Image classification, not RAG/LLM (that is the advisory module, M-advisory).
1. **Pretrain**: fine-tune an ImageNet backbone (e.g. EfficientNet / ConvNeXt / ViT) on Kaggle, 4 classes.
2. **Adapt**: fine-tune on local field photos once the supervisor labels arrive (vine-grouped folds).
3. **Evaluate** on local folds (Kaggle accuracy alone is not the result):
   - 3-class (healthy / leaf_spot / stem_rot; black+red spot collapse to leaf_spot): per-class recall (stem rot first), macro-F1, confusion matrix.
   - Unseen symptoms (yellowing, other): kept out of the F1, reported as what the model predicts for them.
   - Binary healthy vs needs attention: all labelled photos, unseen symptoms count as needs attention.
4. **Serve**: prediction + confidence -> `action` code (`configs/labels.yaml`) -> advisory module / API.

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
.venv/Scripts/pip install -r requirements.txt        # tests, splits
.venv/Scripts/pip install -r requirements-train.txt  # + torch, torchvision, timm for E1
```
On Colab torch is preinstalled: `pip install timm`.

## Splits
```
.venv/Scripts/python -m src.m1.splits --metadata data/m1_local_2026-10-11/metadata.csv
```
Writes `splits/local_vine_folds.csv`. Folds are grouped by vine (no vine in two folds, script fails if one is) and stratified on "vine has any symptom". Splits are frozen: the script refuses to overwrite without `--force`. Regenerate once after supervisor labels, then commit "freeze splits after supervisor labels".
