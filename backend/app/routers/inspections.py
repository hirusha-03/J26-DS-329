from fastapi import APIRouter, HTTPException, status

from app.core.mock_store import mock_inspections_list
from app.core.supabase_client import supabase
from app.schemas import Inspection

router = APIRouter(prefix="/api/inspections", tags=["inspections"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_inspection(inspection: Inspection):
    if not supabase:
        data = inspection.dict()
        mock_inspections_list[:] = [i for i in mock_inspections_list if i["id"] != inspection.id]
        mock_inspections_list.append(data)
        return {"message": "Inspection saved successfully (mock mode)", "data": data}
    try:
        data = inspection.dict()
        response = supabase.table("inspections").upsert(data).execute()
        return {"message": "Inspection synced successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("")
async def get_inspections():
    if not supabase:
        return {"data": mock_inspections_list}
    try:
        response = supabase.table("inspections").select("*").order("created_at", descending=True).execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
