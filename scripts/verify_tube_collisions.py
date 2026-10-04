"""Проверка геометрии пересечений труб со стержнями (app/calc/geometry_check.py) на синтетике: .venv312/bin/python scripts/verify_tube_collisions.py"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.calc import geometry_check as g  # noqa: E402

part = {"type": "extrusion", "name": "Труба T", "group": "pipe", "origin": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "direction": [0, 0, 1], "depth": 600,
        "profile": [[34 * np.cos(a), 34 * np.sin(a)] for a in np.linspace(0, 2 * np.pi, 48, endpoint=False)], "holes": [{"type": "circle", "center": [0, 0], "radius": 33}]}
spec = g.tube_spec(part)
cases = {"cross": ([[-100, 0, 300], [100, 0, 300]], 10, True), "inside-hole": ([[0, 0, 10], [0, 0, 500]], 5, False),
         "outside": ([[100, 0, 300], [200, 0, 300]], 10, False), "tangent": ([[44.2, -100, 300], [44.2, 100, 300]], 10, False),
         "along-wall": ([[0, 43, 0], [0, 43, 600]], 10, True), "beyond-end": ([[-100, 0, 700], [100, 0, 700]], 10, False)}
failed = 0
for name, (points, r, expected) in cases.items():
    hit = bool(g._check_tube_against(spec, [("g", name, r, np.array(points, dtype=float))]))
    print(("ok   " if hit == expected else "FAIL ") + name)
    failed += hit != expected
sys.exit(1 if failed else 0)
