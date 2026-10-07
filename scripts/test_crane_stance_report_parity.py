"""Compare report contents on the preserved baseline and converted private DB.

Usage: PYTHONPATH=. python scripts/test_crane_stance_report_parity.py BASELINE.db CONVERTED.db
"""

import json
import sqlite3
import sys

from app.report_analytics import build_analytics_report
from app.report_pivot import build_completion_pivot


def reports(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        source = conn.execute(
            "SELECT source_file FROM object_drawings WHERE object_id=1 "
            "AND is_current=1 LIMIT 1"
        ).fetchone()[0]
        return {
            "completion": build_completion_pivot(
                conn, source_file=source, object_id=1, group_by=["crane", "stance"]
            ),
            "analytics": build_analytics_report(conn, 1, "2026-09-27"),
        }
    finally:
        conn.close()


def main(before_path, after_path):
    before, after = reports(before_path), reports(after_path)
    for name in before:
        left = json.dumps(before[name], ensure_ascii=False, sort_keys=True)
        right = json.dumps(after[name], ensure_ascii=False, sort_keys=True)
        if left != right:
            keys = [key for key in before[name] if before[name][key] != after[name].get(key)]
            raise AssertionError(f"{name}: changed sections {keys[:10]}")
        print(f"PASS {name}: complete report data identical before and after conversion")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
