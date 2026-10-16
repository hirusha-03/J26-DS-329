import { FlaskConical } from "lucide-react";
import type { Prediction } from "@/lib/disease/types";
import { ACTION_TEXT, TONE_CLASSES, className, classTone, percent } from "@/lib/disease/labels";
import { ModelWarning, ReferBanner } from "./ReviewBanner";

export default function ResultCard({ result }: { result: Prediction }) {
  const needsReview = result.decision === "refer";
  const tone = TONE_CLASSES[needsReview ? "warn" : classTone(result.prediction)];
  const ranked = Object.entries(result.probabilities)
    .map(([label, score]) => ({ label, score }))
    .sort((a, b) => b.score - a.score);

  return (
    <section aria-labelledby="result-heading" className="space-y-5">
      <div className={`rounded-2xl border-t-4 bg-white p-5 shadow-[0_1px_0_rgba(1,45,29,0.06)] sm:p-6 ${tone.border}`}>
        <p className="text-sm text-text-secondary">{needsReview ? "Most likely, but uncertain" : "Result"}</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 id="result-heading" className={`text-4xl font-bold tracking-tight sm:text-5xl ${tone.text}`}>
            {className(result.prediction)}
          </h2>
          <span className="text-lg font-medium tabular-nums text-text-primary">
            {percent(result.confidence)} confidence
          </span>
        </div>
        <p className="mt-4 text-base text-text-primary">
          {ACTION_TEXT[result.action]}
        </p>
      </div>

      <ReferBanner result={result} />
      <ModelWarning text={result.warning} />

      <div className="rounded-2xl border border-border-light bg-white p-5 sm:p-6">
        <h3 className="text-sm font-semibold text-text-primary">Score for each class</h3>
        <ul className="mt-4 space-y-3">
          {ranked.map(({ label, score }) => {
            const t = TONE_CLASSES[classTone(label)];
            return (
              <li key={label} className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-3 text-sm">
                <span className="truncate text-text-primary">{className(label)}</span>
                <span
                  className="h-2 overflow-hidden rounded-full bg-primary/5"
                  role="meter"
                  aria-label={`${className(label)} score`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(score * 100)}
                >
                  <span className={`block h-full rounded-full ${t.bar}`} style={{ width: percent(score) }} />
                </span>
                <span className="text-right tabular-nums text-text-secondary">{percent(score)}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-5 text-xs leading-relaxed text-text-secondary">
          Black spot and red spot are combined as leaf spot. Symptoms the model was not trained on, such as
          yellowing, are forced into the nearest class. Model {result.model_version}.
        </p>
      </div>

      {result.experimental && (
        <details className="rounded-2xl border border-dashed border-border-light bg-white p-5 sm:p-6">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-text-primary">
            <FlaskConical size={16} className="text-secondary" aria-hidden />
            Experimental: healthy-reference check
          </summary>
          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-text-secondary">Healthy-reference score</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums text-text-primary">
                {result.experimental.healthy_ref_score.toFixed(3)}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">Conformal p-value</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums text-text-primary">
                {result.experimental.p_value.toFixed(3)}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-text-secondary">
            Research prototype. It compares this photo with confirmed healthy leaf photos. Its error rate has not
            been validated, and it does not apply to stem photos.
          </p>
        </details>
      )}
    </section>
  );
}
