import { API_BASE_URL } from "@/lib/constants";
import type { ExplainResponse, ModelStatus, Prediction } from "./types";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export class DiseaseApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "The photo couldn't be read. Try a different image.",
  413: "The photo is larger than 10 MB. Choose a smaller one.",
  415: "Only JPG, PNG and WebP photos are supported.",
  503: "The disease model isn't loaded on the server yet.",
};

/** Returns a user-facing problem with the file, or null if it can be sent. */
export function validateImage(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return STATUS_MESSAGES[415];
  if (file.size > MAX_UPLOAD_BYTES) return STATUS_MESSAGES[413];
  return null;
}

async function request<T>(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, { ...init, signal: controller.signal });
    if (!res.ok) {
      let detail: string | undefined;
      try {
        const body = await res.json();
        if (typeof body?.detail === "string") detail = body.detail;
      } catch {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      }
      const retryHeader = res.headers.get("Retry-After");
      const retry = retryHeader === null ? undefined : Number(retryHeader);
      throw new DiseaseApiError(
        detail ?? STATUS_MESSAGES[res.status] ?? `The server returned an error (${res.status}).`,
        res.status,
        retry !== undefined && Number.isFinite(retry) && retry >= 0 ? Math.min(retry, 60) : undefined,
      );
    }
    // Keep the timer and cancellation listener until the entire response is read.
    return (await res.json()) as T;
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (timedOut) throw new DiseaseApiError("The server took too long to respond. Try again.");
    if (err instanceof DiseaseApiError) throw err;
    throw new DiseaseApiError(err instanceof SyntaxError
      ? "The server returned an unreadable response. Try again."
      : "Can't reach the analysis server. Check that the backend is running.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export function getModelStatus(): Promise<ModelStatus> {
  return request<ModelStatus>("/api/disease/status", { method: "GET" }, 8_000);
}

export function predictDisease(file: File): Promise<Prediction> {
  const body = new FormData();
  body.append("file", file);
  return request<Prediction>("/api/disease/predict", { method: "POST", body }, 30_000);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pair(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && value.every(n => Number.isInteger(n) && n > 0 && n <= 4096);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validExplanation(value: unknown): value is ExplainResponse {
  if (!record(value) || !record(value.prediction) || !record(value.explanation)) return false;
  const p = value.prediction, e = value.explanation;
  const sourceLabels: Record<string, string> = {
    healthy: "healthy", black_spot: "leaf_spot", red_spot: "leaf_spot", stem_rot: "stem_rot",
  };
  const png = (v: unknown) => typeof v === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(v);
  return typeof p.model_version === "string" && typeof p.warning === "string"
    && ["healthy", "leaf_spot", "stem_rot"].includes(String(p.prediction))
    && ["accept", "refer"].includes(String(p.decision))
    && ["monitor", "treat_leaf_disease", "urgent_stem_rot", "expert_review"].includes(String(p.action))
    && probability(p.confidence) && record(p.probabilities)
    && ["healthy", "leaf_spot", "stem_rot"].every(c => probability((p.probabilities as Record<string, unknown>)[c]))
    && e.method === "gradcam" && ["ok", "degenerate"].includes(String(e.status))
    && typeof e.target_source_class === "string" && Object.hasOwn(sourceLabels, e.target_source_class)
    && sourceLabels[e.target_source_class] === e.target_display_class && e.target_display_class === p.prediction
    && typeof e.target_layer === "string" && pair(e.input_size) && pair(e.feature_map_size)
    && png(e.input_crop) && png(e.heatmap) && png(e.overlay)
    && typeof e.checkpoint_sha256 === "string" && /^[a-f0-9]{64}$/i.test(e.checkpoint_sha256)
    && typeof e.elapsed_ms === "number" && Number.isFinite(e.elapsed_ms) && e.elapsed_ms >= 0
    && typeof e.note === "string";
}

/** The explanation must describe the result already displayed, never replace it. */
export function matchesPrediction(actual: Prediction, expected: Prediction): boolean {
  return actual.model_version === expected.model_version && actual.prediction === expected.prediction
    && actual.decision === expected.decision && actual.action === expected.action
    && Math.abs(actual.confidence - expected.confidence) <= 1e-4
    && (["healthy", "leaf_spot", "stem_rot"] as const).every(c =>
      Math.abs(actual.probabilities[c] - expected.probabilities[c]) <= 1e-4);
}

export async function explainDisease(file: File, expectedVersion: string, signal: AbortSignal): Promise<ExplainResponse> {
  const body = new FormData();
  body.append("file", file);
  body.append("expected_model_version", expectedVersion);
  let result: unknown;
  try {
    result = await request<unknown>("/api/disease/explain", { method: "POST", body }, 60_000, signal);
  } catch (err) {
    if (!(err instanceof DiseaseApiError)) throw err;
    if (err.status === 409) throw new DiseaseApiError("The model has changed. Analyse this photo again before requesting an explanation.", 409);
    if (err.status === 503) throw new DiseaseApiError(err.retryAfterSeconds !== undefined
      ? "The explanation service is busy. Please wait a moment, then try again."
      : "Visual explanations are unavailable right now. Your prediction is still available.", 503, err.retryAfterSeconds);
    if (err.status && err.status >= 500) throw new DiseaseApiError("The explanation could not be generated. Your prediction is still available.", err.status);
    throw err;
  }
  if (!validExplanation(result)) throw new DiseaseApiError("The server returned an invalid explanation. Try again.");
  return result;
}
