# 🚀 Full Project Setup Guide

This guide provides step-by-step instructions for setting up and running the project (Backend FastAPI + Frontend Next.js) on any laptop (Windows, macOS, or Linux).

---

## 📋 Prerequisites

Before starting, ensure the following software is installed on the laptop:

1. **Git**: [Download Git](https://git-scm.com/)
2. **Node.js** (v18.0.0 or higher) & **npm**: [Download Node.js](https://nodejs.org/)
3. **Python** (v3.10 or higher) & **pip**: [Download Python](https://www.python.org/)

---

## 📥 1. Clone the Repository

Open your terminal (PowerShell, Command Prompt, or Terminal) and run:

```bash
git clone <YOUR_REPOSITORY_URL>
cd Vanilla
```

---

## ⚙️ 2. Backend Setup (FastAPI)

### Step 2.1: Navigate to backend folder
```bash
cd backend
```

The API lives under `backend/app/` (routers/services/core) — the FastAPI
entrypoint is `app.main:app`, not `main:app`.

### Step 2.2: Create and Activate a Python Virtual Environment
- **Windows (PowerShell)**:
  ```powershell
  python -m venv .venv
  .\.venv\Scripts\activate
  ```
- **macOS / Linux**:
  ```bash
  python3 -m venv .venv
  source .venv/bin/activate
  ```

### Step 2.3: Install Backend Dependencies
```bash
pip install -r requirements.txt
```

### Step 2.4: Create Backend Environment File (`.env`)
Create a file named `.env` inside the `backend` folder (or copy from `.env.example`):

- **Windows**: `copy .env.example .env`
- **Mac/Linux**: `cp .env.example .env`

**Contents of `backend/.env`**:
```env
# Supabase Credentials
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key

# Optional CORS setup
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

### Step 2.5: Run Backend Server
```bash
uvicorn app.main:app --reload --port 8000
```
- API will be accessible at: `http://localhost:8000`
- Interactive API Documentation: `http://localhost:8000/docs`

---

## 💻 3. Frontend Setup (Next.js)

This repo is an npm-workspaces monorepo with two Next.js apps:
`frontend/monitor` (the field-inspector data-collection PWA) and
`frontend/dashboard` (the analytics/overview app). You can run either one
standalone.

Open a **new terminal tab/window**.

### Step 3.1: Install Node Dependencies (from repo root)
```bash
npm install
```
This resolves dependencies for both `frontend/monitor` and `frontend/dashboard`
via npm workspaces — no need to `cd` into each app to install.

### Step 3.2: Create Frontend Environment File (`.env.local`)
Create a file named `.env.local` inside `frontend/monitor` (and, if working
on the dashboard, `frontend/dashboard` too) — or copy from `.env.example`:

- **Windows**: `copy .env.example .env.local`
- **Mac/Linux**: `cp .env.example .env.local`

**Contents of `frontend/.env.local`**:
```env
# Backend API URL
NEXT_PUBLIC_API_URL=http://localhost:8000

# Supabase Credentials
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-supabase-anon-key

# Google Drive & Sheets Integration (Optional)
NEXT_PUBLIC_GOOGLE_CLIENT_ID=1042875980541-9ae7r45eiekqa8iak0vqjj7atl6a630e.apps.googleusercontent.com
NEXT_PUBLIC_SPREADSHEET_ID=1o4--rtB8-AAhF5YkV2j9RGq8n1mRPV5EWCYGVi2k8-Q
NEXT_PUBLIC_DRIVE_ZONE_A_FOLDER_ID=1ndIy-3aztLTyvsDnhzX_jt9H3LqcBsD7
NEXT_PUBLIC_DRIVE_ZONE_B_FOLDER_ID=1TbH9lLRY-39TRPe5-5uEF1_OqrUvROIp
NEXT_PUBLIC_DRIVE_ZONE_C_FOLDER_ID=1T4glr3qb5rgJLCoqS6yRdLT7hzk93wlQ
NEXT_PUBLIC_DRIVE_ZONE_D_FOLDER_ID=1EvwZ1c9OUPidjtXDA9oDqvLZEnPWyrsG
```

### Step 3.4: Run Frontend Development Server
From the repo root, run just the app you're working on:
```bash
npm run dev:monitor      # field-inspector app -> http://localhost:3000
npm run dev:dashboard    # analytics dashboard -> http://localhost:3001 (Next.js auto-picks a free port)
```

---

## 🗄️ 4. Database Setup (Supabase)

If setting up a fresh database instance:
1. Log in to [Supabase Console](https://supabase.com/).
2. Create a project and obtain your `SUPABASE_URL` & `SUPABASE_ANON_KEY`.
3. Go to the **SQL Editor** tab in Supabase.
4. Copy and execute the contents of [`backend/supabase_schema.sql`](backend/supabase_schema.sql) to set up tables and security policies.

---

## 🧪 Summary of Execution Commands

| Component | Directory | Terminal Command | Local URL |
| :--- | :--- | :--- | :--- |
| **Backend** | `./backend` | `uvicorn app.main:app --reload --port 8000` | `http://localhost:8000` |
| **Monitor** (field-inspector) | `./frontend/monitor` | `npm run dev:monitor` (from root) | `http://localhost:3000` |
| **Dashboard** (analytics) | `./frontend/dashboard` | `npm run dev:dashboard` (from root) | Next.js-assigned port |
