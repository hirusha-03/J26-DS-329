"""In-memory fallback stores used when no Supabase connection is configured.

Shared across routers (e.g. plant_locations and gps both read/write
mock_locations_list) so mock-mode behavior matches what a real shared
Supabase table would give both endpoints.
"""

mock_plants_list: list[dict] = []
mock_locations_list: list[dict] = []
mock_inspections_list: list[dict] = []
mock_submissions_list: list[dict] = []
mock_mortality_list: list[dict] = []
