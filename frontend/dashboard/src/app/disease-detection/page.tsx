"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, ServerOff } from "lucide-react";
import UploadPanel from "@/components/disease/UploadPanel";
import ResultCard from "@/components/disease/ResultCard";
import { DiseaseApiError, getModelStatus, predictDisease, validateImage } from "@/lib/disease/api";
import type { ModelStatus, Prediction } from "@/lib/disease/types";

type ModelState =
  | { kind: "checking" }
  | { kind: "ready"; status: ModelStatus }
  | { kind: "unavailable"; message: string };

type Phase =
  | { kind: "empty" }
  | { kind: "selected" }
  | { kind: "analysing" }
  | { kind: "done"; result: Prediction }
  | { kind: "error"; message: string };

function errorMessage(err: unknown): string {
  return err instanceof DiseaseApiError ? err.message : "Something went wrong while analysing the photo.";
}

export default function DiseaseDetectionPage() {
  const [model, setModel] = useState<ModelState>({ kind: "checking" });
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "empty" });
  const requestId = useRef(0);

  const checkModel = useCallback(async () => {
    setModel({ kind: "checking" });
    try {
      const status = await getModelStatus();
      setModel(
        status.model_loaded
          ? { kind: "ready", status }
          : { kind: "unavailable", message: "The server is running, but no disease model is loaded." },
      );
    } catch (err) {
      setModel({ kind: "unavailable", message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    let active = true;
    getModelStatus()
      .then((status) => {
        if (!active) return;
        setModel(
          status.model_loaded
            ? { kind: "ready", status }
            : { kind: "unavailable", message: "The server is running, but no disease model is loaded." },
        );
      })
      .catch((err) => active && setModel({ kind: "unavailable", message: errorMessage(err) }));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const selectFile = (next: File) => {
    requestId.current++;
    const problem = validateImage(next);
    if (problem) {
      setPhase({ kind: "error", message: problem });
      return;
    }
    setFile(next);
    setPreviewUrl(URL.createObjectURL(next));
    setPhase({ kind: "selected" });
  };

  const clearFile = () => {
    requestId.current++;
    setFile(null);
    setPreviewUrl(null);
    setPhase({ kind: "empty" });
  };

  const analyse = async () => {
    if (!file) return;
    const id = ++requestId.current;
    setPhase({ kind: "analysing" });
    try {
      const result = await predictDisease(file);
      if (id === requestId.current) setPhase({ kind: "done", result });
    } catch (err) {
      if (id !== requestId.current) return;
      if (err instanceof DiseaseApiError && err.status === 503) void checkModel();
      setPhase({ kind: "error", message: errorMessage(err) });
    }
  };

  const modelReady = model.kind === "ready";
  const analysing = phase.kind === "analysing";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">Disease detection</h1>
          <p className="mt-1 max-w-prose text-sm text-text-secondary sm:text-base">
            Check a vanilla leaf or stem photo for black spot, red spot or stem rot.
          </p>
        </div>
        <ModelBadge model={model} />
      </header>

      {model.kind === "unavailable" && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-border-light bg-white p-4 sm:flex-row sm:items-center">
          <ServerOff size={20} className="shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-semibold text-text-primary">Photos can&apos;t be analysed right now</p>
            <p className="text-text-secondary">{model.message}</p>
          </div>
          <button
            type="button"
            onClick={() => void checkModel()}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-border-light px-3 py-2 text-sm font-medium text-text-primary hover:bg-surface focus-visible:outline-2 focus-visible:outline-secondary"
          >
            <RefreshCw size={14} aria-hidden /> Check again
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
        <div className="space-y-4 lg:sticky lg:top-8">
          <UploadPanel
            file={file}
            previewUrl={previewUrl}
            disabled={analysing}
            onSelect={selectFile}
            onClear={clearFile}
          />
          {file && phase.kind !== "done" && (
            <button
              type="button"
              onClick={() => void analyse()}
              disabled={!modelReady || analysing}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3.5 text-base font-semibold text-white transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {analysing && <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden />}
              {analysing ? "Analysing photo…" : "Analyse photo"}
            </button>
          )}
          {phase.kind === "done" && (
            <button
              type="button"
              onClick={clearFile}
              className="w-full rounded-xl border border-border-light bg-white px-5 py-3.5 text-base font-semibold text-text-primary hover:bg-surface focus-visible:outline-2 focus-visible:outline-secondary"
            >
              Analyse another photo
            </button>
          )}
        </div>

        <div aria-live="polite" className="min-w-0">
          {phase.kind === "done" && <ResultCard result={phase.result} />}
          {phase.kind === "error" && (
            <div role="alert" className="flex gap-3 rounded-xl border-l-4 border-danger bg-danger-soft p-4 text-sm">
              <AlertCircle size={20} className="mt-0.5 shrink-0 text-danger" aria-hidden />
              <div className="min-w-0">
                <p className="font-semibold text-text-primary">The photo wasn&apos;t analysed</p>
                <p className="mt-1 text-text-primary">{phase.message}</p>
                {file && (
                  <button
                    type="button"
                    onClick={() => void analyse()}
                    disabled={!modelReady}
                    className="mt-3 font-medium text-danger underline underline-offset-4 disabled:opacity-50"
                  >
                    Try again
                  </button>
                )}
              </div>
            </div>
          )}
          {analysing && <ResultSkeleton />}
          {(phase.kind === "empty" || phase.kind === "selected") && <HowItWorks />}
        </div>
      </div>
    </div>
  );
}

function ModelBadge({ model }: { model: ModelState }) {
  const dot =
    model.kind === "ready" ? "bg-ok" : model.kind === "checking" ? "bg-text-secondary animate-pulse motion-reduce:animate-none" : "bg-danger";
  const text =
    model.kind === "ready"
      ? `Model ${model.status.model_version ?? "loaded"}`
      : model.kind === "checking"
        ? "Checking model…"
        : "Model unavailable";
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border-light bg-white px-3 py-1.5 text-xs font-medium text-text-primary">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {text}
    </span>
  );
}

function ResultSkeleton() {
  return (
    <div className="space-y-5 motion-safe:animate-pulse" aria-label="Analysing photo">
      <div className="h-40 rounded-2xl bg-primary/5" />
      <div className="h-48 rounded-2xl bg-primary/5" />
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="rounded-2xl border border-border-light bg-white p-5 text-sm sm:p-6">
      <h2 className="text-base font-semibold text-text-primary">Getting a useful result</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-text-secondary">
        <li>Fill the frame with one leaf or one stem section, in daylight and in focus.</li>
        <li>Keep hands, tape and labels out of the shot.</li>
        <li>Results the model isn&apos;t sure about are marked for expert review.</li>
        <li>Stem photos and symptoms like yellowing are less reliable than leaf spots.</li>
      </ul>
    </div>
  );
}
