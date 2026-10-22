"""Read-only inspection audit. Python standard library only; no database writes."""
from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import date as calendar_date, datetime, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import statistics


NUMERIC = {
    "soil_ph": (4.5, 8.0),
    "soil_ec": (0, 2),
    "moisture": (1, 30),
    "temperature": (15, 35),
    "humidity": (40, 100),
    "vine_height_cm": (1, 1500),
}
REQUIRED = ["plant_id", "inspection_date", *NUMERIC, "foliage_color"]
MISSING = {"", "null", "none", "nan", "na", "n/a"}


def audit(path: Path, provenance: str, as_of: calendar_date | None = None) -> tuple[dict, list[dict]]:
    as_of = as_of or datetime.now(timezone.utc).date()
    raw = path.read_bytes()
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
    columns = reader.fieldnames or []
    if len(columns) != len(set(columns)):
        raise ValueError("CSV contains duplicate column names")
    absent = sorted(set(REQUIRED) - set(columns))
    if absent:
        raise ValueError(f"Missing required columns: {', '.join(absent)}")
    rows = list(reader)
    if not rows:
        raise ValueError("CSV has no data rows")
    issues: list[dict] = []
    values: dict[str, list[float]] = {name: [] for name in NUMERIC}
    gps = [name for name in ("latitude", "longitude", "accuracy") if name in columns]
    values.update({name: [] for name in gps})
    missing = Counter()
    keys = Counter()
    plants, slots, dates = set(), set(), set()
    foliage, zones, sources = Counter(), Counter(), Counter()
    date_counts = Counter()

    def issue(line: int, field: str, kind: str, value: str) -> None:
        issues.append({"csv_line": line, "field": field, "issue": kind, "value": value})

    for line, row in enumerate(rows, 2):
        if None in row or any(value is None for value in row.values()):
            issue(line, "row", "malformed_row", "Column count differs from header")
        for name in columns:
            value = (row.get(name) or "").strip()
            if value.lower() in MISSING:
                missing[name] += 1
                if name in REQUIRED or name in gps:
                    issue(line, name, "missing", value)
        pid = (row.get("plant_id") or "").strip()
        valid_pid = pid.lower() not in MISSING
        if valid_pid:
            plants.add(pid)
        slot = (row.get("slot_id") or "").strip()
        if slot.lower() not in MISSING:
            slots.add(slot)
        date = (row.get("inspection_date") or "").strip()
        if date.lower() not in MISSING:
            try:
                parsed = datetime.fromisoformat(date.replace("Z", "+00:00"))
                date = parsed.date().isoformat()
                dates.add(date)
                date_counts[date] += 1
                if valid_pid:
                    keys[(pid, date)] += 1
                if parsed.date() > as_of:
                    issue(line, "inspection_date", "future_date", date)
            except ValueError:
                issue(line, "inspection_date", "invalid_date", date)
        color = (row.get("foliage_color") or "").strip()
        if color.lower() not in MISSING:
            foliage[color] += 1
            if color not in {"Green", "Mixed", "Yellow", "Brown"}:
                issue(line, "foliage_color", "unrecognized_category", color)
        for field, counts in (("zone", zones), ("location_source", sources)):
            value = (row.get(field) or "").strip()
            if value.lower() not in MISSING:
                counts[value] += 1
        for name in values:
            value = (row.get(name) or "").strip()
            if value.lower() in MISSING:
                continue
            try:
                number = float(value)
                if not math.isfinite(number):
                    raise ValueError
            except ValueError:
                issue(line, name, "invalid_number", value)
                continue
            values[name].append(number)
            if name in NUMERIC:
                low, high = NUMERIC[name]
                if not low <= number <= high:
                    issue(line, name, "outside_provisional_range", value)
            elif name == "latitude" and not -90 <= number <= 90:
                issue(line, name, "invalid_coordinate", value)
            elif name == "longitude" and not -180 <= number <= 180:
                issue(line, name, "invalid_coordinate", value)
            elif name == "accuracy":
                if number < 0:
                    issue(line, name, "negative_accuracy", value)
                elif number > 10:
                    issue(line, name, "gps_accuracy_above_review_threshold_10m", value)
    summary = {
        name: {"numeric_count": len(items), "min": min(items),
               "median": statistics.median(items), "max": max(items)}
        for name, items in values.items() if items
    }
    duplicates = [{"plant_id": pid, "date": date, "rows": count}
                  for (pid, date), count in sorted(keys.items()) if count > 1]
    return {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "as_of_date": as_of.isoformat(),
        "source_file": str(path.resolve()),
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "provenance": provenance,
        "rows": len(rows), "plants": len(plants), "slots": len(slots),
        "dates": sorted(dates), "rows_by_date": dict(sorted(date_counts.items())),
        "columns": columns, "missing_by_column": {c: missing[c] for c in columns},
        "numeric_summary": summary, "foliage_counts": dict(foliage),
        "zone_row_counts": dict(zones), "location_source_counts": dict(sources),
        "duplicate_plant_dates": duplicates,
        "issue_counts": dict(Counter(item["issue"] for item in issues)),
        "provisional_ranges": NUMERIC,
        "gps_review_threshold_m": 10,
        "health_target": "not established by this audit",
        "research_ready": False,
    }, issues


def write_report(report: dict, issues: list[dict], out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "audit.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    with (out / "issues.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["csv_line", "field", "issue", "value"])
        writer.writeheader()
        writer.writerows(issues)
    lines = ["# Digital Twin dataset audit", "",
             f"Provenance: **{report['provenance']}**", "",
             f"Rows: {report['rows']}; plants: {report['plants']}; slots: {report['slots']}; "
             f"dates: {len(report['dates'])}.", "",
             f"Duplicate plant/date groups: {len(report['duplicate_plant_dates'])}.", "",
             "## Findings", ""]
    lines += [f"- {kind}: {count}" for kind, count in report["issue_counts"].items()] or ["- No row-level issues found."]
    lines += ["", "## Modelling prerequisites", "",
              "- Confirm health labels and their provenance with the domain expert.",
              "- Exclude label-defining fields and future observations from predictors.",
              "- Confirm units and provisional ranges; flagged values were not changed.",
              "- Review plant generations and slot IDs against inventory exports.",
              "- Split by physical slot where replacement generations share a location; "
              "report plant, block and forward-time validation separately.",
              "- GPS reported accuracy is not measured ground-truth error. The 10 m "
              "threshold is a review flag, not a rejection rule.",
              "- Synthetic data can test pipelines; it cannot validate field accuracy.",
              "- Foliage colour is an observation, not an expert disease diagnosis.",
              "", "Source SHA-256: `" + report["source_sha256"] + "`", ""]
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path)
    parser.add_argument("--provenance", choices=["synthetic", "field", "unknown"], required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--as-of", type=calendar_date.fromisoformat,
                        help="Date boundary for future-date checks (YYYY-MM-DD; default: UTC today)")
    args = parser.parse_args()
    # Keep output separate so an audit cannot overwrite the input dataset.
    if args.out.resolve() == args.csv.resolve() or args.csv.resolve() in {
        (args.out / name).resolve() for name in ("audit.json", "issues.csv", "report.md")
    }:
        parser.error("Output must not overwrite the input dataset")
    try:
        report, issues = audit(args.csv, args.provenance, args.as_of)
    except (OSError, ValueError, csv.Error) as error:
        parser.error(str(error))
    write_report(report, issues, args.out)
    print(f"Audited {report['rows']} rows / {report['plants']} plants. Report: {args.out / 'report.md'}")


if __name__ == "__main__":
    main()
