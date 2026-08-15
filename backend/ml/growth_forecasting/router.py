"""Module 3 (Weerasinghe) — CV vine-length measurement + growth forecasting.

Placeholder only — implementation owned by the Weerasinghe module.
"""
from fastapi import APIRouter, HTTPException, status

router = APIRouter(prefix="/api/growth-forecasting", tags=["growth-forecasting"])


@router.get("/status")
def status_check():
    return {"module": "growth_forecasting", "owner": "Weerasinghe", "implemented": False}


@router.post("/measure")
def measure():
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Vine-length measurement/forecasting pipeline not implemented yet.",
    )
