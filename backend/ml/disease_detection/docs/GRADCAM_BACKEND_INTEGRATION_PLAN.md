# Grad-CAM backend integration plan

Status: implemented locally, 2026-10-19; validation recorded below. No commit,
push, release publication or deployment performed.

Branch: `issue/hirusha/gradcam-backend-intergration`.
Base: freshly fetched `origin/feat/disease-detection`,
`b4a1145439fe3bff5511717be57ae3ee837708d5`.
PR target: `feat/disease-detection`; subsequent integration follows the team's
feature branch -> Develop -> main workflow.

## Intended behavior

A user uploads a photo and receives the existing ONNX disease prediction.
They can then request a Grad-CAM explanation for that same photo. The backend
returns the exact model input crop, a heatmap and an overlay explaining the
winning original class. Explanation failure does not discard their prediction.

This issue implements backend support and its API contract. Dashboard controls
and visual presentation belong in a follow-up issue branch from the feature
branch after this contract is merged. No retraining, research-policy changes,
database migration, or image persistence is needed.

## Verified starting point

- Prediction: `app/services/disease/inference.py`, ONNX Runtime CPU,
  EfficientNet-B0. Upload API: `app/routers/disease.py`.
- Four source classes in order: healthy, black_spot, red_spot, stem_rot.
  Prediction selects the original argmax, then collapses black/red spot to
  leaf_spot. It does not select the argmax of summed three-class probabilities.
- Model preprocessing: RGB, short edge resized to 255, center crop 224,
  ImageNet normalization. Model card is the configuration source of truth.
- Existing executed research notebook:
  https://colab.research.google.com/drive/10QSFBgFTOe-zAHOW8pVmtGuzDLR_E6xi
  Uses `model.conv_head` and predicted four-class logits; feature shape
  [1,1280,7,7]. Its 14 examples across 8 vines produced no degenerate maps.
- Notebook checkpoint SHA-256:
  `fc7872b4df7dab3fe6fa889ab7fdfc798ba87dfb956610172312b5043657af8c`.
  Verified identical to local `best.pt` in the older-named E1 model directory.
  The different directory names do not imply different weights.
- ONNX model card artifact SHA-256:
  `f02e5d4e71b9bc9f1eeb394eb8548fa8b8700f7057c5ab9cd2b7219ced4d5f04`.
  PyTorch-to-deployed-ONNX parity still needs to be verified for integration.
- Notebook figure-saving times include Drive IO; they are not API latency
  benchmarks. Manual visual-review fields remain blank.

## Design decisions

1. Keep ONNX as the prediction engine. Add PyTorch/timm as an optional,
   CPU-only explanation component inside the same FastAPI application.
   Default installations must still import and serve predictions without torch.
2. Extract the notebook's established algorithm rather than introduce another
   attribution library. Capture the final convolution activation, obtain the
   target-logit gradient, average gradients spatially, weight/sum channels,
   apply ReLU, resize bilinearly and normalize with an empty-map guard.
   Use request-local tensors and remove hooks in `finally`.
3. Reuse a shared crop/preprocessing helper for both engines. Preserve existing
   pixel behavior and add regression checks before changing preprocessing.
   Do not introduce a different EXIF rotation rule in the explanation path.
4. The gradient target is the ONNX winning original class, verified against
   the matching PyTorch prediction. Explain healthy and referred predictions
   too, retaining their existing decision, confidence and warning.
5. A heatmap depicts positive contribution to the chosen class. It is not
   a disease mask or evidence that the classification is correct.
6. Lazy-load one verified explanation model per process. Serialize explanation
   work with a process-local lock, run CPU work in the threadpool, and keep
   gradient tracking enabled within the request. Multiple server workers each
   consume their own model memory. Bound admission with a busy response rather
   than allowing an unlimited queue of decoded images.
7. Return bounded PNG data URIs in JSON for the 224x224 crop, heatmap and
   overlay. Keep images in memory only; no server file URL or storage bucket.
   Return a zero/neutral map with explicit `degenerate` status for a constant
   positive-attribution map; never manufacture a meaningful-looking map.

## Proposed API contract

`POST /api/disease/explain`, multipart form:

- `file`: the same JPG, PNG or WebP uploaded for prediction; maximum 10 MiB.
- `expected_model_version`: optional version returned by the earlier prediction;
  reject a stale version with HTTP 409 rather than attach a different explanation.

