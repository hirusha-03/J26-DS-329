"use client";

import { useEffect, useRef, useState } from "react";
import { Noto_Sans_Sinhala } from "next/font/google";
import {
  BarChart3,
  BookOpen,
  ChevronDown,
  Clock3,
  Cpu,
  Globe2,
  Leaf,
  Loader2,
  SendHorizonal,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
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

const PAGE_FONT_STACK =
  '"Inter", "Noto Sans Sinhala", "Iskoola Pota", system-ui, sans-serif';

const EXAMPLE_QUESTIONS_SI = [
  "වැනිලා මල් පරාගනය කරන්න හොඳම වෙලාව මොකක්ද?",
  "අවුරුදු දෙකක වැනිලා වැල් සඳහා භාවිත කළ යුතු පොහොර මොනවාද?",
  "වැනිලා වසංගත රෝග මගහැරවිය හැක්කේ කෙසේද?",
  "වැනිලා මල් කොච්චර කාලයක් පිපිලා තියෙනවද?",
];

const EXAMPLE_QUESTIONS_EN = [
  "How long does vanilla curing take?",
  "What fertilizers should be used for two-year-old vanilla vines?",
  "When should I harvest vanilla pods?",
  "What should I do if vanilla roots start rotting?",
];

const SINHALA_CHAR_PATTERN = /[඀-෿]/;

const MODE_BADGE: Record<
  AskResult["mode"],
  { label: string; classes: string; note?: string; icon: typeof ShieldCheck }
> = {
  confident: { label: "තොරතුරු සහාය: ඉහළ", classes: "bg-ok-soft text-ok", icon: ShieldCheck },
  cautious: {
    label: "තොරතුරු ප්‍රමාණවත් බව තහවුරු නොවේ",
    classes: "bg-warn-soft text-warn",
    icon: ShieldAlert,
  },
  english: {
    label: "English",
    classes: "bg-border-light text-text-secondary",
    icon: Globe2,
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
  const BadgeIcon = badge.icon;

  return (
    <div className="space-y-5 rounded-2xl border border-border-light bg-white p-6 shadow-[0_4px_18px_-6px_rgba(1,45,29,0.12)]">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${badge.classes}`}
        >
          <BadgeIcon className="h-3.5 w-3.5" aria-hidden />
          {badge.label}
        </span>
        {badge.note && <span className="text-xs text-text-secondary">{badge.note}</span>}
      </div>

      <p
        className={`whitespace-pre-line text-[17px] leading-8 text-text-primary ${notoSansSinhala.className}`}
      >
        {result.answer_text}
      </p>

      <div>
        <button
          type="button"
          onClick={() => setShowDiagnostics((v) => !v)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-secondary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-secondary"
        >
          <BarChart3 className="h-4 w-4" aria-hidden />
          {showDiagnostics ? "Hide" : "Show"} diagnostics
          <ChevronDown
            className={`h-4 w-4 transition-transform duration-200 ${showDiagnostics ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
        {showDiagnostics && (
          <div className="mt-4 space-y-4">
            {result.language === "si" && result.p_sufficient !== null && (
              <SufficiencyBar p={result.p_sufficient} threshold={result.threshold} />
            )}

            <ol className="space-y-3">
              {result.passages.map((p) => (
                <li
                  key={p.chunk_id}
                  className="rounded-xl bg-primary/5 p-4 text-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="flex items-center gap-1.5 font-semibold text-text-primary">
                      <BookOpen className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
                      [{p.rank}] {p.section}
                    </p>
                    <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-text-secondary shadow-sm">
                      score {p.score.toFixed(3)}
                    </span>
                  </div>
                  <p className={`mt-2 whitespace-pre-line text-text-secondary ${notoSansSinhala.className}`}>
                    {p.text}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-light pt-4 text-xs text-text-secondary">
        <span className="inline-flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5" aria-hidden />
          Model: {result.llm_model}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="h-3.5 w-3.5" aria-hidden />
          Total time: {result.timings_ms.total_ms?.toFixed(0)} ms
        </span>
        {result.llm_error && <p className="mt-1 w-full text-warn">Fallback answer (LLM unavailable)</p>}
      </div>
    </div>
  );
}

export default function AdvisoryPage() {
  const [apiStatus, setApiStatus] = useState<"loading" | "ok" | "unreachable" | "checking">("checking");
  const [inputLang, setInputLang] = useState<"si" | "en">("si");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [langError, setLangError] = useState<string | null>(null);
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
    const hasSinhala = SINHALA_CHAR_PATTERN.test(trimmed);
    if (inputLang === "si" && !hasSinhala) {
      setLangError("කරුණාකර ප්‍රශ්නය සිංහලෙන් ලියන්න.");
      return;
    }
    if (inputLang === "en" && hasSinhala) {
      setLangError("Please type your question in English.");
      return;
    }
    setLangError(null);
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

  const switchInputLang = (lang: "si" | "en") => {
    if (lang === inputLang) return;
    setInputLang(lang);
    setQuery("");
    setResult(null);
    setError(null);
    setLangError(null);
  };

  return (
    <div style={{ fontFamily: PAGE_FONT_STACK }} className="mx-auto max-w-7xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-secondary">
              <Leaf className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
                Vanilla Advisory
              </h1>
              <p className="mt-1 text-base text-text-secondary">
                Get guidance on vanilla cultivation in Sinhala or English
              </p>
            </div>
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
          <div className="space-y-6">
            <div className="inline-flex rounded-full border border-border-light bg-white p-1 text-sm shadow-sm">
              <button
                type="button"
                onClick={() => switchInputLang("si")}
                className={`rounded-full px-3 py-1 font-medium transition-colors duration-200 ${
                  inputLang === "si" ? "bg-secondary text-white" : "text-text-secondary"
                } ${notoSansSinhala.className}`}
              >
                සිංහල
              </button>
              <button
                type="button"
                onClick={() => switchInputLang("en")}
                className={`rounded-full px-3 py-1 font-medium transition-colors duration-200 ${
                  inputLang === "en" ? "bg-secondary text-white" : "text-text-secondary"
                }`}
              >
                English
              </button>
            </div>

            <div className="rounded-2xl border border-border-light bg-white p-6 shadow-[0_4px_18px_-6px_rgba(1,45,29,0.12)]">
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit(query);
                  }
                }}
                placeholder={
                  inputLang === "si"
                    ? "ඔබේ ප්‍රශ්නය සිංහලෙන් ලියන්න..."
                    : "Type your question in English..."
                }
                rows={3}
                disabled={loading}
                className={`w-full resize-none rounded-xl border border-border-light p-3 text-sm text-text-primary outline-none transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary ${notoSansSinhala.className}`}
              />
              {langError && <p className="mt-2 text-xs text-danger">{langError}</p>}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                  {(inputLang === "si" ? EXAMPLE_QUESTIONS_SI : EXAMPLE_QUESTIONS_EN).map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => {
                        setQuery(q);
                        setLangError(null);
                        submit(q);
                      }}
                      disabled={loading}
                      className={`inline-flex items-center gap-1.5 rounded-full bg-primary/5 px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-primary/10 disabled:opacity-50 ${notoSansSinhala.className}`}
                    >
                      {q.length > 40 ? `${q.slice(0, 40)}…` : q}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => submit(query)}
                  disabled={loading || !query.trim()}
                  className="inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <SendHorizonal className="h-4 w-4" aria-hidden />
                  )}
                  Ask
                </button>
              </div>
            </div>

            {loading && (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Analysing evidence…
              </p>
            )}
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
                    onClick={() => {
                      setSelectedCacheIdx(i);
                      if (r.language === "si" || r.language === "en") {
                        setInputLang(r.language);
                      }
                    }}
                    className={`rounded-full px-3 py-1 text-xs transition-colors ${
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
    </div>
  );
}
