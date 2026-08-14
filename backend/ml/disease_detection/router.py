"""Module 1 — Explainable AI vanilla disease detection (owner: Holipitiya).

/predict classifies a plant image as healthy or one of the target diseases
and returns a Grad-CAM/Score-CAM explanation overlay once a model is
trained. Until then it returns 503 rather than a fabricated prediction —
see ai_context/vanilla-monitor/qa.md #1 for why silently faking ML output
is the thing to avoid here.
"""
from fastapi import APIRouter, File, HTTPException, UploadFile

from .model import CLASS_LABELS, get_model, is_model_available

router = APIRouter(prefix="/api/disease", tags=["disease-detection"])


@router.get("/status")
def status():
    return {"model_available": is_model_available(), "classes": CLASS_LABELS}


@router.post("/predict")
async def predict(image: UploadFile = File(...)):
    model = get_model()
    if model is None:
        raise HTTPException(
            status_code=503,
            detail="Disease detection model not trained yet — run ml/disease_detection/train.py first.",
        )

    # TODO: preprocess `image`, run inference, generate Grad-CAM/Score-CAM
    # overlay, return {"class": ..., "confidence": ..., "explanation_image": ...}
    raise HTTPException(status_code=501, detail="Inference pipeline not yet implemented.")
