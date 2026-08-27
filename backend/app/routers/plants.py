from fastapi import APIRouter, HTTPException, status

from app.core.mock_store import mock_plants_list
from app.core.supabase_client import supabase
from app.schemas import Plant

router = APIRouter(prefix="/api/plants", tags=["plants"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_plant(plant: Plant):
    if not supabase:
        data = plant.dict()
        mock_plants_list[:] = [p for p in mock_plants_list if p["plant_id"] != plant.plant_id]
        mock_plants_list.append(data)
        return {"message": "Plant saved successfully (mock mode)", "data": data}
    try:
        data = plant.dict()
        response = supabase.table("plants").upsert(data).execute()
        return {"message": "Plant synced successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("")
async def get_plants():
    if not supabase:
        return {"data": mock_plants_list}
    try:
        response = supabase.table("plants").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
