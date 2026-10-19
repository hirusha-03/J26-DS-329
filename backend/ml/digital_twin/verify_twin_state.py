"""Check that twin_state covers every planted slot of the plantation with a GPS position.

The expected layout is blocks x plants per block for each zone (default A=5x5, B=4x8, C=3x8, D=2x10,
101 slots). Slot ids follow the field tags: <zone><block:02>-P<plant:03>, e.g. D01-P004.

For each block the report lists how many active plants twin_state returns, which slots are missing,
and any row that is outside the layout, shares a slot with another plant, or has no coordinates.
Exit code is 0 only when every expected slot is present exactly once with a position, so the script
can be used as the "seed query" check for the Supabase schema issue.

Usage:
    python verify_twin_state.py --supabase [--layout A=5x5,B=4x8,C=3x8,D=2x10] [--out results/twin_state]
    python verify_twin_state.py twin_state.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.request
from collections import Counter
from pathlib import Path

DEFAULT_LAYOUT = "A=5x5,B=4x8,C=3x8,D=2x10"


def parse_layout(spec: str) -> dict[str, tuple[int, int]]:
    """Parse "A=5x5,B=4x8" into {"A": (5, 5), "B": (4, 8)} as (blocks, plants per block)."""
    layout = {}
    for part in spec.split(","):
        zone, size = part.strip().split("=")
        blocks, plants = size.lower().split("x")
        layout[zone.strip().upper()] = (int(blocks), int(plants))
    return layout


def expected_slots(layout: dict[str, tuple[int, int]]) -> dict[str, str]:
    """slot_id -> block_id ("A-01") for every slot in the layout."""
    return {
        f"{zone}{b:02d}-P{p:03d}": f"{zone}-{b:02d}"
        for zone, (blocks, plants) in layout.items()
        for b in range(1, blocks + 1)
        for p in range(1, plants + 1)
    }


def check_twin_state(rows: list[dict], layout: dict[str, tuple[int, int]]) -> dict:
    expected = expected_slots(layout)
    per_slot = Counter(r.get("slot_id") for r in rows)

    blocks = {}
    for slot, block in expected.items():
        b = blocks.setdefault(block, {"expected": 0, "present": 0, "missing": []})
        b["expected"] += 1
        if per_slot[slot]:
            b["present"] += 1
        else:
            b["missing"].append(slot)

    unexpected = sorted(r.get("plant_id") for r in rows if r.get("slot_id") not in expected)
    duplicates = sorted(s for s, n in per_slot.items() if n > 1 and s in expected)
    no_gps = sorted(r.get("plant_id") for r in rows if r.get("latitude") in (None, "") or r.get("longitude") in (None, ""))

    n_expected = len(expected)
    n_present = sum(b["present"] for b in blocks.values())
    return {
        "expected": n_expected,
        "present": n_present,
        "rows": len(rows),
        "blocks": dict(sorted(blocks.items())),
        "missing": sorted(s for b in blocks.values() for s in b["missing"]),
        "unexpected": unexpected,
        "duplicates": duplicates,
        "no_gps": no_gps,
        "ok": n_present == n_expected and not unexpected and not duplicates and not no_gps,
    }


def report(res: dict) -> str:
    lines = [
        "# twin_state coverage",
        "",
        f"{res['present']} / {res['expected']} slots present ({res['rows']} rows). "
        + ("**OK**" if res["ok"] else "**Incomplete**"),
        "",
        "| Block | Expected | Present | Missing slots |",
        "|---|---|---|---|",
    ]
    for block, b in res["blocks"].items():
        lines.append(f"| {block} | {b['expected']} | {b['present']} | {', '.join(b['missing']) or '-'} |")
    for key, label in (("unexpected", "Plants outside the layout"), ("duplicates", "Slots with more than one active plant"),
                       ("no_gps", "Plants without coordinates")):
        if res[key]:
            lines += ["", f"{label}: {', '.join(map(str, res[key]))}"]
    return "\n".join(lines) + "\n"


def load_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_supabase() -> list[dict]:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY).")
    rows, page = [], 1000
    while True:
        req = urllib.request.Request(
            f"{url}/rest/v1/twin_state?select=plant_id,zone,block,slot_id,latitude,longitude,location_source"
            f"&order=plant_id&offset={len(rows)}&limit={page}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req) as r:
            batch = json.load(r)
        rows += batch
        if len(batch) < page:
            return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="?", type=Path)
    ap.add_argument("--supabase", action="store_true")
    ap.add_argument("--layout", default=DEFAULT_LAYOUT, help=f"zone=blocksxplants, default {DEFAULT_LAYOUT}")
    ap.add_argument("--out", type=Path, help="also write report.md and summary.json here")
    a = ap.parse_args()
    if not a.csv and not a.supabase:
        ap.error("give a CSV file or --supabase")

    rows = load_supabase() if a.supabase else load_csv(a.csv)
    res = check_twin_state(rows, parse_layout(a.layout))
    text = report(res)
    if a.out:
        a.out.mkdir(parents=True, exist_ok=True)
        (a.out / "summary.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
        (a.out / "report.md").write_text(text, encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(text)
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()
