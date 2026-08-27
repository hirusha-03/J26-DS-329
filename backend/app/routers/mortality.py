from fastapi import APIRouter, HTTPException, status

from app.core.mock_store import mock_mortality_list
from app.core.supabase_client import supabase
from app.schemas import MortalityReport

router = APIRouter(prefix="/api/mortality", tags=["mortality"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_mortality_report(report: MortalityReport):
    if not supabase:
        data = report.dict()
        mock_mortality_list[:] = [m for m in mock_mortality_list if m["id"] != report.id]
        mock_mortality_list.append(data)
        return {"message": "Mortality report saved successfully (mock mode)", "data": report}
    try:
        data = report.dict()
        response = supabase.table("mortality_reports").upsert(data).execute()
        return {"message": "Mortality report saved successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("")
async def get_mortality_reports():
    if not supabase:
        return {"data": mock_mortality_list}
    try:
        response = supabase.table("mortality_reports").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
