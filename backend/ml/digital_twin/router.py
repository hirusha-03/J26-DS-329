"""Module 2 — GPS-referenced digital twin (owner: Hasapathirathna). Placeholder."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/digital-twin", tags=["digital-twin"])


@router.get("/status")
def status():
    raise HTTPException(status_code=501, detail="Not implemented — see README.md for owner.")
