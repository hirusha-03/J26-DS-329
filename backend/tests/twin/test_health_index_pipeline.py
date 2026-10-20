"""Check Health Index semantics, leakage-safe targets and the statistical helpers."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

SCRIPT = Path(__file__).resolve().parents[2] / "ml/digital_twin/health_index_pipeline.py"
SPEC = importlib.util.spec_from_file_location("health_index_pipeline", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def inspections(colors, plant="A01-P001-G1", **changes):
    """Weekly visits of one plant with every reading inside its optimal band."""
    rows = pd.DataFrame({
        "inspection_date": pd.date_range("2026-07-10", periods=len(colors), freq="7D"),
        "plant_id": plant, "zone": "A", "soil_ph": 6.2, "soil_ec": 0.1, "moisture": 6.0,
        "temperature": 25.0, "humidity": 80.0, "vine_height_cm": 100.0 + 5 * np.arange(len(colors)),
        "foliage_color": colors})
    return rows.assign(**changes)


class HealthIndexTests(unittest.TestCase):
    def test_desirability_trapezoid(self):
        d = MODULE.desirability([4.5, 5.15, 6.0, 7.5, 8.0, 9.0], 4.5, 5.8, 7.0, 8.0)
        np.testing.assert_allclose(d, [0, 0.5, 1, 0.5, 0, 0])

    def test_geometric_index_does_not_let_good_soil_hide_brown_foliage(self):
        df = MODULE.add_growth(inspections(["Green", "Brown"]))
        geo = MODULE.health_index(df, how="geometric")
        ari = MODULE.health_index(df, how="arithmetic")
        self.assertAlmostEqual(geo.HI.iloc[0], 100)
        self.assertEqual(list(MODULE.hi_class(geo.HI)), [2, 0])      # Brown -> Poor
        self.assertEqual(MODULE.hi_class(ari.HI)[1], 1)               # arithmetic compensates -> At-risk

    def test_first_visit_growth_is_neutral_median(self):
        df = MODULE.add_growth(inspections(["Green"] * 3))
        self.assertAlmostEqual(df.growth_cm_wk.iloc[0], 5.0)


class TaskTests(unittest.TestCase):
    def scored(self, colors, **changes):
        df = MODULE.health_index(MODULE.add_growth(inspections(colors, **changes)))
        df["hi_class"] = MODULE.hi_class(df.HI)
        return df

    def test_forecast_target_is_next_class_and_last_visit_dropped(self):
        tr, features = MODULE.build_task(self.scored(["Green", "Green", "Brown"]), "forecast")
        self.assertEqual(list(tr.y), [2, 0])
        self.assertEqual(list(tr.hi_class), [2, 2])
        self.assertEqual(list(tr.days_to_next), [7, 7])
        self.assertNotIn("y", features)

    def test_forecast_never_crosses_plants(self):
        df = pd.concat([self.scored(["Green", "Green"]),
                        self.scored(["Brown", "Brown"], plant_id="A01-P002-G1")], ignore_index=True)
        tr, _ = MODULE.build_task(df, "forecast")
        self.assertEqual(dict(zip(tr.plant_id, tr.y)), {"A01-P001-G1": 2, "A01-P002-G1": 0})
        self.assertTrue((tr.delta_hi == 0).all())

    def test_symptom_now_features_exclude_foliage_and_hi(self):
        tr, features = MODULE.build_task(self.scored(["Green", "Mixed", "Yellow", "Brown"]), "symptom_now")
        self.assertEqual(list(tr.y), [2, 1, 1, 0])
        self.assertFalse({"HI", "hi_class", "foliage_ord", "foliage_color"} & set(features))

    def test_locked_test_plants_are_disjoint(self):
        df = pd.concat([self.scored(["Green", "Mixed", "Brown"] if i % 3 == 0 else ["Green"] * 3,
                                    plant_id=f"A01-P{i:03d}-G1") for i in range(20)], ignore_index=True)
        tr, _ = MODULE.build_task(df, "forecast")
        dev, test = MODULE.locked_test_split(tr, 0.2, 42)
        self.assertFalse(set(dev.plant_id) & set(test.plant_id))
        self.assertEqual(len(dev) + len(test), len(tr))

    def test_baselines(self):
        X = pd.DataFrame({"hi_class": [2, 1, 2], "delta_hi": [0, -10, -4]})
        self.assertEqual(list(MODULE.Persistence().fit(X, None).predict(X)), [2, 1, 2])
        self.assertEqual(list(MODULE.TrendRule(drop=5).fit(X, None).predict(X)), [2, 0, 2])


class StatisticsTests(unittest.TestCase):
    def test_holm_adjustment(self):
        np.testing.assert_allclose(MODULE.holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06])

    def test_corrected_ttest_is_more_conservative_than_plain(self):
        a, b = np.array([0.7, 0.72, 0.69, 0.75, 0.71]), np.array([0.65, 0.7, 0.66, 0.7, 0.69])
        _, p_corrected = MODULE.corrected_ttest(a, b, n_tr=80, n_te=20)
        _, p_plain = MODULE.corrected_ttest(a, b, n_tr=1e12, n_te=1)
        self.assertGreater(p_corrected, p_plain)
        self.assertEqual(MODULE.corrected_ttest(a, a, 80, 20), (0.0, 1.0))

    def test_metrics_ignore_classes_absent_from_truth(self):
        m = MODULE.metrics([2, 2, 1, 1], [2, 2, 1, 2])
        self.assertAlmostEqual(m["macro_f1"], (0.8 + 2 / 3) / 2)
        self.assertEqual(m["recall_poor"], 0)


if __name__ == "__main__":
    unittest.main()
