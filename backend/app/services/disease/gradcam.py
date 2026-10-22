"""Optional, CPU-only predicted-class Grad-CAM. Importing this module needs no torch.

The router reserves SLOT before decoding and holds it until worker completion.
All hooks, tensors and images belong to one request; no images are persisted.
Algorithm matches the G1–G5 notebook's conv_head positive-attribution Grad-CAM.
"""

import base64
import hashlib
import importlib.util
import io
import json
import logging
import os
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

from app.services.disease.inference import (
    DEFAULT_MODEL_DIR,
    DiseaseModel,
    input_crop,
    load_card,
    normalize_crop,
)

LOG = logging.getLogger(__name__)
SLOT = threading.Lock()
PARITY_TOLERANCE = 5e-4
NOTE = (
    "Highlighted regions contributed to the predicted class. Grad-CAM is coarse "
    "model attribution, not disease segmentation or proof that the prediction is correct."
)


class ExplanationUnavailable(Exception):
    """A safe, user-facing explanation availability reason."""


class VersionMismatch(Exception):
    pass


def enabled() -> bool:
    return os.getenv("M1_EXPLAIN_ENABLED", "false").lower() in {"1", "true", "yes"}


def checkpoint_path(card: dict) -> Path:
    filename = card.get("explanation", {}).get("artifact", {}).get("file", "best.pt")
    return Path(os.getenv("M1_CHECKPOINT_PATH") or DEFAULT_MODEL_DIR / filename)


def _key(card: dict) -> tuple:
    path = checkpoint_path(card)
    stat = path.stat()
    return (
        str(path.resolve()),
        stat.st_size,
        stat.st_mtime_ns,
        json.dumps(card, sort_keys=True),
    )


_cached_key = None
_service = None
_last_error = None


def capability() -> dict:
    """Cheap status probe: no torch imports, file hashing, or model initialization."""
    result = {"enabled": enabled(), "loaded": False, "method": "gradcam"}
    if not result["enabled"]:
        return {
            **result,
            "state": "disabled",
            "detail": "Explanation support is disabled.",
        }
    if any(
        importlib.util.find_spec(name) is None
        for name in ("torch", "torchvision", "timm")
    ):
        return {
            **result,
            "state": "unavailable",
            "detail": "Install requirements-explain.txt.",
        }
    try:
        card = load_card()
        if not card.get("explanation"):
            raise ValueError("missing metadata")
        key = _key(card)
    except (OSError, ValueError):
        return {
            **result,
            "state": "unavailable",
            "detail": "Configure a verified explanation checkpoint.",
        }
    if _last_error and _last_error[0] == key:
        return {**result, "state": "error", "detail": _last_error[1]}
    loaded = _service is not None and _cached_key == key
    return {
        **result,
        "loaded": loaded,
        "state": "ready" if loaded else "not_loaded",
        "detail": None,
    }


def compute_gradcam(model, layer, array: np.ndarray, target: int):
    """Return raw class probabilities, normalized positive CAM and feature H/W.

    autograd.grad avoids accumulating model parameter gradients. A forward hook
    captures the feature tensor; no module backward hook or global capture state.
    Caller serializes access to the model.
    """
    import torch
    import torch.nn.functional as F

    captured = []
    handle = layer.register_forward_hook(lambda _m, _i, output: captured.append(output))
    try:
        with torch.enable_grad():
            x = torch.from_numpy(np.ascontiguousarray(array)).requires_grad_(True)
            logits = model(x)
            if (
                logits.ndim != 2
                or logits.shape[0] != 1
                or not torch.isfinite(logits).all()
            ):
                raise ExplanationUnavailable(
                    "The explanation model returned invalid scores."
                )
            if not captured or captured[0].ndim != 4:
                raise ExplanationUnavailable(
                    "The explanation feature layer is invalid."
                )
            activation = captured[0]
            (gradient,) = torch.autograd.grad(logits[0, target], activation)
            if (
                not torch.isfinite(activation).all()
                or not torch.isfinite(gradient).all()
            ):
                raise ExplanationUnavailable(
                    "The explanation contains non-finite attribution."
                )
            weights = gradient.mean(dim=(2, 3), keepdim=True)
            cam = (
                (activation.detach() * weights.detach()).sum(dim=1, keepdim=True).relu()
            )
            shape = tuple(activation.shape[-2:])
            cam = F.interpolate(
                cam, size=array.shape[-2:], mode="bilinear", align_corners=False
            )
            cam = cam[0, 0].cpu().numpy().astype(np.float32)
            probs = logits.detach().softmax(1)[0].cpu().numpy()
        span = float(cam.max() - cam.min())
        if not np.isfinite(cam).all() or not np.isfinite(span):
            raise ExplanationUnavailable(
                "The explanation contains non-finite attribution."
            )
        degenerate = span <= 1e-12
        cam = np.zeros_like(cam) if degenerate else (cam - cam.min()) / span
        return probs, cam, shape, degenerate
    finally:
        handle.remove()
        captured.clear()


def _png_uri(image: Image.Image) -> str:
    with io.BytesIO() as buffer:
        image.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(
            "ascii"
        )


