"""Glue between stored data and the pure analysis functions: load a block's events and the
sensor streams recorded during it, then score, detect movement onset and compute sway."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..gateway.sink import read_stream
from ..models import DeviceEvent
from .balance import sway_metrics
from .layout import default_layout
from .scoring import ScoringRules, detect_onset, score_trials, summarize


def block_events(db: Session, block_id: str) -> list[DeviceEvent]:
    return list(db.scalars(select(DeviceEvent).where(DeviceEvent.block_id == block_id).order_by(DeviceEvent.t_hub_us)))


def block_status(events: list[DeviceEvent]) -> str:
    types = {e.type for e in events}
    if "block_done" in types:
        return "done"
    if "block_aborted" in types:
        return "aborted"
    return "running" if events else "pending"


def _event_dict(e: DeviceEvent) -> dict[str, Any]:
    return {"type": e.type, "trial_no": e.trial_no, "target_id": e.target_id, "t_hub_us": e.t_hub_us, "payload": e.payload}


def _streams_for(streams_dir: Path, station: str, kind: str, boot_id: str, t_from: int, t_to: int):
    base = Path(streams_dir) / station / kind
    if not base.exists():
        return {}
    out = {}
    for sensor_dir in base.iterdir():
        if not (sensor_dir / boot_id).exists():
            continue
        table = read_stream(streams_dir, station, kind, sensor_dir.name, boot_id, t_from, t_to)
        if table.num_rows:
            out[sensor_dir.name] = table
    return out


def analyse_block(db: Session, block_id: str, streams_dir: Path, rules: ScoringRules = ScoringRules(),
                  n_targets: int = 8, include_streams: bool | None = None) -> dict[str, Any] | None:
    """``include_streams=None`` reads IMU/balance streams only once the block has finished;
    while it runs, scoring uses events alone (cheap enough to poll)."""
    events = block_events(db, block_id)
    if not events:
        return None
    station, device_id, boot_id = events[0].station, events[0].device_id, events[0].boot_id
    t_start, t_end = events[0].t_hub_us, events[-1].t_hub_us
    trials = score_trials([_event_dict(e) for e in events], rules)
    status = block_status(events)
    if include_streams is None:
        include_streams = status in ("done", "aborted")

    # Movement onset from the wrist IMU (premotor / movement split).
    imu = _streams_for(streams_dir, station, "imu", boot_id, t_start - 1_000_000, t_end + 1_000_000) if include_streams else {}
    imu_used = None
    if imu:
        imu_used, table = next(iter(imu.items()))
        t_list = table.column("t_hub_us").to_numpy().tolist()
        acc = np.column_stack([table.column(c).to_numpy() for c in ("ax", "ay", "az")])
        acc_t = [tuple(r) for r in acc.tolist()]
        for tr in trials:
            if tr.result not in ("hit", "wrong_target") or tr.t_response_us is None:
                continue
            onset = detect_onset(t_list, acc_t, tr.t_stimulus_us, tr.t_response_us)
            if onset is not None and onset <= tr.t_response_us:
                tr.premotor_ms = round((onset - tr.t_stimulus_us) / 1000, 2)
                tr.movement_ms = round((tr.t_response_us - onset) / 1000, 2)

    layout = default_layout(n_targets)
    summary = summarize(trials, rules, layout)

    balance = None
    bal = _streams_for(streams_dir, station, "balance", boot_id, t_start, t_end) if include_streams else {}
    if bal:
        _, table = next(iter(bal.items()))
        balance = sway_metrics(table.column("t_hub_us").to_numpy(),
                               *(table.column(c).to_numpy() for c in ("fl", "fr", "bl", "br")))

    t_server = [e.t_server_us for e in events if e.t_server_us]
    return {
        "block_id": block_id,
        "station": station,
        "device_id": device_id,
        "boot_id": boot_id,
        "status": status,
        "started_at_us": t_server[0] if t_server else None,
        "ended_at_us": t_server[-1] if t_server else None,
        "duration_s": round((t_end - t_start) / 1e6, 1),
        "summary": summary,
        "trials": [t.to_dict() for t in trials],
        "balance": balance,
        "imu_sensor": imu_used,
        "layout": [p.to_dict() for p in layout.values()],
    }
