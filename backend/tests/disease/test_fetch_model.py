"""Artifact fetching must retain default behavior and never invent a release URL."""

import hashlib
import io
import json

import pytest

from scripts import fetch_model


@pytest.fixture
def card(tmp_path, monkeypatch):
    path = tmp_path / "card.json"
    data = b"verified artifact"
    meta = {
        "file": "model.onnx",
        "release_tag": "demo",
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    card = {
        "artifact": meta,
        "explanation": {"artifact": {**meta, "file": "best.pt", "release_tag": None}},
    }
    path.write_text(json.dumps(card))
    monkeypatch.setattr(fetch_model, "CARD", path)
    return card, data


def test_default_download_and_verified_reuse(card, tmp_path, monkeypatch):
    _, data = card
    calls = []

    def download(url, timeout):
        calls.append(url)
        return io.BytesIO(data)

    monkeypatch.setattr(fetch_model.urllib.request, "urlopen", download)
    dest = fetch_model.fetch(tmp_path)
    assert dest.read_bytes() == data
    assert fetch_model.fetch(tmp_path) == dest
    assert len(calls) == 1 and "/demo/model.onnx" in calls[0]


def test_checkpoint_without_release_requires_local_weights(card, tmp_path, monkeypatch):
    _, data = card

    def fail(*_, **__):
        pytest.fail("No network request allowed for unpublished checkpoint")

    monkeypatch.setattr(fetch_model.urllib.request, "urlopen", fail)
    with pytest.raises(SystemExit, match="No checkpoint release"):
        fetch_model.fetch(tmp_path, checkpoint=True)
    (tmp_path / "best.pt").write_bytes(data)
    assert fetch_model.fetch(tmp_path, checkpoint=True).name == "best.pt"


def test_bad_download_never_replaces_existing_artifact(card, tmp_path, monkeypatch):
    dest = tmp_path / "model.onnx"
    dest.write_bytes(b"previous")
    monkeypatch.setattr(
        fetch_model.urllib.request, "urlopen", lambda *_, **__: io.BytesIO(b"wrong")
    )
    with pytest.raises(SystemExit, match="checksum mismatch"):
        fetch_model.fetch(tmp_path)
    assert dest.read_bytes() == b"previous"
    assert not dest.with_suffix(".onnx.part").exists()
