-- Module 2 (GPS-referenced Digital Twin): analytic tables and the twin_state view.
-- Run once in the Supabase SQL editor. Safe to re-run (IF NOT EXISTS / OR REPLACE).
-- Analytic outputs are written by the ML jobs with the service role and are NULL in twin_state
-- until those jobs run, so the app never depends on unfinished analytics.

-- ── GPS ───────────────────────────────────────────────────────────────────────

-- Every raw fix taken at a slot (repeated fixes for the GPS dispersion experiment, E1).
CREATE TABLE IF NOT EXISTS plant_location_observations (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slot_id       TEXT NOT NULL REFERENCES slots(slot_id) ON DELETE CASCADE,
    session_id    TEXT,                     -- one capture session (≥10 fixes)
    latitude      DOUBLE PRECISION NOT NULL,
    longitude     DOUBLE PRECISION NOT NULL,
    altitude      DOUBLE PRECISION,
    accuracy      DOUBLE PRECISION,         -- reported horizontal accuracy (m)
    captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    device        TEXT,
    captured_by   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plant_location_observations_slot_idx ON plant_location_observations (slot_id);

-- Best-estimate coordinate per slot and how much the fixes scattered.
CREATE TABLE IF NOT EXISTS plant_locations_smoothed (
    slot_id        TEXT PRIMARY KEY REFERENCES slots(slot_id) ON DELETE CASCADE,
    latitude       DOUBLE PRECISION NOT NULL,
    longitude      DOUBLE PRECISION NOT NULL,
    method         TEXT NOT NULL,           -- raw | mean | weighted_mean | median | kalman
    n_fixes        INTEGER NOT NULL,
    cep50_m        DOUBLE PRECISION,
    cep95_m        DOUBLE PRECISION,
    rms_m          DOUBLE PRECISION,
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    params         JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ── Analytics outputs ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS health_classifications (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plant_id       TEXT NOT NULL REFERENCES plants(plant_id) ON DELETE CASCADE,
    cycle          DATE NOT NULL,           -- inspection cycle (month start)
    model          TEXT NOT NULL,           -- baseline_rule | random_forest | xgboost
    model_version  TEXT NOT NULL,
    health_class   TEXT NOT NULL,
    probability    DOUBLE PRECISION,
    params         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plant_id, cycle, model, model_version)
);

CREATE TABLE IF NOT EXISTS plant_health_hotspots (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plant_id       TEXT NOT NULL REFERENCES plants(plant_id) ON DELETE CASCADE,
    cycle          DATE NOT NULL,
    cluster_id     INTEGER NOT NULL,        -- -1 = noise (not in a hotspot)
    eps_m          DOUBLE PRECISION NOT NULL,
    min_pts        INTEGER NOT NULL,
    model_version  TEXT NOT NULL,
    params         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plant_id, cycle, eps_m, min_pts, model_version)
);

CREATE TABLE IF NOT EXISTS health_trends (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    level          TEXT NOT NULL CHECK (level IN ('plant', 'block', 'zone')),
    entity_id      TEXT NOT NULL,           -- plant_id, "A-01" or "A"
    window_start   DATE NOT NULL,
    window_end     DATE NOT NULL,
    n_cycles       INTEGER NOT NULL,
    trend          TEXT NOT NULL CHECK (trend IN ('improving', 'stable', 'declining', 'insufficient')),
    slope          DOUBLE PRECISION,
    unhealthy_share DOUBLE PRECISION,
    model_version  TEXT NOT NULL,
    params         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (level, entity_id, window_end, model_version)
);

-- ── Twin state: one row per active plant ──────────────────────────────────────

CREATE OR REPLACE VIEW twin_state WITH (security_invoker = true) AS
WITH latest_inspection AS (
    SELECT DISTINCT ON (plant_id) *
    FROM inspections
    ORDER BY plant_id, inspection_date DESC NULLS LAST
),
latest_class AS (
    SELECT DISTINCT ON (plant_id) plant_id, health_class, probability, model, model_version, cycle
    FROM health_classifications
    ORDER BY plant_id, cycle DESC, created_at DESC
),
latest_hotspot AS (
    SELECT DISTINCT ON (plant_id) plant_id, cluster_id, cycle
    FROM plant_health_hotspots
    ORDER BY plant_id, cycle DESC, created_at DESC
),
latest_trend AS (
    SELECT DISTINCT ON (entity_id) entity_id, trend, slope, n_cycles
    FROM health_trends
    WHERE level = 'plant'
    ORDER BY entity_id, window_end DESC, created_at DESC
)
SELECT
    p.plant_id,
    p.zone,
    p.block,
    p.zone || '-' || p.block                       AS block_id,
    p.slot_id,
    COALESCE(ls.latitude, s.latitude)              AS latitude,
    COALESCE(ls.longitude, s.longitude)            AS longitude,
    CASE WHEN ls.slot_id IS NOT NULL THEN ls.rms_m ELSE s.accuracy END AS location_error_m,
    CASE WHEN ls.slot_id IS NOT NULL THEN 'smoothed' ELSE 'single_fix' END AS location_source,
    li.inspection_date                             AS last_inspection_date,
    li.foliage_color,
    li.soil_ph,
    li.soil_ec,
    li.moisture,
    li.temperature,
    li.humidity,
    li.vine_height_cm,
    lc.health_class,
    lc.probability                                 AS health_probability,
    lc.model                                       AS health_model,
    lc.model_version                               AS health_model_version,
    (lh.cluster_id IS NOT NULL AND lh.cluster_id >= 0) AS in_hotspot,
    lh.cluster_id                                  AS hotspot_cluster_id,
    lt.trend,
    lt.slope                                       AS trend_slope
FROM plants p
LEFT JOIN slots s                     ON s.slot_id = p.slot_id
LEFT JOIN plant_locations_smoothed ls ON ls.slot_id = p.slot_id
LEFT JOIN latest_inspection li        ON li.plant_id = p.plant_id
LEFT JOIN latest_class lc             ON lc.plant_id = p.plant_id
LEFT JOIN latest_hotspot lh           ON lh.plant_id = p.plant_id
LEFT JOIN latest_trend lt             ON lt.entity_id = p.plant_id
WHERE COALESCE(p.status, 'active') NOT IN ('retired', 'replaced')
  AND p.replaced_by_plant_id IS NULL;

-- ── Access ────────────────────────────────────────────────────────────────────
-- Signed-in staff can read; only the service role (ML jobs / backend) writes.
-- Field capture of GPS observations is allowed for signed-in staff.

ALTER TABLE plant_location_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE plant_locations_smoothed    ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_classifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE plant_health_hotspots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_trends               ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['plant_location_observations', 'plant_locations_smoothed',
                             'health_classifications', 'plant_health_hotspots', 'health_trends']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_read') THEN
            EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_read', t);
        END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'plant_location_observations'
                   AND policyname = 'plant_location_observations_insert') THEN
        CREATE POLICY plant_location_observations_insert ON plant_location_observations
            FOR INSERT TO authenticated WITH CHECK (true);
    END IF;
END $$;

GRANT SELECT ON twin_state TO authenticated;
