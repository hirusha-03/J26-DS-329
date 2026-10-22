"""Real CPU autograd tests: executed in the optional-dependency CI job."""

import copy
import hashlib
import io

import numpy as np
import pytest
from PIL import Image

torch = pytest.importorskip("torch")

from app.services.disease import gradcam
from app.services.disease.inference import DiseaseModel, load_card
from tests.disease.test_inference import FakeSession


class TinyCNN(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.conv_head = torch.nn.Conv2d(3, 2, 1, bias=False)
        with torch.no_grad():
            self.conv_head.weight.zero_()
            self.conv_head.weight[0, 0, 0, 0] = 1
            self.conv_head.weight[1, 1, 0, 0] = 1

    def forward(self, x):
        return self.conv_head(x).mean((2, 3))


@pytest.fixture
def model():
    torch.set_num_threads(2)
    return TinyCNN().eval()


def test_targets_follow_different_spatial_features_without_parameter_grads(model):
    array = np.zeros((1, 3, 8, 8), dtype=np.float32)
    array[0, 0, :4] = 2
    array[0, 1, 4:] = 1
    probs, red, shape, empty = gradcam.compute_gradcam(model, model.conv_head, array, 0)
    _, green, _, _ = gradcam.compute_gradcam(model, model.conv_head, array, 1)
    assert probs.argmax() == 0 and shape == (8, 8) and not empty
    np.testing.assert_array_equal(red[:4], 1)
    np.testing.assert_array_equal(red[4:], 0)
    np.testing.assert_array_equal(green[:4], 0)
    np.testing.assert_array_equal(green[4:], 1)
    assert all(p.grad is None for p in model.parameters())
    assert not model.conv_head._forward_hooks
    # Input gradients also allow fully frozen weights (production loader).
    model.requires_grad_(False)
    _, repeated, _, _ = gradcam.compute_gradcam(model, model.conv_head, array, 0)
    np.testing.assert_array_equal(red, repeated)


def test_positive_only_and_constant_attribution(model):
    array = np.zeros((1, 3, 8, 8), dtype=np.float32)
    array[0, 0] = -1
    _, cam, _, empty = gradcam.compute_gradcam(model, model.conv_head, array, 0)
    assert empty and not cam.any()
    crop = Image.new("RGB", (8, 8), (12, 24, 36))
    rendered = gradcam.render(crop, cam, empty)
    assert rendered["overlay"] == rendered["input_crop"]


def test_failure_removes_hook_and_next_request_works(model):
    array = np.ones((1, 3, 8, 8), dtype=np.float32)
    with pytest.raises(IndexError):
        gradcam.compute_gradcam(model, model.conv_head, array, 99)
    assert not model.conv_head._forward_hooks
    gradcam.compute_gradcam(model, model.conv_head, array, 0)
    assert all(p.grad is None for p in model.parameters())


def test_nonfinite_input_rejected_and_cleaned(model):
    array = np.full((1, 3, 8, 8), np.nan, dtype=np.float32)
    with pytest.raises(gradcam.ExplanationUnavailable, match="invalid scores"):
        gradcam.compute_gradcam(model, model.conv_head, array, 0)
    assert not model.conv_head._forward_hooks


def test_no_grad_outer_context_is_overridden(model):
    array = np.random.default_rng(4).random((1, 3, 8, 8), dtype=np.float32)
    with torch.no_grad():
        _, cam, _, _ = gradcam.compute_gradcam(model, model.conv_head, array, 0)
    assert np.isfinite(cam).all() and cam.max() == 1


def test_request_probability_mismatch_is_not_explained(model):
    card = load_card()
    # Four-class prediction from an intentionally unrelated ONNX model.
    predictor = DiseaseModel(
        FakeSession([10, 0, 0, 0]), card, card["explanation"]["prediction_sha256"]
    )
    service = gradcam.GradCamModel(model, card, "a" * 64)
    with pytest.raises(gradcam.ExplanationUnavailable, match="do not agree"):
        service.explain(Image.new("RGB", (224, 224)), predictor)


def test_artifact_mismatch_rejected_before_computation(model):
    card = load_card()
    predictor = DiseaseModel(FakeSession([10, 0, 0, 0]), card, "wrong hash")
    service = gradcam.GradCamModel(model, card, "a" * 64)
    with pytest.raises(gradcam.ExplanationUnavailable, match="artifacts do not match"):
        service.explain(Image.new("RGB", (224, 224)), predictor)


def test_checksum_verified_before_deserialization(tmp_path, monkeypatch):
    pytest.importorskip("timm")
    bad = tmp_path / "best.pt"
    bad.write_bytes(b"not a checkpoint")
    monkeypatch.setenv("M1_CHECKPOINT_PATH", str(bad))

    def fail(*_, **__):
        pytest.fail("Unverified bytes must never be deserialized")

    monkeypatch.setattr(torch, "load", fail)
    with pytest.raises(gradcam.ExplanationUnavailable, match="checksum"):
        gradcam._load_service(load_card())


def test_metadata_and_state_dict_are_checked(tmp_path, monkeypatch):
    pytest.importorskip("timm")
    card = copy.deepcopy(load_card())
    checkpoint = {
        "backbone": "efficientnet_b0",
        "classes": list(reversed(card["classes"])),
        "img_size": 224,
        "model": {},
    }
    buffer = io.BytesIO()
    torch.save(checkpoint, buffer)
    data = buffer.getvalue()
    file = tmp_path / "best.pt"
    file.write_bytes(data)
    card["explanation"]["artifact"]["sha256"] = hashlib.sha256(data).hexdigest()
    monkeypatch.setenv("M1_CHECKPOINT_PATH", str(file))
    with pytest.raises(gradcam.ExplanationUnavailable, match="metadata"):
        gradcam._load_service(card)


def test_lazy_loader_reuses_model_and_retries_after_failure(
    tmp_path, monkeypatch, model
):
    checkpoint = tmp_path / "best.pt"
    checkpoint.write_bytes(b"test")
    monkeypatch.setenv("M1_EXPLAIN_ENABLED", "true")
    monkeypatch.setenv("M1_CHECKPOINT_PATH", str(checkpoint))
    monkeypatch.setattr(gradcam, "_service", None)
    monkeypatch.setattr(gradcam, "_cached_key", None)
    monkeypatch.setattr(gradcam, "_last_error", None)
    card = load_card()
    service = gradcam.GradCamModel(model, card, "a" * 64)
    calls = []

    def load(_):
        calls.append(1)
        if len(calls) == 1:
            raise gradcam.ExplanationUnavailable("Try a valid checkpoint.")
        return service

    monkeypatch.setattr(gradcam, "_load_service", load)
    with pytest.raises(gradcam.ExplanationUnavailable):
        gradcam.get_explainer(card)
    assert gradcam.capability()["state"] == "error"
    assert gradcam.get_explainer(card) is service
    assert gradcam.get_explainer(card) is service
    assert len(calls) == 2
