import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { ExplainResponse, ExplanationCapability, Prediction } from "../src/lib/disease/types";

const capability: ExplanationCapability = { enabled: true, loaded: false, method: "gradcam", state: "not_loaded", detail: null };
const prediction: Prediction = {
  model_version: "e1-test", prediction: "healthy", decision: "refer", confidence: .91,
  probabilities: { healthy: .91, leaf_spot: .06, stem_rot: .03 }, action: "expert_review",
  warning: "Baseline model; not validated for Sri Lankan vines.", experimental: null,
};

async function harness(page: Page, options: {
  capability?: ExplanationCapability | null;
  prediction?: Prediction;
  explain?: (route: Route, response: ExplainResponse) => Promise<void>;
} = {}) {
  const [crop, heatmap] = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 224;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgb(20,80,40)";
    context.fillRect(0, 0, 224, 224);
    const crop = canvas.toDataURL("image/png");
    context.fillStyle = "rgb(220,0,0)";
    context.fillRect(0, 0, 224, 224);
    return [crop, canvas.toDataURL("image/png")];
  });
  const result = options.prediction ?? prediction;
  const response: ExplainResponse = {
    prediction: result,
    explanation: {
      method: "gradcam", target_source_class: result.prediction === "leaf_spot" ? "red_spot" : result.prediction,
      target_display_class: result.prediction, target_layer: "conv_head", status: "ok",
      input_size: [224, 224], feature_map_size: [7, 7], input_crop: crop, heatmap, overlay: crop,
      checkpoint_sha256: "a".repeat(64), elapsed_ms: 150, note: "Model contribution, not lesion segmentation.",
    },
  };
  let calls = 0;
  let submitted: Buffer | null = null;
  await page.route("**/api/disease/status", route => route.fulfill({ json: {
    model_loaded: true, model_version: result.model_version, classes: ["healthy", "leaf_spot", "stem_rot"],
    status: "baseline", detail: null,
    ...(options.capability === null ? {} : { explanation: options.capability ?? capability }),
  } }));
  await page.route("**/api/disease/predict", route => route.fulfill({ json: result }));
  await page.route("**/api/disease/explain", async route => {
    calls++;
    submitted = route.request().postDataBuffer();
    if (options.explain) await options.explain(route, response);
    else await route.fulfill({ json: response });
  });
  await page.goto("/disease-detection");
  await expect(page.getByText("Model e1-test", { exact: true })).toBeVisible();
  const file = { name: "leaf.png", mimeType: "image/png", buffer: Buffer.from(crop.split(",")[1], "base64") };
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "Analyse photo", exact: true }).click();
  await expect(page.getByRole("heading", { name: result.prediction === "stem_rot" ? "Stem rot" : result.prediction === "leaf_spot" ? "Leaf spot" : "Healthy", exact: true })).toBeVisible();
  return { response, file, calls: () => calls, submitted: () => submitted };
}

