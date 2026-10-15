"""Write FAKE plantation shapes and plants into public/geo/ for testing the map page.

Demo only - never use for screenshots or results. Run from frontend/dashboard/.
"""
import json
import random
from pathlib import Path

random.seed(1)
OUT = Path("public/geo")
OUT.mkdir(parents=True, exist_ok=True)

LAT0, LNG0 = 7.2000, 80.4000      # arbitrary placeholder, NOT the real plantation
DLAT, DLNG = 0.0009, 0.0008       # one block is roughly 100 m x 90 m
ZONES = {"A": 5, "B": 6, "C": 4, "D": 4}  # same block counts as the app


def square(x0, y0, w, h):
    return [[[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]]]


def fc(features):
    return {"type": "FeatureCollection", "features": features}


blocks, zones, plants = [], [], []
for zi, (zone, n_blocks) in enumerate(ZONES.items()):
    y0 = LAT0 + zi * DLAT
    zones.append({"type": "Feature", "properties": {"zone": zone},
                  "geometry": {"type": "Polygon", "coordinates": square(LNG0, y0, n_blocks * DLNG, DLAT)}})
    for b in range(n_blocks):
        x0 = LNG0 + b * DLNG
        block_id = f"{zone}-{b + 1}"
        blocks.append({"type": "Feature",
                       "properties": {"block_id": block_id, "zone": zone, "planted_count": 115},
                       "geometry": {"type": "Polygon", "coordinates": square(x0, y0, DLNG, DLAT)}})
        for i in range(random.choice([0, 3, 8, 25])):
            inspected = random.random() < 0.85
            plants.append({
                "plant_id": f"{block_id}-{i + 1:03d}", "zone": zone, "block": str(b + 1), "block_id": block_id,
                "latitude": y0 + random.uniform(0.1, 0.9) * DLAT,
                "longitude": x0 + random.uniform(0.1, 0.9) * DLNG,
                "accuracy": round(random.uniform(2, 8), 1),
                "last_inspection_date": f"2026-{random.choice(['07', '08', '09', '10'])}-0{random.randint(1, 7)}"
                if inspected else None,
                "foliage_color": random.choices(["Green", "Yellow", "Brown", "Red"], [6, 2, 1, 0.3])[0]
                if inspected else None,
                "soil_ph": round(random.uniform(5.2, 7.2), 1) if inspected else None,
                "moisture": random.randint(30, 70) if inspected else None,
                "vine_height_cm": random.randint(60, 200) if inspected else None,
                "notes": None,
            })

boundary = [{"type": "Feature", "properties": {"name": "DEMO"},
             "geometry": {"type": "Polygon", "coordinates": square(LNG0, LAT0, 6 * DLNG, 4 * DLAT)}}]

(OUT / "blocks.geojson").write_text(json.dumps(fc(blocks)))
(OUT / "zones.geojson").write_text(json.dumps(fc(zones)))
(OUT / "boundary.geojson").write_text(json.dumps(fc(boundary)))
(OUT / "demo_plants.json").write_text(json.dumps(plants))
print(f"DEMO data written: {len(blocks)} blocks, {len(plants)} plants -> {OUT}/")
