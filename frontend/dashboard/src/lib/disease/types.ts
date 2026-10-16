// Contract for the M1 disease-detection API (backend/app/routers/disease.py).
// Stable across model versions: E1 baseline now, E4 conformal routing later.

export type DiseaseClass = "healthy" | "leaf_spot" | "stem_rot";

export type DiseaseAction =
  | "monitor"
  | "treat_leaf_disease"
  | "urgent_stem_rot"
  | "expert_review";

export interface ModelStatus {
  model_loaded: boolean;
  model_version: string | null;
  classes: DiseaseClass[];
  status: string;
  detail: string | null;
}

/** Healthy-reference conformal routing (E4a). Research prototype, not validated. */
export interface ExperimentalScores {
  healthy_ref_score: number;
  p_value: number;
}

export interface Prediction {
  model_version: string;
  prediction: DiseaseClass;
  decision: "accept" | "refer";
  confidence: number;
  probabilities: Record<DiseaseClass, number>;
  action: DiseaseAction;
  warning: string;
  experimental?: ExperimentalScores | null;
}
