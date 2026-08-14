"""Module 4 — Sinhala/code-mixed query understanding + RAG recommendations (owner: Fonseka). Placeholder."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/assistant", tags=["recommendation-nlp"])


@router.get("/status")
def status():
    raise HTTPException(status_code=501, detail="Not implemented — see README.md for owner.")
