"""Module 2 (Hasapathirathna) — GPS-referenced digital twin / spatial clustering.

Placeholder only — implementation owned by the Hasapathirathna module.
"""
from fastapi import APIRouter, HTTPException, status

router = APIRouter(prefix="/api/digital-twin-ml", tags=["digital-twin-ml"])


@router.get("/status")
def status_check():
    return {"module": "digital_twin", "owner": "Hasapathirathna", "implemented": False}


@router.get("/hotspots")
def hotspots():
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Digital twin disease-hotspot clustering not implemented yet.",
    )
