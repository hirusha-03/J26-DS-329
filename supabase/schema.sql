-- J26-DS-329 Supabase schema
-- Base (tables 1-10) ported as-is from Vanilla-Monitor's corrected
-- 2026-08-08 schema — reverse-engineered from actual frontend usage.
-- See ../ai_context/vanilla-monitor/known-issues.md and qa.md for context.
--
-- NOT YET VERIFIED against a live Supabase project in this session (no
-- credentials/DB access available) — run on a fresh project's SQL Editor
-- and report back any errors.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Supervisor allowlist — gates login (AuthContext.tsx checkAllowlist)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE supervisor_accounts (
    email TEXT PRIMARY KEY,
    full_name TEXT,
    role TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);
-- Add yourself, e.g.:
-- INSERT INTO supervisor_accounts (email, full_name, role, is_active)
-- VALUES ('you@example.com', 'Your Name', 'admin', true);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Slots — a physical planting spot; GPS lives here, not per-plant.
--    A slot's active_plant_id points at the current generation growing there.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE slots (
    slot_id TEXT PRIMARY KEY,
    zone TEXT NOT NULL,
    block TEXT NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    altitude DOUBLE PRECISION,
    accuracy DOUBLE PRECISION,
    active_plant_id TEXT,
    qr_value TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Plants — static per-vine record, extended with the replant/
