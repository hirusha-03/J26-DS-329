# Vanilla Monitor - FastAPI Backend

This is the backend API server for the Vanilla Monitor PWA. It connects to Supabase as its primary datastore and provides clean API endpoints for logging plantation inspections, plant GPS coordinates, and vine mortality reports.

## Prerequisites

- **Python 3.11+** (Python 3.12 recommended for optional Grad-CAM)
- **pip** (Python package installer)

## Getting Started

1. **Navigate to the backend directory**:
   ```bash
   cd backend
   ```

2. **Create a virtual environment**:
   ```bash
   python -m venv .venv
   ```

3. **Activate the virtual environment**:
   - **Windows**:
     ```powershell
     .venv\Scripts\Activate.ps1
     ```
   - **macOS / Linux**:
     ```bash
     source .venv/bin/activate
     ```

4. **Install the dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

5. **Configure environment variables**:
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Edit `.env` and fill in your actual Supabase URL and Anon Key. If left empty, the server will start in fallback mock mode.

6. **Start the API Server**:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```

7. **Verify the server is running**:
   - Access the health check endpoint: [http://localhost:8000/health](http://localhost:8000/health)
   - View the interactive Swagger API documentation: [http://localhost:8000/docs](http://localhost:8000/docs)

## Optional disease explanations (Grad-CAM)

`POST /api/disease/predict` continues to use ONNX Runtime. Grad-CAM adds a
separate CPU PyTorch component to explain the same prediction; it is disabled
by default. Installing only `requirements.txt` is sufficient for prediction.

From `backend/`, create a separate environment to keep existing installations:

```powershell
py -3.12 -m venv .venv-explain
.venv-explain\Scripts\python.exe -m pip install -r requirements.txt -r requirements-explain.txt
```

On Linux use `python3.12 -m venv .venv-explain` and
`.venv-explain/bin/python -m pip install -r requirements.txt -r requirements-explain.txt`.
The optional requirements select CPU torch 2.11.0/torchvision 0.26.0 and timm
1.0.30, matching the research notebook. No model download from Hugging Face
occurs at runtime (`pretrained=False`).

Supply the trusted E1 `best.pt` checkpoint in `backend/models/m1/`, or set its
path in the backend environment. Model weights remain outside Git. The exact
SHA-256 must be
`fc7872b4df7dab3fe6fa889ab7fdfc798ba87dfb956610172312b5043657af8c`.
The API verifies the bytes before loading and checks backbone, input size,
class order, ONNX artifact hash and per-request probability agreement.

```dotenv
M1_EXPLAIN_ENABLED=true
# Optional override; default is models/m1/best.pt
M1_CHECKPOINT_PATH=D:/path/to/trusted/best.pt
# CPU intra-op threads, 1-32; default 4, applied when explanation model first loads
M1_EXPLAIN_THREADS=4
```

`python scripts/fetch_model.py` still downloads/verifies only ONNX.
`python scripts/fetch_model.py --checkpoint` verifies an already-present
default checkpoint. It reports that no download is available until a versioned
checkpoint release is published and its tag is recorded in `model_card.json`.
It does not invent a URL or silently modify releases.

Start using the optional environment:

```powershell
.venv-explain\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Restart the process after changing weights, model configuration or CPU thread
settings. Use one worker initially: each worker loads its own ONNX and PyTorch
models. One explanation runs per process; excess requests receive 503 with
`Retry-After: 2`. Prediction requests do not acquire the explanation lock.

### API contract

```powershell
curl.exe http://127.0.0.1:8000/api/disease/status
curl.exe -X POST http://127.0.0.1:8000/api/disease/explain -F "file=@leaf.jpg" -F "expected_model_version=e1-effb0-seed0-20261015"
```

On Linux use `curl`. `expected_model_version` is optional; it should be the
version returned by the earlier prediction. A stale version returns 409.

The response contains `prediction` (the existing full prediction object) and
`explanation`, with these fields:

