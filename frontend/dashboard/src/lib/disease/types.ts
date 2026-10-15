// Contract for the M1 disease-detection API (backend/app/routers/disease.py).
// Classes and actions mirror backend/ml/disease_detection/configs/labels.yaml.

export type DiseaseClass = "healthy" | "black_spot" | "red_spot" | "stem_rot";

export type DiseaseAction =
  | "monitor"
  | "treat_leaf_disease"
  | "urgent_stem_rot"
  | "expert_review";

export interface ModelStatus {
  model_loaded: boolean;
  model_version: string | null;
  classes: DiseaseClass[];
}

export interface ClassScore {
  label: DiseaseClass;
  score: number;
}

export interface ReviewState {
  status: "auto" | "needs_review";
  reasons: string[];
}

/** Healthy-reference conformal routing (E4a). Research prototype, not validated. */
export interface ExperimentalScores {
  healthy_ref_score: number;
  p_value: number;
}

export interface Prediction {
  model_version: string;
  predicted_class: DiseaseClass;
  score: number;
  probabilities: ClassScore[];
  action: DiseaseAction;
  review: ReviewState;
  experimental?: ExperimentalScores | null;
}
