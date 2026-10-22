# Grad-CAM frontend integration plan

Status: implemented and validated locally, 2026-10-19. No frontend commit,
push, PR or deployment performed.

Repository: `D:/Y4S1/RP/vanilla-app/J26-DS-329`.
Branch: `issue/hirusha/gradcam-frontend-intergration`.
Base: `issue/hirusha/gradcam-backend-intergration`, commit
`37ffeb17fb8e88a0b0556840b0241d2e97bc0664`.
The backend branch was clean and matched its freshly fetched remote before
branch creation. This frontend branch includes the committed backend work.
Review/PR target: the backend issue branch while that branch is open; if it
merges first, retarget to `feat/disease-detection` after verifying ancestry.

## Current structure checked

| Existing file | Responsibility and implication |
| --- | --- |
| `src/app/disease-detection/page.tsx` | Client page owns model status, selected File/blob preview and prediction phases. A request counter rejects stale prediction results; clearing/changing files invalidates the counter. Explanation needs an independent lifecycle. |
| `src/components/disease/UploadPanel.tsx` | File picker, drag/drop and preview. Already supports selecting/removing a photo after prediction. Those controls should remain usable while an explanation is pending. |
| `src/components/disease/ResultCard.tsx` | Displays diagnosis, confidence, actions, class scores and warnings. Keep this result visible during explanation loading/errors. |
| `src/components/disease/ReviewBanner.tsx` | Referred-result and baseline warnings. Continue displaying both when an explanation is shown. |
| `src/lib/disease/types.ts` | Prediction/status types; currently missing explanation capability and response types. |
| `src/lib/disease/api.ts` | Shared browser fetch helper; status/predict calls only. Timeout currently ends after response headers, before body parsing; caller cancellation is not supported. |
| `src/lib/disease/labels.ts` | Existing display labels/tones can be reused for the explanation's display class. No new disease label is introduced. |
| `src/app/globals.css` | Tailwind v4 tokens already cover cards, statuses, borders, text and focus styling. No new design system is needed. |
| `src/components/ClientLayout.tsx`, `public/sw.js` | Service worker registration only in production, local bypass already present. Explanation POST requests do not need caching/service-worker changes. |
| `package.json`, `tsconfig.json`, `eslint.config.mjs` | Next 16.2.9, React 19.2.4, strict TypeScript, ESLint. No dashboard test script or browser-test runner currently installed. |

All paths in the table are relative to `frontend/dashboard/`. Dashboard has no
own AGENTS.md; the monitor-specific instructions are scoped to the other app.
Read installed Next docs for client components and Playwright setup in
`node_modules/next/dist/docs/01-app/` before choosing the implementation.
Local Node is 22.20.0, npm 10.9.3; dependencies and Next docs are available.

Baseline checks: dashboard lint passed. Initial TypeScript check found stale
ignored `.next/types` pointing to a removed recommendations page from another
branch. Running `next typegen` regenerated route types; the strict TypeScript
check then passed. No tracked source/config changes were needed. No production
build or browser test has been run during this planning stage.

## User flow

1. Select photo and run the existing prediction flow.
2. Keep the result/warnings visible; show a separate Visual explanation card
   below the result with a **Show explanation** action.
3. On demand, submit the same File and prediction model version to `/explain`.
   Do not generate explanations automatically for every prediction.
4. Show independent loading feedback. First use can load the model; local
   backend cold request measured about 11 seconds. Let the user change/remove
   the photo while it loads; abort and ignore the previous response.
5. On success, compare **Model input crop** with **Highlighted contribution**.
   Both use the server's exact 224x224 crop. Keep the full uploaded preview
   separate, with a short note explaining that the model used a center crop.
6. Provide a labeled opacity range control (0-100%, default 42%) and a
   **Download overlay** action. Use responsive stacked panels on mobile and
   side-by-side panels where space permits; preserve square aspect ratios.
7. Show a short note that highlights contributed to the prediction and are
   not lesion boundaries or proof of a correct diagnosis. Keep any expert-review
   message visible. Explain healthy and referred predictions as well as disease.

