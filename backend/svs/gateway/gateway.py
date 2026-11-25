"""Device gateway: MQTT in, validated + de-duplicated + time-mapped data out.

Responsibilities (research doc §3 M6):
  * validate every message against the contract
  * drop duplicates by (device_id, boot_id, channel, seq); detect and report gaps
  * map hub clock -> server clock (ping/pong clock sync, per boot)
  * persist events to SQL (idempotent) and streams to Parquet
  * track device health (online/offline, battery, heartbeat, stalls) and raise alerts
  * send commands and wait for their acknowledgement
  * fan out live data to WebSocket subscribers (telemetry throttled)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from ..config import Settings
from ..contract import topics
from ..contract.messages import Command, CommandAck, HubEvent, HubStatus, StreamBatch, SyncPing, SyncPong
from ..models import Device, DeviceAlert, DeviceEvent
from ..transport.base import Message, Transport
from .clock import ClockMapper
from .live import LiveHub
from .seq import SeqTracker
from .sink import ParquetSink

log = logging.getLogger(__name__)


def now_us() -> int:
    return time.time_ns() // 1000


class CommandError(RuntimeError):
    pass


@dataclass
class DeviceState:
    station: str
    device_id: str
    boot_id: str | None = None
    online: bool = False
    status: dict[str, Any] = field(default_factory=dict)
    last_status_mono: float = 0.0
    low_battery_alerted: bool = False
    stream_last_mono: dict[str, float] = field(default_factory=dict)
    stalled: set[str] = field(default_factory=set)


class Gateway:
    def __init__(
        self,
        transport: Transport,
        sessionmaker: sessionmaker,
        settings: Settings,
        live: LiveHub | None = None,
        sink: ParquetSink | None = None,
    ) -> None:
        self.t = transport
        self.sm = sessionmaker
        self.s = settings
        self.live = live or LiveHub()
        self.sink = sink or ParquetSink(settings.streams_dir, settings.parquet_flush_rows, settings.parquet_flush_s)
        self.stations: set[str] = set(settings.stations)
        self.devices: dict[str, DeviceState] = {}
        self.trackers: dict[tuple[str, str, str], SeqTracker] = {}
        self.clocks: dict[tuple[str, str], ClockMapper] = {}
        self._pings: dict[str, int] = {}  # ping id -> t0
        self._pending_cmds: dict[str, asyncio.Future] = {}
        self._live_last: dict[tuple[str, str, str], float] = {}
        self._stream_gaps: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._tasks: list[asyncio.Task] = []
        self.stats: dict[str, int] = defaultdict(int)
        self.running = False

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        await self.t.connect()
        for pattern in topics.GATEWAY_SUBSCRIPTIONS:
            await self.t.subscribe(pattern, qos=1)
        self.running = True
        self._tasks = [
            asyncio.create_task(self._consume(), name="gw-consume"),
            asyncio.create_task(self._sync_loop(), name="gw-sync"),
            asyncio.create_task(self._housekeeping(), name="gw-housekeeping"),
        ]
        log.info("gateway started; stations=%s", sorted(self.stations))

    async def stop(self) -> None:
        self.running = False
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._tasks = []
        await asyncio.to_thread(self.sink.flush_all)
        with contextlib.suppress(Exception):
            await self.t.close()

    # ------------------------------------------------------------------ inbound

    async def _consume(self) -> None:
        async for msg in self.t.messages():
            try:
                await self.handle(msg)
            except Exception:  # never let one bad message kill ingest
                self.stats["handler_errors"] += 1
                log.exception("error handling %s", msg.topic)

    async def handle(self, msg: Message) -> None:
        parsed = topics.parse(msg.topic)
        if parsed is None:
            self.stats["unknown_topic"] += 1
            return
        self.stats["messages"] += 1
        self.stations.add(parsed.station)
        try:
            match parsed.kind:
                case "status":
                    await self._on_status(parsed.station, HubStatus.model_validate_json(msg.payload))
                case "events":
                    await self._on_event(parsed.station, HubEvent.model_validate_json(msg.payload))
                case "stream":
                    batch = StreamBatch.model_validate_json(msg.payload)
                    if batch.stream != parsed.stream_kind or batch.sensor_id != parsed.sensor:
                        raise ValueError("topic and payload disagree on stream/sensor")
                    await self._on_stream(parsed.station, batch)
                case "pong":
                    self._on_pong(SyncPong.model_validate_json(msg.payload))
                case "ack":
                    self._on_ack(CommandAck.model_validate_json(msg.payload))
        except (ValidationError, ValueError) as exc:
            self.stats["invalid"] += 1
            if self.stats["invalid"] <= 20 or self.stats["invalid"] % 100 == 0:
                await self._alert(parsed.station, None, "bad_message", "warning",
                                  f"Rejected malformed {parsed.kind} message", topic=msg.topic, error=str(exc)[:300])

    def _device(self, station: str, device_id: str) -> DeviceState:
        dev = self.devices.get(device_id)
        if dev is None:
            dev = self.devices[device_id] = DeviceState(station=station, device_id=device_id)
        return dev

    async def _on_status(self, station: str, st: HubStatus) -> None:
        dev = self._device(station, st.device_id)
        was_online, old_boot = dev.online, dev.boot_id
        if not st.online and old_boot is not None and st.boot_id != old_boot:
            return  # stale Last-Will from a previous boot; the new boot is already online
        dev.online = st.online
        dev.boot_id = st.boot_id
        dev.status = st.model_dump(mode="json")
        dev.last_status_mono = time.monotonic()
        if st.online and old_boot is not None and st.boot_id != old_boot:
            self.stats["reboots"] += 1
            await self._alert(station, st.device_id, "device_rebooted", "warning",
                              f"{st.device_id} rebooted", old_boot=old_boot, new_boot=st.boot_id)
        if was_online != st.online:
            if st.online:
                await self._alert(station, st.device_id, "device_online", "info", f"{st.device_id} is online")
            else:
                await self._alert(station, st.device_id, "device_offline", "critical", f"{st.device_id} went offline")
        if st.battery_pct is not None:
            if st.battery_pct < self.s.low_battery_pct and not dev.low_battery_alerted:
                dev.low_battery_alerted = True
                await self._alert(station, st.device_id, "low_battery", "warning",
                                  f"{st.device_id} battery at {st.battery_pct:.0f}%", battery_pct=st.battery_pct)
            elif st.battery_pct >= self.s.low_battery_pct + 5:
                dev.low_battery_alerted = False
        await asyncio.to_thread(self._upsert_device, station, st)
        self.live.publish(station, {"type": "device_status", "device_id": st.device_id, "status": dev.status})

    def _upsert_device(self, station: str, st: HubStatus) -> None:
        with self.sm() as db:
            dev = db.get(Device, st.device_id)
            if dev is None:
                dev = Device(id=st.device_id, station=station, kind="hub")
                db.add(dev)
            dev.station = station
            dev.online = st.online
            dev.boot_id = st.boot_id
            if st.firmware:
                dev.firmware = st.firmware
            if st.battery_pct is not None:
                dev.battery_pct = st.battery_pct
            if st.rssi is not None:
                dev.rssi = st.rssi
            dev.last_seen = datetime.now(timezone.utc)
            dev.last_status = st.model_dump(mode="json")
            db.commit()

    def _map_time(self, device_id: str, boot_id: str, hub_us: int, arrival_us: int) -> tuple[int, str]:
        clock = self.clocks.get((device_id, boot_id))
        mapped = clock.to_server(hub_us) if clock else None
        if mapped is None:
            return arrival_us, "arrival"
        return mapped, "synced"

    def _tracker(self, device_id: str, boot_id: str, channel: str) -> SeqTracker:
        key = (device_id, boot_id, channel)
        tr = self.trackers.get(key)
        if tr is None:
            tr = self.trackers[key] = SeqTracker(self.s.gap_grace_s)
        return tr

    async def _on_event(self, station: str, ev: HubEvent) -> None:
        arrival = now_us()
        verdict = self._tracker(ev.device_id, ev.boot_id, "events").accept(ev.seq)
        if verdict == "duplicate":
            self.stats["duplicates"] += 1
            return
        t_server, quality = self._map_time(ev.device_id, ev.boot_id, ev.t_us, arrival)
        stored = await asyncio.to_thread(self._insert_event, station, ev, t_server, quality)
        if not stored:
            self.stats["duplicates"] += 1  # already in DB (e.g. gateway restarted, then backfill)
            return
        self.stats["events"] += 1
        if verdict == "recovered" or ev.backfill:
            self.stats["backfilled"] += 1
        self.live.publish(station, {
            "type": "event", "event": ev.model_dump(mode="json"),
            "t_server_us": t_server, "clock_quality": quality, "latency_ms": round((arrival - t_server) / 1000, 2),
        })

    def _insert_event(self, station: str, ev: HubEvent, t_server: int, quality: str) -> bool:
        with self.sm() as db:
            db.add(DeviceEvent(
                station=station, device_id=ev.device_id, boot_id=ev.boot_id, seq=ev.seq, type=ev.type,
                block_id=ev.block_id, trial_no=ev.trial_no, target_id=ev.target_id,
                t_hub_us=ev.t_us, t_server_us=t_server, clock_quality=quality, backfill=ev.backfill,
                payload=ev.model_dump(mode="json", exclude={"v", "device_id", "boot_id", "seq", "type", "t_us"}),
            ))
            try:
                db.commit()
                return True
            except IntegrityError:
                db.rollback()
                return False

    async def _on_stream(self, station: str, batch: StreamBatch) -> None:
        arrival = now_us()
        channel = f"stream/{batch.stream}/{batch.sensor_id}"
        if self._tracker(batch.device_id, batch.boot_id, channel).accept(batch.seq) == "duplicate":
            self.stats["duplicates"] += 1
            return
        last_sample_us = batch.t0_us + (len(batch.samples) - 1) * batch.dt_us
        mapped_last, quality = self._map_time(batch.device_id, batch.boot_id, last_sample_us, arrival)
        t0_server = mapped_last - (last_sample_us - batch.t0_us)
        self.sink.add_batch(station, batch, t0_server, quality)
        self.stats["stream_batches"] += 1
        self.stats["stream_samples"] += len(batch.samples)

        dev = self._device(station, batch.device_id)
        dev.stream_last_mono[channel] = time.monotonic()
        if channel in dev.stalled:
            dev.stalled.discard(channel)
            await self._alert(station, batch.device_id, "stream_resumed", "info", f"{channel} resumed")

        key = (station, batch.device_id, channel)
        now = time.monotonic()
        if now - self._live_last.get(key, 0.0) >= 1 / self.s.live_telemetry_hz:
            self._live_last[key] = now
            self.live.publish(station, {
                "type": f"telemetry.{batch.stream}", "device_id": batch.device_id, "sensor_id": batch.sensor_id,
                "channels": batch.channels, "sample": batch.samples[-1], "t_hub_us": last_sample_us,
                "t_server_us": mapped_last, "clock_quality": quality,
            })

    def _on_pong(self, pong: SyncPong) -> None:
        t3 = now_us()
        t0 = self._pings.pop(pong.id, None)
        if t0 is None or t0 != pong.t0:
            self.stats["sync_unmatched"] += 1
            return
        key = (pong.device_id, pong.boot_id)
        clock = self.clocks.get(key)
        if clock is None:
            clock = self.clocks[key] = ClockMapper()
        if clock.add(t0, pong.t1, pong.t2, t3):
            self.stats["sync_samples"] += 1

    def _on_ack(self, ack: CommandAck) -> None:
        fut = self._pending_cmds.pop(ack.cmd_id, None)
        if fut is not None and not fut.done():
            fut.set_result(ack)

    # ------------------------------------------------------------------ outbound

    async def send_command(self, station: str, cmd: str, args: dict | None = None, timeout_s: float | None = None) -> CommandAck:
        command = Command(cmd_id=uuid.uuid4().hex[:12], cmd=cmd, args=args or {})
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending_cmds[command.cmd_id] = fut
        await self.t.publish(topics.cmd(station), command.model_dump_json().encode(), qos=1)
        self.stats["commands"] += 1
        try:
            return await asyncio.wait_for(fut, timeout_s or self.s.command_timeout_s)
        except TimeoutError:
            await self._alert(station, None, "command_timeout", "critical",
                              f"No acknowledgement for '{cmd}'", cmd_id=command.cmd_id)
            raise CommandError(f"hub on {station} did not acknowledge '{cmd}'") from None
        finally:
            self._pending_cmds.pop(command.cmd_id, None)

    async def _sync_loop(self) -> None:
        while True:
            for station in sorted(self.stations):
                ping = SyncPing(id=uuid.uuid4().hex[:10], t0=now_us())
                self._pings[ping.id] = ping.t0
                with contextlib.suppress(Exception):
                    await self.t.publish(topics.sync_ping(station), ping.model_dump_json().encode(), qos=0)
            # forget pings that never got an answer
            cutoff = now_us() - 10_000_000
            for pid, t0 in list(self._pings.items()):
                if t0 < cutoff:
                    del self._pings[pid]
            await asyncio.sleep(self.s.sync_interval_s)

    # ------------------------------------------------------------------ housekeeping

    async def _housekeeping(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            await self.housekeeping_tick()

    async def housekeeping_tick(self) -> None:
        now = time.monotonic()
        for key, tr in list(self.trackers.items()):
            device_id, boot_id, channel = key
            dev = self.devices.get(device_id)
            station = dev.station if dev else "?"
            for lo, hi in tr.check_gaps(now):
                self.stats["gaps"] += 1
                if channel == "events":
                    # Lost timing events can corrupt a trial: report each one.
                    await self._alert(station, device_id, "data_gap", "warning",
                                      f"{hi - lo + 1} event(s) lost", channel=channel, boot_id=boot_id,
                                      seq_from=lo, seq_to=hi)
                else:
                    acc = self._stream_gaps.setdefault(key, {"since": now, "messages": 0, "ranges": []})
                    acc["messages"] += hi - lo + 1
                    if len(acc["ranges"]) < 50:
                        acc["ranges"].append([lo, hi])
            # Stream losses are summarised per channel at most every stream_gap_summary_s.
            acc = self._stream_gaps.get(key)
            if acc and now - acc["since"] >= self.s.stream_gap_summary_s:
                del self._stream_gaps[key]
                window = now - acc["since"]
                await self._alert(station, device_id, "data_gap", "info",
                                  f"{acc['messages']} batch(es) lost on {channel} in the last {window:.0f}s",
                                  channel=channel, boot_id=boot_id, lost_batches=acc["messages"],
                                  ranges=acc["ranges"], seq_from=acc["ranges"][0][0], seq_to=acc["ranges"][-1][1])
        for dev in list(self.devices.values()):
            if dev.online and now - dev.last_status_mono > self.s.status_stale_after_s:
                dev.online = False
                await self._alert(dev.station, dev.device_id, "device_offline", "critical",
                                  f"{dev.device_id} heartbeat lost")
                await asyncio.to_thread(self._mark_offline, dev.device_id)
            if dev.online:
                for channel, last in dev.stream_last_mono.items():
                    if channel not in dev.stalled and now - last > self.s.stall_after_s:
                        dev.stalled.add(channel)
                        await self._alert(dev.station, dev.device_id, "stream_stall", "warning",
                                          f"No data on {channel} for {now - last:.1f}s", channel=channel)
        await asyncio.to_thread(self.sink.flush_due)

    def _mark_offline(self, device_id: str) -> None:
        with self.sm() as db:
            dev = db.get(Device, device_id)
            if dev is not None:
                dev.online = False
                db.commit()

    async def _alert(self, station: str, device_id: str | None, kind: str, severity: str, message: str, **detail: Any) -> None:
        self.stats[f"alert.{kind}"] += 1
        log.log(logging.WARNING if severity != "info" else logging.INFO, "[%s] %s: %s", station, kind, message)

        def _write() -> int:
            with self.sm() as db:
                row = DeviceAlert(station=station, device_id=device_id, kind=kind, severity=severity,
                                  message=message, detail=detail)
                db.add(row)
                db.commit()
                return row.id

        alert_id = await asyncio.to_thread(_write)
        self.live.publish(station, {"type": "alert", "id": alert_id, "kind": kind, "severity": severity,
                                    "device_id": device_id, "message": message, "detail": detail})

    # ------------------------------------------------------------------ introspection

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "connected": self.t.connected,
            "stations": sorted(self.stations),
            "stats": dict(self.stats),
            "parquet": {"rows_written": self.sink.rows_written, "files_written": self.sink.files_written},
            "live_subscribers": self.live.subscriber_count(),
            "devices": {
                d.device_id: {"station": d.station, "online": d.online, "boot_id": d.boot_id,
                              "stalled": sorted(d.stalled)}
                for d in self.devices.values()
            },
            "clocks": {f"{dev}/{boot}": c.quality() for (dev, boot), c in self.clocks.items()},
            "sequences": {f"{dev}/{boot}/{ch}": dict(tr.counts) for (dev, boot, ch), tr in self.trackers.items()},
        }
