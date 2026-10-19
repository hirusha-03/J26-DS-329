import logging
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.services.disease import gradcam
from app.services.disease.inference import ModelUnavailable, get_model, load_card
from app.services.disease.schemas import ExplainResponse, ModelStatusResponse
from app.services.disease.uploads import decode_image, read_upload

LOG = logging.getLogger(__name__)
router = APIRouter(prefix="/api/disease", tags=["disease"])


@router.get("/status", response_model=ModelStatusResponse)
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
        "explanation": gradcam.capability(),
    }


def _predict(data: bytes):
    with decode_image(data) as img:
        try:
            model = get_model()
        except ModelUnavailable as e:
            raise HTTPException(503, f"The disease model isn't loaded: {e}") from None
        return model.predict(img)


@router.post("/predict")
async def predict(file: Annotated[UploadFile, File()]):
    return await run_in_threadpool(_predict, await read_upload(file))


def _explain(data: bytes, expected_version: str | None):
    # Admission, decoding, model initialization and hooks share the same worker.
    # Worker owns release even if the client disconnects/cancels its coroutine.
    if not gradcam.SLOT.acquire(blocking=False):
        raise HTTPException(
            503,
            "The explanation worker is busy. Try again shortly.",
            headers={"Retry-After": "2"},
        )
    try:
        if not gradcam.enabled():
            raise gradcam.ExplanationUnavailable("Explanation support is disabled.")
        with decode_image(data) as img:
            return gradcam.explain(img, get_model(), expected_version)
    except gradcam.VersionMismatch as exc:
        raise HTTPException(409, str(exc)) from None
    except gradcam.ExplanationUnavailable as exc:
        raise HTTPException(503, str(exc)) from None
    except ModelUnavailable:
        raise HTTPException(503, "The prediction model is unavailable.") from None
    except HTTPException:
        raise
    except Exception:
        LOG.exception("Grad-CAM request failed")
        raise HTTPException(
            500, "The explanation could not be generated. Try again."
        ) from None
    finally:
        gradcam.SLOT.release()


@router.post("/explain", response_model=ExplainResponse)
async def explain(
    file: Annotated[UploadFile, File()],
    expected_model_version: Annotated[str | None, Form(max_length=128)] = None,
):
    return await run_in_threadpool(
        _explain, await read_upload(file), expected_model_version
    )
