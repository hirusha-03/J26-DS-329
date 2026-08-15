"""Module 1 (Holipitiya) — Explainable AI disease detection.

Deliberately returns 503/501 instead of fabricated predictions when the
model or inference pipeline isn't ready yet — see ai_context qa.md #1.
"""
from fastapi import APIRouter, HTTPException, UploadFile, File, status

from .model import is_model_available, CLASS_LABELS

router = APIRouter(prefix="/api/disease", tags=["disease-detection"])


@router.get("/status")
def status_check():
    return {
        "module": "disease_detection",
        "owner": "Holipitiya",
        "model_available": is_model_available(),
        "classes": CLASS_LABELS,
    }


@router.post("/predict")
async def predict(image: UploadFile = File(...)):
    if not is_model_available():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Disease detection model not trained/exported yet.",
        )

    # Inference + Grad-CAM/Score-CAM pipeline not implemented yet.
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Prediction pipeline not implemented yet.",
    )