The endpoint recomputes the ONNX result on the submitted bytes and includes it
in the response. No client-provided class or diagnosis controls the target.
The UI must associate the request/response with the selected file, just as its
prediction flow already does; it must not attach results to a newly selected photo.

```json
{
  "prediction": {
    "model_version": "e1-effb0-seed0-20261015",
    "prediction": "leaf_spot",
    "decision": "accept",
    "confidence": 0.97,
    "probabilities": {"healthy": 0.01, "leaf_spot": 0.98, "stem_rot": 0.01},
    "action": "treat_leaf_disease",
    "warning": "Baseline model trained on Indonesian data; not validated for Sri Lankan vines.",
    "experimental": null
  },
  "explanation": {
    "method": "gradcam",
    "target_source_class": "red_spot",
    "target_display_class": "leaf_spot",
    "target_layer": "conv_head",
    "status": "ok",
    "input_size": [224, 224],
    "feature_map_size": [7, 7],
    "input_crop": "data:image/png;base64,...",
    "heatmap": "data:image/png;base64,...",
    "overlay": "data:image/png;base64,..."
  }
}
```

The values above are illustrative. Define explicit Pydantic response models. Include a short
interpretation note, checkpoint fingerprint and measured explanation time in
the finalized response. `status` is `ok` or `degenerate`.

Extend `GET /api/disease/status` with an additive `explanation` object containing
`enabled`, `loaded`, `method` and an availability reason. Status checks should
not unexpectedly load torch weights. `loaded=false` with `enabled=true` can
mean the model has not been requested yet; distinguish that from a missing
dependency/artifact. Preserve all existing status and prediction fields.

Error handling:

- 400 undecodable/unsafe image, 413 oversized input, 415 unsupported MIME.
- 409 expected model version differs from the current prediction model.
- 503 optional support disabled, dependencies/checkpoint absent, checksum or
  metadata invalid, ONNX/PyTorch parity failure, or explanation worker busy.
- Unexpected computation failures return a bounded error without local paths
  or checkpoint contents. Existing prediction UI remains usable.

Share upload validation between predict/explain. Define a decoded-image pixel
limit and handle Pillow decompression-bomb cases before large allocations;
verify the selected bound against the actual field-photo sizes. Do not rely
only on compressed upload size. Run parity, hooks and rendering under the
explanation lock; unrelated ONNX prediction requests do not acquire that lock.

## Implementation sequence

### Preflight checked locally

- Working directory: `D:/Y4S1/RP/vanilla-app/J26-DS-329`.
- Issue branch is active; runtime source is unchanged. This plan is the only
  untracked file at preflight. HEAD equals the fetched feature-branch base.
- `backend/.venv`: Python 3.12, ONNX Runtime, pytest and httpx available;
  torch/timm/torchvision absent. Use it to verify the lightweight installation.
- `backend/ml/disease_detection/.venv`: Python 3.14, torch 2.14.1+cpu,
  torchvision 0.29.1+cpu, timm 1.0.30, ONNX Runtime, pytest and Ruff;
  httpx absent. Notebook provenance used torch 2.11.0+cpu/timm 1.0.30.
  Do not assume this research environment proves compatibility with the backend.
- Create a separate ignored `backend/.venv-explain` using Python 3.12 for full
  integration testing, with compatible CPU dependency versions verified at
  install time. Preserve both existing environments.
- `backend/models/m1/model.onnx` and local field-data directory exist. Trusted
  checkpoint and training predictions exist under `D:/Y4S1/RP/Models/`.
  Confirm actual image paths/counts when running the real-artifact checks.
- Docker executable was not found. Run container checks in CI or report them
  as unverified locally; do not claim a successful local Docker build.
- Existing M1 API CI installs no torch and runs `tests/disease`; extend it with
  a separate CPU explanation job so both configurations remain tested.

### File-by-file change inventory

Paths below are relative to the repository root. This inventory describes the
implemented change; the ordered units remain as review guidance. No files were
removed or renamed.

