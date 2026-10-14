
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

```bash
cd backend\ml\advisory
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```
