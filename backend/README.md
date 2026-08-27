# Vanilla Monitor - FastAPI Backend

This is the backend API server for the Vanilla Monitor PWA. It connects to Supabase as its primary datastore and provides clean API endpoints for logging plantation inspections, plant GPS coordinates, and vine mortality reports.

## Prerequisites

- **Python 3.8+**
- **pip** (Python package installer)

## Getting Started

1. **Navigate to the backend directory**:
   ```bash
   cd backend
   ```

2. **Create a virtual environment**:
   ```bash
   python -m venv .venv
   ```

3. **Activate the virtual environment**:
   - **Windows**:
     ```powershell
     .venv\Scripts\Activate.ps1
     ```
   - **macOS / Linux**:
     ```bash
     source .venv/bin/activate
     ```

4. **Install the dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

5. **Configure environment variables**:
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Edit `.env` and fill in your actual Supabase URL and Anon Key. If left empty, the server will start in fallback mock mode.

6. **Start the API Server**:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```

7. **Verify the server is running**:
   - Access the health check endpoint: [http://localhost:8000/health](http://localhost:8000/health)
   - View the interactive Swagger API documentation: [http://localhost:8000/docs](http://localhost:8000/docs)
