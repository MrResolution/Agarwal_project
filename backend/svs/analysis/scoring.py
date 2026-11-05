"""Trial scoring and block summaries (research doc §3 M7).

Input: the block's hub events in any order (duplicates already removed by the gateway).
Output: one :class:`TrialResult` per trial that reached the hub, and a summary dict.

Classification order for a trial (first match wins):
    1. any ``false_start`` during the foreperiod          -> "false_start"
    2. response with RT < anticipation cutoff              -> "anticipation"
    3. response on a no-go trial                           -> "false_alarm"
    4. response on a different target                      -> "wrong_target"
    5. response                                            -> "hit"
    6. no response on a no-go trial                        -> "correct_rejection"
    7. no response, trial completed (stimulus_off seen)    -> "miss"
    8. no response, trial never completed (block aborted)  -> "invalid"
Hits further than ``outlier_mad`` robust SDs from the median are kept but marked
``excluded="outlier"``. Nothing is silently dropped.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from dataclasses import asdict, dataclass
from statistics import NormalDist
from typing import Any

from .layout import TargetPos, default_layout

RESULTS = ("hit", "wrong_target", "miss", "false_alarm", "correct_rejection", "false_start", "anticipation", "invalid")


@dataclass(frozen=True)
class ScoringRules:
    anticipation_ms: float = 100.0  # faster than this cannot be a reaction to the stimulus
    outlier_mad: float = 3.0  # robust SDs (1.4826 x MAD) from the median
    min_valid_trials: int = 5  # fewer valid hits -> "insufficient_data"


@dataclass
class TrialResult:
    trial_no: int
    target_id: str | None
    colour: str | None
    is_nogo: bool
    t_stimulus_us: int | None
    response_target_id: str | None = None
    t_response_us: int | None = None
    rt_ms: float | None = None  # total response time: stimulus -> hit
    premotor_ms: float | None = None  # stimulus -> movement onset (needs IMU)
    movement_ms: float | None = None  # movement onset -> hit (needs IMU)
    force: float | None = None
    false_starts: int = 0
    result: str = "invalid"
    excluded: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _ev_get(ev: dict, key: str, default=None):
    if key in ev and ev[key] is not None:
        return ev[key]
    payload = ev.get("payload") or {}
    if key in payload and payload[key] is not None:
        return payload[key]
    return (payload.get("data") or {}).get(key, default)


def score_trials(events: list[dict], rules: ScoringRules = ScoringRules()) -> list[TrialResult]:
    """``events`` are dicts with at least ``type``, ``trial_no``, ``t_hub_us``, ``target_id``
    (``DeviceEvent`` rows as dicts, or raw contract events with ``t_us``)."""
    by_trial: dict[int, list[dict]] = defaultdict(list)
    for ev in events:
        n = ev.get("trial_no")
        if n is not None:
            by_trial[int(n)].append(ev)

    def t(ev: dict) -> int:
        return int(ev.get("t_hub_us", ev.get("t_us")))

    trials: list[TrialResult] = []
    for n in sorted(by_trial):
        evs = sorted(by_trial[n], key=t)
        stim = next((e for e in evs if e["type"] == "stimulus_on"), None)
        if stim is None:
            continue  # trial never started (block aborted during the foreperiod)
        t_stim = t(stim)
        tr = TrialResult(
            trial_no=n,
            target_id=stim.get("target_id"),
            colour=_ev_get(stim, "colour"),
            is_nogo=bool(_ev_get(stim, "is_nogo", False)),
            t_stimulus_us=t_stim,
        )
        tr.false_starts = sum(1 for e in evs if e["type"] == "false_start" and t(e) <= t_stim)
        resp = next((e for e in evs if e["type"] == "response" and t(e) >= t_stim), None)
        off = next((e for e in evs if e["type"] == "stimulus_off"), None)
        if resp is not None:
            tr.response_target_id = resp.get("target_id")
            tr.t_response_us = t(resp)
            tr.rt_ms = round((tr.t_response_us - t_stim) / 1000, 3)
            tr.force = _ev_get(resp, "force")

        if tr.false_starts:
            tr.result = "false_start"
        elif resp is not None and tr.rt_ms < rules.anticipation_ms:
            tr.result = "anticipation"
        elif resp is not None and tr.is_nogo:
            tr.result = "false_alarm"
        elif resp is not None and tr.response_target_id != tr.target_id:
            tr.result = "wrong_target"
        elif resp is not None:
            tr.result = "hit"
        elif tr.is_nogo:
            tr.result = "correct_rejection" if off is not None else "invalid"
        else:
            tr.result = "miss" if off is not None else "invalid"
        trials.append(tr)

    _mark_outliers(trials, rules)
    return trials


def _mark_outliers(trials: list[TrialResult], rules: ScoringRules) -> None:
    hits = [t for t in trials if t.result == "hit"]
    if len(hits) < 5:
        return
    rts = [t.rt_ms for t in hits]
    med = statistics.median(rts)
    mad = statistics.median(abs(r - med) for r in rts) * 1.4826
    if mad <= 0:
        return
    for t in hits:
        if abs(t.rt_ms - med) > rules.outlier_mad * mad:
            t.excluded = "outlier"


def rt_stats(values: list[float]) -> dict[str, float | int | None]:
    n = len(values)
    if n == 0:
        return {"n": 0, "median": None, "mean": None, "sd": None, "iqr": None, "mad": None, "cv": None,
                "min": None, "max": None, "p10": None, "p90": None}
    s = sorted(values)
    mean = statistics.fmean(s)
    sd = statistics.stdev(s) if n > 1 else 0.0
    med = statistics.median(s)

    def q(p: float) -> float:
        if n == 1:
            return s[0]
        k = (n - 1) * p
        lo, hi = math.floor(k), math.ceil(k)
        return s[lo] + (s[hi] - s[lo]) * (k - lo)

    return {
        "n": n, "median": round(med, 2), "mean": round(mean, 2), "sd": round(sd, 2),
        "iqr": round(q(0.75) - q(0.25), 2), "mad": round(statistics.median(abs(v - med) for v in s), 2),
        "cv": round(sd / mean, 4) if mean else None, "min": round(s[0], 2), "max": round(s[-1], 2),
        "p10": round(q(0.10), 2), "p90": round(q(0.90), 2),
    }


def dprime(hits: int, go: int, false_alarms: int, nogo: int) -> tuple[float | None, float | None]:
    """Signal-detection sensitivity d' and criterion c, with the log-linear correction."""
    if go == 0 or nogo == 0:
        return None, None
    z = NormalDist().inv_cdf
    h = (hits + 0.5) / (go + 1)
    fa = (false_alarms + 0.5) / (nogo + 1)
    return round(z(h) - z(fa), 3), round(-(z(h) + z(fa)) / 2, 3)


