from fastapi import APIRouter, HTTPException, status

from app.core.mock_store import mock_locations_list
from app.core.supabase_client import supabase
from app.schemas import GPSRecord

router = APIRouter(prefix="/api/gps", tags=["gps"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def save_gps(gps: GPSRecord):
    if not supabase:
        data = {"plant_id": gps.plant_id, "latitude": gps.lat, "longitude": gps.lng}
        mock_locations_list[:] = [l for l in mock_locations_list if l["plant_id"] != gps.plant_id]
        mock_locations_list.append(data)
        return {"message": "GPS saved successfully (mock mode)", "data": gps}
    try:
        data = {"plant_id": gps.plant_id, "latitude": gps.lat, "longitude": gps.lng}
        response = supabase.table("plant_locations").upsert(data).execute()
        return {"message": "GPS saved successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("")
async def get_gps():
    if not supabase:
        res = [{"plant_id": l["plant_id"], "lat": l["latitude"], "lng": l["longitude"]} for l in mock_locations_list]
        return {"data": res}
    try:
        response = supabase.table("plant_locations").select("plant_id, latitude, longitude").execute()
        res = [{"plant_id": r["plant_id"], "lat": r["latitude"], "lng": r["longitude"]} for r in response.data]
        return {"data": res}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
