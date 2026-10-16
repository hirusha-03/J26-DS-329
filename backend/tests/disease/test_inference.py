"""CI tests for M1 inference and the /api/disease router, using a fake ONNX session."""
import io

import numpy as np
import pytest
from app.routers import disease as disease_router
from app.services.disease import inference
from app.services.disease.inference import (
    DiseaseModel,
    ModelUnavailable,
    load_card,
    preprocess,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image


class FakeSession:
    """Returns fixed logits; order = card classes (healthy, black_spot, red_spot, stem_rot)."""

    def __init__(self, logits):
        self.logits = np.array([logits], dtype=np.float32)
        self.seen_shape = None

    def get_inputs(self):
        return [type("I", (), {"name": "input"})()]

    def run(self, _, feeds):
        self.seen_shape = feeds["input"].shape
        return [self.logits]


def probs_logits(*p):
    return np.log(np.array(p))


def jpeg_bytes(size=(320, 240), fmt="JPEG"):
    buf = io.BytesIO()
    Image.new("RGB", size, (60, 120, 70)).save(buf, fmt)
    return buf.getvalue()


@pytest.fixture
def card():
    return load_card()


def test_preprocess_shape_and_normalisation(card):
    x = preprocess(Image.new("RGB", (400, 300), (124, 116, 104)), card)
    assert x.shape == (1, 3, 224, 224) and x.dtype == np.float32
    # ImageNet mean colour normalises to ~0
    assert np.abs(x).max() < 0.01


def test_preprocess_resizes_short_side_then_center_crops(card):
    img = Image.new("RGB", (1000, 500), (0, 0, 0))
    img.paste((255, 255, 255), (0, 0, 250, 500))  # -> x 0..127 after resize; crop starts at 143  # white left band, cropped away by center crop
    x = preprocess(img, card)
    assert x[0, 0].max() < 0  # all black after normalisation


def test_predict_accepts_confident_and_collapses(card):
    m = DiseaseModel(FakeSession(probs_logits(0.01, 0.97, 0.01, 0.01)), card)
    r = m.predict(Image.new("RGB", (300, 300)))
    assert r["prediction"] == "leaf_spot" and r["decision"] == "accept"
    assert r["action"] == "treat_leaf_disease"
    assert set(r["probabilities"]) == {"healthy", "leaf_spot", "stem_rot"}
    assert r["probabilities"]["leaf_spot"] == pytest.approx(0.98, abs=1e-5)
    assert r["warning"] and r["experimental"] is None


def test_predict_refers_below_threshold(card):
    m = DiseaseModel(FakeSession(probs_logits(0.43, 0.17, 0.40, 0.0001)), card)
    r = m.predict(Image.new("RGB", (300, 300)))
    # notebook rule: argmax over raw classes, then collapse -> healthy (not summed leaf_spot)
    assert r["prediction"] == "healthy"
    assert r["confidence"] == pytest.approx(0.43, abs=1e-3)
    assert r["decision"] == "refer" and r["action"] == "expert_review"


def test_refer_threshold_env_override(monkeypatch):
    monkeypatch.setenv("M1_REFER_BELOW", "0.5")
    assert load_card()["refer_below"] == 0.5


@pytest.fixture
def client(monkeypatch, card):
    app = FastAPI()
    app.include_router(disease_router.router)
    model = DiseaseModel(FakeSession(probs_logits(0.02, 0.01, 0.01, 0.96)), card)
    monkeypatch.setattr(disease_router, "get_model", lambda: model)
    return TestClient(app)


def test_predict_endpoint(client):
    r = client.post("/api/disease/predict", files={"file": ("leaf.jpg", jpeg_bytes(), "image/jpeg")})
    assert r.status_code == 200
    body = r.json()
    assert body["prediction"] == "stem_rot" and body["decision"] == "accept"
    assert body["action"] == "urgent_stem_rot"


@pytest.mark.parametrize(
    "name,data,ctype,code",
    [
        ("a.gif", b"GIF89a", "image/gif", 415),
        ("a.jpg", b"not an image", "image/jpeg", 400),
        ("a.jpg", None, "image/jpeg", 413),
    ],
    ids=["wrong-type", "undecodable", "too-large"],
)
def test_predict_rejects_bad_uploads(client, name, data, ctype, code):
    data = data if data is not None else b"0" * (10 * 1024 * 1024 + 1)
    r = client.post("/api/disease/predict", files={"file": (name, data, ctype)})
    assert r.status_code == code and isinstance(r.json()["detail"], str)


def test_unavailable_model_gives_503_and_status(monkeypatch):
    def unavailable():
        raise ModelUnavailable("M1_MODEL_PATH is not set.")

    app = FastAPI()
    app.include_router(disease_router.router)
    monkeypatch.setattr(disease_router, "get_model", unavailable)
    c = TestClient(app)
    s = c.get("/api/disease/status").json()
    assert s["model_loaded"] is False and s["model_version"] is None and "M1_MODEL_PATH" in s["detail"]
    r = c.post("/api/disease/predict", files={"file": ("a.jpg", jpeg_bytes(), "image/jpeg")})
    assert r.status_code == 503


def test_load_reports_missing_path(monkeypatch):
    monkeypatch.delenv("M1_MODEL_PATH", raising=False)
    inference._load.cache_clear()
    with pytest.raises(ModelUnavailable):
        inference.get_model()
    inference._load.cache_clear()
