"""Analysis engine: classification rules, summary statistics, plans, onset and sway."""

from __future__ import annotations

import math

import numpy as np
import pytest

from svs.analysis.balance import sway_metrics
from svs.analysis.layout import default_layout
from svs.analysis.protocols import PROTOCOLS, generate_plan, protocol_with_overrides
from svs.analysis.scoring import ScoringRules, detect_onset, dprime, rt_stats, score_trials, summarize


def ev(type_, trial, t_ms, target="T1", **data):
    payload = {"data": data} if data else {}
    if "colour" in data:
        payload["colour"] = data.pop("colour")
    return {"type": type_, "trial_no": trial, "target_id": target, "t_hub_us": int(t_ms * 1000), "payload": payload}


def trial(n, t0, target="T1", rt=None, pressed=None, nogo=False, false_start_at=None, completed=True):
    out = []
    if false_start_at is not None:
        out.append(ev("false_start", n, t0 - false_start_at, target=pressed or target))
    out.append(ev("stimulus_on", n, t0, target=target, colour="red" if nogo else "green", is_nogo=nogo))
    if rt is not None:
        out.append(ev("response", n, t0 + rt, target=pressed or target))
    if completed:
        out.append(ev("stimulus_off", n, t0 + (rt or 1500) + 1, target=target))
    return out


def test_every_classification_rule():
    events = (
        trial(0, 1000, rt=300)                              # hit
        + trial(1, 4000, rt=320, pressed="T2")              # wrong target
        + trial(2, 7000)                                    # miss
        + trial(3, 10000, rt=280, nogo=True)                # false alarm
        + trial(4, 13000, nogo=True)                        # correct rejection
        + trial(5, 16000, rt=310, false_start_at=400)       # false start (pressed in foreperiod)
        + trial(6, 19000, rt=60)                            # anticipation (< 100 ms)
        + trial(7, 22000, completed=False)                  # block aborted mid-trial -> invalid
    )
    result = {t.trial_no: t.result for t in score_trials(list(reversed(events)))}  # order must not matter
    assert result == {0: "hit", 1: "wrong_target", 2: "miss", 3: "false_alarm", 4: "correct_rejection",
                      5: "false_start", 6: "anticipation", 7: "invalid"}


def test_summary_statistics_and_dprime():
    rts = [250, 260, 270, 280, 290, 300, 310, 900]  # 900 is an outlier
    events = []
    for i, rt in enumerate(rts):
        events += trial(i, 1000 + i * 3000, target=f"T{(i % 8) + 1}", rt=rt)
    events += trial(20, 90000, nogo=True) + trial(21, 93000, rt=250, nogo=True, target="T3")
    trials = score_trials(events)
    s = summarize(trials, ScoringRules(), default_layout(8))
    assert s["counts"]["hit"] == 8 and s["excluded_outliers"] == 1
    assert s["valid_hits"] == 7
    assert s["rt"]["median"] == 280 and s["rt"]["n"] == 7
    assert s["accuracy"] == 1.0 and s["commission_rate"] == 0.5
    assert s["dprime"] == dprime(8, 8, 1, 2)[0]
    assert s["quality"] == "ok"
    sides = s["by_side"]
    assert sides["left"] is not None and sides["right"] is not None
    assert sum(b["count"] for b in s["histogram"]) == 7
    assert {p["target_id"] for p in s["per_target"]} == {f"T{i}" for i in range(1, 9)}


def test_rt_stats_and_dprime_values():
    st = rt_stats([200, 300, 400])
    assert (st["median"], st["mean"], st["sd"], st["min"], st["max"]) == (300, 300, 100, 200, 400)
    assert rt_stats([])["median"] is None
    d, c = dprime(hits=18, go=20, false_alarms=2, nogo=10)
    # log-linear: H = 18.5/21 -> z 1.180, FA = 2.5/11 -> z -0.748, d' = 1.928, c = -0.216
    assert d == pytest.approx(1.928, abs=0.002) and c == pytest.approx(-0.216, abs=0.002)
    assert dprime(5, 5, 0, 0) == (None, None)


def test_insufficient_data_flag():
    events = trial(0, 1000, rt=300) + trial(1, 4000, rt=310)
    assert summarize(score_trials(events))["quality"] == "insufficient_data"


