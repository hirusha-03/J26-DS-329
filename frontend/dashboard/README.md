# Vanilla dashboard

Next.js analytics dashboard. Disease detection supports optional Grad-CAM
explanations through the disease backend; Docker is not needed for local use.

## Run locally

From the repository root:

```powershell
npm install
npm run dev -w frontend/dashboard -- --hostname 127.0.0.1 --port 3001
```

Open `http://127.0.0.1:3001/disease-detection`. Use the same hostname that the
development server binds to. `NEXT_PUBLIC_API_URL` defaults to
`http://localhost:8000`; an override belongs in `frontend/dashboard/.env.local`
or in the frontend process environment before starting Next.js.

Start the backend in a second terminal, from `backend/`:

```powershell
$env:M1_EXPLAIN_ENABLED = 'true'
.\.venv-explain\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The optional environment and trusted checkpoint must be prepared first; see
[backend setup](../../backend/README.md#optional-disease-explanations-grad-cam).
Regular prediction still works with explanation support disabled or an older
backend that does not advertise the explanation capability. No Supabase
credentials are required for the disease upload/explanation flow itself.

## Visual explanations

1. Upload a JPG, PNG or WebP and select **Analyse photo**.
2. Select **Show explanation** below the result. The first request can take
   longer while the backend loads the optional CPU model (60-second client limit).
3. Compare the exact model crop with the highlighted contribution. The opacity
   slider blends the raw heatmap over the crop; it does not rerun the model.
4. **Download overlay** saves the current blend as a PNG at the native crop
   resolution. Images/results are not saved in browser storage.

The full upload preview and 224x224 model crop are deliberately separate.
Highlights show positive contribution to the selected class, not lesion
boundaries or proof of correct diagnosis. Baseline and expert-review warnings
remain visible. Method/source-class/checkpoint details are expandable.

Explanation loading and failure never replace the displayed diagnosis.
**Retry explanation** retries a failed request; a busy service respects the
server's retry delay. **Analyse again** appears if the server model/result has
changed. A constant/empty map is identified without showing a useful highlight.
**Check availability** can recover after optional support is enabled on the
server. Changing/removing the photo cancels and ignores its pending explanation.

## Checks

From the repository root:

```powershell
npm run lint -w frontend/dashboard
.\node_modules\.bin\tsc.cmd --noEmit --project frontend/dashboard/tsconfig.json
npm run build:dashboard
.\node_modules\.bin\playwright.cmd install chromium --no-shell
npm run test:e2e -w frontend/dashboard
```

On Linux/macOS use `npx tsc`, `npx playwright install chromium --no-shell` and
the same npm commands. Linux may require `npx playwright install --with-deps
chromium --no-shell` to install Chromium system dependencies.

Playwright uses Chromium's headless mode at desktop and narrow viewport sizes.
It starts its own Next.js server on `127.0.0.1:3101`; keep that port free. API
responses are mocked only in the tests, so no live backend or field-photo data
is needed for the browser suite. The configuration blocks service workers,
uses a single worker and saves traces/screenshots for failed tests under ignored
`test-results/`. Browser dependencies are development-only.

Browser checks cover on-demand requests, diagnosis preservation, exact file and
version submission, cancellation/stale responses, busy retries, HTTP 409,
legacy/unavailable capability, malformed responses/images, degenerate maps,
keyboard opacity control, downloaded PNG pixels/dimensions and narrow layouts.

After switching branches, stale generated `.next/types` may reference routes
from another branch. Regenerate them with `npx next typegen` from
`frontend/dashboard/` before treating those TypeScript errors as source bugs.

The implementation inventory and validation record are in
[the frontend plan](docs/GRADCAM_FRONTEND_INTEGRATION_PLAN.md).
