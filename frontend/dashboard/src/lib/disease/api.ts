import { API_BASE_URL } from "@/lib/constants";
import type { ModelStatus, Prediction } from "./types";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export class DiseaseApiError extends Error {
  constructor(
    message: string,
    public status?: number,
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

async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { ...init, signal: controller.signal });
  } catch {
    throw new DiseaseApiError(
      controller.signal.aborted
        ? "The server took too long to respond. Try again."
        : "Can't reach the analysis server. Check that the backend is running.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // non-JSON error body
    }
    throw new DiseaseApiError(
      detail ?? STATUS_MESSAGES[res.status] ?? `The server returned an error (${res.status}).`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

export function getModelStatus(): Promise<ModelStatus> {
  return request<ModelStatus>("/api/disease/status", { method: "GET" }, 8_000);
}

export function predictDisease(file: File): Promise<Prediction> {
  const body = new FormData();
  body.append("file", file);
  return request<Prediction>("/api/disease/predict", { method: "POST", body }, 30_000);
}
