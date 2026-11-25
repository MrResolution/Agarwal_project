"""Unit tests: sequence tracking, clock mapping, topic parsing, contract validation."""

from __future__ import annotations

import random

import pytest
from pydantic import ValidationError

from svs.contract import topics
from svs.contract.messages import StreamBatch
from svs.gateway.clock import ClockMapper
from svs.gateway.seq import SeqTracker, to_ranges


def test_seq_new_duplicate_and_gap():
    tr = SeqTracker(grace_s=1.0)
    assert [tr.accept(s) for s in (0, 1, 1, 2, 5)] == ["new", "new", "duplicate", "new", "new"]
    assert tr.check_gaps(now=100.0) == []  # 3, 4 just noticed
    assert tr.check_gaps(now=100.5) == []
    assert tr.check_gaps(now=101.1) == [(3, 4)]
    assert tr.check_gaps(now=200.0) == [], "a gap is reported once"
    assert tr.accept(4) == "recovered"  # late arrival (e.g. backfill)
    assert tr.accept(4) == "duplicate"
    assert tr.accept(6) == "new"
    assert tr.counts == {"new": 5, "duplicate": 2, "recovered": 1, "lost": 1}


def test_seq_starts_mid_stream_without_false_gap():
    tr = SeqTracker(grace_s=0)
    tr.accept(1000)
    tr.accept(1001)
    assert tr.check_gaps(now=1e9) == []
    assert tr.accept(999) == "duplicate"  # before tracking began: treated as already settled


def test_to_ranges():
    assert to_ranges([9, 3, 4, 5]) == [(3, 5), (9, 9)]


def test_clock_mapping_with_offset_drift_and_jitter():
    rng = random.Random(1)
    drift_ppm, offset = 80.0, 7_654_321

    def hub_at(server_us: float) -> int:
        return int(offset + server_us * (1 + drift_ppm / 1e6))

    cm = ClockMapper()
    server = 1_700_000_000_000_000.0
    for _ in range(40):
        up, down = rng.uniform(300, 3000), rng.uniform(300, 3000)  # asymmetric one-way delays
        t0 = int(server)
        t1 = hub_at(server + up)
        t2 = t1 + 50
        t3 = int(server + up + 50 / (1 + drift_ppm / 1e6) + down)
        cm.add(t0, t1, t2, t3)
        server += 2_000_000  # every 2 s

    probe_server = server - 1_000_000
    mapped = cm.to_server(hub_at(probe_server))
    q = cm.quality()
    assert abs(mapped - probe_server) < 1500, q  # within the network-asymmetry bound
    assert abs(q["drift_ppm"] - drift_ppm) < 15, q


def test_clock_rejects_impossible_samples():
    cm = ClockMapper()
    assert cm.add(100, 50, 40, 200) is False  # hub send before hub receive
    assert cm.to_server(123) is None
    assert cm.quality() == {"synced": False, "samples": 0}


def test_topic_parse_and_match():
    p = topics.parse("svs/st-2/stream/imu/wrist_r")
    assert (p.station, p.kind, p.stream_kind, p.sensor) == ("st-2", "stream", "imu", "wrist_r")
    assert topics.parse("svs/st-2/hub/status").kind == "status"
    assert topics.parse("other/x/events") is None
    assert topics.matches("svs/+/stream/#", "svs/a/stream/imu/w")
    assert not topics.matches("svs/+/events", "svs/a/b/events")
    assert topics.matches("svs/#", "svs")


def test_stream_batch_shape_validation():
    base = dict(device_id="d", boot_id="b", seq=0, stream="balance", sensor_id="board", rate_hz=50,
                t0_us=0, dt_us=20000, channels=["fl", "fr", "bl", "br"])
    StreamBatch(**base, samples=[[1, 2, 3, 4]])
    with pytest.raises(ValidationError):
        StreamBatch(**base, samples=[[1, 2, 3]])
