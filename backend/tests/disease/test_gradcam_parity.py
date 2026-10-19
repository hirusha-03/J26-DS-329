"""Local real-artifact checks; CI exercises autograd separately with a tiny CNN.

Set M1_CHECKPOINT_PATH and M1_PARITY_CSV to the trusted E1 run. M1_LOCAL_DATA
defaults to the same path as existing ONNX notebook-parity tests.
"""

import csv
import os
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

torch = pytest.importorskip("torch")
pytest.importorskip("timm")

from app.services.disease import gradcam
from app.services.disease.inference import (
    get_model,
    input_crop,
    load_card,
    normalize_crop,
)

DATA = Path(os.getenv("M1_LOCAL_DATA", "ml/disease_detection/data/m1_local_2026-10-11"))


@pytest.fixture(scope="module")
def real_models():
    card = load_card()
    if not gradcam.checkpoint_path(card).is_file() or not DATA.is_dir():
        pytest.skip(
            "Set M1_CHECKPOINT_PATH and supply local field photos for real-model checks"
        )
    predictor = get_model()
    service = gradcam._load_service(card)
    csv_path = Path(os.getenv("M1_PARITY_CSV", "models/m1/local_predictions.csv"))
    if not csv_path.is_file():
        pytest.skip("Supply M1_PARITY_CSV from the trusted training run")
    with csv_path.open(newline="") as file:
        rows = [r for r in csv.DictReader(file) if (DATA / r["path"]).is_file()]
    assert rows, "No photos match the training manifest"
    return card, predictor, service, rows


def test_torch_onnx_probabilities_and_original_argmax_on_field_photos(real_models):
    card, predictor, service, rows = real_models
    worst = 0.0
    for row in rows:
        with Image.open(DATA / row["path"]) as image, input_crop(image, card) as crop:
            raw = predictor.class_probs(image)
            with torch.no_grad():
                probabilities = service.model(
                    torch.from_numpy(np.ascontiguousarray(normalize_crop(crop, card)))
                )
                probabilities = probabilities.softmax(1)[0].numpy()
            expected = np.array([raw[c] for c in card["classes"]])
            worst = max(worst, float(np.abs(probabilities - expected).max()))
            assert probabilities.argmax() == expected.argmax(), row["path"]
    assert worst <= gradcam.PARITY_TOLERANCE, (
        f"Worst difference {worst} over {len(rows)} photos"
    )
    print(
        f"Torch/ONNX parity: {len(rows)} photos; max probability difference {worst:.3g}"
    )


def test_crop_and_cam_match_notebook_algorithm(real_models):
    from torchvision import transforms as T

    card, predictor, service, rows = real_models
    with Image.open(DATA / rows[0]["path"]) as image:
        crop = input_crop(image, card)
        notebook_crop = T.Compose([T.Resize(255), T.CenterCrop(224)])(
            image.convert("RGB")
        )
        np.testing.assert_array_equal(np.asarray(crop), np.asarray(notebook_crop))
        array = normalize_crop(crop, card)
        source = predictor.class_probs(image)
        target = card["classes"].index(max(source, key=source.get))
        _, actual, _, _ = gradcam.compute_gradcam(
            service.model, service.layer, array, target
        )
        # Original notebook tensor gradient hook + backward, using trainable weights.
        service.model.requires_grad_(True)
        captured = {}

        def capture(_module, _inputs, output):
            captured["activation"] = output
            output.register_hook(lambda gradient: captured.update(gradient=gradient))

        handle = service.layer.register_forward_hook(capture)
        try:
            logits = service.model(torch.from_numpy(np.ascontiguousarray(array)))
            logits[0, target].backward()
            weights = captured["gradient"].mean((2, 3), keepdim=True)
            cam = (
                (captured["activation"].detach() * weights).sum(1, keepdim=True).relu()
            )
            cam = torch.nn.functional.interpolate(
                cam, (224, 224), mode="bilinear", align_corners=False
            )
            cam = cam[0, 0].detach().numpy()
            span = cam.max() - cam.min()
            expected = (cam - cam.min()) / span if span > 1e-12 else np.zeros_like(cam)
            np.testing.assert_allclose(actual, expected, atol=1e-5, rtol=1e-5)
        finally:
            handle.remove()
            service.model.zero_grad(set_to_none=True)
            service.model.requires_grad_(False)


def test_real_explanations_preserve_predictions_across_source_classes(real_models):
    card, predictor, service, rows = real_models
    selected = {}
    for row in rows:
        # Saved CSV groups cover healthy, black spot, red spot, stem rot and low confidence.
        selected.setdefault(row["pred"], row)
        if float(row["confidence"]) < 0.95:
            selected.setdefault("refer", row)
    assert set(card["classes"]).issubset(selected)
    for row in selected.values():
        with Image.open(DATA / row["path"]) as image:
            response = service.explain(image, predictor)
            assert response["prediction"] == predictor.predict(image)
            assert response["explanation"]["input_size"] == (224, 224)
            assert response["explanation"]["feature_map_size"] == (7, 7)
            assert response["explanation"]["target_source_class"] == row["pred"]
            assert not service.layer._forward_hooks


def test_real_http_round_trip(real_models, monkeypatch):
    import base64
    import io

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers.disease import router

    card, _, _, rows = real_models
    monkeypatch.setenv("M1_EXPLAIN_ENABLED", "true")
    app = FastAPI()
    app.include_router(router)
    data = (DATA / rows[0]["path"]).read_bytes()
    with TestClient(app) as client:
        prediction = client.post(
            "/api/disease/predict", files={"file": ("leaf.jpg", data, "image/jpeg")}
        )
        assert prediction.status_code == 200
        explanation = client.post(
            "/api/disease/explain",
            files={"file": ("leaf.jpg", data, "image/jpeg")},
            data={"expected_model_version": card["model_version"]},
        )
        assert explanation.status_code == 200, explanation.text
        body = explanation.json()
        assert body["prediction"] == prediction.json()
        assert (
            client.get("/api/disease/status").json()["explanation"]["state"] == "ready"
        )
        encoded_crop = body["explanation"]["input_crop"].split(",", 1)[1]
        with (
            Image.open(io.BytesIO(base64.b64decode(encoded_crop))) as returned,
            Image.open(io.BytesIO(data)) as original,
            input_crop(original, card) as expected,
        ):
            np.testing.assert_array_equal(np.asarray(returned), np.asarray(expected))
