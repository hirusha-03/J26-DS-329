"""Additive, typed disease explanation API contract."""

from typing import Literal

from pydantic import BaseModel, Field

DiseaseClass = Literal["healthy", "leaf_spot", "stem_rot"]
SourceClass = Literal["healthy", "black_spot", "red_spot", "stem_rot"]


class PredictionResponse(BaseModel):
    model_version: str
    prediction: DiseaseClass
    decision: Literal["accept", "refer"]
    confidence: float = Field(ge=0, le=1)
    probabilities: dict[DiseaseClass, float]
    action: Literal["monitor", "treat_leaf_disease", "urgent_stem_rot", "expert_review"]
    warning: str
    experimental: dict[str, float] | None = None


class ExplanationCapability(BaseModel):
    enabled: bool
    loaded: bool
    method: Literal["gradcam"] = "gradcam"
    state: Literal["disabled", "unavailable", "not_loaded", "ready", "error"]
    detail: str | None = None


class ExplanationResponse(BaseModel):
    method: Literal["gradcam"] = "gradcam"
    target_source_class: SourceClass
    target_display_class: DiseaseClass
    target_layer: str
    status: Literal["ok", "degenerate"]
    input_size: tuple[int, int]
    feature_map_size: tuple[int, int]
    input_crop: str
    heatmap: str
    overlay: str
    checkpoint_sha256: str
    elapsed_ms: float = Field(ge=0)
    note: str


class ExplainResponse(BaseModel):
    prediction: PredictionResponse
    explanation: ExplanationResponse


class ModelStatusResponse(BaseModel):
    model_loaded: bool
    model_version: str | None
    classes: list[DiseaseClass]
    status: str
    detail: str | None
    explanation: ExplanationCapability