| Field | Meaning |
| --- | --- |
| `method`, `target_layer` | `gradcam`, `conv_head` |
| `target_source_class`, `target_display_class` | Original four-way winner and its collapsed UI label |
| `status` | `ok` or `degenerate` for an empty/constant positive-attribution map |
| `input_size`, `feature_map_size` | `[224,224]`, `[7,7]` for this model |
| `input_crop`, `heatmap`, `overlay` | PNG data URIs; no server files are written |
| `checkpoint_sha256`, `elapsed_ms`, `note` | Artifact provenance, warm computation/rendering time, interpretation |

The image is converted to RGB, resized on the short edge to 255 and center
cropped to 224, with ImageNet normalization. The overlay is aligned to that
exact crop. Neither path applies EXIF rotation. Do not stretch the cropped
heatmap across the uncropped original. Blue-to-red colour shows relative
positive contribution; a degenerate map is neutral gray with an unchanged
input overlay. The attribution target is the winning **original logit**;
black/red spot collapse to `leaf_spot` only for display. A heatmap cannot
resolve the existing distinction between original-class confidence and summed
three-class probability bars, and does not alter accept/refer routing.

`/status` adds an `explanation` capability object (`enabled`, `loaded`, `method`,
`state`, `detail`). States distinguish disabled, unavailable, not-yet-loaded,
ready and a last explanation failure. Probing status does not load torch or
weights. `loaded=false` alone is not an error: the first explanation lazy-loads
the verified checkpoint.

Error responses: 400 invalid/unsafe image dimensions or decoding; 413 over
10 MiB; 415 unsupported MIME; 409 stale expected version; 503 busy, disabled,
missing dependencies/weights or incompatible model outputs; 500 unexpected
explanation failure. JPG/PNG/WebP inputs are accepted up to 50 megapixels and
20:1 aspect ratio. Decoding bounds apply to prediction as well. Retain the
previous prediction in the UI if explanation fails; associate responses with
the selected file and ignore stale requests. Missing explanation support does
not disable prediction. No database/storage changes are required.

These heatmaps show model contribution, **not lesion segmentation or proof of
correct diagnosis**. The E1 baseline and expert-review warnings still apply.
The dashboard does not yet call `/explain`; UI integration is a follow-up.

### Validation

From `backend/`, install `pytest httpx` in the environment being tested:

```powershell
# Base environment: API/contract tests; real autograd modules skip without torch
.venv\Scripts\python.exe -m pytest -q tests/disease
# Optional environment: real CPU autograd, loader and API tests
.venv-explain\Scripts\python.exe -m pytest -q tests/disease
# Real artifacts and field photos: make local parity checks mandatory by providing inputs
$env:M1_CHECKPOINT_PATH = 'D:/path/to/trusted/best.pt'
$env:M1_PARITY_CSV = 'D:/path/to/training-run/local_predictions.csv'
$env:M1_LOCAL_DATA = 'D:/path/to/m1_local_2026-10-11'
.venv-explain\Scripts\python.exe -m pytest -q -s tests/disease/test_gradcam_parity.py
```

CPU tests cover target-specific gradients, finite/empty maps, cleanup after
errors, concurrent admission and unchanged prediction behavior. Local parity
tests compare original-class probabilities (absolute tolerance 5e-4), argmax,
crop pixels and the notebook's gradient-hook algorithm. Project weights and
field images are not downloaded in CI; a separate CPU job requires torch and
runs actual tiny-CNN attribution tests so optional tests cannot all skip.

### Containers

Default build stays prediction-only. For explanation support:

```bash
docker build --build-arg WITH_EXPLANATIONS=true -t vanilla-api-explain backend
docker run --rm -p 8000:8000 -e M1_EXPLAIN_ENABLED=true \
  -v /absolute/path/to/best.pt:/app/models/m1/best.pt:ro vanilla-api-explain
```

Run the build from the repository root. Pass the usual backend environment
configuration if needed. Mount the matching checkpoint read-only; no checkpoint
is baked into the default image. Container builds run in CI; local verification
requires Docker.
