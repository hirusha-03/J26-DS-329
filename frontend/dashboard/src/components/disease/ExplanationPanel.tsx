"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Download, Loader2, ScanEye } from "lucide-react";
import { DiseaseApiError, explainDisease, matchesPrediction } from "@/lib/disease/api";
import { className } from "@/lib/disease/labels";
import type { DiseaseExplanation, ExplanationCapability, Prediction } from "@/lib/disease/types";

type State = { kind: "idle" } | { kind: "loading" } | { kind: "success"; explanation: DiseaseExplanation }
  | { kind: "error"; message: string; stale: boolean };

interface Props {
  file: File;
  prediction: Prediction;
  capability?: ExplanationCapability;
  onReanalyse: () => void;
  onCheckAvailability: () => Promise<ExplanationCapability | undefined>;
}

const buttonClass = "inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-50";

export default function ExplanationPanel({ file, prediction, capability, onReanalyse, onCheckAvailability }: Props) {
  const headingId = useId();
  const opacityId = useId();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [opacity, setOpacity] = useState(42);
  const [waiting, setWaiting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [availabilityMessage, setAvailabilityMessage] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const lifecycle = useRef({ active: false, token: 0, controller: null as AbortController | null,
    retryTimer: undefined as ReturnType<typeof setTimeout> | undefined, objectUrl: null as string | null });
  const cropRef = useRef<HTMLImageElement>(null);
  const heatmapRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const life = lifecycle.current;
    life.active = true;
    return () => {
      life.active = false;
      life.token++;
      life.controller?.abort();
      clearTimeout(life.retryTimer);
      if (life.objectUrl) URL.revokeObjectURL(life.objectUrl);
    };
  }, []);

  const available = capability?.enabled && !["disabled", "unavailable"].includes(capability.state);
  const loading = state.kind === "loading";

  const generate = async () => {
    const life = lifecycle.current;
    if (loading || waiting || life.controller) return;
    const id = ++life.token;
    const controller = new AbortController();
    life.controller = controller;
    setState({ kind: "loading" });
    setDownloading(false);
    setDownloadError(null);
    try {
      const result = await explainDisease(file, prediction.model_version, controller.signal);
      if (!life.active || id !== life.token) return;
      if (!matchesPrediction(result.prediction, prediction)) {
        throw new DiseaseApiError("This explanation describes a different result. Analyse this photo again.", 409);
      }
      setOpacity(42);
      setState({ kind: "success", explanation: result.explanation });
    } catch (err) {
      if (!life.active || id !== life.token || controller.signal.aborted) return;
      const error = err instanceof DiseaseApiError ? err : new DiseaseApiError("The explanation could not be loaded. Try again.");
      setState({ kind: "error", message: error.message, stale: error.status === 409 });
      if (error.retryAfterSeconds && error.retryAfterSeconds > 0) {
        setWaiting(true);
        life.retryTimer = setTimeout(() => { if (life.active && id === life.token) setWaiting(false); }, error.retryAfterSeconds * 1000);
      }
    } finally {
      if (id === life.token) life.controller = null;
    }
  };

  const checkAvailability = async () => {
    if (checking) return;
    const life = lifecycle.current;
    const token = life.token;
    setChecking(true);
    setAvailabilityMessage(null);
    try {
      const updated = await onCheckAvailability();
      if (life.active && token === life.token && (!updated?.enabled || updated.state === "unavailable")) {
        setAvailabilityMessage("Visual explanations are still unavailable on this server.");
      }
    } catch {
      if (life.active && token === life.token) setAvailabilityMessage("Couldn't check explanation availability. Try again.");
    } finally {
      if (life.active && token === life.token) setChecking(false);
    }
  };

  const imageFailed = () => {
    lifecycle.current.token++;
    setDownloading(false);
    setState({ kind: "error", message: "The explanation images could not be displayed. Try again.", stale: false });
  };

  const download = async () => {
    if (state.kind !== "success" || downloading) return;
    const life = lifecycle.current;
    const token = life.token;
    const crop = cropRef.current, heatmap = heatmapRef.current;
    if (!crop || !heatmap) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await Promise.all([crop.decode(), heatmap.decode()]);
      if (!life.active || token !== life.token) return;
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = state.explanation.input_size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(crop, 0, 0, canvas.width, canvas.height);
      context.globalAlpha = opacity / 100;
      context.drawImage(heatmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG unavailable")), "image/png"));
      if (!life.active || token !== life.token) return;
      if (life.objectUrl) URL.revokeObjectURL(life.objectUrl);
      life.objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = life.objectUrl;
      link.download = `gradcam-${file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      if (life.active && token === life.token) setDownloadError("The overlay couldn't be downloaded. Try again.");
    } finally {
      if (life.active && token === life.token) setDownloading(false);
    }
  };

  const explanation = state.kind === "success" ? state.explanation : null;
  const degenerate = explanation?.status === "degenerate";
  return (
    <section aria-labelledby={headingId} aria-busy={loading} className="mt-5 min-w-0 space-y-4 rounded-2xl border border-border-light bg-white p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <ScanEye size={18} className="shrink-0 text-secondary" aria-hidden />
        <h3 id={headingId} className="text-base font-semibold text-text-primary">Visual explanation</h3>
      </div>
      <p className="text-sm leading-relaxed text-text-secondary">See which regions contributed to the {className(prediction.prediction).toLowerCase()} prediction. Highlights are not lesion boundaries or proof that the result is correct.</p>

      {state.kind === "idle" && (available ? (
        <button type="button" className={buttonClass} onClick={() => void generate()}>Show explanation</button>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">Visual explanations are unavailable on this server. Your prediction is still available.</p>
          <button type="button" className={buttonClass} disabled={checking} onClick={() => void checkAvailability()}>{checking ? "Checking availability…" : "Check availability"}</button>
          {availabilityMessage && <p role="status" className="text-sm text-text-secondary">{availabilityMessage}</p>}
        </div>
      ))}
      {loading && <p role="status" className="flex items-start gap-2 text-sm text-text-secondary"><Loader2 size={18} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />Generating explanation… The first request may take a little longer.</p>}
      {state.kind === "error" && (
        <div className="space-y-3">
          <p role="alert" className="rounded-lg bg-warn-soft p-3 text-sm text-text-primary">{state.message}</p>
          <button type="button" className={buttonClass} disabled={waiting} onClick={state.stale ? onReanalyse : () => void generate()}>
            {state.stale ? "Analyse again" : waiting ? "Please wait before retrying…" : "Retry explanation"}
          </button>
        </div>
      )}
      {explanation && (
        <>
          <p className="text-xs leading-relaxed text-text-secondary">The model used this center crop of your photo. Highlights align with the crop, rather than the full uploaded image.</p>
          {degenerate && <p role="status" className="rounded-lg bg-warn-soft p-3 text-sm text-text-primary">No useful highlight was produced for this prediction. The diagnosis and its uncertainty are unchanged.</p>}
          <div className={`grid min-w-0 gap-4 ${degenerate ? "" : "sm:grid-cols-2"}`}>
            <figure className="min-w-0">
              <div className="overflow-hidden rounded-xl bg-surface">
                {/* eslint-disable-next-line @next/next/no-img-element -- dynamic in-memory API PNG, not a remote optimizable asset */}
                <img ref={cropRef} src={explanation.input_crop} alt="Exact model input crop" width={explanation.input_size[0]} height={explanation.input_size[1]} onError={imageFailed} className="aspect-square w-full object-contain" />
              </div>
              <figcaption className="mt-2 text-xs font-medium text-text-secondary">Model input crop</figcaption>
            </figure>
            {!degenerate && <figure className="min-w-0">
              <div className="relative overflow-hidden rounded-xl bg-surface">
                {/* eslint-disable-next-line @next/next/no-img-element -- dynamic in-memory API PNG */}
                <img src={explanation.input_crop} alt="Model crop beneath highlighted contribution" width={explanation.input_size[0]} height={explanation.input_size[1]} className="aspect-square w-full object-contain" />
                {/* eslint-disable-next-line @next/next/no-img-element -- dynamic in-memory API heatmap */}
                <img ref={heatmapRef} src={explanation.heatmap} alt="Positive contribution heatmap" width={explanation.input_size[0]} height={explanation.input_size[1]} onError={imageFailed} style={{ opacity: opacity / 100 }} className="absolute inset-0 h-full w-full object-contain" />
              </div>
              <figcaption className="mt-2 text-xs font-medium text-text-secondary">Highlighted contribution · blue: lower, red: higher</figcaption>
            </figure>}
          </div>
          {!degenerate && <div className="space-y-3">
            <label htmlFor={opacityId} className="flex items-center justify-between gap-3 text-sm font-medium text-text-primary">Highlight opacity <output htmlFor={opacityId}>{opacity}%</output></label>
            <input id={opacityId} type="range" min={0} max={100} value={opacity} onChange={event => setOpacity(Number(event.target.value))} className="w-full accent-secondary focus-visible:outline-2 focus-visible:outline-secondary" />
            <button type="button" className={buttonClass} disabled={downloading} onClick={() => void download()}><Download size={16} aria-hidden />{downloading ? "Preparing PNG…" : "Download overlay"}</button>
            {downloadError && <p role="alert" className="text-sm text-danger">{downloadError}</p>}
          </div>}
          <details className="border-t border-border-light pt-3 text-xs text-text-secondary">
            <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-secondary">Explanation details</summary>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
              <dt>Method</dt><dd>Grad-CAM</dd><dt>Explained source class</dt><dd>{explanation.target_source_class.replace(/_/g, " ")}</dd>
              <dt>Model</dt><dd className="break-all">{prediction.model_version}</dd><dt>Feature layer</dt><dd>{explanation.target_layer} · {explanation.feature_map_size.join(" × ")}</dd>
              <dt>Checkpoint</dt><dd className="break-all">{explanation.checkpoint_sha256}</dd>
            </dl>
          </details>
        </>
      )}
    </section>
  );
}
