"""Data integrity checks for the first ML workflow stage."""
import csv
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "ml/digital_twin/audit_dataset.py"
SPEC = importlib.util.spec_from_file_location("audit_dataset", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AuditTests(unittest.TestCase):
    def run_audit(self, rows, columns=None):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "source.csv"
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=columns or list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
            before = path.read_bytes()
            result = MODULE.audit(path, "synthetic")
            MODULE.write_report(*result, Path(temp) / "results")
            self.assertEqual(path.read_bytes(), before)
            self.assertTrue((Path(temp) / "results/report.md").exists())
            return result

    def row(self, **changes):
        return {"plant_id": "A01-P001-G1", "inspection_date": "2026-07-10",
                "soil_ph": "6.2", "soil_ec": "0.05", "moisture": "6",
                "temperature": "24", "humidity": "80", "vine_height_cm": "300",
                "foliage_color": "Green", "latitude": "7.3", "longitude": "80.6",
                "accuracy": "5", **changes}

    def test_clean_data_and_provenance(self):
        report, issues = self.run_audit([self.row()])
        self.assertEqual(issues, [])
        self.assertEqual(report["plants"], 1)
        self.assertEqual(report["provenance"], "synthetic")
        self.assertFalse(report["research_ready"])
        self.assertEqual(len(report["source_sha256"]), 64)

    def test_duplicate_dates_and_invalid_values_are_preserved_and_flagged(self):
        report, issues = self.run_audit([
            self.row(), self.row(inspection_date="2026-07-10T14:00:00Z",
                                 soil_ph="inf", humidity="", latitude="91", accuracy="96")])
        self.assertEqual(len(report["duplicate_plant_dates"]), 1)
        kinds = {item["issue"] for item in issues}
        self.assertTrue({"invalid_number", "missing", "invalid_coordinate",
                         "gps_accuracy_above_review_threshold_10m"} <= kinds)

    def test_missing_schema_and_empty_input_fail(self):
        with self.assertRaisesRegex(ValueError, "Missing required columns"):
            self.run_audit([{"plant_id": "A"}])
        with self.assertRaisesRegex(ValueError, "no data rows"):
            self.run_audit([], MODULE.REQUIRED)

    def test_invalid_date_range_and_category(self):
        report, issues = self.run_audit([
            self.row(inspection_date="bad", moisture="83", foliage_color="unknown")])
        self.assertEqual(report["dates"], [])
        self.assertEqual({i["issue"] for i in issues},
                         {"invalid_date", "outside_provisional_range", "unrecognized_category"})


if __name__ == "__main__":
    unittest.main()
