import io

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from PIL import Image, UnidentifiedImageError

from app.services.disease.inference import ModelUnavailable, get_model, load_card

router = APIRouter(prefix="/api/disease", tags=["disease"])

ACCEPTED_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


@router.get("/status")
def status():
    card = load_card()
    try:
        get_model()
        loaded, detail = True, None
    except ModelUnavailable as e:
        loaded, detail = False, str(e)
    return {
        "model_loaded": loaded,
        "model_version": card["model_version"] if loaded else None,
        "classes": card["output_classes"],
        "status": card["status"],
        "detail": detail,
    }


@router.post("/predict")
async def predict(file: UploadFile = File(...)):
    if file.content_type not in ACCEPTED_TYPES:
        raise HTTPException(415, "Only JPG, PNG and WebP photos are supported.")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "The photo is larger than 10 MB.")
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError):
        raise HTTPException(400, "The image could not be decoded.")
    try:
        model = get_model()
    except ModelUnavailable as e:
        raise HTTPException(503, f"The disease model isn't loaded: {e}")
    return await run_in_threadpool(model.predict, img)
