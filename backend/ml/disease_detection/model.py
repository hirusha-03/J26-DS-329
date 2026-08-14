"""Model loading for vanilla disease classification.

Trained weights are expected at ml/disease_detection/model/best_model.keras
(produced by train.py). Loaded lazily and cached so importing this module
before training doesn't fail.
"""
from pathlib import Path
from typing import Optional

MODEL_DIR = Path(__file__).parent / "model"
MODEL_PATH = MODEL_DIR / "best_model.keras"

CLASS_LABELS = [
    "Healthy",
    "Anthracnose",
    "Fusarium Stem/Root Rot",
    "Basal Stem Rot",
]

_model = None


def is_model_available() -> bool:
    return MODEL_PATH.exists()


def get_model():
    """Returns the loaded Keras model, or None if it hasn't been trained yet."""
    global _model
    if _model is not None:
        return _model
    if not is_model_available():
        return None
    import tensorflow as tf  # deferred import — heavy, only needed once trained

    _model = tf.keras.models.load_model(MODEL_PATH)
    return _model
