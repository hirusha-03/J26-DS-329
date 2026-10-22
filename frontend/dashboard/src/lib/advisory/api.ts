// Typed client for the advisory RAG service (backend/ml/advisory/src/api.py).
// Follows the pattern of src/lib/disease/api.ts.

const ADVISORY_API_URL =
  process.env.NEXT_PUBLIC_ADVISORY_API_URL || "http://127.0.0.1:8001";

export class AdvisoryApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export interface HealthResponse {
  status: "ok" | "loading";
  llm_model: string | null;
  threshold: number | null;
}

export interface Passage {
  rank: number;
  chunk_id: string;
  section: string;
  score: number;
  text: string;
}

export interface AskResult {
  query: string;
  language: "si" | "en";
  mode: "confident" | "cautious" | "english";
  p_sufficient: number | null;
  threshold: number;
  answer_text: string;
  llm_model: string;
  llm_error: string | null;
  passages: Passage[];
  timings_ms: Record<string, number>;
}

async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${ADVISORY_API_URL}${path}`, { ...init, signal: controller.signal });
  } catch {
    throw new AdvisoryApiError(
      controller.signal.aborted
        ? "The server took too long to respond. Try again."
        : "Can't reach the advisory API. Check that the backend is running.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") detail = body.error;
      else if (Array.isArray(body?.detail) && body.detail[0]?.msg) detail = body.detail[0].msg;
    } catch {
      // non-JSON error body
    }
    throw new AdvisoryApiError(detail ?? `The server returned an error (${res.status}).`, res.status);
  }
  return (await res.json()) as T;
}

export function health(): Promise<HealthResponse> {
  return request<HealthResponse>("/health", { method: "GET" }, 60_000);
}

export function ask(query: string): Promise<AskResult> {
  return request<AskResult>(
    "/ask",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    },
    60_000,
  );
}

export function demoCache(): Promise<AskResult[]> {
  return request<AskResult[]>("/demo-cache", { method: "GET" }, 60_000);
}