Technical provenance (method, original source class, model version, layer,
checkpoint hash, feature size) belongs in optional details. Main copy uses the
display class (e.g. Leaf spot). Do not imply that red/black spot are additional
validated local diagnoses or that an opacity slider changes model inference.

## State, compatibility and failure behavior

- Prediction remains in the page's existing phase state. Add an analysis ID to
  the successful phase using the existing request counter. Key the explanation
  panel by that ID, not filename/lastModified, to isolate each analysis.
- The panel owns `idle | loading | success | error` explanation state, an
  AbortController, a request token and download/opacity state. An unmount or
  new analysis invalidates pending callbacks and aborts the fetch. No derived
  state reset effect should cause cascading renders.
- On explanation failure, preserve prediction, image and warnings. Use a local
  retry action; do not send explanation errors into the page's prediction error
  phase or mark the prediction model unavailable.
- Extend the shared request helper to accept cancellation, keep timeout active
  through body parsing, clean up timers/listeners, and distinguish an intentional
  abort from a timeout. Existing status/predict calls remain compatible.
- Use a 60-second explanation timeout initially to cover cold startup; existing
  status/prediction timeouts remain 8/30 seconds. No automatic retry loop.
- Extend DiseaseApiError with optional Retry-After information. On busy 503,
  show a retry message and respect the server delay before another attempt.
  Do not confuse busy with a missing prediction model.
- HTTP 409: keep the earlier result but mark it stale for explanation and offer
  **Analyse again** on the same file. Do not silently replace its diagnosis
  with the nested prediction from `/explain`.
- Before attaching images, check that the nested prediction matches the
  displayed model version, class, action, decision and scores (small numeric
  tolerance). Reject incompatible/malformed explanation data locally.
- Support legacy `/status` responses without an explanation property: show
  unavailable explanation support while prediction continues to work.
- Capability `not_loaded` is eligible for an explanation: lazy initialization
  happens on request. `ready` is eligible. `error` with enabled=true can offer
  a user-initiated retry. `disabled`/`unavailable` show concise unavailable copy
  and **Check availability**; do not expose installation commands in the product.
- A failed availability refresh must not erase an existing prediction/result.
- `degenerate` response: show the input crop and a clear no-useful-highlight
  message. Do not render the neutral map as meaningful disease evidence; hide
  or disable opacity controls, retain the prediction and its warnings.
- Broken/invalid image data or canvas download failure should affect only this
  card and allow retry. No images or results go to localStorage/IndexedDB.

## Image rendering and downloads

Use the returned crop as the base image and the returned **raw heatmap** as an
aligned layer with CSS opacity. The backend `overlay` is already blended at
42%; applying opacity to that over the crop would blend twice. Download the
currently displayed blend using an in-memory canvas at the native crop size,
then a temporary object URL with cleanup. Default opacity reproduces the
backend blend visually; minor browser rounding need not be byte-identical.

Use scoped plain img elements for dynamic PNG data URIs, consistent with the
existing blob preview; include alt text, explicit width/height and a local
Next image-lint explanation. No remote image configuration or external image
library is required. Opacity is presentation-only, never another API call.

## File-by-file implementation inventory

Paths relative to repository root. No files are removed or renamed.

