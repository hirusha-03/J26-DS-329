"""Module 4 (Fonseka) — Sinhala/code-mixed query understanding + RAG recommendations.

Placeholder only — implementation owned by the Fonseka module.
"""
from fastapi import APIRouter, HTTPException, status

router = APIRouter(prefix="/api/recommendation", tags=["recommendation-nlp"])


@router.get("/status")
def status_check():
    return {"module": "recommendation_nlp", "owner": "Fonseka", "implemented": False}


@router.post("/query")
def query():
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Recommendation/RAG pipeline not implemented yet.",
    )
