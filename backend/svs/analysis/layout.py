"""Physical target layout: where each LED target sits relative to the athlete's gaze.

Until device calibration (M3) stores the measured layout, a default is used: N targets on a
horizontal arc from -70 deg (left) to +70 deg (right), T1 leftmost, alternating upper/lower row.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class TargetPos:
    target_id: str
    angle_deg: float  # horizontal angle from straight ahead; negative = left
    row: str  # "upper" | "lower"

    @property
    def side(self) -> str:
        if abs(self.angle_deg) < 10:
            return "centre"
        return "left" if self.angle_deg < 0 else "right"

    @property
    def eccentricity_deg(self) -> float:
        return abs(self.angle_deg)

    @property
    def band(self) -> str:
        e = self.eccentricity_deg
        return "central" if e < 20 else "mid" if e < 45 else "peripheral"

    def to_dict(self) -> dict:
        return {**asdict(self), "side": self.side, "eccentricity_deg": self.eccentricity_deg, "band": self.band}


def default_layout(n_targets: int = 8, span_deg: float = 140.0) -> dict[str, TargetPos]:
    if n_targets == 1:
        return {"T1": TargetPos("T1", 0.0, "upper")}
    step = span_deg / (n_targets - 1)
    return {
        f"T{i + 1}": TargetPos(f"T{i + 1}", round(-span_deg / 2 + i * step, 1), "upper" if i % 2 == 0 else "lower")
        for i in range(n_targets)
    }