def test_plans_are_seeded_balanced_and_valid():
    p = PROTOCOLS["go_nogo"]
    a, b = generate_plan(p, seed=42), generate_plan(p, seed=42)
    assert [t.model_dump() for t in a] == [t.model_dump() for t in b], "same seed -> identical plan"
    assert [t.model_dump() for t in a] != [t.model_dump() for t in generate_plan(p, seed=43)]
    assert len(a) == p.n_trials and sum(t.is_nogo for t in a) == round(p.n_trials * p.nogo_ratio)
    assert not a[0].is_nogo
    counts = {}
    for t in a:
        counts[t.target_id] = counts.get(t.target_id, 0) + 1
    assert max(counts.values()) - min(counts.values()) <= 1, "targets balanced"
    ids = [t.target_id for t in a]
    assert all(len(set(ids[i:i + 4])) > 1 for i in range(len(ids) - 3)), "no target 4x in a row"
    assert all(p.foreperiod_ms[0] <= t.foreperiod_ms <= p.foreperiod_ms[1] for t in a)
    simple = generate_plan(PROTOCOLS["simple_rt"], seed=1)
    assert len({t.target_id for t in simple}) == 1
    periph = generate_plan(PROTOCOLS["peripheral"], seed=1)
    layout = default_layout(8)
    assert all(layout[t.target_id].band == "peripheral" for t in periph)
    assert protocol_with_overrides("choice_rt", {"n_trials": 6, "foreperiod_ms": [100, 200]}).n_trials == 6
    with pytest.raises(KeyError):
        protocol_with_overrides("nope", None)


def test_onset_detection_on_synthetic_imu():
    t = list(range(0, 2_000_000, 10_000))  # 100 Hz
    rng = np.random.default_rng(0)
    onset_true = 1_250_000
    acc = []
    for ti in t:
        burst = 12 * math.sin(math.pi * min(1, (ti - onset_true) / 300_000)) if ti >= onset_true else 0.0
        acc.append((rng.normal(0, 0.05) + burst, rng.normal(0, 0.05), 9.81 + rng.normal(0, 0.05)))
    found = detect_onset(t, acc, t_stim_us=1_000_000, t_end_us=1_700_000)
    assert found is not None and 0 <= found - onset_true <= 30_000
    still = [(0.0, 0.0, 9.81)] * len(t)
    assert detect_onset(t, still, 1_000_000, 1_700_000) is None


def test_stream_file_pruning_by_time():
    from pathlib import Path

    from svs.gateway.sink import _prune_by_name

    files = [Path(f"part-{t:016d}-ab.parquet") for t in (0, 100, 200, 300, 400)]
    names = lambda ps: [int(p.name.split("-")[1]) for p in ps]  # noqa: E731
    assert names(_prune_by_name(files, 150, 250)) == [100, 200]  # file 100 covers [100, 200)
    assert names(_prune_by_name(files, 200, 200)) == [200]
    assert names(_prune_by_name(files, 450, None)) == [400]
    assert names(_prune_by_name(files, None, 50)) == [0]
    assert _prune_by_name([Path("odd.parquet")], 1, 2) == [Path("odd.parquet")]


def test_sway_metrics_on_known_circle():
    n, r_mm = 1000, 10.0
    t = np.arange(n) * 20_000
    theta = np.linspace(0, 2 * math.pi, n)
    lx = ly = 360.0
    x, y = r_mm * np.cos(theta), r_mm * np.sin(theta)
    w = 70.0
    # invert the CoP equations for a 70 kg load centred at (x, y)
    fr_br, fl_bl = w / 2 + x * w / lx, w / 2 - x * w / lx
    front, back = w / 2 + y * w / ly, w / 2 - y * w / ly
    fl, fr = fl_bl * front / w, fr_br * front / w
    bl, br = fl_bl * back / w, fr_br * back / w
    m = sway_metrics(t, fl, fr, bl, br)
    assert m["status"] == "ok" and m["mean_load_kg"] == pytest.approx(70, abs=0.01)
    assert m["path_length_mm"] == pytest.approx(2 * math.pi * r_mm, rel=0.03)
    assert m["range_ml_mm"] == pytest.approx(2 * r_mm, rel=0.05)
    assert sway_metrics(t, *(np.zeros(n),) * 4)["status"] == "no_load"
