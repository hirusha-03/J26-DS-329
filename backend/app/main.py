from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_cors_origins
from app.core.supabase_client import supabase
from app.routers import gps, inspections, mortality, ocr, plant_locations, plants, submissions

app = FastAPI(
    title="Vanilla Monitor API",
    description="Backend API for plantation inspections, GPS tracking, and mortality reports.",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(plants.router)
app.include_router(plant_locations.router)
app.include_router(inspections.router)
app.include_router(submissions.router)
app.include_router(gps.router)
app.include_router(mortality.router)
app.include_router(ocr.router)


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "database_connected": supabase is not None
    }
