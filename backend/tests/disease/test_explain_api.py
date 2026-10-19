"""Explanation contract/availability/admission tests; no torch required."""

import base64
import io
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app.routers import disease
from app.services.disease import gradcam, uploads
from app.services.disease.inference import DiseaseModel, load_card
from tests.disease.test_inference import FakeSession, jpeg_bytes, probs_logits


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("M1_EXPLAIN_ENABLED", "true")
    card = load_card()
    model = DiseaseModel(FakeSession(probs_logits(0.01, 0.01, 0.97, 0.01)), card)
    monkeypatch.setattr(disease, "get_model", lambda: model)
    app = FastAPI()
    app.include_router(disease.router)
    with TestClient(app) as client:
        yield client


def post(client, data=None, **fields):
    return client.post(
        "/api/disease/explain",
        data=fields,
        files={"file": ("photo.jpg", data or jpeg_bytes(), "image/jpeg")},
    )


def test_success_contract_and_expected_version(client, monkeypatch):
    def explain(img, model, expected):
        assert expected == model.card["model_version"]
        assert img.size == (320, 240)
        return {
            "prediction": model.predict(img),
            "explanation": {
                "target_source_class": "red_spot",
                "target_display_class": "leaf_spot",
                "target_layer": "conv_head",
                "status": "ok",
                "input_size": [224, 224],
                "feature_map_size": [7, 7],
                "checkpoint_sha256": "a" * 64,
                "elapsed_ms": 1.5,
                "note": gradcam.NOTE,
                **gradcam.render(
                    Image.new("RGB", (224, 224)), np.zeros((224, 224)), True
                ),
            },
        }

    monkeypatch.setattr(gradcam, "explain", explain)
    response = post(client, expected_model_version=load_card()["model_version"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["prediction"]["prediction"] == "leaf_spot"
    assert body["explanation"]["method"] == "gradcam"
    for field in ("input_crop", "heatmap", "overlay"):
        uri = body["explanation"][field]
        with Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1]))) as png:
            assert png.size == (224, 224) and png.format == "PNG"


def test_disabled_and_predict_still_available(client, monkeypatch):
    monkeypatch.setenv("M1_EXPLAIN_ENABLED", "false")
    assert post(client).status_code == 503
    status = client.get("/api/disease/status").json()
    assert status["model_loaded"] is True
    assert status["explanation"]["state"] == "disabled"
    assert (
        client.post(
            "/api/disease/predict",
            files={"file": ("a.jpg", jpeg_bytes(), "image/jpeg")},
        ).status_code
        == 200
    )


def test_version_mismatch_does_not_load_torch(client, monkeypatch):
    def fail(*_):
        pytest.fail("A stale version must not initialize explanation weights")

    monkeypatch.setattr(gradcam, "get_explainer", fail)
    assert post(client, expected_model_version="old-model").status_code == 409


@pytest.mark.parametrize(
    "error,code",
    [
        (gradcam.ExplanationUnavailable("Checkpoint is unavailable."), 503),
        (RuntimeError("secret/local/path"), 500),
    ],
)
def test_failure_sanitized_and_slot_released(client, monkeypatch, error, code):
    def fail(*_):
        raise error

    monkeypatch.setattr(gradcam, "explain", fail)
    response = post(client)
    assert response.status_code == code
    assert "secret" not in response.text
    assert gradcam.SLOT.acquire(blocking=False)
    gradcam.SLOT.release()


@pytest.mark.parametrize("path", ["predict", "explain"])
def test_shared_validation(client, monkeypatch, path):
    url = f"/api/disease/{path}"
    assert (
        client.post(url, files={"file": ("a.gif", b"GIF89a", "image/gif")}).status_code
        == 415
    )
    assert (
        client.post(
            url, files={"file": ("a.jpg", b"invalid", "image/jpeg")}
        ).status_code
        == 400
    )
    monkeypatch.setattr(uploads, "MAX_UPLOAD_BYTES", 20)
    assert (
        client.post(url, files={"file": ("a.jpg", b"a" * 21, "image/jpeg")}).status_code
        == 413
    )


def test_dimensions_checked_before_rgb_allocation(monkeypatch):
    monkeypatch.setattr(uploads, "MAX_IMAGE_PIXELS", 100)
    with pytest.raises(HTTPException) as error:
        uploads.decode_image(jpeg_bytes())
    assert error.value.status_code == 400
    monkeypatch.setattr(uploads, "MAX_IMAGE_PIXELS", 50_000_000)
    with pytest.raises(HTTPException):
        uploads.decode_image(jpeg_bytes((1000, 1)))


def test_bomb_warning_is_handled(monkeypatch):
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 60_000)
    with pytest.raises(HTTPException) as error:
        uploads.decode_image(jpeg_bytes())
    assert error.value.status_code == 400


def test_capability_is_lazy(client, monkeypatch, tmp_path):
    checkpoint = tmp_path / "best.pt"
    checkpoint.write_bytes(b"placeholder")
    monkeypatch.setenv("M1_CHECKPOINT_PATH", str(checkpoint))
    monkeypatch.setattr(gradcam.importlib.util, "find_spec", lambda _: object())
    monkeypatch.setattr(gradcam, "_service", None)

    def fail(*_):
        pytest.fail("Status must not load optional model")

    monkeypatch.setattr(gradcam, "_load_service", fail)
    assert (
        client.get("/api/disease/status").json()["explanation"]["state"] == "not_loaded"
    )
    monkeypatch.setattr(gradcam.importlib.util, "find_spec", lambda _: None)
    assert gradcam.capability()["state"] == "unavailable"


def test_busy_worker_rejects_before_decoding_and_recovers(client, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def slow(*_):
        entered.set()
        assert release.wait(10)
        raise gradcam.ExplanationUnavailable("Test complete.")

    monkeypatch.setattr(gradcam, "explain", slow)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(disease._explain, jpeg_bytes(), None)
        try:
            assert entered.wait(10)
            # Invalid bytes would yield 400 if a second request were decoded.
            response = post(client, b"invalid")
            assert (
                response.status_code == 503 and response.headers["retry-after"] == "2"
            )
            assert (
                client.post(
                    "/api/disease/predict",
                    files={"file": ("a.jpg", jpeg_bytes(), "image/jpeg")},
                ).status_code
                == 200
            )
        finally:
            release.set()
        with pytest.raises(HTTPException):
            future.result(timeout=10)
    assert not gradcam.SLOT.locked()


def test_module_import_does_not_import_torch():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; from app.services.disease import gradcam; "
                "assert 'torch' not in sys.modules; assert 'timm' not in sys.modules"
            ),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_actual_app_exposes_busy_retry_header_to_browser():
    from app.main import app

    with TestClient(app) as client, gradcam.SLOT:
        response = client.post(
            "/api/disease/explain",
            headers={"Origin": "http://localhost:3000"},
            files={"file": ("photo.jpg", jpeg_bytes(), "image/jpeg")},
        )
    assert response.status_code == 503
    assert response.headers["retry-after"] == "2"
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "retry-after" in response.headers["access-control-expose-headers"].lower()