def render(crop: Image.Image, cam: np.ndarray, degenerate: bool) -> dict:
    # Fixed blue->cyan->yellow->red scale. Zero/empty attribution stays neutral.
    stops = np.array(
        [[0, 0, 128], [0, 192, 255], [255, 224, 0], [192, 0, 0]], dtype=float
    )
    colors = np.stack(
        [np.interp(cam, [0, 1 / 3, 2 / 3, 1], stops[:, i]) for i in range(3)], axis=-1
    )
    colors = np.clip(colors, 0, 255).astype(np.uint8)
    if degenerate:
        heat = Image.new("RGB", crop.size, (128, 128, 128))
        overlay = crop.copy()
    else:
        heat = Image.fromarray(colors)
        # Match notebook opacity; avoid rounding via multiple image conversions.
        overlay = Image.fromarray(
            (np.asarray(crop) * 0.58 + colors * 0.42).astype(np.uint8)
        )
    try:
        return {
            "input_crop": _png_uri(crop),
            "heatmap": _png_uri(heat),
            "overlay": _png_uri(overlay),
        }
    finally:
        heat.close()
        overlay.close()


class GradCamModel:
    def __init__(self, model, card: dict, digest: str):
        self.model = model.eval()
        self.card = card
        self.digest = digest
        self.layer = model.get_submodule(card["explanation"]["target_layer"])

    def explain(self, image: Image.Image, predictor: DiseaseModel) -> dict:
        started = time.perf_counter()
        expected = self.card["explanation"]["prediction_sha256"]
        if predictor.artifact_sha256 != expected or predictor.card != self.card:
            raise ExplanationUnavailable(
                "Prediction and explanation model artifacts do not match."
            )
        raw = predictor.class_probs(image)
        classes = self.card["classes"]
        reference = np.array([raw[c] for c in classes], dtype=np.float32)
        if not np.isfinite(reference).all():
            raise ExplanationUnavailable("The prediction model returned invalid scores.")
        target = int(reference.argmax())
        with input_crop(image, self.card) as crop:
            probabilities, cam, shape, degenerate = compute_gradcam(
                self.model, self.layer, normalize_crop(crop, self.card), target
            )
            if (
                probabilities.shape != reference.shape
                or not np.isfinite(probabilities).all()
                or int(probabilities.argmax()) != target
                or float(np.abs(probabilities - reference).max()) > PARITY_TOLERANCE
            ):
                raise ExplanationUnavailable(
                    "Prediction and explanation model outputs do not agree."
                )
            source = classes[target]
            explanation = {
                "method": "gradcam",
                "target_source_class": source,
                "target_display_class": self.card["collapse"].get(source, source),
                "target_layer": self.card["explanation"]["target_layer"],
                "status": "degenerate" if degenerate else "ok",
                "input_size": crop.size,
                "feature_map_size": shape,
                **render(crop, cam, degenerate),
                "checkpoint_sha256": self.digest,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
                "note": NOTE,
            }
        return {"prediction": predictor.result(raw), "explanation": explanation}


def _load_service(card: dict) -> GradCamModel:
    import timm
    import torch

    threads = int(os.getenv("M1_EXPLAIN_THREADS", "4"))
    if not 1 <= threads <= 32:
        raise ExplanationUnavailable("M1_EXPLAIN_THREADS must be between 1 and 32.")
    torch.set_num_threads(threads)
    meta = card["explanation"]
    if card["backbone"] != "efficientnet_b0" or meta["target_layer"] != "conv_head":
        raise ExplanationUnavailable(
            "The configured backbone or explanation layer is unsupported."
        )
    # Hash the same bytes that will be deserialized, not a separately reopened path.
    data = checkpoint_path(card).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != meta["artifact"]["sha256"]:
        raise ExplanationUnavailable(
            "The explanation checkpoint failed checksum verification."
        )
    # This exact, checksum-pinned project checkpoint is trusted; never load uploads as weights.
    ck = torch.load(io.BytesIO(data), map_location="cpu", weights_only=False)
    if (
        ck["backbone"] != card["backbone"]
        or list(ck["classes"]) != card["classes"]
        or ck["img_size"] != card["img_size"]
    ):
        raise ExplanationUnavailable(
            "The explanation checkpoint metadata does not match the model card."
        )
    model = timm.create_model(
        card["backbone"], pretrained=False, num_classes=len(card["classes"])
    )
    model.load_state_dict(ck["model"], strict=True)
    # Gradients are needed for features, not weights; input requires_grad is set per request.
    model.requires_grad_(False)
    return GradCamModel(model, card, digest)


def get_explainer(card: dict) -> GradCamModel:
    """Call only while holding SLOT, including lazy initialization."""
    global _cached_key, _service, _last_error
    if not enabled():
        raise ExplanationUnavailable("Explanation support is disabled.")
    key = None
    try:
        key = _key(card)
        if key != _cached_key or _service is None:
            _service = _load_service(card)
            _cached_key = key
            _last_error = None
        return _service
    except ExplanationUnavailable as exc:
        _last_error = (key, str(exc))
        raise
    except Exception:
        LOG.exception("Could not initialize Grad-CAM")
        message = "Explanation support is unavailable. Check optional dependencies and checkpoint configuration."
        _last_error = (key, message)
        raise ExplanationUnavailable(message) from None


def explain(
    image: Image.Image, predictor: DiseaseModel, expected_version: str | None = None
) -> dict:
    """Worker entrypoint. Router owns SLOT and closes the image on completion."""
    global _last_error
    if (
        expected_version is not None
        and expected_version != predictor.card["model_version"]
    ):
        raise VersionMismatch(
            "The model version changed. Analyse the photo again before requesting an explanation."
        )
    card = load_card()
    service = get_explainer(card)
    try:
        result = service.explain(image, predictor)
        _last_error = None
        return result
    except ExplanationUnavailable as exc:
        _last_error = (_cached_key, str(exc))
        raise
