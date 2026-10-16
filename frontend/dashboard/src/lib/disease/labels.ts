import type { DiseaseAction, DiseaseClass } from "./types";

export type Tone = "ok" | "warn" | "danger";

export const CLASS_INFO: Record<DiseaseClass, { name: string; tone: Tone }> = {
  healthy: { name: "Healthy", tone: "ok" },
  leaf_spot: { name: "Leaf spot", tone: "warn" },
  stem_rot: { name: "Stem rot", tone: "danger" },
};

export const ACTION_TEXT: Record<DiseaseAction, string> = {
  monitor: "No treatment needed. Keep monitoring this vine.",
  treat_leaf_disease: "Treat for leaf disease and recheck the vine.",
  urgent_stem_rot: "Treat for stem rot urgently and isolate the vine.",
  expert_review: "Send this photo to an expert before acting.",
};

export function className(label: string): string {
  return CLASS_INFO[label as DiseaseClass]?.name ?? label.replace(/_/g, " ");
}

export function classTone(label: string): Tone {
  return CLASS_INFO[label as DiseaseClass]?.tone ?? "warn";
}

export const TONE_CLASSES: Record<Tone, { text: string; bg: string; bar: string; border: string }> = {
  ok: { text: "text-ok", bg: "bg-ok-soft", bar: "bg-ok", border: "border-ok" },
  warn: { text: "text-warn", bg: "bg-warn-soft", bar: "bg-warn", border: "border-warn" },
  danger: { text: "text-danger", bg: "bg-danger-soft", bar: "bg-danger", border: "border-danger" },
};

export function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}
