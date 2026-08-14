"""Module 3 — vine length measurement + growth forecasting (owner: Weerasinghe). Placeholder."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/growth", tags=["growth-forecasting"])


@router.get("/status")
def status():
    raise HTTPException(status_code=501, detail="Not implemented — see README.md for owner.")