test("on-demand explanation preserves diagnosis and sends the exact file/version", async ({ page }) => {
  const mock = await harness(page);
  expect(mock.calls()).toBe(0);
  await page.getByRole("button", { name: "Show explanation" }).click();
  await expect(page.getByAltText("Exact model input crop", { exact: true })).toBeVisible();
  await expect(page.getByAltText("Positive contribution heatmap", { exact: true })).toHaveCSS("opacity", "0.42");
  await expect(page.getByText("Needs expert review", { exact: true })).toBeVisible();
  await expect(page.getByText(prediction.warning, { exact: true })).toBeVisible();
  expect(mock.submitted()!.includes(mock.file.buffer)).toBe(true);
  expect(mock.submitted()!.toString()).toContain('name="expected_model_version"');
  expect(mock.submitted()!.toString()).toContain("e1-test");
  await expect(page.getByRole("slider", { name: "Highlight opacity" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("disease source class appears in optional details", async ({ page }) => {
  await harness(page, { prediction: { ...prediction, prediction: "leaf_spot", decision: "accept", confidence: .97,
    probabilities: { healthy: .01, leaf_spot: .98, stem_rot: .01 }, action: "treat_leaf_disease" } });
  await page.getByRole("button", { name: "Show explanation" }).click();
  await page.getByText("Explanation details", { exact: true }).click();
  await expect(page.getByText("red spot", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Leaf spot", exact: true })).toBeVisible();
});

test("keyboard opacity changes presentation and downloads the current PNG blend", async ({ page }) => {
  const mock = await harness(page);
  await page.getByRole("button", { name: "Show explanation" }).click();
  const slider = page.getByRole("slider", { name: "Highlight opacity" });
  await slider.focus();
  await slider.press("Home");
  await expect(page.getByAltText("Positive contribution heatmap", { exact: true })).toHaveCSS("opacity", "0");
  expect(mock.calls()).toBe(1);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download overlay", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("gradcam-leaf.png");
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(224);
  expect(bytes.readUInt32BE(20)).toBe(224);
  // Compare the downloaded image's pixels with the crop at 0% heatmap opacity.
  const pixel = await page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 224;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(100, 100, 1, 1).data);
  }, bytes.toString("base64"));
  expect(pixel).toEqual([20, 80, 40, 255]);
});

for (const state of ["legacy", "disabled", "unavailable"] as const) {
  test(`${state} explanation capability leaves prediction usable`, async ({ page }) => {
    const mock = await harness(page, { capability: state === "legacy" ? null
      : { ...capability, enabled: state !== "disabled", state } });
    await expect(page.getByRole("button", { name: "Show explanation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check availability" })).toBeVisible();
    await page.getByRole("button", { name: "Check availability" }).click();
    await expect(page.getByText("Visual explanations are still unavailable on this server.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Healthy", exact: true })).toBeVisible();
    expect(mock.calls()).toBe(0);
  });
}

test("availability can recover, including an enabled previous-error state", async ({ page }) => {
  await harness(page, { capability: { ...capability, enabled: false, state: "disabled" } });
  await page.unroute("**/api/disease/status");
  await page.route("**/api/disease/status", route => route.fulfill({ json: {
    model_loaded: true, model_version: "e1-test", classes: ["healthy", "leaf_spot", "stem_rot"], status: "baseline", detail: null,
    explanation: { ...capability, state: "error", detail: "Previous request failed" },
  } }));
  await page.getByRole("button", { name: "Check availability" }).click();
  await page.getByRole("button", { name: "Show explanation" }).click();
  await expect(page.getByAltText("Exact model input crop", { exact: true })).toBeVisible();
});

test("availability network failure preserves the diagnosis", async ({ page }) => {
  await harness(page, { capability: null });
  await page.unroute("**/api/disease/status");
  await page.route("**/api/disease/status", route => route.abort("failed"));
  await page.getByRole("button", { name: "Check availability" }).click();
  await expect(page.getByText("Couldn't check explanation availability. Try again.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Healthy", exact: true })).toBeVisible();
});

test("explanation timeout remains active while the response body is pending", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith("/api/disease/explain")) {
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"prediction":'));
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
          },
        }), { headers: { "Content-Type": "application/json" } }));
      }
      return original(input, init);
    };
  });
  await harness(page);
  await page.getByRole("button", { name: "Show explanation" }).click();
  await expect(page.getByText("Generating explanation…", { exact: false })).toBeVisible();
  await page.clock.fastForward(60_001);
  await expect(page.getByText("The server took too long to respond. Try again.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Healthy", exact: true })).toBeVisible();
});