| File | Action | Individual implementation |
| --- | --- | --- |
| `backend/app/services/disease/inference.py` | Edit | Extract exact RGB resize/center-crop helper; reuse it in current NumPy preprocessing. Expose result formatting from already-computed four-class probabilities so explain does not select a different class or duplicate ONNX inference. |
| `backend/app/services/disease/gradcam.py` | Add | Optional dependency checks, enable/path settings, lazy verified checkpoint loader, request admission lock, four-class parity checks, target-logit gradients, heatmap normalization, PNG rendering and cleanup. Keep torch imports inside optional runtime functions. |
| `backend/app/services/disease/schemas.py` | Add | Pydantic prediction, explanation, capability and combined response schemas; source/display class enums, status enums, image sizes and provenance fields. Keep existing prediction serialization compatible. |
| `backend/app/services/disease/uploads.py` | Add | Shared MIME, compressed-size, decoded-pixel and Pillow decoding checks used by both endpoints. Return a detached image and translate known upload failures consistently. |
| `backend/app/routers/disease.py` | Edit | Reuse upload helper; add typed `/explain`, optional expected-version field, nonblocking admission before image decoding, threadpool work and safe errors. Add explanation capability to `/status` without loading torch weights. |
| `backend/app/services/disease/model_card.json` | Edit | Add separate explanation artifact metadata: checkpoint filename/hash, supported backbone/layer and matching prediction artifact hash. Preserve model version, class order, thresholds, prediction artifact and warnings. No nonexistent download URL. |
| `backend/requirements-explain.txt` | Add | Tested optional CPU torch/torchvision and timm versions compatible with supported backend Python; document CPU index usage. Base `requirements.txt` stays lightweight. |
| `backend/.env.example` | Edit | Document `M1_EXPLAIN_ENABLED`, `M1_CHECKPOINT_PATH` and optional CPU thread configuration if measurements justify it; no secrets or user-specific paths. |
| `backend/scripts/fetch_model.py` | Edit | Preserve default ONNX download. Add explicit checkpoint-fetch selection only when valid versioned release metadata exists; otherwise explain how to supply a local checkpoint. Verify checksum and use atomic replacement. |
| `backend/Dockerfile` | Edit | Add opt-in explanation dependency build option. Document mounting a verified local checkpoint until a release asset is published; default build remains prediction-only. |
| `backend/tests/disease/test_inference.py` | Edit | Preserve existing fake-session contract checks and add pixel-level regression for extracted crop/helper and probability-result formatting. |
| `backend/tests/disease/test_explain_api.py` | Add | Lightweight endpoint tests with a fake explanation service: request validation, nested response contract, version mismatch, busy/unavailable/failure handling and status that does not initialize torch. |
| `backend/tests/disease/test_gradcam.py` | Add | Real CPU autograd on a tiny deterministic CNN: target-specific spatial response, positive/empty maps, finite outputs, PNG alignment, hook cleanup, repeated requests and admission contention. Optional dependency tests must run in the dedicated CI job. |
| `backend/tests/disease/test_gradcam_parity.py` | Add | Local-artifact tests comparing Torch/ONNX original probabilities and argmax, crop equivalence, notebook-method equivalence and real image explanation output. Explicit skips only for unavailable local artifacts. |
| `backend/tests/disease/test_fetch_model.py` | Add | Verify ONNX download/reuse, atomic checksum failure behavior and explicit handling of unpublished optional checkpoint artifacts. |
| `backend/.gitignore` | Edit | Ignore the separate `.venv-explain/` validation environment; existing `models/` rule already excludes weights and generated validation images. |
| `.github/workflows/m1-disease-detection.yml` | Edit | Watch new requirements/fetcher/container files; retain base API job; add CPU explanation job and application-import smoke checks. Shared general CI changes are unnecessary. |
| `backend/README.md` | Edit | Optional environment setup, checkpoint configuration, startup/restart instructions, status/explain curl examples, failure meanings and test commands. |
| `backend/ml/disease_detection/docs/GRADCAM_BACKEND_INTEGRATION_PLAN.md` | Add/update | This plan, completed implementation checklist, actual validation results and any remaining deployment limitations. |

No frontend files change in this backend issue. No database, Supabase, advisory,
growth, digital-twin, training notebook or dataset changes. Model weights and
new virtual environments remain ignored. Do not edit tracked real `.env` values.

### Ordered implementation units and checks

1. **Shared model input and artifact identity** — inference helper, model card,
   crop/format tests. Gate: original ONNX API tests pass with unchanged outputs;
   exact artifact identity and shared input tensor confirmed.
