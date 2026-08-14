"""Training script skeleton for Module 1 (vanilla disease detection).

Per the TAF: compare transfer-learning backbones (EfficientNetV2,
MobileNetV3, ConvNeXt) on the annotated healthy / Anthracnose / Fusarium
Stem-Root Rot / Basal Stem Rot image set in ./data, then apply Grad-CAM /
Score-CAM for explainability. Fill in as the dataset is collected.
"""
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
MODEL_DIR = Path(__file__).parent / "model"

if __name__ == "__main__":
    raise SystemExit(
        "Not implemented yet — annotate images into data/<class_name>/ "
        "then build the training pipeline here."
    )
