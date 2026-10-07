from fastapi import APIRouter, HTTPException, status

from app.core.mock_store import mock_submissions_list
from app.core.supabase_client import supabase
from app.schemas import Submission

router = APIRouter(prefix="/api/submissions", tags=["submissions"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_submission(submission: Submission):
    if not supabase:
        data = submission.dict()
        mock_submissions_list[:] = [s for s in mock_submissions_list if s["id"] != submission.id]
        mock_submissions_list.append(data)
        return {"message": "Saved successfully (mock mode)", "data": submission}
    try:
        data = submission.dict()
        response = supabase.table("submissions").upsert(data).execute()
        return {"message": "Submission synced successfully", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("")
async def get_submissions():
    if not supabase:
        return {"data": mock_submissions_list}
    try:
        response = supabase.table("submissions").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