| File | Action | Individual implementation |
| --- | --- | --- |
| `frontend/dashboard/src/lib/disease/types.ts` | Edit | Add original source-class, capability, explanation and combined-response types matching Python schemas. Make capability optional for legacy status compatibility. |
| `frontend/dashboard/src/lib/disease/api.ts` | Edit | Add explainDisease(file, expectedVersion, signal), 60-second timeout, independent explanation error mapping, caller cancellation, Retry-After support and response validation. Preserve status/predict callers. |
| `frontend/dashboard/src/components/disease/ExplanationPanel.tsx` | Add | On-demand request lifecycle, availability/retry controls, cropped comparison, heatmap opacity, degenerate state, download, concise interpretation and optional provenance. Own cleanup and stale-response guards. |
| `frontend/dashboard/src/app/disease-detection/page.tsx` | Edit | Add successful analysis ID; render panel for that exact File/result/capability; wire check-availability and same-file Analyse again. Preserve current diagnosis flow and warnings. |
| `frontend/dashboard/playwright.config.ts` | Add | Minimal Chromium browser tests on a dedicated 127.0.0.1 port with a controlled dashboard server and service workers blocked. Keep test behavior isolated from normal dev sessions. |
| `frontend/dashboard/e2e/disease-explanation.spec.ts` | Add | Route-mocked browser tests for successful/failed explanations, controls, download, capability compatibility, stale requests and result retention. Use in-memory small PNG inputs; no field-photo fixture committed. |
| `frontend/dashboard/package.json` | Edit | Add @playwright/test as a dev dependency and a scoped test:e2e command. No new production dependency. |
| `package-lock.json` | Edit | Workspace lock changes from installing the dashboard-only test dependency; inspect for unrelated upgrades. |
| `frontend/dashboard/.gitignore` | Edit | Ignore Playwright reports/traces/test-results, keeping generated artifacts out of commits. |
| `frontend/dashboard/README.md` | Add | Dashboard-specific startup, API URL, explanation prerequisites, behavior, validation and browser-test commands. Reference backend setup rather than duplicate it. |
| `frontend/dashboard/docs/GRADCAM_FRONTEND_INTEGRATION_PLAN.md` | Add/update | This plan, final implementation inventory, test evidence and any known limitations. |

`ResultCard.tsx`, `UploadPanel.tsx`, `ReviewBanner.tsx`, global styles and backend
files need no planned changes. If implementation uncovers a required adjustment,
record the reason before expanding scope. No monitor/advisory/growth/map edits.
Do not add a second frontend test framework. Playwright is justified here by
the async photo-change race, real image layering, downloads and keyboard controls.

## Ordered implementation units and checks

1. **Contract and API client** — types/api. Verify schema alignment, old API
   compatibility, caller aborts, timeout cleanup, expected-version form field
   and Retry-After parsing. Keep production dependencies unchanged.
2. **Explanation card** — standalone client component. Implement independent
   loading/error/success state, crop-aligned heatmap controls, degenerate copy
   and canvas download. Check keyboard labels/focus and mobile image sizing.
3. **Page integration** — mount by analysis ID and exact File, capability
   refresh and same-file reanalysis. Verify old results never attach to a new
   photo and explanation failures never hide prediction results.
4. **Browser verification** — install one scoped test runner; intercept only
   disease API traffic for deterministic failure/delay cases. Test Chromium
   desktop and a narrow viewport. Add no fake production responses.
5. **Real backend verification and documentation** — run dashboard against
   optional Python environment with M1_EXPLAIN_ENABLED=true; use an existing
   local photo to confirm prediction, explanation, crop alignment and download.
   Record actual results, then final lint/type-check/build and diff review.

Validation commands from repository root:

```powershell
npm run lint -w frontend/dashboard
.\node_modules\.bin\tsc.cmd --noEmit --project frontend/dashboard/tsconfig.json
npm run build:dashboard
npm run test:e2e -w frontend/dashboard
```

Install Chromium through the scoped Playwright installation before browser tests.
Use a dedicated server port (e.g. 3101), not an assumed available 3000/3001.
Match the dev server's bound hostname in browser URLs. Backend CORS already
allows local 3000/3001; for a real check on 3101 add that origin via process-level
CORS_ORIGINS, without editing the user's real environment files. Mocked tests
do not need a live backend or Supabase credentials. Docker is not required.

## Browser scenarios required

- Successful healthy and disease predictions can request an explanation.
- Request contains the exact original file and expected prediction version.
- Loading retains diagnosis, uncertainty and baseline warnings; double submission
  is prevented; mobile panels remain contained.
- Capability absent/disabled/unavailable, lazy not_loaded and enabled error states
  behave as specified; availability refresh preserves the existing result.
- Busy 503, missing support, network failure and malformed image/response produce
  a local error; busy delay is respected; a manual retry can succeed.
- HTTP 409 offers same-file reanalysis; conflicting nested prediction is not used.
- Change/remove photo while a delayed explanation is running: old response is
  aborted/ignored. Analyse the same filename again without reusing stale images.
