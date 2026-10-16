import { ShieldAlert, TriangleAlert } from "lucide-react";
import type { Prediction } from "@/lib/disease/types";
import { percent } from "@/lib/disease/labels";

export function ReferBanner({ result }: { result: Prediction }) {
  if (result.decision !== "refer") return null;

  return (
    <div role="status" className="flex gap-3 rounded-xl border-l-4 border-warn bg-warn-soft p-4">
      <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-text-primary">Needs expert review</p>
        <p className="mt-1 text-text-secondary">
          {`The model is only ${percent(result.confidence)} sure, so this result shouldn't be acted on alone.`}
        </p>
      </div>
    </div>
  );
}

export function ModelWarning({ text }: { text: string }) {
  return (
    <p className="flex gap-2 rounded-xl border border-border-light bg-white p-3 text-xs leading-relaxed text-text-secondary">
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden />
      <span>{text}</span>
    </p>
  );
}
