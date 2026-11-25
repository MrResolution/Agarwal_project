"""Balance-board analytics (research doc §3 M8): centre of pressure and sway metrics.

Corners: fl, fr, bl, br in kg. Load-cell spacing ``lx`` (left-right) x ``ly`` (front-back) in mm.
    CoP_x (medio-lateral, + = right)  = (lx/2) * ((fr + br) - (fl + bl)) / W
    CoP_y (antero-posterior, + = front) = (ly/2) * ((fl + fr) - (bl + br)) / W
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass(frozen=True)
class BoardGeometry:
    lx_mm: float = 360.0
    ly_mm: float = 360.0
    min_load_kg: float = 10.0  # below this nobody is standing on the board


def cop(fl: np.ndarray, fr: np.ndarray, bl: np.ndarray, br: np.ndarray, geo: BoardGeometry = BoardGeometry()):
    w = fl + fr + bl + br
    with np.errstate(divide="ignore", invalid="ignore"):
        x = (geo.lx_mm / 2) * ((fr + br) - (fl + bl)) / w
        y = (geo.ly_mm / 2) * ((fl + fr) - (bl + br)) / w
    return x, y, w


def smooth(v: np.ndarray, n: int = 5) -> np.ndarray:
    """Centred moving average (zero phase); edges use a shrinking window."""
    if len(v) < n or n <= 1:
        return v
    kernel = np.ones(n) / n
    pad = n // 2
    padded = np.pad(v, pad, mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def sway_metrics(t_us: np.ndarray, fl, fr, bl, br, geo: BoardGeometry = BoardGeometry(),
                 max_points: int = 300) -> dict[str, Any]:
    fl, fr, bl, br = (np.asarray(a, dtype=float) for a in (fl, fr, bl, br))
    t_us = np.asarray(t_us, dtype=np.int64)
    x, y, w = cop(fl, fr, bl, br, geo)
    loaded = w >= geo.min_load_kg
    if loaded.sum() < 10:
        return {"status": "no_load", "samples": int(len(t_us)), "loaded_samples": int(loaded.sum())}
    t, x, y, w = t_us[loaded], smooth(x[loaded]), smooth(y[loaded]), w[loaded]
    duration_s = max((t[-1] - t[0]) / 1e6, 1e-6)
    dx, dy = np.diff(x), np.diff(y)
    path = float(np.sum(np.hypot(dx, dy)))
    xc, yc = x - x.mean(), y - y.mean()
    cov = np.cov(np.vstack([xc, yc]))
    eig = np.clip(np.linalg.eigvalsh(cov), 0, None)
    ellipse = math.pi * 5.991 * math.sqrt(eig[0] * eig[1])  # 95 % confidence ellipse, mm^2
    step = max(1, len(t) // max_points)
    return {
        "status": "ok",
        "samples": int(len(t)),
        "duration_s": round(duration_s, 2),
        "mean_load_kg": round(float(w.mean()), 2),
        "mean_cop_mm": [round(float(x.mean()), 2), round(float(y.mean()), 2)],
        "path_length_mm": round(path, 1),
        "mean_velocity_mm_s": round(path / duration_s, 2),
        "rms_ml_mm": round(float(np.sqrt(np.mean(xc**2))), 2),
        "rms_ap_mm": round(float(np.sqrt(np.mean(yc**2))), 2),
        "range_ml_mm": round(float(x.max() - x.min()), 2),
        "range_ap_mm": round(float(y.max() - y.min()), 2),
        "ellipse_area_mm2": round(ellipse, 1),
        "geometry": {"lx_mm": geo.lx_mm, "ly_mm": geo.ly_mm},
        "path": [[round(float(a), 2), round(float(b), 2)] for a, b in zip(x[::step], y[::step])],
    }