--    generation-tracking columns the app actually writes.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE plants (
    plant_id TEXT PRIMARY KEY,
    slot_id TEXT REFERENCES slots(slot_id) ON DELETE SET NULL,
    generation INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',              -- 'active' | 'replaced'
    previous_plant_id TEXT,                     -- self-ref chain; not FK-enforced (upsert order isn't guaranteed)
    replaced_by_plant_id TEXT,
    retired_date TIMESTAMP WITH TIME ZONE,

    zone TEXT NOT NULL,
    block TEXT NOT NULL,
    plant_no INTEGER NOT NULL,

    qr_code TEXT,
    qr_image_url TEXT,

    common_name TEXT,
    latin_name TEXT,
    scientific_name TEXT,
    variety TEXT,
    plant_type TEXT,

    purchase_date DATE,
    planted_date DATE,
    purchased_from TEXT,
    purchase_condition TEXT,
    max_cutting_height_cm NUMERIC,

    planting_arrangement TEXT,
    spacing_between_hedges TEXT,
    spacing_between_rows TEXT,
    land_type TEXT,
    agricultural_land_type TEXT,
    landform_type TEXT,
    support_tree_type TEXT,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Plant locations — kept for backward compatibility. NOT written by the
--    current frontend (GPS now lives on `slots`); safe to omit if starting
--    fresh and nothing else depends on it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE plant_locations (
    plant_id TEXT PRIMARY KEY REFERENCES plants(plant_id) ON DELETE CASCADE,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    altitude DOUBLE PRECISION,
    accuracy DOUBLE PRECISION,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Inspections — periodic per-plant observation logs.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE inspections (
    id TEXT PRIMARY KEY,                         -- app-generated (plant_id-YYYYMMDD-HHMM); can collide within the same minute, see qa.md #7
    plant_id TEXT NOT NULL REFERENCES plants(plant_id) ON DELETE CASCADE,
    inspection_date TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),

    supervisor_name TEXT,
    supervisor_email TEXT,

    watering_status TEXT,
    sunlight_level TEXT,
    sunlight_lux TEXT,
    shade_level TEXT,
    shade_percentage TEXT,

    soil_type TEXT,
    soil_ph NUMERIC,
    soil_ec NUMERIC,
    moisture NUMERIC,
    temperature NUMERIC,
    humidity NUMERIC,

    fertilizer_type TEXT[],
    fertilizer_used TEXT,
    last_fertilized DATE,
    fertilizer_source TEXT DEFAULT 'edited',      -- 'edited' | 'carried'

    vine_height_cm NUMERIC,
    foliage_color TEXT,
    notes TEXT,
    photo_url TEXT,

    sync_status TEXT DEFAULT 'synced',
    reading_source JSONB DEFAULT '{}'::jsonb,     -- e.g. { meter_photo_url: '...' }
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Carried fertilizer — cached last-used fertilizer choice, one global
--    row keyed 'default' (see syncService.ts syncCarriedFertilizer).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE carried_fertilizer (
    id TEXT PRIMARY KEY,                          -- always 'default' in current app usage
    fertilizer_types TEXT[],
    fertilizer_description TEXT,
    last_fertilized_date DATE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    updated_by TEXT
);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Mortality reports — per zone/block dead counts.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE mortality_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    zone TEXT NOT NULL,
    block TEXT NOT NULL,
    dead_support_trees INTEGER DEFAULT 0,
    dead_vines INTEGER DEFAULT 0,
    notes TEXT,
    reported_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Legacy submissions table — old flat inspection record format, still
--    referenced by syncService.ts for backward compatibility. Only needed
--    if you have historical data to preserve; the legacy sync branch
--    simply no-ops on an empty local queue if this table is absent from
--    the write path (but syncService.ts does query/upsert against it, so
--    create it if you want that code path to work rather than error).
-- ─────────────────────────────────────────────────────────────────────────
-- CREATE TABLE submissions ( ... );  -- no complete column list could be
-- confirmed from static analysis alone; check an existing project's
-- actual columns before recreating this one.

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Storage bucket — inspection/meter photos
--    (supabase.storage.from('inspection-photos') in syncService.ts,
--    new-inspection/page.tsx).
-- ─────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('inspection-photos', 'inspection-photos', true)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Row Level Security — NOT DEFINED ANYWHERE in the prior version of
--     this file. The frontend writes with the public anon key, so without
--     RLS, the anon key has whatever default access Supabase gives new
--     tables (RLS off by default = fully open to anyone holding the anon
--     key, which is public in the JS bundle). Decide your actual policy
--     before going to production; a permissive starting point that at
--     least requires *a* logged-in Supabase user (not necessarily an
--     allowlisted one — that's still enforced only client-side in
--     AuthContext) looks like:
-- ─────────────────────────────────────────────────────────────────────────
-- ALTER TABLE plants ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "authenticated read/write" ON plants
--   FOR ALL USING (auth.role() = 'authenticated')
--   WITH CHECK (auth.role() = 'authenticated');
-- -- Repeat per table: slots, inspections, mortality_reports,
-- -- carried_fertilizer, plant_locations.
-- -- supervisor_accounts should probably be read-only to authenticated
-- -- users and writable only by service_role (i.e. no client-side policy
-- -- granting INSERT/UPDATE/DELETE), since it's the access-control list.

-- ─────────────────────────────────────────────────────────────────────────
-- 11. Module 1 — disease detection predictions (owner: Holipitiya).
--     Written by backend/ml/disease_detection once a model is trained.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE disease_detections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plant_id TEXT NOT NULL REFERENCES plants(plant_id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    predicted_class TEXT NOT NULL,           -- one of CLASS_LABELS in ml/disease_detection/model.py
    confidence NUMERIC NOT NULL,
    explanation_image_url TEXT,              -- Grad-CAM/Score-CAM overlay
    model_version TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ─────────────────────────────────────────────────────────────────────────
-- 12. Module 2 — digital twin (owner: Hasapathirathna). Health
--     classifications / spatial-cluster results — table shape TBD by owner.
-- ─────────────────────────────────────────────────────────────────────────
-- CREATE TABLE plant_health_classifications ( ... );

-- ─────────────────────────────────────────────────────────────────────────
-- 13. Module 3 — growth forecasting (owner: Weerasinghe). Vine-length
--     measurements + 4-week forecasts — table shape TBD by owner.
-- ─────────────────────────────────────────────────────────────────────────
-- CREATE TABLE vine_growth_measurements ( ... );

-- ─────────────────────────────────────────────────────────────────────────
-- 14. Module 4 — recommendation NLP (owner: Fonseka). Query/response log +
--     pgvector knowledge base — table shape TBD by owner.
-- ─────────────────────────────────────────────────────────────────────────
-- CREATE EXTENSION IF NOT EXISTS vector;
-- CREATE TABLE recommendation_queries ( ... );
