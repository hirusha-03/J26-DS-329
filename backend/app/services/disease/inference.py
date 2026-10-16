"""M1 disease detection inference (ONNX Runtime, no torch).

The model file lives outside git; M1_MODEL_PATH points at it (exported with
ml/disease_detection/scripts/export_onnx.py). Preprocessing mirrors the training
notebook's validation transform: Resize(255) -> CenterCrop(224) -> ImageNet normalise.
"""
import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

import app.core.config  # noqa: F401  loads .env

CARD_PATH = Path(__file__).with_name("model_card.json")


def load_card() -> dict:
    card = json.loads(CARD_PATH.read_text(encoding="utf-8"))
    if os.getenv("M1_REFER_BELOW"):
        card["refer_below"] = float(os.environ["M1_REFER_BELOW"])
    return card


def preprocess(img: Image.Image, card: dict) -> np.ndarray:
    """PIL image -> (1, 3, H, W) float32, matching torchvision Resize/CenterCrop/Normalize."""
    img = img.convert("RGB")
    w, h = img.size
    short, long = (w, h) if w <= h else (h, w)
    new_short = card["resize"]
    new_long = int(new_short * long / short)
    new_w, new_h = (new_short, new_long) if w <= h else (new_long, new_short)
    img = img.resize((new_w, new_h), Image.BILINEAR)

    size = card["img_size"]
    top = round((new_h - size) / 2.0)
    left = round((new_w - size) / 2.0)
    img = img.crop((left, top, left + size, top + size))

    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - np.array(card["mean"], dtype=np.float32)) / np.array(card["std"], dtype=np.float32)
    return x.transpose(2, 0, 1)[None]


def softmax(z: np.ndarray) -> np.ndarray:
    e = np.exp(z - z.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


class DiseaseModel:
    def __init__(self, session, card: dict):
        self.session = session
        self.card = card
        self.input_name = session.get_inputs()[0].name

    def class_probs(self, img: Image.Image) -> dict[str, float]:
        """Raw per-class probabilities over the training classes."""
        logits = self.session.run(None, {self.input_name: preprocess(img, self.card)})[0][0]
        return dict(zip(self.card["classes"], softmax(logits).tolist()))

    def predict(self, img: Image.Image) -> dict:
        card = self.card
        raw = self.class_probs(img)
        # Same rule as the notebook's evaluation: argmax over training classes, then collapse.
        # Confidence is that class's probability, so refer_below means what conf_threshold meant there.
        top_raw = max(raw, key=raw.get)
        top = card["collapse"].get(top_raw, top_raw)
        confidence = raw[top_raw]
        probs = {c: 0.0 for c in card["output_classes"]}
        for c, p in raw.items():
            probs[card["collapse"].get(c, c)] += p
        decision = "accept" if confidence >= card["refer_below"] else "refer"
        return {
            "model_version": card["model_version"],
            "prediction": top,
            "decision": decision,
            "confidence": confidence,
            "probabilities": probs,
            "action": card["action"]["refer" if decision == "refer" else top],
            "warning": card["warning"],
            "experimental": None,
        }


class ModelUnavailable(Exception):
    pass


@lru_cache(maxsize=1)
def _load() -> DiseaseModel | ModelUnavailable:
    path = os.getenv("M1_MODEL_PATH")
    if not path:
        return ModelUnavailable("M1_MODEL_PATH is not set.")
    if not Path(path).is_file():
        return ModelUnavailable(f"Model file not found at M1_MODEL_PATH ({path}).")
    try:
        import onnxruntime as ort

        session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    except Exception as e:  # noqa: BLE001  bad file or missing runtime -> report, do not crash
        return ModelUnavailable(f"Model failed to load: {e}")
    return DiseaseModel(session, load_card())


def get_model() -> DiseaseModel:
    """Loaded once per process; raises ModelUnavailable with the reason."""
    m = _load()
    if isinstance(m, ModelUnavailable):
        raise m
    return m
