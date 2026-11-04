"""Hub clock -> server clock mapping from NTP-style ping/pong exchanges.

Reaction time never needs this (stimulus and response are stamped by the same hub clock).
It is needed to put streams from different devices (hub, camera, other hubs) on one
timeline, and to show events in wall-clock time.

For an exchange with server send ``t0``, hub receive ``t1``, hub send ``t2`` and server
receive ``t3`` (server times from one clock, hub times from the other):

    round-trip delay  rtt = (t3 - t0) - (t2 - t1)
    midpoints         hub_mid = (t1 + t2) / 2,  server_mid = (t0 + t3) / 2

Assuming symmetric network delay, ``server_mid`` and ``hub_mid`` are the same instant. A
least-squares line ``server = a * hub + b`` through the lowest-delay exchanges gives the offset
(``b``) and drift (``a - 1``). Low-delay exchanges are the least affected by queueing.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class SyncSample:
    hub_mid: float
    server_mid: float
    rtt_us: float


class ClockMapper:
    MAX_DRIFT_PPM = 2000.0  # anything beyond this is treated as a bad fit, not a real crystal

    def __init__(self, max_samples: int = 64, best_fraction: float = 0.5) -> None:
        self._samples: deque[SyncSample] = deque(maxlen=max_samples)
        self.best_fraction = best_fraction
        self._ref_hub = 0.0
        self._ref_server = 0.0
        self._a = 1.0
        self._b = 0.0  # in reference-relative units
        self._residual_us = 0.0
        self._used = 0

    @property
    def synced(self) -> bool:
        return bool(self._samples)

    def add(self, t0: int, t1: int, t2: int, t3: int) -> bool:
        rtt = (t3 - t0) - (t2 - t1)
        if rtt < 0 or t2 < t1 or t3 < t0:
            return False
        if not self._samples:
            self._ref_hub, self._ref_server = float(t1), float(t0)
        self._samples.append(SyncSample((t1 + t2) / 2, (t0 + t3) / 2, float(rtt)))
        self._fit()
        return True

    def _fit(self) -> None:
        best = sorted(self._samples, key=lambda s: s.rtt_us)
        k = max(2, int(len(best) * self.best_fraction)) if len(best) >= 2 else 1
        used = best[:k]
        xs = [s.hub_mid - self._ref_hub for s in used]
        ys = [s.server_mid - self._ref_server for s in used]
        n = len(used)
        mx, my = sum(xs) / n, sum(ys) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        a = 1.0
        if n >= 2 and sxx > 0:
            a = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
            # Too little time span to estimate drift, or an implausible slope: assume no drift.
            if abs(a - 1.0) * 1e6 > self.MAX_DRIFT_PPM or (max(xs) - min(xs)) < 1e6:
                a = 1.0
        b = my - a * mx
        self._a, self._b, self._used = a, b, n
        self._residual_us = (sum((y - (a * x + b)) ** 2 for x, y in zip(xs, ys)) / n) ** 0.5

    def to_server(self, hub_us: int) -> int | None:
        if not self._samples:
            return None
        return int(round(self._ref_server + self._a * (hub_us - self._ref_hub) + self._b))

    def quality(self) -> dict:
        if not self._samples:
            return {"synced": False, "samples": 0}
        return {
            "synced": True,
            "samples": len(self._samples),
            "used": self._used,
            "rtt_min_us": min(s.rtt_us for s in self._samples),
            # Positive = the hub clock runs fast relative to the server (hub = server * (1 + drift)).
            "drift_ppm": round((1.0 / self._a - 1.0) * 1e6, 3),
            "residual_us": round(self._residual_us, 1),
            # Worst-case error from asymmetric delay is half the best round trip.
            "uncertainty_us": round(min(s.rtt_us for s in self._samples) / 2, 1),
        }
