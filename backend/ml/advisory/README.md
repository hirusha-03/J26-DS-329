# Advisory

Evidence-sufficiency prediction and RAG pipeline for Sinhala vanilla queries.

## Folder layout

- `data/raw/` — source English PDF guide (the only indexed document)
- `data/queries/` — query lists and the labeling sheet
- `data/labels/` — manually assigned sufficiency labels
- `index/` — FAISS index, chunks.json, config.json (frozen retrieval settings)
- `src/` — pipeline scripts
- `notebooks/` — exploratory notebooks
- `outputs/` — generated CSVs, plots, and result tables

## src files

- `config.py` — all settings in one place (paths, embedding model name, max_seq_length, chunk size, overlap, top_k)
- `build_index.py` — build the FAISS index from the raw PDF
- `retrieve.py` — return Top-3 chunks with scores for a query
- `test_retrieval.py` — run test queries and save results for manual checking
- `fill_labeling_sheet.py` — write Top-3 passages into the labeling sheet, scores kept separate
- `features.py` — compute sufficiency features from retrieval scores and passages
- `train_eval.py` — train and evaluate threshold / Logistic Regression / XGBoost models
- `error_analysis.py` — feature importance plot and misclassified examples
- `rag.py` — query to Top-3 passages to LLM answer
- `pipeline.py` — final system routing Sinhala queries through the sufficiency predictor, English queries straight to `rag.py`

## Setup (Windows)

```
cd backend\ml\advisory
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```
