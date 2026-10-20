"use client";

import { useEffect, useRef, useState } from "react";
import { Noto_Sans_Sinhala } from "next/font/google";
import {
  AdvisoryApiError,
  ask,
  demoCache,
  health,
  type AskResult,
  type HealthResponse,
} from "@/lib/advisory/api";

const notoSansSinhala = Noto_Sans_Sinhala({
  subsets: ["sinhala"],
  weight: ["400", "600"],
  display: "swap",
});

const EXAMPLE_QUESTIONS = [
  "වැනිලා මල් පරාගනය කරන්න හොඳම වෙලාව මොකක්ද?",
  "අවුරුදු දෙකක වැනිලා වැල් සඳහා භාවිත කළ යුතු පොහොර මොනවාද?",
  "How long does vanilla curing take?",
  "වැනිලා වසංගත රෝග මගහැරවිය හැක්කේ කෙසේද?",
];

const MODE_BADGE: Record<AskResult["mode"], { label: string; classes: string; note?: string }> = {
  confident: { label: "Confident", classes: "bg-ok-soft text-ok" },
  cautious: {
    label: "Cautious",
    classes: "bg-warn-soft text-warn",
  },
  english: {
    label: "English",
    classes: "bg-border-light text-text-secondary",
    note: "(support check not applied)",
  },
};

