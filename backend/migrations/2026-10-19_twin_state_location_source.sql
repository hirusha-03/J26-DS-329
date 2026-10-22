-- Module 2: twin_state.location_source now says whether a plant's position is a field GPS fix
-- ('gps') or a placeholder ('estimated'), taken from slots.location_source.
-- Analytics (DBSCAN hotspots, proximity evaluation) must use location_source = 'gps' rows only.
-- The previous meaning (smoothed vs single fix) moves to a new last column, location_method.
-- Run once in the Supabase SQL editor after 2026-10-17_digital_twin.sql. Safe to re-run.

-- Already present in the live project (added outside the repo); recorded here so a fresh setup matches.
ALTER TABLE slots ADD COLUMN IF NOT EXISTS location_source TEXT;

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
    -- A smoothed position comes from repeated field fixes, so it counts as GPS. A slot without a
    -- recorded source is treated as estimated so it never leaks into GPS-only analytics.
    CASE
        WHEN ls.slot_id IS NOT NULL THEN 'gps'
        WHEN s.latitude IS NULL THEN NULL
        ELSE COALESCE(s.location_source, 'estimated')
    END                                            AS location_source,
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
    lt.slope                                       AS trend_slope,
    CASE
        WHEN ls.slot_id IS NOT NULL THEN 'smoothed'
        WHEN s.latitude IS NOT NULL THEN 'single_fix'
    END                                            AS location_method
FROM plants p
LEFT JOIN slots s                     ON s.slot_id = p.slot_id
LEFT JOIN plant_locations_smoothed ls ON ls.slot_id = p.slot_id
LEFT JOIN latest_inspection li        ON li.plant_id = p.plant_id
LEFT JOIN latest_class lc             ON lc.plant_id = p.plant_id
LEFT JOIN latest_hotspot lh           ON lh.plant_id = p.plant_id
LEFT JOIN latest_trend lt             ON lt.entity_id = p.plant_id
WHERE COALESCE(p.status, 'active') NOT IN ('retired', 'replaced')
  AND p.replaced_by_plant_id IS NULL;

GRANT SELECT ON twin_state TO authenticated;

-- Check (expect about 78 gps / 23 estimated until the field re-capture):
-- SELECT location_source, count(*) FROM twin_state GROUP BY location_source;
