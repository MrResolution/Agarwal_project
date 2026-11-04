"""Protocols, athlete runs (start / list / stop), per-block analysis, trends and the dashboard overview."""

from __future__ import annotations

import random
import statistics
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from .. import audit
from ..analysis.protocols import PROTOCOLS, generate_plan, protocol_with_overrides
from ..analysis.service import analyse_block, block_events, block_status
from ..deps import current_user, get_db, get_visible_athlete, require_staff, visible_athletes
from ..gateway import CommandError
from ..models import BlockRun, ConsentType, Device, DeviceAlert, DeviceEvent, User, utcnow
from .athletes import has_active_consent
from .devices import get_gateway

router = APIRouter(tags=["runs & analysis"])

FINAL = ("done", "aborted", "failed")
CACHE_AFTER_S = 15  # streams are flushed to Parquet every few seconds; wait before caching results
STALE_AFTER_S = 300  # a block with no events for this long will never finish


def _stale(received_at: datetime | None) -> bool:
    if received_at is None:
        return False
    if received_at.tzinfo is None:
        received_at = received_at.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - received_at > timedelta(seconds=STALE_AFTER_S)


class RunCreate(BaseModel):
    protocol: str
    station: str = "station-1"
    params: dict[str, Any] = {}
    seed: int | None = None
    notes: str | None = Field(default=None, max_length=2000)


def run_out(run: BlockRun, include_plan: bool = False) -> dict[str, Any]:
    out = {
        "id": run.id, "block_id": run.block_id, "athlete_id": run.athlete_id, "station": run.station,
        "protocol": run.protocol, "protocol_name": PROTOCOLS[run.protocol].name if run.protocol in PROTOCOLS else run.protocol,
        "kind": run.kind, "params": run.params, "seed": run.seed, "status": run.status, "error": run.error,
        "notes": run.notes, "created_at": run.created_at, "finished_at": run.finished_at,
        "n_trials": len(run.plan), "summary": _compact(run.summary) if run.summary else None,
    }
    if include_plan:
        out["plan"] = run.plan
    return out


def _compact(summary: dict[str, Any]) -> dict[str, Any]:
    """The headline numbers used in lists and trends."""
    rt = summary.get("rt") or {}
    return {
        "median_rt": rt.get("median"), "mean_rt": rt.get("mean"), "sd_rt": rt.get("sd"), "cv": rt.get("cv"),
        "accuracy": summary.get("accuracy"), "overall_accuracy": summary.get("overall_accuracy"),
        "dprime": summary.get("dprime"), "valid_hits": summary.get("valid_hits"), "trials": summary.get("trials"),
        "false_start_rate": summary.get("false_start_rate"), "omission_rate": summary.get("omission_rate"),
        "commission_rate": summary.get("commission_rate"), "premotor_median": (summary.get("premotor") or {}).get("median"),
        "movement_median": (summary.get("movement") or {}).get("median"),
        "asymmetry_index_pct": (summary.get("by_side") or {}).get("asymmetry_index_pct"),
        "quality": summary.get("quality"), "sway_velocity": summary.get("sway_velocity"),
    }


def refresh_run(db: Session, run: BlockRun, request: Request) -> dict[str, Any] | None:
    """Update status from hub events; compute (and cache once final) the analysis."""
    if run.status == "failed":
        return None
    events = block_events(db, run.block_id)
    st = block_status(events)
    changed = False
    if st in ("done", "aborted") and run.status != st:
        run.status = st
        run.finished_at = events[-1].received_at
        changed = True
    elif st == "running" and run.status == "sent":
        run.status = "running"
        changed = True
    if st == "running" and _stale(events[-1].received_at):
        # The hub stopped sending mid-block (power loss, reboot, Wi-Fi gone): close the run.
        run.status, run.finished_at = "aborted", events[-1].received_at
        run.error = f"no hub events for {STALE_AFTER_S // 60} min; block never finished"
        changed = True
    analysis = None
    if events:
        analysis = analyse_block(db, run.block_id, request.app.state.settings.streams_dir)
        finished = run.finished_at
        if finished is not None and finished.tzinfo is None:
            finished = finished.replace(tzinfo=timezone.utc)
        if run.status in ("done", "aborted") and analysis and finished and \
                datetime.now(timezone.utc) - finished > timedelta(seconds=CACHE_AFTER_S) and run.summary is None:
            summary = dict(analysis["summary"])
            if analysis.get("balance") and analysis["balance"].get("status") == "ok":
                summary["sway_velocity"] = analysis["balance"]["mean_velocity_mm_s"]
            run.summary = summary
            changed = True
    if changed:
        db.commit()
    return analysis