- Opacity modifies only rendering, not network requests; download is a PNG at
  native crop resolution matching current blend.
- Degenerate heatmap is clearly identified without altering prediction.
- Controls have accessible names; status/error messages are announced; keyboard
  operation, reduced-motion styling and narrow-screen layout are checked.

## Completion criteria

Explanation UI works with the committed backend contract, preserves diagnosis
on all explanation failures, handles stale files/versions, correctly layers the
crop and heatmap, and downloads the current blend. Scoped browser tests plus
dashboard lint, strict TypeScript and production build pass. Real-backend check
is recorded honestly; deployment and Docker are not prerequisites. No commits,
pushes or PR creation are implied by this planning stage. Follow the user's
global rule against automated-agent author/commit attribution.

## Required scope adjustment found during browser integration

The busy-service browser test showed that `Retry-After` was sent by the backend
but hidden from frontend JavaScript by cross-origin response-header rules.
The backend's CORS middleware did not expose it. Before expanding runtime scope,
record the required fix here: edit `backend/app/main.py` to expose only
`Retry-After`, and add a regression check to
`backend/tests/disease/test_explain_api.py` using the actual application CORS
middleware. Test response mocks must expose the same header too. This change
is necessary to implement the existing retry contract; no disease inference,
checkpoint, database or model behavior changes.

## Completed implementation and validation

- Added the explanation types and capability-compatible API client, including
  caller aborts, timeout through body parsing, response validation, model/result
  comparison and Retry-After handling. Existing status/prediction calls remain
  compatible with their original signatures.
- Added `ExplanationPanel.tsx` with independent request state. Successful page
  results now carry an analysis ID; the keyed panel captures the exact File and
  result. Old requests are aborted and ignored on removal/replacement/reanalysis.
- Added input-crop/raw-heatmap comparison, 42% default opacity, keyboard range
  control, native-resolution PNG canvas download, degenerate state and optional
  provenance details. Existing diagnosis, confidence and expert/baseline warnings
  stay visible on explanation failures. No global styles or result/upload card
  changes were required.
- Added the scoped Playwright development dependency/configuration and one
  browser test file. Workspace lock adds only @playwright/test, playwright and
  playwright-core; no production dependency upgrades were introduced.
- Browser suite: all 36 tests passed (18 cases each on 1440px desktop and 390px
  narrow Chromium). Tests cover lazy/legacy/error capability, failed availability
  checks, exact file/version submission, native PNG pixel/dimension download,
  opacity without extra requests, malformed responses/images, 409/reanalysis,
  local error retention, empty attribution and a timeout during response-body
  parsing. A delayed old request is explicitly observed cancelling; a different
  image with the same filename can then be explained without old highlights.
- The first browser run caught the hidden Retry-After header. Added only
  `expose_headers=["Retry-After"]` in backend CORS and a regression test using
  the actual backend application. Both busy browser cases then passed; all
  13 backend explanation API tests and critical Ruff checks passed.
- Dashboard lint, strict TypeScript check and final production build passed.
  The build generated all eight existing routes successfully.
- Actual browser-to-backend check passed using the optional Python runtime
  at 127.0.0.1:8012 and dashboard at 127.0.0.1:3101. Actual local healthy and
  stem-rot images both returned `ok`, [224,224] crops and [7,7] feature maps.
  Downloaded each overlay at 65% opacity. No page errors or narrow horizontal
  overflow. The final check used the configured backend URL directly, without
  mocked responses. Screenshots and report are under ignored `test-results/`
  (`gradcam-real-healthy-desktop.png`, `gradcam-real-stem_rot-desktop.png`,
  narrow views, downloaded overlays and `gradcam-real-report.json`).
- Inspected generated desktop/narrow previews for crop alignment and control
  layout. This checks UI behavior, not agronomic correctness or lesion location.
- Local environment files, model weights, database schemas, other research
  modules and the monitor application were not changed. Docker was not used.
- Temporary validation servers are stopped after checks. Remote CI and hosted
  deployment have not run as part of this local implementation.
