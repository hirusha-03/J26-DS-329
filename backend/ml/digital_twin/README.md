# Module 2 — Digital Twin analytics

Scripts behind the GPS-referenced Digital Twin (Survey Plan No. 61 plantation). Outputs are written to
`results/` and, once the analyses run against the database, to the tables created by
`backend/migrations/2026-10-17_digital_twin.sql`.

| Script | Workstream | What it does |
|---|---|---|
| `gps_dispersion.py` | WS2 / E1 (RQ1) | Single fix vs mean / weighted mean / median / static Kalman, scored by cross-session repeatability; within-session CEP50 / CEP95 / RMS |

## E1 field protocol

1. In the monitor app open **GPS Re-capture** (`/gps-capture`), pick the slot from its tag, take 10 readings.
2. Repeat at the same plant at a different time of day (second session). Target: ≥3 plants per block.
3. Readings upload to `plant_location_observations` (kept on the phone until the table exists; the
   download button exports them as CSV).

```bash
pip install -r requirements.txt
python gps_dispersion.py observations.csv --out results/e1_gps
# or straight from Supabase:
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python gps_dispersion.py --supabase
```

Results: `report.md` (tables for the dissertation), `summary.json`, `sessions.csv`.
