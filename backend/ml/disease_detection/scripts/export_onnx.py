"""Export an M1 training checkpoint (best.pt) to ONNX for the backend.

    python scripts/export_onnx.py --ckpt <run>/best.pt [--out <run>/model.onnx]

Writes the .onnx next to the checkpoint by default (weights stay out of git) and
checks that ONNX Runtime matches PyTorch on random input.
"""
import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
import timm
import torch


def load_model(ckpt_path: Path) -> tuple[torch.nn.Module, dict]:
    ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    model = timm.create_model(ck["backbone"], pretrained=False, num_classes=len(ck["classes"]))
    model.load_state_dict(ck["model"])
    return model.eval(), ck


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    out = args.out or args.ckpt.with_name("model.onnx")

    model, ck = load_model(args.ckpt)
    size = ck["img_size"]
    dummy = torch.randn(1, 3, size, size)
    torch.onnx.export(
        model, dummy, out, input_names=["input"], output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}}, opset_version=17, dynamo=False,
    )

    x = torch.randn(4, 3, size, size)
    with torch.no_grad():
        ref = model(x).numpy()
    got = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"]).run(None, {"input": x.numpy()})[0]
    softmax = lambda z: np.exp(z - z.max(1, keepdims=True)) / np.exp(z - z.max(1, keepdims=True)).sum(1, keepdims=True)
    diff = float(np.abs(softmax(ref) - softmax(got)).max())
    print(f"wrote {out} | classes={ck['classes']} | max |torch-onnx| prob diff = {diff:.2e}")
    if diff > 1e-3:  # float32 kernel differences; real-photo parity is tested in the backend
        raise SystemExit("ONNX output does not match PyTorch")


if __name__ == "__main__":
    main()