2. **Grad-CAM computation** — optional requirements and `gradcam.py`, tiny-CNN
   tests. Gate: real CPU gradients work, target classes are correct, maps align,
   hooks/gradients clean up after success and failure, no cross-request state.
3. **HTTP integration** — schemas, uploads, router, environment sample and API
   tests. Gate: complete request/response/error contract passes without torch;
   enabled environment produces real explanations; parallel calls are bounded.
4. **Real model validation** — local parity tests and CPU timing/memory checks.
   Gate: probability tolerance <= 5e-4 and matching original argmax; documented
   warm/cold latency and actual tested image count. Any failed comparison is
   investigated before calling explanations compatible with the deployed model.
5. **Distribution and operation** — fetcher, optional container build, M1 CI,
   README and final test run. Gate: base backend still imports/runs without torch;
   optional backend runs with local weights; CI contains real CPU attribution
   tests. Release publishing and hosted deployment are separate actions.

For each unit, inspect the diff and run its relevant checks before proceeding.
Run the combined disease suite once after the final changes. No commit or push
is required to implement locally; preserve the user's Git identity and omit all
automated-agent attribution from any later commit messages/trailers.

### 1. Model and pixel parity

- Check both artifacts' hashes; inspect trusted checkpoint metadata and enforce
  backbone, class order, input size and strict state-dict loading.
- Extract the reusable crop helper without changing ONNX predictions.
- Compare original four-class probabilities on local photos with maximum
  absolute difference <= 5e-4, following existing parity-test tolerance.
  Verify original argmax separately. Investigate near ties instead of hiding them.
- At explanation time, verify PyTorch/ONNX outputs agree on the request before
  attributing the ONNX target. Do not serve a heatmap from mismatched weights.

### 2. Explanation service

- Add `app/services/disease/gradcam.py` and optional dependencies in
  `backend/requirements-explain.txt` (CPU torch, compatible timm; select tested
  versions during implementation). No Captum/OpenCV/matplotlib dependency needed
  for runtime; render with existing NumPy/Pillow support and a defined color map.
- Use `eval()` with autograd enabled. Prefer a targeted gradient calculation
  over accumulating parameter gradients; verify equivalence to the notebook.
- Add lazy initialization, checksum validation, request-local capture, lock,
  bounded busy handling, degenerate/non-finite handling, and cleanup on failure.
- Add `M1_EXPLAIN_ENABLED` (default false) and `M1_CHECKPOINT_PATH`, with a default
  checkpoint location under ignored `backend/models/m1/`.

### 3. Router and schemas

- Add `/explain`, shared upload validation, typed response models and additive
  capability status. Preserve current `/predict` behavior and routing threshold.
- Document the API and curl example. Add configuration to `.env.example`.
- Ensure missing optional dependencies cannot crash `import app.main`.

### 4. Validation and packaging

- Lightweight tests: validation, capability disabled/unavailable, version mismatch,
  mocked service errors, and unchanged prediction contract.
- Optional torch tests with a tiny CNN: known spatial attribution, correct target,
  ReLU/normalization, constant map, cleanup after failure, repeatability, and
  overlapping-request isolation. Run actual CPU autograd, not only mocks.
- Local real-artifact checks: ONNX parity, notebook crop alignment and selected
  sample heatmaps; compare numerical attribution where notebook artifacts allow.
- Exercise healthy, leaf_spot, stem_rot, low-confidence and incorrect predictions.
  Complete expert visual review separately from numerical correctness checks.
- Benchmark cold start, warm explanation time, peak memory and repeated requests
  on the intended CPU host. Use measurements to set client timeout/deployment size.
- Keep the ordinary backend image lightweight by default; add an opt-in build
  option for explanation dependencies/artifact and smoke-test both builds.
- Plan a versioned, checksum-pinned release asset for the matching checkpoint
  and optional fetch mode. Publishing that asset is a separate release action;
  no weights committed to Git or silently added to an existing release.
- Extend the M1 workflow with optional CPU explanation tests. Existing API tests
  remain runnable without torch; do not silently skip all Grad-CAM testing in CI.

## Acceptance criteria

- Existing prediction responses and thresholds are unchanged; base backend
  runs without PyTorch installed and reports explanation support accurately.
- Enabled backend explains a validated photo with the exact 224x224 input crop,
  a finite heatmap and overlay for the ONNX winning original class.
