"""Distances, anomaly signals, spatial tests, tracking and triage rules of the hotspot pipeline."""
from pathlib import Path
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ml" / "digital_twin"))
import hotspots as hs  # noqa: E402

LAT0, LON0 = 7.3388, 80.6957
M_LON = 111_320 * np.cos(np.radians(LAT0))


def at(dx, dy):
    """lat, lon of a point dx m east and dy m north of the origin."""
    return LAT0 + dy / 111_320, LON0 + dx / M_LON


class DistanceTests(unittest.TestCase):
    def test_haversine_matches_metres(self):
        lat, lon = at(30, 40)
        self.assertAlmostEqual(hs.haversine_m(LAT0, LON0, lat, lon), 50, delta=0.2)

    def test_utm_distances_match_haversine(self):
        lat, lon = zip(at(0, 0), at(300, 400))
        x, y = hs.to_utm(lat, lon)
        utm = float(np.hypot(x[1] - x[0], y[1] - y[0]))
        sphere = hs.haversine_m(lat[0], lon[0], lat[1], lon[1])
        self.assertLess(abs(utm - sphere) / sphere, 0.006)          # ellipsoid vs sphere

    def test_stable_coordinate_drops_poor_and_stray_fixes(self):
        pts = [at(0, 0), at(1, 0), at(0, 1), at(-1, 0), at(60, 0)]          # last fix is a stray
        fixes = pd.DataFrame({"plant_id": "A01-P001-G1", "latitude": [p[0] for p in pts] + [at(0, 0)[0]],
                              "longitude": [p[1] for p in pts] + [at(0, 0)[1]], "accuracy": [5] * 5 + [40]})
        coords, log = hs.stable_coordinates(fixes, max_accuracy_m=10)
        self.assertEqual(coords.n_fixes.iloc[0], 4)
        self.assertLess(hs.haversine_m(LAT0, LON0, coords.lat.iloc[0], coords.lon.iloc[0]), 1.0)
        self.assertEqual(sorted(log.reason.unique()), ["accuracy worse than limit or unknown",
                                                       "fix far from the plant's other fixes"])

    def test_kdist_elbow_finds_the_jump(self):
        self.assertEqual(hs.kdist_elbow(np.array([5, 5.5, 6, 6.2, 6.5, 40, 45])), 6.5)


class AnomalyTests(unittest.TestCase):
    def frame(self):
        rows = []
        for p in range(10):
            for c in range(6):
                rows.append({"plant_id": f"B01-P{p + 1:03d}-G1", "cycle": c, "block": "B01", "zone": "B",
                             "soil_ph": 6.3 + 0.02 * ((p + c) % 3), "soil_ec": 0.08 + 0.01 * (p % 2),
                             "moisture": 6 + (p + c) % 2, "growth_cm_wk": 5 + (p % 3), "foliage_color": "Green"})
        d = pd.DataFrame(rows)
        sick = (d.plant_id == "B01-P001-G1") & (d.cycle == 5)
        d.loc[sick, ["soil_ec", "foliage_color"]] = [0.01, "Yellow"]
        return d

    def test_rule_flags_the_changed_plant_only(self):
        d = hs.anomaly_signals(self.frame())
        flagged = d[d.rule_flag]
        self.assertEqual(list(zip(flagged.plant_id, flagged.cycle)), [("B01-P001-G1", 5)])
        reasons = flagged.reasons.iloc[0]
        self.assertIn("foliage Yellow", reasons)
        self.assertTrue(any(r.startswith("self_z_soil_ec") for r in reasons))

    def test_faster_growth_is_not_a_health_signal(self):
        d = self.frame()
        d.loc[(d.plant_id == "B01-P002-G1") & (d.cycle == 5), "growth_cm_wk"] = 40
        self.assertFalse(hs.anomaly_signals(d).query("plant_id == 'B01-P002-G1' and cycle == 5").rule_flag.iloc[0])

    def test_run_onset_restarts_after_a_gap(self):
        flags = pd.DataFrame({"plant_id": "A", "cycle": [0, 1, 2, 3, 4], "flag": [True, False, True, True, True]})
        self.assertEqual(hs.run_onsets(flags), {("A", 0): 0, ("A", 2): 2, ("A", 3): 2, ("A", 4): 2})


