"""Cleaning, imputation and feature rules shared by training and scoring."""
from pathlib import Path
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ml" / "digital_twin"))
import inspection_prep as ip  # noqa: E402
from score_new_inspections import as_raw  # noqa: E402
from train_health_model import RuleBasedHealth  # noqa: E402

COLUMNS = ["id", "plant_id", "inspection_date", "created_at", "last_fertilized", "soil_ph", "soil_ec", "moisture",
           "temperature", "humidity", "vine_height_cm", "foliage_color", "soil_type", "sunlight_level",
           "shade_level", "watering_status"]


def row(i, plant="A01-P001-G1", date="2026-08-07", **kw):
    base = dict(id=f"r{i}", plant_id=plant, inspection_date=f"{date} 00:00:00+00",
                created_at=f"{date} 05:00:00+00", last_fertilized="2026-07-24", soil_ph="6.3", soil_ec="0.08",
                moisture="6", temperature="24.5", humidity="78", vine_height_cm="200", foliage_color="Green",
                soil_type="Acidic", sunlight_level="bright", shade_level="light", watering_status="Keep moist")
    base.update(kw)
    return base


def frame(rows):
    return pd.DataFrame(rows, columns=COLUMNS).astype(object).replace({None: np.nan})


class CleaningTests(unittest.TestCase):
    def test_plant_id_variants_are_standardised(self):
        for raw in ["a01-p1-g1", "A1-P1-G1", "A01_P001_G1", " A01-P001-G1 "]:
            self.assertEqual(ip.norm_plant_id(raw), "A01-P001-G1")
        self.assertTrue(pd.isna(ip.norm_plant_id("plant 7")))

    def test_numbers_with_units_and_decimal_commas(self):
        self.assertEqual(ip.to_number("24.5°C"), 24.5)
        self.assertEqual(ip.to_number("78%"), 78.0)
        self.assertEqual(ip.to_number("6,4"), 6.4)

    def test_ambiguous_date_resolved_by_created_at(self):
        window = (ip.STUDY_START, ip.STUDY_END)
        date, status = ip.parse_inspection_date("09/12/2026", pd.Timestamp("2026-09-12"), window)
        self.assertEqual((date, status), (pd.Timestamp("2026-09-12"), "ok"))
        date, status = ip.parse_inspection_date("2025-08-21 00:00:00+00", pd.Timestamp("2026-08-21"), window)
        self.assertEqual((date, status), (pd.Timestamp("2026-08-21"), "reconciled_from_created_at"))

    def test_bad_values_become_missing_and_same_day_repeat_keeps_latest(self):
        raw = frame([row(1, soil_ph="9.8"),
                     row(2, date="2026-08-14", moisture="45", created_at="2026-08-14 05:00:00+00"),
                     row(3, date="2026-08-14", moisture="5", created_at="2026-08-14 09:00:00+00"),
                     row(4, date="2026-08-21", soil_ph="6.2", soil_ec=None, moisture=None, temperature=None,
                         humidity=None)])
        clean, log, _ = ip.clean_inspections(raw)
        self.assertEqual(list(clean["id"]), ["r1", "r3", "r4"])
        self.assertTrue(np.isnan(clean.loc[clean.id == "r1", "soil_ph"].iloc[0]))
        self.assertTrue(np.isnan(clean.loc[clean.id == "r4", "soil_ph"].iloc[0]))   # form default, not a reading
        self.assertEqual(set(log.action), {"out_of_range", "form_default"})

    def test_labels_are_standardised(self):
        clean, _, _ = ip.clean_inspections(frame([row(1, foliage_color=" GREEN"), row(2, date="2026-08-14",
                                                                                         foliage_color="Yelow")]))
        self.assertEqual(list(clean.foliage_color), ["Green", "Yellow"])


class FeatureTests(unittest.TestCase):
    def features(self, rows):
        return ip.build_features(ip.impute(ip.clean_inspections(frame(rows))[0]))

    def test_previous_reading_comes_from_the_earlier_visit_only(self):
        d = self.features([row(1, moisture="4"), row(2, date="2026-08-14", moisture="8"),
                           row(3, date="2026-08-21", moisture="6")])
        self.assertEqual(list(d.moisture_prev), [4, 4, 8])
        self.assertEqual(list(d.moisture_delta), [0, 4, -2])
        self.assertEqual(list(d.health_index), [0, 0, 0])

    def test_plants_do_not_share_history(self):
        d = self.features([row(1, moisture="3"), row(2, plant="B01-P001-G1", moisture="9")])
        self.assertEqual(dict(zip(d.plant_id, d.moisture_prev)), {"A01-P001-G1": 3, "B01-P001-G1": 9})

    def test_missing_soil_reading_interpolated_within_the_plant(self):
        d = self.features([row(1, soil_ph="6.0"), row(2, date="2026-08-14", soil_ph=None),
                           row(3, date="2026-08-21", soil_ph="6.4")])
        self.assertAlmostEqual(d.soil_ph.iloc[1], 6.2)

    def test_target_mapping(self):
        d = self.features([row(1, foliage_color="Mixed"), row(2, date="2026-08-14", foliage_color="Brown"),
                           row(3, date="2026-08-21", foliage_color=None)])
        self.assertEqual(d.health_index.iloc[0], 1)
        self.assertEqual(d.health_index.iloc[1], 2)
        self.assertTrue(np.isnan(d.health_index.iloc[2]))


class BaselineAndApiTests(unittest.TestCase):
    def test_rule_baseline_counts_stress_points(self):
        X = pd.DataFrame({"moisture": [6, 2, 2], "soil_ph": [6.3, 6.3, 7.5], "soil_ec": [0.1, 0.1, 0.1],
                          "humidity": [80, 80, 80]})
        self.assertEqual(list(RuleBasedHealth().fit(X).predict(X)), [0, 1, 2])

    def test_api_rows_read_like_a_csv_export(self):
        raw = as_raw([{"plant_id": "A01-P001-G1", "soil_ph": 6.3, "notes": None, "photo_url": ""}])
        self.assertEqual(raw.soil_ph.iloc[0], "6.3")
        self.assertTrue(pd.isna(raw.notes.iloc[0]) and pd.isna(raw.photo_url.iloc[0]))


if __name__ == "__main__":
    unittest.main()
