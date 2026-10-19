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
  /** Absent on older prediction-only backends. */
  explanation?: ExplanationCapability;
}

export type SourceDiseaseClass = "healthy" | "black_spot" | "red_spot" | "stem_rot";

export interface ExplanationCapability {
  enabled: boolean;
  loaded: boolean;
  method: "gradcam";
  state: "disabled" | "unavailable" | "not_loaded" | "ready" | "error";
  detail: string | null;
}

export interface DiseaseExplanation {
  method: "gradcam";
  target_source_class: SourceDiseaseClass;
  target_display_class: DiseaseClass;
  target_layer: string;
  status: "ok" | "degenerate";
  input_size: [number, number];
  feature_map_size: [number, number];
  input_crop: string;
  heatmap: string;
  overlay: string;
  checkpoint_sha256: string;
  elapsed_ms: number;
  note: string;
}

export interface ExplainResponse {
  prediction: Prediction;
  explanation: DiseaseExplanation;
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