def _get_run(db: Session, user: User, run_id: int) -> BlockRun:
    run = db.get(BlockRun, run_id)
    if run is None or run.org_id != user.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Run not found")
    get_visible_athlete(db, user, run.athlete_id)  # enforces athlete visibility for non-staff
    return run


# ------------------------------------------------------------------------------- protocols


@router.get("/protocols")
def list_protocols(_: User = Depends(current_user)) -> list[dict[str, Any]]:
    return [p.to_dict() for p in PROTOCOLS.values()]


# ------------------------------------------------------------------------------- runs


@router.post("/athletes/{athlete_id}/runs", status_code=201)
async def start_run(athlete_id: int, body: RunCreate, request: Request, db: Session = Depends(get_db),
                    user: User = Depends(require_staff)) -> dict[str, Any]:
    athlete = get_visible_athlete(db, user, athlete_id)
    if not has_active_consent(athlete, ConsentType.data):
        raise HTTPException(status.HTTP_409_CONFLICT, "No active data consent for this athlete")
    try:
        proto = protocol_with_overrides(body.protocol, body.params)
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from None
    gw = get_gateway(request)
    dev = next((d for d in gw.devices.values() if d.station == body.station and d.online), None)
    if dev is None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"No online hub on {body.station}")
    n_targets = len(dev.status.get("targets") or []) or 8
    seed = body.seed if body.seed is not None else random.randrange(1, 2**31)
    plan = generate_plan(proto, seed, n_targets)
    run = BlockRun(
        block_id=f"{proto.key}-{uuid.uuid4().hex[:8]}", org_id=user.org_id, athlete_id=athlete.id,
        station=body.station, protocol=proto.key, kind=proto.kind, params=body.params, seed=seed,
        plan=[t.model_dump() for t in plan], notes=body.notes, created_by_id=user.id,
    )
    db.add(run)
    db.flush()
    audit.record(db, user, "start_run", "athlete", athlete.id, block_id=run.block_id, protocol=proto.key)
    db.commit()
    try:
        ack = await gw.send_command(body.station, "start_block",
                                    {"block_id": run.block_id, "trials": run.plan})
    except CommandError as exc:
        run.status, run.error = "failed", str(exc)
        db.commit()
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, str(exc)) from None
    if not ack.ok:
        run.status, run.error = "failed", ack.error
        db.commit()
        raise HTTPException(status.HTTP_409_CONFLICT, f"Hub rejected the block: {ack.error}")
    return run_out(run, include_plan=True)


@router.post("/runs/{run_id}/stop")
async def stop_run(run_id: int, request: Request, estop: bool = False, db: Session = Depends(get_db),
                   user: User = Depends(require_staff)) -> dict[str, Any]:
    run = _get_run(db, user, run_id)
    if run.status in FINAL:
        return run_out(run)
    try:
        await get_gateway(request).send_command(run.station, "estop" if estop else "stop")
    except CommandError as exc:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, str(exc)) from None
    audit.record(db, user, "estop" if estop else "stop_run", "athlete", run.athlete_id, block_id=run.block_id)
    db.commit()
    return run_out(run)


