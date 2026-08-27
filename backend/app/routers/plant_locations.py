from fastapi import APIRouter, HTTPException, status

from app.core.mock_store import mock_locations_list
from app.core.supabase_client import supabase
from app.schemas import PlantLocation

router = APIRouter(prefix="/api/plant_locations", tags=["plant_locations"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_plant_location(location: PlantLocation):
    if not supabase:
        data = location.dict()
        mock_locations_list[:] = [l for l in mock_locations_list if l["plant_id"] != location.plant_id]
        mock_locations_list.append(data)
        return {"message": "Location saved successfully (mock mode)", "data": data}
    try:
        data = location.dict()
        response = supabase.table("plant_locations").upsert(data).execute()
        return {"message": "Location synced successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("")
async def get_plant_locations():
    if not supabase:
        return {"data": mock_locations_list}
    try:
        response = supabase.table("plant_locations").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
