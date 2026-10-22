"""Digital Twin (Module 2) API: twin state per plant and the analytic outputs.

Classification, hotspot and trend outputs come from the ML jobs. Until those have run (or before
migrations/2026-10-17_digital_twin.sql is applied) the analytic endpoints answer
status "not_available", so the field app can integrate now without depending on them.
"""

from typing import Any, Optional

from fastapi import APIRouter, Query

from app.core.supabase_client import supabase

router = APIRouter(prefix="/api/twin", tags=["digital_twin"])

ANALYTIC_FIELDS = (
    "health_class", "health_probability", "health_model", "health_model_version",
    "in_hotspot", "hotspot_cluster_id", "trend", "trend_slope",
)


def _not_available(reason: str) -> dict[str, Any]:
    return {"status": "not_available", "reason": reason, "data": []}


def _state_from_base_tables(zone: Optional[str]) -> list[dict[str, Any]]:
    """twin_state without the view: plants + slots + latest inspection, analytic fields empty."""
    plants_q = supabase.table("plants").select("plant_id, zone, block, slot_id, status, replaced_by_plant_id")
    if zone:
        plants_q = plants_q.eq("zone", zone)
    plants = plants_q.execute().data or []
    slots = {s["slot_id"]: s for s in (supabase.table("slots").select("slot_id, latitude, longitude, accuracy").execute().data or [])}
    latest: dict[str, dict[str, Any]] = {}
    inspections = (
        supabase.table("inspections")
        .select("plant_id, inspection_date, foliage_color, soil_ph, soil_ec, moisture, temperature, humidity, vine_height_cm")
        .execute()
        .data
        or []
    )
    for i in inspections:
        prev = latest.get(i["plant_id"])
        if i.get("inspection_date") and (not prev or str(i["inspection_date"]) > str(prev["inspection_date"])):
            latest[i["plant_id"]] = i

    rows = []
    for p in plants:
        if p.get("status") in ("retired", "replaced") or p.get("replaced_by_plant_id"):
            continue
        s = slots.get(p.get("slot_id") or "", {})
        i = latest.get(p["plant_id"], {})
        rows.append({
            "plant_id": p["plant_id"],
            "zone": p.get("zone"),
            "block": p.get("block"),
            "block_id": f"{p.get('zone')}-{p.get('block')}" if p.get("zone") and p.get("block") else None,
            "slot_id": p.get("slot_id"),
            "latitude": s.get("latitude"),
            "longitude": s.get("longitude"),
            "location_error_m": s.get("accuracy"),
            "location_source": "single_fix" if s else None,
            "last_inspection_date": i.get("inspection_date"),
            **{k: i.get(k) for k in ("foliage_color", "soil_ph", "soil_ec", "moisture", "temperature", "humidity", "vine_height_cm")},
            **{k: None for k in ANALYTIC_FIELDS},
        })
    return rows


@router.get("/state")
async def get_twin_state(zone: Optional[str] = Query(None, description="Filter by zone, e.g. A")):
    """One row per active plant: identity, best coordinate, latest inspection and analytic outputs (nullable)."""
    if not supabase:
        return {"source": "mock", "data": []}
    try:
        q = supabase.table("twin_state").select("*")
        if zone:
            q = q.eq("zone", zone)
        return {"source": "twin_state", "data": q.execute().data or []}
    except Exception:
        # View not installed yet: same shape from the operational tables.
        return {"source": "base_tables", "data": _state_from_base_tables(zone)}


def _analytic(table: str, label: str, filters: dict[str, Optional[str]]) -> dict[str, Any]:
    if not supabase:
        return _not_available("Database not connected (mock mode).")
    try:
        q = supabase.table(table).select("*")
        for col, val in filters.items():
            if val:
                q = q.eq(col, val)
        data = q.execute().data or []
    except Exception:
        return _not_available(f"{label} tables are not installed yet.")
    if not data:
        return _not_available(f"No {label.lower()} results yet: waiting for inspection history and the health label.")
    return {"status": "ok", "data": data}


@router.get("/classifications")
async def get_classifications(plant_id: Optional[str] = None, model: Optional[str] = None):
    return _analytic("health_classifications", "Health classification", {"plant_id": plant_id, "model": model})


@router.get("/hotspots")
async def get_hotspots(cycle: Optional[str] = None):
    return _analytic("plant_health_hotspots", "Hotspot", {"cycle": cycle})


@router.get("/trends")
async def get_trends(level: Optional[str] = Query(None, pattern="^(plant|block|zone)$"), entity_id: Optional[str] = None):
    return _analytic("health_trends", "Trend", {"level": level, "entity_id": entity_id})