class SpatialTests(unittest.TestCase):
    def grid(self):
        pts = [at(6 * i, 6 * j) for i in range(5) for j in range(4)]
        return np.array([p[0] for p in pts]), np.array([p[1] for p in pts])

    def test_join_count_detects_a_clump(self):
        lat, lon = self.grid()
        flags = np.zeros(20, bool)
        flags[[0, 1, 4, 5]] = True                       # 2 x 2 corner
        res = hs.join_count(flags, hs.band_weights(lat, lon, 6.5), n_perm=499)
        self.assertEqual(res["bb_joins"], 4)
        self.assertLess(res["p"], 0.05)

    def test_dbscan_uses_metres(self):
        lat, lon = zip(at(0, 0), at(5, 0), at(10, 0), at(100, 0))
        self.assertEqual(list(hs.dbscan(np.array(lat), np.array(lon), 6, 3)), [0, 0, 0, -1])
        self.assertEqual(list(hs.dbscan(np.array(lat), np.array(lon), 4, 3)), [-1, -1, -1, -1])

    def test_tracking_matches_and_measures_spread(self):
        ids = [f"P{i}" for i in range(6)]
        pts = [at(6 * i, 0) for i in range(6)]
        coords = pd.DataFrame({"plant_id": ids, "lat": [p[0] for p in pts], "lon": [p[1] for p in pts]})
        coords["x"], coords["y"] = hs.to_utm(coords.lat, coords.lon)
        clusters = {0: [{"P0", "P1", "P2"}], 1: [{"P0", "P1", "P2", "P3", "P4"}], 2: []}
        onset = {("P0", 0): 0, ("P1", 0): 0, ("P2", 0): 0, ("P0", 1): 0, ("P1", 1): 0, ("P2", 1): 0,
                 ("P3", 1): 1, ("P4", 1): 1}
        t = hs.track(clusters, coords, onset, eps_m=7)
        self.assertEqual(list(t.status), ["new", "expanding", "resolved"])
        self.assertEqual(t.hotspot_id.nunique(), 1)
        row = t.iloc[1]
        self.assertEqual((row.net_growth, row.new_members), (2, 2))
        self.assertEqual(row.new_members_adjacent, 0.5)       # P3 is 6 m from P2, P4 is 12 m away


class TriageTests(unittest.TestCase):
    base = {"soil_vs_ring_p": np.nan, "growth_suppressed": False, "adjacent_share_total": np.nan,
            "net_growth": 0, "soil_out_of_range_share": 0.0, "yellow_share": 0.0, "brown_mixed_share": 0.0,
            "onset_spread_cycles": 0.0}

    def test_stationary_yellow_low_ec_is_nutrient(self):
        h = {**self.base, "soil_out_of_range_share": 1.0, "yellow_share": 1.0, "growth_suppressed": True}
        self.assertEqual(hs.triage(h)[0], "likely_nutrient_deficiency")

    def test_spreading_brown_with_normal_soil_is_disease(self):
        h = {**self.base, "brown_mixed_share": 1.0, "onset_spread_cycles": 2.0, "adjacent_share_total": 1.0,
             "net_growth": 3}
        self.assertEqual(hs.triage(h)[0], "likely_disease")

    def test_mixed_evidence_goes_to_the_expert(self):
        h = {**self.base, "yellow_share": 1.0, "onset_spread_cycles": 2.0}
        self.assertEqual(hs.triage(h)[0], "uncertain_expert_review")

    def test_underpowered_soil_test_is_not_evidence(self):
        members = pd.DataFrame({"soil_ph": [5.0] * 4, "soil_ec": [0.01] * 4, "moisture": [6] * 4,
                                "growth_cm_wk": [0] * 4, "foliage_color": ["Yellow"] * 4})
        ring = members.assign(soil_ph=6.4, soil_ec=0.1, growth_cm_wk=6, foliage_color="Green")
        self.assertTrue(np.isnan(hs.evidence(members, ring)["soil_vs_ring_p"]))           # 4 vs 4: can't reach 0.05
        big = pd.concat([ring] * 2, ignore_index=True)
        self.assertLess(hs.evidence(members, big)["soil_vs_ring_p"], 0.05)                # 4 vs 8: can


if __name__ == "__main__":
    unittest.main()
