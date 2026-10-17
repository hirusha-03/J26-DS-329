"""Fit the final M3+Q Logistic Regression pipeline on all 400 queries and save
it with joblib, together with a model card, to outputs/models/.

Run order: train_eval.py -> train_final.py"""

import datetime
import json

import joblib
import pandas as pd

import config
from train_eval import FEATURE_BLOCKS_JSON, make_lr_pipeline, load_data, load_feature_blocks

RESULTS_DIR = config.OUTPUTS_DIR / "results"
MODELS_DIR = config.OUTPUTS_DIR / "models"
SELECTIVE_CONFIG_PATH = RESULTS_DIR / "selective_config.json"

MODEL_NAME = "M3+Q"
CLASSIFIER_NAME = "LR"


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    if not SELECTIVE_CONFIG_PATH.exists():
        raise SystemExit("run train_eval.py first")
    with open(SELECTIVE_CONFIG_PATH, "r", encoding="utf-8") as f:
        selective_config = json.load(f)

    df, _ = load_data()
    blocks = load_feature_blocks()
    cols = blocks[MODEL_NAME]

    pipe = make_lr_pipeline(cols)
    pipe.fit(df[cols], df["label"].values)

    model_path = MODELS_DIR / "sufficiency_lr_m3q.joblib"
    joblib.dump(pipe, model_path)

    results_cv = pd.read_csv(RESULTS_DIR / "results_cv.csv")
    cv_row = results_cv[
        (results_cv.model == MODEL_NAME) & (results_cv.classifier == CLASSIFIER_NAME)
    ].iloc[0].to_dict()

    results_topic = pd.read_csv(RESULTS_DIR / "results_topic_holdout.csv")
    topic_row = results_topic[
        (results_topic.model == MODEL_NAME) & (results_topic.classifier == CLASSIFIER_NAME)
    ].iloc[0].to_dict()

    model_card = {
        "model_name": MODEL_NAME,
        "classifier": CLASSIFIER_NAME,
        "pipeline": "StandardScaler (numeric) + OneHotEncoder (qword) + LogisticRegression(C=1.0, class_weight='balanced')",
        "training_date": datetime.date.today().isoformat(),
        "n_training_queries": int(len(df)),
        "feature_list": cols,
        "decision_threshold": selective_config["final_threshold"],
        "decision_threshold_note": (
            "80th percentile of 5-fold CV out-of-fold probabilities on all 400 "
            "queries (M3+Q LR), targeting 20% coverage; see "
            "outputs/results/selective_config.json"
        ),
        "target_coverage": selective_config["target_coverage"],
        "threshold_procedure": selective_config["threshold_procedure"],
        "nested_cv_selective": selective_config["nested_cv_selective"],
        "cv_results": cv_row,
        "topic_holdout_results": topic_row,
        "trained_on": "outputs/features.csv (BGE-M3 embeddings not loaded; features precomputed)",
        "purpose": "deployment/demo only; all reported metrics come from cross-validation",
    }

    model_card_path = MODELS_DIR / "model_card.json"
    with open(model_card_path, "w", encoding="utf-8") as f:
        json.dump(model_card, f, indent=2, default=str)

    print(f"Saved model: {model_path} ({model_path.stat().st_size} bytes)")
    print(f"Saved model card: {model_card_path} ({model_card_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
