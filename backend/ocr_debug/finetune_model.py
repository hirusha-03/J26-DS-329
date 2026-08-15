"""Fine-tunes the existing synthetic-trained digit_model.json on real
photographed digit crops (backend/ml_ocr_data/raw/ + labels.json),
instead of retraining from scratch — ~53 real crops isn't enough to
train an 11-class MLP alone, but is enough to nudge existing weights
toward the real font/lighting via warm-started continued training on an
augmented (rotated/blurred/jittered) expansion of those real crops,
mixed with a slice of the original synthetic data so digit shapes not
present in the 5 sample photos aren't forgotten.

Usage: .venv/Scripts/python.exe -m ocr_debug.finetune_model
"""
import json
import os
import random
import sys

import numpy as np
from PIL import Image, ImageFilter
from sklearn.neural_network import MLPClassifier

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from train_model import generate_dataset  # synthetic data generator, reused for the mix-in

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(BACKEND_DIR, "ml_ocr_data", "raw")
LABELS_PATH = os.path.join(BACKEND_DIR, "ml_ocr_data", "labels.json")
MODEL_PATH = os.path.join(BACKEND_DIR, "digit_model.json")


def augment_crop(arr: np.ndarray, n: int) -> list:
    """Same style of augmentation as train_model.py's synthetic generator
    (slant/rotation/blur/noise), applied to a real 28x28 grayscale [0,1]
    array instead of a procedurally drawn digit."""
    img = Image.fromarray((arr * 255).astype(np.uint8), mode="L")
    out = []
    for _ in range(n):
        rotation = random.uniform(-6, 6)
        dx = random.randint(-2, 2)
        dy = random.randint(-2, 2)
        blur_r = random.uniform(0.0, 0.8)

        variant = img.rotate(rotation, resample=Image.BILINEAR, fillcolor=255, translate=(dx, dy))
        if blur_r > 0:
            variant = variant.filter(ImageFilter.GaussianBlur(blur_r))

        v = np.array(variant, dtype=np.float32) / 255.0
        noise = np.random.normal(0, 0.05, v.shape)
        v = np.clip(v + noise, 0.0, 1.0)
        out.append(v.flatten())
    return out


def load_real_dataset(augment_per_crop=25):
    with open(LABELS_PATH) as f:
        labels = json.load(f)
    labels.pop("_comment", None)

    X, y = [], []
    for crop_id, cls in labels.items():
        path = os.path.join(RAW_DIR, f"{crop_id}.png")
        img = Image.open(path).convert("L")
        arr = np.array(img, dtype=np.float32) / 255.0
        # Include the un-augmented original too.
        X.append(arr.flatten())
        y.append(cls)
        for variant in augment_crop(arr, augment_per_crop):
            X.append(variant)
            y.append(cls)
    return np.array(X), np.array(y)


def load_existing_weights():
    with open(MODEL_PATH) as f:
        data = json.load(f)
    return data


def main():
    print("Loading real crops + labels...")
    X_real, y_real = load_real_dataset(augment_per_crop=25)
    print(f"Real (augmented) dataset: {X_real.shape}, classes present: {sorted(set(y_real.tolist()))}")

    print("Generating a small synthetic mix-in (to avoid forgetting unseen digit shapes)...")
    X_synth, y_synth = generate_dataset(samples_per_class=150)

    X = np.concatenate([X_real, X_synth], axis=0)
    y = np.concatenate([y_real, y_synth], axis=0)
    print(f"Combined training set: {X.shape}")

    print("Loading existing synthetic-trained weights for warm start...")
    existing = load_existing_weights()

    mlp = MLPClassifier(
        hidden_layer_sizes=(128, 64),
        activation="relu",
        solver="adam",
        max_iter=1,
        warm_start=True,
        random_state=42,
    )
    # Prime internal state with one throwaway iteration, then overwrite
    # with the existing model's weights before continuing training —
    # sklearn requires at least one fit() call before coefs_ can be set,
    # and warm_start requires that first call to already see every class
    # (shuffle first so a small slice isn't missing any of the 11).
    shuffle_idx = np.random.RandomState(0).permutation(len(X))
    mlp.fit(X[shuffle_idx], y[shuffle_idx])
    mlp.coefs_ = [np.array(existing["W1"]), np.array(existing["W2"]), np.array(existing["W3"])]
    mlp.intercepts_ = [np.array(existing["b1"]), np.array(existing["b2"]), np.array(existing["b3"])]

    print("Fine-tuning on the combined real+synthetic dataset...")
    mlp.set_params(max_iter=60)
    mlp.fit(X, y)

    train_acc = mlp.score(X, y)
    real_acc = mlp.score(X_real, y_real)
    print(f"Combined train accuracy: {train_acc:.4f}")
    print(f"Real-crop-only accuracy (in-sample): {real_acc:.4f}")

    model_data = {
        "W1": mlp.coefs_[0].tolist(),
        "b1": mlp.intercepts_[0].tolist(),
        "W2": mlp.coefs_[1].tolist(),
        "b2": mlp.intercepts_[1].tolist(),
        "W3": mlp.coefs_[2].tolist(),
        "b3": mlp.intercepts_[2].tolist(),
    }
    with open(MODEL_PATH, "w") as f:
        json.dump(model_data, f)
    print(f"Fine-tuned model saved to {MODEL_PATH}")


if __name__ == "__main__":
    main()
