
# Vanilla Advisory System

A multilingual agricultural advisory module integrating **cross-lingual retrieval, evidence-sufficiency prediction, and Retrieval-Augmented Generation (RAG)** to support Sinhala-language vanilla cultivation queries using an English knowledge base.

The module uses **BGE-M3 embeddings and FAISS** for semantic retrieval, followed by a machine learning classifier to determine whether the retrieved evidence is sufficient for answer generation.

## Project Structure

```text
advisory/
├── data/
│   ├── raw/                    # Source knowledge base documents
│   ├── queries/                # Sinhala queries and labeling sheets
│   └── labels/                 # Annotated sufficiency labels
├── index/                      # FAISS index and retrieval metadata
├── src/
│   ├── config.py               # Centralized configuration
│   ├── build_index.py          # Document processing and vector indexing
│   ├── retrieve.py             # Cross-lingual passage retrieval
│   ├── test_retrieval.py       # Retrieval testing and verification
│   ├── prepare_labeling_data.py # Annotation dataset preparation
│   ├── features.py             # Sufficiency feature extraction
│   ├── train_eval.py           # Classifier training and evaluation
│   ├── error_analysis.py       # Error analysis and feature importance
│   ├── rag.py                  # RAG-based answer generation
│   └── pipeline.py             # End-to-end advisory pipeline
├── notebooks/                  # Exploratory experiments
├── outputs/                    # Experimental results and visualizations
├── requirements.txt            # Python dependencies
└── README.md                   # Project documentation
```

## Core Components

- **Knowledge Base Indexing** — Document preprocessing, chunking, and FAISS vector indexing.
- **Cross-Lingual Retrieval** — Retrieval of Top-3 English passages for Sinhala queries using BGE-M3.
- **Evidence Sufficiency Prediction** — Binary classification of retrieved evidence as `SUFFICIENT` or `INSUFFICIENT`.
- **Model Evaluation** — Comparison of threshold-based, Logistic Regression, and XGBoost classifiers using stratified 5-fold cross-validation.
- **RAG Integration** — Evidence-aware routing to support grounded advisory responses.

## Setup

Research/training venv (build_index.py, train_eval.py, error_analysis.py):

```bash
cd backend\ml\advisory
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Live demo API venv (rag.py, api.py — FlagEmbedding, openai, fastapi, uvicorn):

```bash
cd backend\ml\advisory
python -m venv .venv-features
.venv-features\Scripts\activate
pip install -r requirements-features.txt
```

### One-time data setup (not in git)

`index/`, `outputs/cache/`, and `data/raw/` are gitignored — the FAISS index and
retrieval cache are derived artifacts, not source. On a fresh clone:

1. Place the knowledge-base PDF in `data/raw/` (ask the advisory module owner
   for the current source document).
2. Build the index and cache:
   ```bash
   .venv\Scripts\python.exe src\build_index.py
   .venv\Scripts\python.exe src\features.py
   ```
   (`outputs/models/sufficiency_lr_m3q.joblib`, `model_card.json`, and
   `feature_blocks.json` are already committed — no need to retrain unless the
   classifier itself changes.)
3. Make sure the BGE-M3 model (`BAAI/bge-m3`) is cached locally. `rag.py` sets
   `HF_HUB_OFFLINE=1`, so it will not download the model at runtime — on a new
   machine, run once with that variable unset (or pre-populate the Hugging
   Face cache) so the weights are fetched before the first live run.
4. Add `OPENROUTER_API_KEY` and `ADVISORY_LLM_MODEL` to `backend/.env` (see
   `backend/.env.example`).

### Running the live demo API

```bash
cd backend\ml\advisory
.venv-features\Scripts\python.exe -m uvicorn src.api:app --host 127.0.0.1 --port 8001
```

Never pass `--reload` — it would load BGE-M3 a second time. See
`src/api.py` for the alternative invocation from `backend/` (so it can run
alongside `uvicorn app.main:app --reload --port 8000`, which uses the
separate `backend/.venv`).
