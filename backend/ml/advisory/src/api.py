"""FastAPI service wrapping AdvisoryRAG for the live demo.

Run from backend/ml/advisory (loads BGE-M3 once at startup; never use --reload,
it would load the model a second time):

    .venv-features\\Scripts\\python.exe -m uvicorn src.api:app --host 127.0.0.1 --port 8001
"""

import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # rag.py/config.py use bare imports

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

import config
from rag import AdvisoryRAG

app = FastAPI(title="Vanilla Advisory API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_rag: AdvisoryRAG | None = None
_rag_lock = threading.Lock()


@app.on_event("startup")
def _load_model():
    global _rag
    _rag = AdvisoryRAG()


class AskRequest(BaseModel):
    query: str

    @field_validator("query")
    @classmethod
    def _validate_query(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("query must not be empty")
        if len(v) > 500:
            raise ValueError("query must be at most 500 characters")
        return v


@app.exception_handler(Exception)
async def _on_error(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": "internal error"})


@app.get("/health")
def health():
    if _rag is None:
        return {"status": "loading", "llm_model": None, "threshold": None}
    return {"status": "ok", "llm_model": _rag.llm_model, "threshold": _rag.threshold}


@app.post("/ask")
def ask(req: AskRequest):
    if _rag is None:
        return JSONResponse(status_code=503, content={"error": "model still loading"})
    with _rag_lock:
        result = _rag.answer(req.query)
    return JSONResponse(content=result)


@app.get("/demo-cache")
def demo_cache():
    path = config.OUTPUTS_DIR / "demo_cache.jsonl"
    if not path.exists():
        return []
    results = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            results.append(json.loads(line))
    return results