- Torch and ONNX are artifact-matched and pass probability/argmax checks.
- No cross-request hook state, leaked gradients, silent empty maps, image files
  left on disk, or cropped maps stretched over the uncropped original photo.
- Missing/corrupt optional support yields a clear explanation failure while
  predictions continue to work.
- Automated CPU tests, local real-model parity, and documented performance
  measurements pass before a PR targets `feat/disease-detection`.

## Follow-up dashboard issue

Add Show explanation, loading/retry, input-crop/overlay comparison, opacity and
download controls. Reuse prediction request-ID protection to ignore stale
responses. Retain uncertainty and baseline warnings; describe highlighted
regions as contributions to the prediction. Review this UX after the backend
contract is implemented; do not promote E4a or F3 findings into production
prediction changes as part of this integration.

## Implementation and validation record

- Shared crop and NumPy normalization preserve original prediction pixels.
  ONNX now loads from the same bytes used to calculate its artifact fingerprint.
- Optional `gradcam.py` uses the notebook's attribution formula with
  `torch.autograd.grad` instead of parameter-gradient accumulation. The
  checksum-pinned model is frozen; only request-local input/features need gradients.
- `/explain` returns the existing prediction plus typed explanation metadata
  and PNG data URIs. Admission is acquired within the worker before decoding,
  and released by that same worker even if the HTTP coroutine is cancelled.
  Bounded raw upload reading precedes worker admission; no decoded-image queue.
- Shared input bounds: 10 MiB, 50 megapixels, maximum aspect ratio 20:1.
  Limits admit the available 720x1280/900x1600 field images and 48 MP photos;
  very narrow panoramas are rejected before large resize allocations.
- Added `M1_EXPLAIN_THREADS` (default 4, range 1-32) for reproducible CPU
  thread sizing. It changes PyTorch's process-wide intra-op setting only when
  optional explanation support first initializes; restart after changing it.
- Optional packages installed and checked in a separate Python 3.12 environment:
  torch 2.11.0+cpu, torchvision 0.26.0+cpu, timm 1.0.30.
- Verified local checkpoint copied into ignored `backend/models/m1/best.pt`.
  No real `.env` edits; normal runtime remains explanation-disabled by default.
- Lightweight backend suite without torch: 33 tests passed; two optional
  test modules skipped. Application import succeeded without importing torch.
- Optional attribution/API/fetcher tests: 25 passed, including actual tiny-CNN
  autograd and busy-worker recovery.
- Final combined optional-environment disease suite: all 47 tests passed
  (including both old notebook parity tests and all four new real-artifact
  integration tests). Final lightweight suite: 33 passed, 2 optional modules
  skipped. `pip check` reports no broken requirements.
- Real-artifact integration: four tests passed. Across all 183 available local
  photos, original-class argmax agreed and maximum Torch/ONNX probability
  difference was 9.42e-6 (required <= 5e-4). Exact crop and the original
  notebook backward-hook CAM matched. All four source classes and a referred
  prediction were exercised; real HTTP predict/explain responses agreed.
- Local benchmark: Windows, Python 3.12, 8 logical CPUs, 4 PyTorch threads,
  in-process FastAPI TestClient, one process. First request 10.73 s (includes
  lazy model imports/loading); eight warm requests median 0.178 s, max 0.214 s.
  Peak native process working set 567.95 MiB, measured with Windows
  GetProcessMemoryInfo; this includes ONNX/PyTorch and temporary diagnostics.
  These are local measurements, not a deployed-host or network latency guarantee.
- Generated and visually inspected a four-photo crop/CAM/overlay contact sheet
  for alignment under ignored `backend/models/m1/gradcam-validation.png`.
  Numeric timings are in ignored `gradcam-validation.json`. Expert review of
  biological relevance remains separate; this is not disease-localization validation.
- New/touched disease modules pass Ruff. Workflow YAML parses; backend bytecode
  compilation and checkpoint-verification CLI pass.
- Container builds cannot run locally (Docker unavailable). M1 CI now builds
  and smoke-tests the optional image; existing shared CI covers the base build.
  Remote CI has not run because no branch was pushed or PR opened.
- A checkpoint release is deliberately not published. Local weights/mounting
  are supported; `--checkpoint` downloads only after a valid release tag is
  configured, and otherwise verifies a local default artifact or reports the
  missing release explicitly.
