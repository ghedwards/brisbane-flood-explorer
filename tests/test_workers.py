"""Tests for workers by place of work (no network).

Run with: python -m unittest tests/test_workers.py
"""
import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_workers as fw  # noqa: E402


def datapack():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        rows = ["SA2_CODE_2021,Age_15_19_M,Tot_M,Tot_F,Tot_P"] + [f"{100000000 + i},1,5,6,{11 + i}" for i in range(1500)]
        z.writestr("2021 Census WPP SA2 for AUS/2021Census_W01A_AUS_SA2.csv", "\n".join(rows))
        z.writestr("2021 Census WPP SA2 for AUS/2021Census_W02_AUS_SA2.csv", "SA2_CODE_2021,X\n1,2")
    return buf.getvalue()


class Workers(unittest.TestCase):
    def test_reads_totals_per_sa2(self):
        table, col, w = fw.workers_from_zip(datapack())
        self.assertEqual(col, "Tot_P")
        self.assertEqual(len(w), 1500)
        self.assertEqual(w["100000000"], 11)
        self.assertIn("W01A", table)

    def test_total_column_patterns(self):
        self.assertEqual(fw.total_column(["SA2", "Tot_M", "Tot_P"]), 2)
        self.assertEqual(fw.total_column(["SA2", "Total_Persons"]), 1)
        self.assertIsNone(fw.total_column(["SA2", "Males"]))


if __name__ == "__main__":
    unittest.main()