@router.get("/athletes/{athlete_id}/runs")
def list_runs(athlete_id: int, request: Request, protocol: str | None = None, limit: int = 50,
              db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict[str, Any]]:
    get_visible_athlete(db, user, athlete_id)
    stmt = select(BlockRun).where(BlockRun.athlete_id == athlete_id)
    if protocol:
        stmt = stmt.where(BlockRun.protocol == protocol)
    runs = list(db.scalars(stmt.order_by(BlockRun.created_at.desc()).limit(min(limit, 500))))
    for run in runs:
        if run.status not in FINAL or run.summary is None:
            refresh_run(db, run, request)
    return [run_out(r) for r in runs]


@router.get("/runs/{run_id}")
def get_run(run_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    run = _get_run(db, user, run_id)
    analysis = refresh_run(db, run, request)
    return {"run": run_out(run, include_plan=True), "analysis": analysis}


# ------------------------------------------------------------------------------- any block (incl. demo)


@router.get("/stations/{station}/blocks")
def station_blocks(station: str, limit: int = 30, db: Session = Depends(get_db), _: User = Depends(require_staff)) -> list[dict[str, Any]]:
    rows = db.execute(
        select(DeviceEvent.block_id, func.min(DeviceEvent.received_at), func.max(DeviceEvent.received_at),
               func.count(), func.sum(case((DeviceEvent.type == "stimulus_on", 1), else_=0)))
        .where(DeviceEvent.station == station, DeviceEvent.block_id.is_not(None))
        .group_by(DeviceEvent.block_id).order_by(func.max(DeviceEvent.received_at).desc()).limit(min(limit, 200))
    ).all()
    runs = {r.block_id: r for r in db.scalars(select(BlockRun).where(BlockRun.block_id.in_([r[0] for r in rows])))}
    out = []
    for block_id, first, last, n_events, n_stim in rows:
        types = set(db.scalars(select(DeviceEvent.type).where(DeviceEvent.block_id == block_id).distinct()))
        run = runs.get(block_id)
        out.append({"block_id": block_id, "first_event_at": first, "last_event_at": last, "events": n_events,
                    "stimuli": int(n_stim or 0),
                    "status": "done" if "block_done" in types else "aborted" if "block_aborted" in types
                    else "incomplete" if _stale(last) else "running",
                    "run_id": run.id if run else None, "athlete_id": run.athlete_id if run else None,
                    "protocol": run.protocol if run else None})
    return out


@router.get("/blocks/{block_id}/analysis")
def block_analysis(block_id: str, request: Request, db: Session = Depends(get_db), _: User = Depends(require_staff)) -> dict[str, Any]:
    analysis = analyse_block(db, block_id, request.app.state.settings.streams_dir)
    if analysis is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No events for this block")
    return analysis


# ------------------------------------------------------------------------------- trends & overview


@router.get("/athletes/{athlete_id}/trends")
def athlete_trends(athlete_id: int, request: Request, protocol: str | None = None, db: Session = Depends(get_db),
                   user: User = Depends(current_user)) -> dict[str, Any]:
    """Completed runs over time with change vs. the athlete's own baseline (first 2 completed runs
    of the same protocol). Changes are labelled unverified until test-retest reliability (MDC) exists."""
    get_visible_athlete(db, user, athlete_id)
    stmt = select(BlockRun).where(BlockRun.athlete_id == athlete_id)
    if protocol:
        stmt = stmt.where(BlockRun.protocol == protocol)
    runs = list(db.scalars(stmt.order_by(BlockRun.created_at)))
    for run in runs:
        if run.summary is None and run.status != "failed":
            refresh_run(db, run, request)
    series: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        if run.status != "done" or not run.summary:
            continue
        c = _compact(run.summary)
        series.setdefault(run.protocol, []).append({"run_id": run.id, "block_id": run.block_id, "at": run.created_at, **c})
    out = {}
    for proto, points in series.items():
        usable = [p for p in points if p["quality"] == "ok" and p["median_rt"] is not None]
        base = usable[:2]
        baseline = {
            "median_rt": round(statistics.fmean(p["median_rt"] for p in base), 2) if base else None,
            "accuracy": round(statistics.fmean(p["accuracy"] for p in base if p["accuracy"] is not None), 4)
            if any(p["accuracy"] is not None for p in base) else None,
            "runs": [p["run_id"] for p in base],
        }
        for p in points:
            if baseline["median_rt"] and p["median_rt"]:
                p["rt_change_pct"] = round((p["median_rt"] - baseline["median_rt"]) / baseline["median_rt"] * 100, 2)
        out[proto] = {"protocol_name": PROTOCOLS[proto].name if proto in PROTOCOLS else proto,
                      "baseline": baseline, "points": points, "change_status": "unverified"}
    return {"athlete_id": athlete_id, "protocols": out}


@router.get("/overview")
def overview(request: Request, days: int = 42, tz_offset_min: int = 0, db: Session = Depends(get_db),
             user: User = Depends(require_staff)) -> dict[str, Any]:
    """``tz_offset_min`` is the browser's ``Date.getTimezoneOffset()`` (minutes *behind* UTC, so
    India = -330); per-day counts are bucketed by the viewer's local date."""
    now = utcnow()
    week_ago = now - timedelta(days=7)
    local = timezone(timedelta(minutes=-max(-840, min(840, tz_offset_min))))
    athletes = list(db.scalars(visible_athletes(user)))
    runs = list(db.scalars(select(BlockRun).where(BlockRun.org_id == user.org_id).order_by(BlockRun.created_at.desc()).limit(1000)))
    for run in runs[:20]:
        if run.status not in FINAL or run.summary is None:
            refresh_run(db, run, request)

    def aware(d: datetime) -> datetime:
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)

    done = [r for r in runs if r.status == "done" and r.summary]
    week = [r for r in runs if aware(r.created_at) >= week_ago]
    latest_by_athlete: dict[int, BlockRun] = {}
    for r in done:
        latest_by_athlete.setdefault(r.athlete_id, r)
    per_day = {}
    days = max(1, min(days, 120))
    today = now.astimezone(local).date()
    for i in range(days):
        day = (today - timedelta(days=days - 1 - i)).isoformat()
        per_day[day] = 0
    for r in runs:
        d = aware(r.created_at).astimezone(local).date().isoformat()
        if d in per_day:
            per_day[d] += 1
    rts = [_compact(r.summary)["median_rt"] for r in done if _compact(r.summary)["median_rt"]]
    accs = [_compact(r.summary)["accuracy"] for r in done if _compact(r.summary)["accuracy"] is not None]
    devices = list(db.scalars(select(Device)))
    open_alerts = db.scalar(select(func.count()).select_from(DeviceAlert).where(
        DeviceAlert.resolved_at.is_(None), DeviceAlert.severity != "info")) or 0
    by_id = {a.id: a for a in athletes}
    return {
        "athletes": len(athletes),
        "runs_total": len(runs),
        "runs_this_week": len(week),
        "completed_this_week": sum(1 for r in week if r.status == "done"),
        "median_rt_recent": round(statistics.median(rts[:20]), 1) if rts else None,
        "accuracy_recent": round(statistics.fmean(accs[:20]), 4) if accs else None,
        "runs_per_day": [{"date": d, "runs": n} for d, n in per_day.items()],
        "protocol_mix": {p: sum(1 for r in runs if r.protocol == p) for p in PROTOCOLS},
        "devices_online": sum(1 for d in devices if d.online),
        "devices_total": len(devices),
        "open_alerts": open_alerts,
        "recent_runs": [run_out(r) | {"athlete_code": by_id[r.athlete_id].code if r.athlete_id in by_id else None,
                                      "athlete_name": by_id[r.athlete_id].display_name if r.athlete_id in by_id else None}
                        for r in runs[:8]],
        "leaderboard": sorted(
            [{"athlete_id": a, "code": by_id[a].code, "name": by_id[a].display_name, "sport": by_id[a].sport,
              "protocol": r.protocol, **{k: _compact(r.summary)[k] for k in ("median_rt", "accuracy")}}
             for a, r in latest_by_athlete.items() if a in by_id],
            key=lambda x: x["median_rt"] or 1e9)[:8],
        "athletes_without_consent": sum(1 for a in athletes if not has_active_consent(a, ConsentType.data)),
    }
