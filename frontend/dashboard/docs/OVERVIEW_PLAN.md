# Overview page — implementation plan

Branch: `issue/hirusha/overview-implemetation` (from `feat/overview-common`, Develop c009363 merged).

## Goal

Turn `/overview` from a scaffold into the manager's starting point: what to do in the
field today, where the digital twin wants a disease check, what changed this cycle and
how far the data can be trusted. Frontend only — no backend, schema or teammate-module
changes.

## Data (verified against Supabase, 2026-10-22)

| Source | Rows | Use |
|---|---|---|
| `twin_state` view | 101 | Plants via existing `fetchPlantRows()` |
| `plant_health_hotspots` | 45 | Hotspot clusters (in `params`), grouped by `fetchPlantRows()`; latest cycle 2026-10-01 has 4 clusters, H001 = likely disease, expanding, referred to Module 1, 10 plants |
| `health_trends` | 111 | Block/zone trends (improving / stable / declining / insufficient) |
| `health_hotspots` | — | Migration 2026-10-21 not applied; not used |

Not in the database, so not on the overview: disease predictions (not persisted),
vine measurements (browser localStorage), advisory queries.

## Sections

1. **Today's field plan** — ranked plants, each with its reasons. Weights (summed):
   likely-disease hotspot 100, high-risk and stale 80, uncertain hotspot 60, moderate and
   stale 50, never inspected 40, weak location (estimated / single fix / none) 15.
   Stale = `STALE_AFTER_DAYS` (45, `lib/mapConfig.ts`), same as the digital twin. Dead
   plants are excluded. Top 10, expandable. Links: field app `/new-inspection?plant_id=`
   and `/history?plant_id=` (`NEXT_PUBLIC_MONITOR_URL`).
2. **Hotspots needing a disease check** — likely-disease and uncertain clusters, referred
   first. Each member links to `/disease-detection?plant=&hotspot=`; the disease page shows
   which plant and hotspot is being checked (nothing is saved).
3. **What changed this cycle** — latest block/zone trend per entity, declining first;
   new and expanding hotspots.
4. **How far to trust the data** — inspection coverage, stale share, location-source mix,
   latest inspection date, disease model validation note.
5. **Module status** — M1 `/api/disease/status`, M2 plants loaded from `twin_state`,
   M3 local-only note, M4 advisory `/health`. 3 s timeout each; offline never breaks the page.

## Files

- `src/lib/overview/` — `fieldPlan.ts`, `cycleChanges.ts`, `dataTrust.ts` (pure),
  `data.ts` (loading + module checks).
- `src/components/overview/` — `FieldPlan`, `HotspotChecks`, `CycleChanges`,
  `DataTrust`, `ModuleStatus`.
- `src/app/overview/page.tsx` — layout, per-section loading/error states.
- `src/app/disease-detection/page.tsx` — optional `?plant=&hotspot=` context line.
- `e2e/overview.spec.ts` — mocked Supabase + APIs: ranking, offline module, no hotspots,
  narrow viewport.

## Later (needs backend / teammates)

- `disease_predictions` table so a hotspot check can be marked done and disease counts shown.
- Vine measurements in Supabase (Module 3 owner).
