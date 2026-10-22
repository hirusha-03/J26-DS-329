-- Module 2: plant-level anomaly flags and spatial plant health hotspots with cause triage.
-- Written by backend/ml/digital_twin/run_hotspots.py --write (service key). Run once in the Supabase
-- SQL editor after 2026-10-17_digital_twin.sql. Safe to re-run.
-- Module 2 triages; it does not diagnose. likely_cause is likely_nutrient_deficiency, likely_disease or
-- uncertain_expert_review, and likely_disease hotspots are referred to Module 1 for identification.

CREATE TABLE IF NOT EXISTS plant_health_anomalies (
    plant_id        TEXT NOT NULL REFERENCES plants(plant_id) ON DELETE CASCADE,
    inspection_date DATE NOT NULL,
    cycle           INTEGER NOT NULL,
    anomaly_score   DOUBLE PRECISION,           -- Isolation Forest score, higher = more unusual
    iso_flag        BOOLEAN NOT NULL,
    rule_flag       BOOLEAN NOT NULL,           -- foliage Yellow/Brown or worse, or a robust |z| > 3
    reasons         JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_version   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plant_id, inspection_date)
);

CREATE TABLE IF NOT EXISTS health_hotspots (
    hotspot_id          TEXT NOT NULL,
    cycle               INTEGER NOT NULL,
    member_plant_ids    TEXT[] NOT NULL,
    n_members           INTEGER NOT NULL,
    centroid_lat        DOUBLE PRECISION,
    centroid_lon        DOUBLE PRECISION,
    area_m2             DOUBLE PRECISION,       -- convex hull in UTM 44N
    status              TEXT NOT NULL,          -- new | persistent | expanding | shrinking
    likely_cause        TEXT NOT NULL,
    evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
    referred_to_module1 BOOLEAN NOT NULL DEFAULT false,
    model_version       TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hotspot_id, cycle)
);

ALTER TABLE plant_health_anomalies ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_hotspots        ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['plant_health_anomalies', 'health_hotspots'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_read') THEN
            EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_read', t);
        END IF;
    END LOOP;
END $$;