function StatusPill({ apiStatus }: { apiStatus: "loading" | "ok" | "unreachable" | "checking" }) {
  const config = {
    checking: { label: "Checking…", classes: "bg-border-light text-text-secondary" },
    ok: { label: "Ready", classes: "bg-ok-soft text-ok" },
    loading: { label: "Loading model…", classes: "bg-warn-soft text-warn" },
    unreachable: { label: "API not reachable", classes: "bg-danger-soft text-danger" },
  }[apiStatus];
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${config.classes}`}>
      {config.label}
    </span>
  );
}

function SufficiencyBar({ p, threshold }: { p: number; threshold: number }) {
  return (
    <div className="space-y-1">
      <div className="relative h-2 w-full rounded-full bg-border-light">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-secondary"
          style={{ width: `${Math.round(p * 100)}%` }}
        />
        <div
          className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-text-primary"
          style={{ left: `${Math.round(threshold * 100)}%` }}
          title={`threshold ${threshold.toFixed(2)}`}
        />
      </div>
      <p className="text-xs text-text-secondary">
        P(sufficient) = {p.toFixed(2)} · confident-answer cut-off {threshold.toFixed(2)}
      </p>
    </div>
  );
}

function ResultCard({ result }: { result: AskResult }) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const badge = MODE_BADGE[result.mode];

  return (
    <div className="space-y-4 rounded-2xl border border-border-light bg-white p-5 shadow-[0_1px_0_rgba(1,45,29,0.06)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${badge.classes}`}>
          {badge.label}
        </span>
        {badge.note && <span className="text-xs text-text-secondary">{badge.note}</span>}
      </div>

      <p className={`whitespace-pre-line text-sm text-text-primary ${notoSansSinhala.className}`}>
        {result.answer_text}
      </p>

      <div>
        <button
          type="button"
          onClick={() => setShowDiagnostics((v) => !v)}
          className="text-sm font-medium text-secondary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-secondary"
        >
          {showDiagnostics ? "Hide" : "Show"} diagnostics
        </button>
        {showDiagnostics && (
          <div className="mt-3 space-y-4">
            {result.language === "si" && result.p_sufficient !== null && (
              <SufficiencyBar p={result.p_sufficient} threshold={result.threshold} />
            )}

            <ol className="space-y-3">
              {result.passages.map((p) => (
                <li key={p.chunk_id} className="rounded-xl bg-primary/5 p-3 text-sm">
                  <p className="font-medium text-text-primary">
                    [{p.rank}] {p.section} · score {p.score.toFixed(3)}
                  </p>
                  <p className={`mt-1 whitespace-pre-line text-text-secondary ${notoSansSinhala.className}`}>
                    {p.text}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <div className="border-t border-border-light pt-3 text-xs text-text-secondary">
        <p>
          Model: {result.llm_model} · Total time: {result.timings_ms.total_ms?.toFixed(0)} ms
        </p>
        {result.llm_error && <p className="mt-1 text-warn">Fallback answer (LLM unavailable)</p>}
      </div>
    </div>
  );
}

export default function AdvisoryPage() {
  const [apiStatus, setApiStatus] = useState<"loading" | "ok" | "unreachable" | "checking">("checking");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);

  const [offline, setOffline] = useState(false);
  const [cache, setCache] = useState<AskResult[]>([]);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [selectedCacheIdx, setSelectedCacheIdx] = useState<number | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const h: HealthResponse = await health();
        setApiStatus(h.status === "ok" ? "ok" : "loading");
        if (h.status === "ok" && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        setApiStatus("unreachable");
      }
    };
    checkHealth();
    pollRef.current = setInterval(checkHealth, 5_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (!offline) return;
    let cancelled = false;
    demoCache()
      .then((data) => {
        if (!cancelled) {
          setCache(data);
          setCacheError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setCacheError(e instanceof AdvisoryApiError ? e.message : "Could not load the demo cache.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [offline]);

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await ask(trimmed);
      setResult(r);
    } catch (e) {
      setError(e instanceof AdvisoryApiError ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Vanilla Advisory</h1>
          <p className="text-base text-text-secondary">
            Get guidance on vanilla cultivation in Sinhala or English
          </p>
        </div>
        <StatusPill apiStatus={apiStatus} />
      </div>

      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={offline}
          onChange={(e) => setOffline(e.target.checked)}
          className="h-4 w-4 accent-secondary"
        />
        Offline demo (use saved results, no live call)
      </label>

      {!offline ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-border-light bg-white p-4">
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(query);
                }
              }}
              placeholder="Ask a vanilla cultivation question in Sinhala or English…"
              rows={3}
              disabled={loading}
              className={`w-full resize-none rounded-xl border border-border-light p-3 text-sm text-text-primary outline-none focus-visible:outline-2 focus-visible:outline-secondary ${notoSansSinhala.className}`}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => {
                      setQuery(q);
                      submit(q);
                    }}
                    disabled={loading}
                    className={`rounded-full bg-primary/5 px-3 py-1 text-xs text-text-secondary hover:bg-primary/10 disabled:opacity-50 ${notoSansSinhala.className}`}
                  >
                    {q.length > 40 ? `${q.slice(0, 40)}…` : q}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => submit(query)}
                disabled={loading || !query.trim()}
                className="rounded-full bg-secondary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Ask
              </button>
            </div>
          </div>

          {loading && <p className="text-sm text-text-secondary">Analysing evidence…</p>}
          {error && (
            <p className="rounded-xl bg-danger-soft p-3 text-sm text-danger">{error}</p>
          )}
          {result && <ResultCard result={result} />}
        </div>
      ) : (
        <div className="space-y-4">
          {cacheError && <p className="rounded-xl bg-danger-soft p-3 text-sm text-danger">{cacheError}</p>}
          {!cacheError && cache.length === 0 && (
            <p className="text-sm text-text-secondary">No saved demo results found.</p>
          )}
          {cache.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {cache.map((r, i) => (
                <button
                  key={`${r.query}-${i}`}
                  type="button"
                  onClick={() => setSelectedCacheIdx(i)}
                  className={`rounded-full px-3 py-1 text-xs ${
                    selectedCacheIdx === i
                      ? "bg-secondary text-white"
                      : "bg-primary/5 text-text-secondary hover:bg-primary/10"
                  } ${notoSansSinhala.className}`}
                >
                  {r.query.length > 40 ? `${r.query.slice(0, 40)}…` : r.query}
                </button>
              ))}
            </div>
          )}
          {selectedCacheIdx !== null && cache[selectedCacheIdx] && (
            <ResultCard result={cache[selectedCacheIdx]} />
          )}
        </div>
      )}
    </div>
  );
}