test("busy responses respect Retry-After and permit manual retry", async ({ page }) => {
  let busy = true;
  await harness(page, { explain: async (route, response) => {
    if (busy) { busy = false; await route.fulfill({ status: 503, headers: { "Retry-After": "1", "Access-Control-Expose-Headers": "Retry-After" }, json: { detail: "busy" } }); }
    else await route.fulfill({ json: response });
  } });
  await page.getByRole("button", { name: "Show explanation" }).click();
  await expect(page.getByRole("button", { name: "Please wait before retrying…" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Healthy", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry explanation" }).click();
  await expect(page.getByAltText("Exact model input crop", { exact: true })).toBeVisible();
});

for (const failure of ["network", "unavailable", "malformed", "broken-image"] as const) {
  test(`${failure} failure is isolated to the explanation card`, async ({ page }) => {
    await harness(page, { explain: async (route, response) => {
      if (failure === "network") await route.abort("failed");
      else if (failure === "unavailable") await route.fulfill({ status: 503, json: { detail: "Private server installation detail" } });
      else if (failure === "malformed") await route.fulfill({ json: { explanation: null } });
      else await route.fulfill({ json: { ...response, explanation: { ...response.explanation, input_crop: "data:image/png;base64,YmFk" } } });
    } });
    await page.getByRole("button", { name: "Show explanation" }).click();
    await expect(page.getByRole("button", { name: "Retry explanation" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Healthy", exact: true })).toBeVisible();
    await expect(page.getByText("The photo wasn't analysed", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Private server installation detail")).toHaveCount(0);
  });
}

for (const failure of ["version", "conflicting-result"] as const) {
  test(`${failure} offers same-file reanalysis without replacing diagnosis`, async ({ page }) => {
    await harness(page, { explain: async (route, response) => {
      if (failure === "version") await route.fulfill({ status: 409, json: { detail: "changed" } });
      else await route.fulfill({ json: { ...response, prediction: { ...response.prediction, confidence: .5 } } });
    } });
    await page.getByRole("button", { name: "Show explanation" }).click();
    await expect(page.getByRole("button", { name: "Analyse again", exact: true })).toBeVisible();
    await expect(page.getByText("91% confidence", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Analyse again", exact: true }).click();
    await expect(page.getByRole("button", { name: "Show explanation" })).toBeVisible();
    await expect(page.getByText("leaf.png", { exact: true })).toBeVisible();
  });
}

test("degenerate attribution is identified without displaying a meaningful heatmap", async ({ page }) => {
  await harness(page, { explain: (route, response) => route.fulfill({ json: { ...response,
    explanation: { ...response.explanation, status: "degenerate" } } }) });
  await page.getByRole("button", { name: "Show explanation" }).click();
  await expect(page.getByText("No useful highlight was produced", { exact: false })).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download overlay" })).toHaveCount(0);
  await expect(page.getByText("Needs expert review", { exact: true })).toBeVisible();
});

test("photo removal and same-filename replacement cannot receive delayed highlights", async ({ page }) => {
  let release!: () => void;
  let completedOldRequest = false;
  let attempts = 0;
  let cancelled = false;
  page.on("requestfailed", request => { if (request.url().endsWith("/api/disease/explain")) cancelled = true; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const mock = await harness(page, { explain: async (route, response) => {
    if (++attempts === 1) {
      await waiting;
      await route.fulfill({ json: response }).catch(() => {}); // Aborted request is expected.
      completedOldRequest = true;
    } else await route.fulfill({ json: response });
  } });
  await page.getByRole("button", { name: "Show explanation" }).click();
  await expect(page.getByText("Generating explanation…", { exact: false })).toBeVisible();
  expect(mock.calls()).toBe(1);
  await expect(page.getByText("Needs expert review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove photo" }).click();
  const replacement = { ...mock.file, buffer: Buffer.from(mock.response.explanation.heatmap.split(",")[1], "base64") };
  await page.locator('input[type="file"]').setInputFiles(replacement);
  await page.getByRole("button", { name: "Analyse photo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show explanation" })).toBeVisible();
  release();
  await expect.poll(() => completedOldRequest).toBe(true);
  await expect.poll(() => cancelled).toBe(true);
  await expect(page.getByAltText("Exact model input crop", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show explanation" }).click();
  await expect(page.getByAltText("Exact model input crop", { exact: true })).toBeVisible();
  expect(mock.calls()).toBe(2);
  expect(mock.submitted()!.includes(replacement.buffer)).toBe(true);
});
