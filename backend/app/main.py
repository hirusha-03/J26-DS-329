from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import CORS_ORIGINS
from ml.disease_detection.router import router as disease_router
from ml.digital_twin.router import router as digital_twin_router
from ml.growth_forecasting.router import router as growth_router
from ml.recommendation_nlp.router import router as assistant_router

app = FastAPI(title="J26-DS-329 — Vanilla Plantation AI Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


app.include_router(disease_router)
app.include_router(digital_twin_router)
app.include_router(growth_router)
app.include_router(assistant_router)
