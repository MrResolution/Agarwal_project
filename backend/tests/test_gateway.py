"""B1: simulator <-> gateway over the in-memory bus, including injected faults."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from conftest import migrated_settings
from svs.contract import topics
from svs.contract.messages import StartBlockArgs, TrialSpec
from svs.db import make_engine, make_sessionmaker
from svs.gateway import CommandError, Gateway, read_stream
from svs.models import Device, DeviceAlert, DeviceEvent
from svs.simulator import SimConfig, SimHub
from svs.transport import MemoryBus

FAST = dict(sync_interval_s=0.2, gap_grace_s=0.3, stall_after_s=1.0, status_stale_after_s=1.5,
            parquet_flush_s=0.3, command_timeout_s=1.0, stream_gap_summary_s=0.8)


@pytest.fixture
async def rig(tmp_path):
    """A gateway and a factory for simulated hubs, all on one in-memory bus."""
    settings = migrated_settings(tmp_path, **FAST)
    engine = make_engine(settings.resolved_database_url())
    sm = make_sessionmaker(engine)
    bus = MemoryBus()
    gw = Gateway(bus.client("gateway"), sm, settings)
    await gw.start()
    hubs: list[SimHub] = []

    async def make_hub(**cfg) -> SimHub:
        base = dict(seed=7, status_interval_s=0.3)
        hub = SimHub(bus.client(cfg.get("device_id", "hub-01")), SimConfig(**{**base, **cfg}))
        await hub.start()
        hubs.append(hub)
        return hub

    class Rig:
        pass

    r = Rig()
    r.gw, r.sm, r.bus, r.settings, r.make_hub = gw, sm, bus, settings, make_hub
    yield r
    for hub in hubs:
        await hub.stop()
    await gw.stop()
    engine.dispose()


async def until(cond: Callable[[], bool], timeout: float = 10.0, every: float = 0.05) -> None:
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(every)


async def connected(bus: MemoryBus, client_id: str):
    client = bus.client(client_id)
    await client.connect()
    return client


def events(sm, **where) -> list[DeviceEvent]:
    with sm() as db:
        stmt = select(DeviceEvent).order_by(DeviceEvent.t_hub_us)
        for k, v in where.items():
            stmt = stmt.where(getattr(DeviceEvent, k) == v)
        return list(db.scalars(stmt))


def alerts(sm, kind: str | None = None) -> list[DeviceAlert]:
    with sm() as db:
        stmt = select(DeviceAlert).order_by(DeviceAlert.id)
        if kind:
            stmt = stmt.where(DeviceAlert.kind == kind)
        return list(db.scalars(stmt))


def block(n: int, block_id: str = "b1", **kw) -> dict:
    trials = [TrialSpec(trial_no=i, target_id=f"T{(i % 8) + 1}", foreperiod_ms=120 + 20 * (i % 3),
                        window_ms=900, iti_ms=30, **kw) for i in range(n)]
    return StartBlockArgs(block_id=block_id, trials=trials).model_dump()


async def test_device_registered_and_clock_synced(rig):
    hub = await rig.make_hub(drift_ppm=60)
    await until(lambda: rig.gw.clocks.get((hub.cfg.device_id, hub.boot_id)) is not None)
    with rig.sm() as db:
        dev = db.get(Device, "hub-01")
    assert dev.online and dev.station == "station-1" and dev.firmware == "sim-0.1.0"
    assert rig.gw.clocks[(hub.cfg.device_id, hub.boot_id)].quality()["synced"]
    assert [a.kind for a in alerts(rig.sm)] == ["device_online"]


async def test_block_via_command_with_duplicates(rig):
    hub = await rig.make_hub(dup_rate=0.3, p_false_start=0.2, p_miss=0.1)
    await until(lambda: (hub.cfg.device_id, hub.boot_id) in rig.gw.clocks)

    ack = await rig.gw.send_command("station-1", "start_block", block(8))
    assert ack.ok
    await until(lambda: any(e.type == "block_done" for e in events(rig.sm, block_id="b1")), timeout=20)

    stored = events(rig.sm)
    emitted = list(hub.events_emitted)
    assert len(stored) == len(emitted), "every event stored exactly once despite duplicates"
    assert hub.injected["duplicated"] > 0 and rig.gw.stats["duplicates"] > 0
    assert {e.seq for e in stored} == {e.seq for e in emitted}
    assert all(e.clock_quality == "synced" for e in stored)

    # RT timestamps survive end-to-end: response - stimulus == simulator ground truth.
    stim = {e.trial_no: e for e in stored if e.type == "stimulus_on"}
    responses = [e for e in stored if e.type == "response"]
    assert responses
    for r in responses:
        truth = r.payload["data"]["truth"]
        rt_ms = (r.t_hub_us - stim[r.trial_no].t_hub_us) / 1000
        assert rt_ms == pytest.approx(truth["premotor_ms"] + truth["movement_ms"], abs=0.01)
    assert len(stim) == 8


async def test_streams_written_to_parquet_without_duplicates(rig):
    hub = await rig.make_hub(dup_rate=0.2)
    await asyncio.sleep(1.2)
    await hub.stop()
    await asyncio.to_thread(rig.gw.sink.flush_all)
    imu = read_stream(rig.settings.streams_dir, "station-1", "imu", "wrist_r")
    bal = read_stream(rig.settings.streams_dir, "station-1", "balance", "board")
    assert imu.num_rows >= 50 and bal.num_rows >= 30
    t = imu.column("t_hub_us").to_pylist()
    assert t == sorted(t) and len(set(t)) == len(t), "no duplicated samples"
    diffs = {b - a for a, b in zip(t, t[1:])}
    assert diffs == {10_000}, "contiguous 100 Hz samples"
    assert set(imu.column_names) >= {"t_server_us", "ax", "gz", "seq"}
    assert all(v is not None for v in imu.column("t_server_us").to_pylist())


async def test_lost_messages_raise_gap_alerts(rig):
    hub = await rig.make_hub(drop_rate=0.25)
    await asyncio.sleep(2.0)
    await until(lambda: alerts(rig.sm, "data_gap"), timeout=5)
    lost = sum(tr.counts["lost"] for tr in rig.gw.trackers.values())
    assert 0 < lost <= hub.injected["dropped"]
    gaps = alerts(rig.sm, "data_gap")
    assert gaps[0].detail["seq_from"] <= gaps[0].detail["seq_to"]
    # Stream losses are summarised (one alert per channel per window), not one alert per packet.
    assert len(gaps) < lost
    assert sum(g.detail["lost_batches"] for g in gaps) <= lost


async def test_lost_event_is_reported_individually(rig):
    hub = await rig.make_hub()
    await until(lambda: rig.gw.devices.get("hub-01") is not None)
    await hub.emit("error")  # seq 0 arrives (tracking starts here)
    hub.cfg.drop_rate = 1.0
    await hub.emit("error")  # seq 1 lost
    hub.cfg.drop_rate = 0.0
    await hub.emit("error")  # seq 2 arrives -> hole at 1
    await until(lambda: any(a.detail.get("channel") == "events" for a in alerts(rig.sm, "data_gap")), timeout=5)
    gap = next(a for a in alerts(rig.sm, "data_gap") if a.detail["channel"] == "events")
    assert gap.severity == "warning" and gap.message == "1 event(s) lost"


async def test_outage_backfill_is_ingested_once(rig):
    hub = await rig.make_hub(p_miss=0, p_false_start=0)
    await until(lambda: (hub.cfg.device_id, hub.boot_id) in rig.gw.clocks)
    await rig.gw.send_command("station-1", "start_block", block(6, "b2"))
    await asyncio.sleep(0.4)
    await hub.outage(1.5)  # events produced meanwhile go to the SD buffer, then are replayed
    await until(lambda: any(e.type == "block_done" for e in events(rig.sm, block_id="b2")), timeout=20)
    stored = events(rig.sm)
    assert any(e.backfill for e in stored)
    assert len(stored) == len(hub.events_emitted)
    # Replaying the same backfill again (e.g. hub retries) creates nothing new.
    replay = await connected(rig.bus, "replay")
    for ev in [e for e in hub.events_emitted if e.backfill]:
        await replay.publish(topics.events("station-1"), ev.model_dump_json())
    await asyncio.sleep(0.3)
    assert len(events(rig.sm)) == len(stored)
    assert rig.gw.stats["alert.stream_stall"] >= 1, "streams paused during the outage"


async def test_reboot_and_last_will(rig):
    hub = await rig.make_hub()
    old_boot = hub.boot_id
    await until(lambda: rig.gw.devices.get("hub-01") and rig.gw.devices["hub-01"].online)
    await hub.reboot()
    await until(lambda: rig.gw.devices["hub-01"].boot_id == hub.boot_id and rig.gw.devices["hub-01"].online)
    kinds = [a.kind for a in alerts(rig.sm)]
    assert "device_offline" in kinds and "device_rebooted" in kinds
    assert hub.boot_id != old_boot
    with rig.sm() as db:
        assert db.get(Device, "hub-01").boot_id == hub.boot_id


async def test_heartbeat_loss_and_command_timeout(rig):
    hub = await rig.make_hub()
    await until(lambda: rig.gw.devices.get("hub-01") and rig.gw.devices["hub-01"].online)
    # Simulate a frozen hub: stays "connected" (no Last-Will) but stops talking.
    for task in hub._tasks:
        task.cancel()
    await until(lambda: alerts(rig.sm, "device_offline"), timeout=5)
    assert not rig.gw.devices["hub-01"].online
    assert alerts(rig.sm, "device_offline")[0].message.endswith("heartbeat lost")
    with pytest.raises(CommandError):
        await rig.gw.send_command("station-1", "ping", timeout_s=0.3)
    assert alerts(rig.sm, "command_timeout")


async def test_rejected_commands_and_estop(rig):
    hub = await rig.make_hub()
    await until(lambda: rig.gw.devices.get("hub-01") is not None)
    bad = await rig.gw.send_command("station-1", "start_block", {"block_id": "x", "trials": []})
    assert not bad.ok and "invalid args" in bad.error
    unknown = await rig.gw.send_command("station-1", "start_block",
                                        {"block_id": "x", "trials": [{"trial_no": 0, "target_id": "T99", "foreperiod_ms": 10}]})
    assert not unknown.ok and "unknown targets" in unknown.error

    assert (await rig.gw.send_command("station-1", "start_block", block(20, "long"))).ok
    busy = await rig.gw.send_command("station-1", "start_block", block(2, "other"))
    assert not busy.ok and busy.error.startswith("busy")
    assert (await rig.gw.send_command("station-1", "estop")).ok
    await until(lambda: any(e.type == "block_aborted" for e in events(rig.sm)))
    assert not any(e.type == "block_done" for e in events(rig.sm, block_id="long"))
    assert hub.blocks_completed == 0


async def test_malformed_messages_are_rejected_not_fatal(rig):
    client = await connected(rig.bus, "junk")
    await client.publish(topics.events("station-1"), b"{not json")
    await client.publish(topics.events("station-1"), b'{"device_id":"d","boot_id":"b","seq":-1,"type":"response","t_us":1}')
    await client.publish(topics.stream("station-1", "imu", "x"), b'{"device_id":"d","boot_id":"b","seq":0,"stream":"balance",'
                         b'"sensor_id":"x","rate_hz":1,"t0_us":0,"dt_us":1,"channels":["a"],"samples":[[1]]}')
    await until(lambda: rig.gw.stats["invalid"] == 3)
    assert len(alerts(rig.sm, "bad_message")) == 3
    hub = await rig.make_hub()  # gateway still healthy afterwards
    await until(lambda: rig.gw.devices.get(hub.cfg.device_id) is not None)


async def test_live_feed_receives_events_and_throttled_telemetry(rig):
    q = rig.gw.live.subscribe("station-1")
    await rig.make_hub()
    await asyncio.sleep(1.0)
    msgs = []
    while not q.empty():
        msgs.append(q.get_nowait())
    types = {m["type"] for m in msgs}
    assert {"device_status", "telemetry.imu", "telemetry.balance"} <= types
    imu_msgs = [m for m in msgs if m["type"] == "telemetry.imu"]
    assert len(imu_msgs) <= 25, "IMU forwarded at <= ~20 Hz, not the raw 100 Hz"


async def test_event_count_query(rig):
    """Sanity: DB unique constraint is the last line of defence against duplicate events."""
    hub = await rig.make_hub()
    await until(lambda: rig.gw.devices.get("hub-01") is not None)
    ev = await hub.emit("error", data={"code": "E1"})
    dup = await connected(rig.bus, "dup")
    for _ in range(3):
        await dup.publish(topics.events("station-1"), ev.model_dump_json())
    await asyncio.sleep(0.2)
    with rig.sm() as db:
        assert db.scalar(select(func.count()).select_from(DeviceEvent).where(DeviceEvent.type == "error")) == 1
