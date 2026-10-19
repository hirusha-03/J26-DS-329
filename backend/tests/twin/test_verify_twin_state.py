"""Tests for the twin_state coverage check (ml/digital_twin/verify_twin_state.py)."""
from ml.digital_twin.verify_twin_state import (
    check_twin_state,
    expected_slots,
    parse_layout,
)

LAYOUT = parse_layout("A=2x2,D=1x3")


def row(slot, plant=None, lat=7.0, lng=80.0):
    return {"plant_id": plant or f"{slot}-G1", "slot_id": slot, "latitude": lat, "longitude": lng}


def full():
    return [row(s) for s in expected_slots(LAYOUT)]


def test_parse_and_expand_layout():
    assert parse_layout("A=5x5, d=2X10") == {"A": (5, 5), "D": (2, 10)}
    slots = expected_slots(parse_layout("A=5x5,B=4x8,C=3x8,D=2x10"))
    assert len(slots) == 101
    assert slots["D01-P004"] == "D-01"
    assert slots["B04-P008"] == "B-04"


def test_complete_twin_state_is_ok():
    res = check_twin_state(full(), LAYOUT)
    assert res["ok"]
    assert (res["expected"], res["present"]) == (7, 7)


def test_reports_missing_slots_per_block():
    rows = [r for r in full() if r["slot_id"] not in ("D01-P002", "A02-P001")]
    res = check_twin_state(rows, LAYOUT)
    assert not res["ok"]
    assert res["missing"] == ["A02-P001", "D01-P002"]
    assert res["blocks"]["D-01"] == {"expected": 3, "present": 2, "missing": ["D01-P002"]}


def test_flags_unexpected_duplicate_and_no_gps():
    rows = full() + [row("A03-P001", "A03-P001-G1"), row("A01-P001", "A01-P001-G2")]
    rows[1]["latitude"] = None
    res = check_twin_state(rows, LAYOUT)
    assert not res["ok"]
    assert res["unexpected"] == ["A03-P001-G1"]
    assert res["duplicates"] == ["A01-P001"]
    assert res["no_gps"] == [rows[1]["plant_id"]]
