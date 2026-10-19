"""M1 disease detection inference (ONNX Runtime, no torch).

The model file is not in git. `python scripts/fetch_model.py` downloads it from the GitHub
Release named in model_card.json into backend/models/m1/; M1_MODEL_PATH overrides the location. Preprocessing mirrors the training
notebook's validation transform: Resize(255) -> CenterCrop(224) -> ImageNet normalise.
"""
import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

import app.core.config  # noqa: F401  loads .env

CARD_PATH = Path(__file__).with_name("model_card.json")
DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[3] / "models" / "m1"


def load_card() -> dict:
    card = json.loads(CARD_PATH.read_text(encoding="utf-8"))
    if os.getenv("M1_REFER_BELOW"):
        card["refer_below"] = float(os.environ["M1_REFER_BELOW"])
    return card


def model_path() -> Path:
    return Path(os.getenv("M1_MODEL_PATH") or DEFAULT_MODEL_DIR / load_card()["artifact"]["file"])


def input_crop(img: Image.Image, card: dict) -> Image.Image:
    """Exact RGB crop seen by both ONNX and Grad-CAM (no EXIF rotation)."""
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
    return img.crop((left, top, left + size, top + size))


def normalize_crop(img: Image.Image, card: dict) -> np.ndarray:
    """Already-cropped RGB input -> (1, 3, H, W) float32."""
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - np.array(card["mean"], dtype=np.float32)) / np.array(card["std"], dtype=np.float32)
    return x.transpose(2, 0, 1)[None]


def preprocess(img: Image.Image, card: dict) -> np.ndarray:
    return normalize_crop(input_crop(img, card), card)


def softmax(z: np.ndarray) -> np.ndarray:
    e = np.exp(z - z.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


class DiseaseModel:
    def __init__(self, session, card: dict, artifact_sha256: str | None = None):
        self.session = session
        self.card = card
        self.input_name = session.get_inputs()[0].name
        self.artifact_sha256 = artifact_sha256

    def class_probs(self, img: Image.Image) -> dict[str, float]:
        """Raw per-class probabilities over the training classes."""
        logits = self.session.run(None, {self.input_name: preprocess(img, self.card)})[0][0]
        return dict(zip(self.card["classes"], softmax(logits).tolist()))

    def predict(self, img: Image.Image) -> dict:
        return self.result(self.class_probs(img))

    def result(self, raw: dict[str, float]) -> dict:
        """Format an existing ONNX probability vector without another inference."""
        card = self.card
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
    path = model_path()
    if not path.is_file():
        return ModelUnavailable(
            f"Model file not found at {path}. Run `python scripts/fetch_model.py` in backend/ "
            "or set M1_MODEL_PATH."
        )
    try:
        import onnxruntime as ort

        model_bytes = path.read_bytes()
        session = ort.InferenceSession(model_bytes, providers=["CPUExecutionProvider"])
    except Exception as e:  # noqa: BLE001  bad file or missing runtime -> report, do not crash
        return ModelUnavailable(f"Model failed to load: {e}")
    digest = hashlib.sha256(model_bytes).hexdigest()
    return DiseaseModel(session, load_card(), digest)


def get_model() -> DiseaseModel:
    """Loaded once per process; raises ModelUnavailable with the reason."""
    m = _load()
    if isinstance(m, ModelUnavailable):
        raise m
    return m
