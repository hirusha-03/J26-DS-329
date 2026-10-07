"""Standalone MLP-based digit-field OCR decoder used by the /api/ocr/decode-field endpoint.

Loads its weights from digit_model.json in this same directory (backend/app/services/).
"""
import json
import os

import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(__file__), "digit_model.json")
try:
    with open(MODEL_PATH, "r") as f:
        model_weights = json.load(f)
    W1 = np.array(model_weights["W1"])
    b1 = np.array(model_weights["b1"])
    W2 = np.array(model_weights["W2"])
    b2 = np.array(model_weights["b2"])
    W3 = np.array(model_weights["W3"])
    b3 = np.array(model_weights["b3"])
except Exception as e:
    print(f"Warning: Could not load digit_model.json: {e}")
    W1, b1, W2, b2, W3, b3 = None, None, None, None, None, None


def otsu_threshold(gray: np.ndarray) -> int:
    hist, bin_edges = np.histogram(gray, bins=256, range=(0, 256))
    total = gray.size

    current_max = 0.0
    threshold = 127

    sum_total = np.sum(np.arange(256) * hist)
    sum_back = 0.0
    weight_back = 0.0

    for t in range(256):
        weight_back += hist[t]
        if weight_back == 0:
            continue
        weight_fore = total - weight_back
        if weight_fore == 0:
            break

        sum_back += t * hist[t]
        mean_back = sum_back / weight_back
        mean_fore = (sum_total - sum_back) / weight_fore

        var_between = weight_back * weight_fore * (mean_back - mean_fore) ** 2
        if var_between > current_max:
            current_max = var_between
            threshold = t

    return threshold


def predict_digit(flat_img):
    if W1 is None:
        return 10, 0.0
    h1 = np.maximum(0, np.dot(flat_img, W1) + b1)
    h2 = np.maximum(0, np.dot(h1, W2) + b2)
    scores = np.dot(h2, W3) + b3
    exps = np.exp(scores - np.max(scores))
    probs = exps / np.sum(exps)
    cls = np.argmax(probs)
    return int(cls), float(probs[cls])
