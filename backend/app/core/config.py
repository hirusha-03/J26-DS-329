import os
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")


def get_cors_origins() -> list[str]:
    origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
    cors_origins_env = os.getenv("CORS_ORIGINS")
    if cors_origins_env:
        origins.extend([o.strip() for o in cors_origins_env.split(",") if o.strip()])
    return list(set(origins))
