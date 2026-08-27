from typing import Optional

from supabase import create_client, Client

from app.core.config import SUPABASE_URL, SUPABASE_ANON_KEY

supabase: Optional[Client] = None
if SUPABASE_URL and SUPABASE_ANON_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
        print("Supabase client initialized successfully.")
    except Exception as e:
        print(f"Failed to initialize Supabase client: {e}")
else:
    print("Warning: Supabase credentials not found. API running in fallback local mock mode.")
