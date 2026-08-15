"""Model loading for vanilla disease detection (transfer learning + Grad-CAM)."""
import os
from typing import Optional

CLASS_LABELS = ["healthy", "anthracnose", "fusarium_wilt", "basal_stem_rot"]

MODEL_PATH = os.path.join(os.path.dirname(__file__), "model", "disease_model.keras")

_model = None


def is_model_available() -> bool:
    return os.path.exists(MODEL_PATH)


def get_model():
    """Lazily loads the trained Keras model. Raises if not yet trained/exported."""
    global _model
    if _model is not None:
        return _model

    if not is_model_available():
        raise FileNotFoundError(
            f"No trained model found at {MODEL_PATH}. Run train.py first."
        )

    import tensorflow as tf  # imported lazily so the API can boot without TF installed

    _model = tf.keras.models.load_model(MODEL_PATH)
    return _model