def histogram(values: list[float], lo: float = 100, hi: float = 1000, width: float = 50) -> list[dict]:
    bins = []
    edge = lo
    while edge < hi:
        bins.append({"from": edge, "to": edge + width, "count": 0})
        edge += width
    for v in values:
        idx = min(len(bins) - 1, max(0, int((v - lo) // width)))
        bins[idx]["count"] += 1
    return bins


def summarize(
    trials: list[TrialResult],
    rules: ScoringRules = ScoringRules(),
    layout: dict[str, TargetPos] | None = None,
) -> dict[str, Any]:
    layout = layout or default_layout()
    counts = {r: 0 for r in RESULTS}
    for t in trials:
        counts[t.result] += 1

    go = [t for t in trials if not t.is_nogo and t.result != "invalid"]
    nogo = [t for t in trials if t.is_nogo and t.result != "invalid"]
    valid_hits = [t for t in trials if t.result == "hit" and t.excluded is None]
    rts = [t.rt_ms for t in valid_hits]
    scored = [t for t in trials if t.result != "invalid"]

    d, c = dprime(counts["hit"], len(go), counts["false_alarm"], len(nogo))
    premotor = [t.premotor_ms for t in valid_hits if t.premotor_ms is not None]
    movement = [t.movement_ms for t in valid_hits if t.movement_ms is not None]

    per_target = []
    by_target: dict[str, list[TrialResult]] = defaultdict(list)
    for t in trials:
        if t.target_id:
            by_target[t.target_id].append(t)
    for tid in sorted(by_target, key=lambda x: (len(x), x)):
        ts = [t for t in by_target[tid] if t.result != "invalid"]
        go_t = [t for t in ts if not t.is_nogo]
        hits_t = [t.rt_ms for t in ts if t.result == "hit" and t.excluded is None]
        pos = layout.get(tid)
        per_target.append({
            "target_id": tid,
            "trials": len(ts),
            "hits": sum(1 for t in ts if t.result == "hit"),
            "accuracy": round(sum(1 for t in go_t if t.result == "hit") / len(go_t), 3) if go_t else None,
            "median_rt": round(statistics.median(hits_t), 2) if hits_t else None,
            **({"angle_deg": pos.angle_deg, "side": pos.side, "band": pos.band, "row": pos.row} if pos else {}),
        })

    def median_where(pred) -> float | None:
        vals = [t.rt_ms for t in valid_hits if t.target_id in layout and pred(layout[t.target_id])]
        return round(statistics.median(vals), 2) if vals else None

    left, right = median_where(lambda p: p.side == "left"), median_where(lambda p: p.side == "right")
    asym = round((right - left) / ((right + left) / 2) * 100, 2) if left and right else None

    return {
        "trials": len(trials),
        "counts": counts,
        "go_trials": len(go),
        "nogo_trials": len(nogo),
        "valid_hits": len(valid_hits),
        "excluded_outliers": sum(1 for t in trials if t.excluded == "outlier"),
        "rt": rt_stats(rts),
        "premotor": rt_stats(premotor),
        "movement": rt_stats(movement),
        "accuracy": round(counts["hit"] / len(go), 4) if go else None,
        "overall_accuracy": round((counts["hit"] + counts["correct_rejection"]) / len(scored), 4) if scored else None,
        "omission_rate": round(counts["miss"] / len(go), 4) if go else None,
        "commission_rate": round(counts["false_alarm"] / len(nogo), 4) if nogo else None,
        "false_start_rate": round((counts["false_start"] + counts["anticipation"]) / len(scored), 4) if scored else None,
        "dprime": d,
        "criterion": c,
        "per_target": per_target,
        "by_band": {b: median_where(lambda p, b=b: p.band == b) for b in ("central", "mid", "peripheral")},
        "by_side": {"left": left, "right": right, "asymmetry_index_pct": asym},
        "histogram": histogram(rts),
        "quality": "ok" if len(valid_hits) >= rules.min_valid_trials else "insufficient_data",
        "rules": asdict(rules),
    }


@dataclass
class OnsetConfig:
    baseline_ms: float = 200.0  # window before the stimulus used as the resting baseline
    k_sd: float = 4.0  # threshold = baseline mean + k * SD of |acc| deviation
    floor: float = 0.35  # m/s^2, minimum threshold (a very still baseline has tiny SD)
    consecutive: int = 2  # samples above threshold required


def detect_onset(t_us: list[int], acc_xyz: list[tuple[float, float, float]], t_stim_us: int, t_end_us: int,
                 cfg: OnsetConfig | None = None) -> int | None:
    """First movement after the stimulus, or None.

    The signal is the distance of each acceleration sample from the *resting* acceleration
    vector (the mean over the baseline window before the stimulus), so it works whatever
    way the sensor is strapped on. Onset = first sample after the stimulus where that distance
    exceeds baseline mean + k*SD (at least ``floor``) for ``consecutive`` samples.
    """
    cfg = cfg or OnsetConfig()
    base_from = t_stim_us - int(cfg.baseline_ms * 1000)
    base = [a for t, a in zip(t_us, acc_xyz) if base_from <= t < t_stim_us]
    if len(base) < 3:
        return None
    rest = tuple(statistics.fmean(a[i] for a in base) for i in range(3))

    def dev(a: tuple[float, float, float]) -> float:
        return math.sqrt(sum((a[i] - rest[i]) ** 2 for i in range(3)))

    base_dev = [dev(a) for a in base]
    mean, sd = statistics.fmean(base_dev), statistics.pstdev(base_dev)
    thr = max(mean + cfg.k_sd * sd, mean + cfg.floor)
    run = 0
    first = None
    for t, a in zip(t_us, acc_xyz):
        if t < t_stim_us or t > t_end_us:
            continue
        if dev(a) > thr:
            run += 1
            if run == 1:
                first = t
            if run >= cfg.consecutive:
                return first
        else:
            run = 0
    return None
