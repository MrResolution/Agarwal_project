"""Software stand-in for the ESP32-S3 hub.

It speaks the exact MQTT contract in :mod:`svs.contract`, so the gateway, API and later the
session engine can be built and tested before the electronics exist. It also injects the
faults the real system must survive: lost and duplicated messages, clock drift, Wi-Fi
outages with SD-card backfill, reboots and abrupt disconnects.

Human behaviour model
---------------------
* Pre-motor reaction time (stimulus -> movement onset) ~ ex-Gaussian(mu, sigma, tau),
  the standard shape of human RT distributions.
* Movement time (onset -> hit) ~ Normal(mt_mu, mt_sigma), floored at 60 ms.
* Outcomes per trial: false start, miss, wrong target, no-go commission, or a hit.
The ground truth is included in each response event under ``data.truth`` so scoring code
(B3) can be tested against known answers.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import random
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ValidationError

from ..contract import topics
from ..contract.messages import (
    BALANCE_CHANNELS,
    IMU_CHANNELS,
    Command,
    CommandAck,
    HubEvent,
    HubStatus,
    StartBlockArgs,
    StreamBatch,
    SyncPing,
    SyncPong,
    TargetStatus,
    TrialSpec,
)
from ..transport.base import Transport, Will

log = logging.getLogger(__name__)
G = 9.81


@dataclass
class SimConfig:
    station: str = "station-1"
    device_id: str = "hub-01"
    firmware: str = "sim-0.1.0"
    n_targets: int = 8
    imu_sensors: list[str] = field(default_factory=lambda: ["wrist_r"])
    balance_sensors: list[str] = field(default_factory=lambda: ["board"])
    imu_hz: float = 100.0
    balance_hz: float = 50.0
    batch_size: int = 10
    status_interval_s: float = 2.0
    seed: int | None = None
    ip: str | None = None  # reported in status, as real firmware reports WiFi.localIP()
    ssid: str | None = None

    # behaviour model (ms)
    rt_mu: float = 230.0
    rt_sigma: float = 25.0
    rt_tau: float = 50.0
    mt_mu: float = 180.0
    mt_sigma: float = 35.0
    p_false_start: float = 0.03
    p_miss: float = 0.03
    p_wrong_target: float = 0.03
    p_nogo_commission: float = 0.15
    body_mass_kg: float = 70.0

    # faults
    drop_rate: float = 0.0  # probability a published sequenced message is lost
    dup_rate: float = 0.0  # probability a sequenced message is delivered twice
    drift_ppm: float = 0.0  # hub crystal error vs real time
    clock_offset_us: int | None = None  # hub clock value at boot (random if None)

    # battery
    battery_start_pct: float = 96.0
    battery_drain_pct_per_min: float = 0.4


class SimHub:
    def __init__(self, transport: Transport, cfg: SimConfig | None = None) -> None:
        self.t = transport
        self.cfg = cfg or SimConfig()
        self.rng = random.Random(self.cfg.seed)
        self.targets = [f"T{i + 1}" for i in range(self.cfg.n_targets)]
        self._tasks: list[asyncio.Task] = []
        self._block_task: asyncio.Task | None = None
        self._current_block: str | None = None
        self._offline = False  # simulated Wi-Fi outage: events go to the SD buffer
        self._sd_buffer: list[HubEvent] = []
        self._motion: list[tuple[int, int]] = []  # (onset_us, end_us) windows of arm movement
        self._sway = [0.0, 0.0]  # CoP random-walk state (normalised -1..1)
        self.blocks_completed = 0
        self.injected = {"sent": 0, "dropped": 0, "duplicated": 0}  # fault-injection counters
        self.events_emitted: deque[HubEvent] = deque(maxlen=10_000)  # every event created (test oracle)
        self._new_boot()

    # ------------------------------------------------------------------ clock & identity

    def _new_boot(self) -> None:
        self.boot_id = uuid.uuid4().hex[:8]
        self._boot_mono_ns = time.monotonic_ns()
        offset = self.cfg.clock_offset_us
        self._clock_offset = offset if offset is not None else self.rng.randint(1_000_000, 50_000_000)
        self._seq: dict[str, int] = {}
        self._booted_at = time.monotonic()

    def now_us(self) -> int:
        """Hub clock: microseconds since boot (plus offset), running at (1 + drift) x real time."""
        elapsed_us = (time.monotonic_ns() - self._boot_mono_ns) / 1000
        return self._clock_offset + int(elapsed_us * (1 + self.cfg.drift_ppm / 1e6))

    def _next_seq(self, channel: str) -> int:
        n = self._seq.get(channel, 0)
        self._seq[channel] = n + 1
        return n

    @property
    def battery_pct(self) -> float:
        minutes = (time.monotonic() - self._booted_at) / 60
        return max(0.0, self.cfg.battery_start_pct - minutes * self.cfg.battery_drain_pct_per_min)

    # ------------------------------------------------------------------ lifecycle

    def _will(self) -> Will:
        offline = HubStatus(device_id=self.cfg.device_id, boot_id=self.boot_id, online=False)
        return Will(topics.status(self.cfg.station), offline.model_dump_json().encode(), qos=1, retain=True)

    async def start(self) -> None:
        await self.t.connect(will=self._will())
        await self.t.subscribe(topics.cmd(self.cfg.station), qos=1)
        await self.t.subscribe(topics.sync_ping(self.cfg.station), qos=0)
        await self._publish_status()
        self._tasks = [
            asyncio.create_task(self._consume(), name="sim-consume"),
            asyncio.create_task(self._status_loop(), name="sim-status"),
            *[asyncio.create_task(self._imu_loop(s), name=f"sim-imu-{s}") for s in self.cfg.imu_sensors],
            *[asyncio.create_task(self._balance_loop(s), name=f"sim-bal-{s}") for s in self.cfg.balance_sensors],
        ]

    async def stop(self, clean: bool = True) -> None:
        if self._block_task:
            self._block_task.cancel()
        for task in self._tasks:
            task.cancel()
        for task in [*self._tasks, self._block_task]:
            if task:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._tasks = []
        if clean:
            with contextlib.suppress(Exception):
                await self._publish_status(online=False)
            await self.t.close()
        else:
            await self.t.drop()

    async def reboot(self) -> None:
        """Power-cycle: new boot_id, seq counters and clock restart, Last-Will fires first."""
        await self.stop(clean=False)
        self._new_boot()
        await self.start()

    async def outage(self, seconds: float) -> None:
        """Simulated Wi-Fi loss: streams pause, events are buffered then backfilled."""
        self._offline = True
        await asyncio.sleep(seconds)
        self._offline = False
        buffered, self._sd_buffer = self._sd_buffer, []
        for ev in buffered:
            ev.backfill = True
            await self._send(topics.events(self.cfg.station), ev, qos=1, faults=False)

    # ------------------------------------------------------------------ publishing

    async def _send(self, topic: str, msg: BaseModel, qos: int, retain: bool = False, faults: bool = True) -> None:
        payload = msg.model_dump_json(exclude_none=True).encode()
        if faults and self.rng.random() < self.cfg.drop_rate:
            self.injected["dropped"] += 1
            return  # lost in transit (its seq is consumed, so the gateway sees a gap)
        await self.t.publish(topic, payload, qos=qos, retain=retain)
        self.injected["sent"] += 1
        if faults and self.rng.random() < self.cfg.dup_rate:
            await self.t.publish(topic, payload, qos=qos, retain=retain)
            self.injected["duplicated"] += 1

    async def _publish_status(self, online: bool = True) -> None:
        status = HubStatus(
            device_id=self.cfg.device_id,
            boot_id=self.boot_id,
            online=online,
            t_us=self.now_us(),
            firmware=self.cfg.firmware,
            battery_pct=round(self.battery_pct, 1),
            rssi=round(-50 - 10 * self.rng.random(), 1),
            uptime_s=round(time.monotonic() - self._booted_at, 1),
            ip=self.cfg.ip,
            ssid=self.cfg.ssid,
            targets=[TargetStatus(id=t, online=True, battery_pct=round(self.battery_pct, 1)) for t in self.targets],
            sensors=[f"imu/{s}" for s in self.cfg.imu_sensors] + [f"balance/{s}" for s in self.cfg.balance_sensors],
        )
        await self.t.publish(topics.status(self.cfg.station), status.model_dump_json().encode(), qos=1, retain=True)

    async def emit(self, type_: str, t_us: int | None = None, **fields: Any) -> HubEvent:
        ev = HubEvent(
            device_id=self.cfg.device_id,
            boot_id=self.boot_id,
            seq=self._next_seq("events"),
            type=type_,
            t_us=self.now_us() if t_us is None else t_us,
            **fields,
        )
        self.events_emitted.append(ev)
        if self._offline:
            self._sd_buffer.append(ev)
        else:
            await self._send(topics.events(self.cfg.station), ev, qos=1)
        return ev

    async def _ack(self, cmd_id: str, ok: bool, error: str | None = None) -> None:
        ack = CommandAck(
            device_id=self.cfg.device_id, boot_id=self.boot_id, cmd_id=cmd_id, ok=ok, error=error, t_us=self.now_us()
        )
        await self.t.publish(topics.ack(self.cfg.station), ack.model_dump_json().encode(), qos=1)

    # ------------------------------------------------------------------ loops

    async def _status_loop(self) -> None:
        while True:
            await asyncio.sleep(self.cfg.status_interval_s)
            if not self._offline:
                await self._publish_status()

    async def _consume(self) -> None:
        async for msg in self.t.messages():
            parsed = topics.parse(msg.topic)
            if parsed is None:
                continue
            try:
                if parsed.kind == "ping":
                    await self._on_ping(SyncPing.model_validate_json(msg.payload))
                elif parsed.kind == "cmd":
                    await self._on_command(Command.model_validate_json(msg.payload))
            except ValidationError as exc:
                log.warning("simulator ignored malformed %s: %s", parsed.kind, exc)

    async def _on_ping(self, ping: SyncPing) -> None:
        if self._offline:
            return
        t1 = self.now_us()
        await asyncio.sleep(0)  # processing time between receive and reply
        pong = SyncPong(id=ping.id, device_id=self.cfg.device_id, boot_id=self.boot_id, t0=ping.t0, t1=t1, t2=self.now_us())
        await self.t.publish(topics.sync_pong(self.cfg.station), pong.model_dump_json().encode(), qos=0)

    async def _on_command(self, cmd: Command) -> None:
        if cmd.cmd == "ping":
            await self._ack(cmd.cmd_id, True)
        elif cmd.cmd == "start_block":
            if self._block_task and not self._block_task.done():
                await self._ack(cmd.cmd_id, False, "busy: a block is already running")
                return
            try:
                args = StartBlockArgs.model_validate(cmd.args)
            except ValidationError as exc:
                await self._ack(cmd.cmd_id, False, f"invalid args: {exc.errors()[0]['msg']}")
                return
            unknown = {t.target_id for t in args.trials} - set(self.targets)
            if unknown:
                await self._ack(cmd.cmd_id, False, f"unknown targets: {sorted(unknown)}")
                return
            await self._ack(cmd.cmd_id, True)
            self._block_task = asyncio.create_task(self.run_block(args))
        elif cmd.cmd in ("stop", "estop"):
            running = self._block_task and not self._block_task.done()
            if running:
                self._block_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._block_task
            await self._ack(cmd.cmd_id, True)
            if running:
                await self.emit("block_aborted", block_id=self._current_block, data={"reason": cmd.cmd})
            self._current_block = None
        elif cmd.cmd == "config":
            changed = {}
            for key, value in cmd.args.items():
                if hasattr(self.cfg, key) and key.startswith(("rt_", "mt_", "p_", "drop_rate", "dup_rate")):
                    setattr(self.cfg, key, float(value))
                    changed[key] = value
            await self._ack(cmd.cmd_id, True, None if changed else "no recognised keys")

    # ------------------------------------------------------------------ trial execution

    def _exgauss(self) -> float:
        return max(80.0, self.rng.gauss(self.cfg.rt_mu, self.cfg.rt_sigma) + self.rng.expovariate(1 / self.cfg.rt_tau))

    async def run_block(self, args: StartBlockArgs) -> None:
        counts = {"trials": 0, "responses": 0, "false_starts": 0}
        self._current_block = args.block_id
        await self.emit("block_started", block_id=args.block_id, data={"n_trials": len(args.trials)})
        for spec in args.trials:
            r = await self._run_trial(args.block_id, spec)
            counts["trials"] += 1
            counts["responses"] += r["responded"]
            counts["false_starts"] += r["false_start"]
        self.blocks_completed += 1
        await self.emit("block_done", block_id=args.block_id, data=counts)
        self._current_block = None

    async def _run_trial(self, block_id: str, spec: TrialSpec) -> dict[str, bool]:
        cfg, rng = self.cfg, self.rng
        result = {"responded": False, "false_start": False}
        fp_s = spec.foreperiod_ms / 1000

        # Foreperiod, possibly with an anticipatory press before the light comes on.
        if rng.random() < cfg.p_false_start and fp_s > 0.05:
            early = rng.uniform(0.3, 0.9) * fp_s
            await asyncio.sleep(early)
            await self.emit("false_start", block_id=block_id, trial_no=spec.trial_no, target_id=spec.target_id)
            result["false_start"] = True
            await asyncio.sleep(fp_s - early)
        else:
            await asyncio.sleep(fp_s)

        t_stim = self.now_us()
        await self.emit(
            "stimulus_on", t_us=t_stim, block_id=block_id, trial_no=spec.trial_no,
            target_id=spec.target_id, colour=spec.colour, data={"is_nogo": spec.is_nogo},
        )

        respond = rng.random() < (cfg.p_nogo_commission if spec.is_nogo else 1 - cfg.p_miss)
        premotor = self._exgauss()
        mt = max(60.0, rng.gauss(cfg.mt_mu, cfg.mt_sigma))
        total_ms = premotor + mt
        window_s = spec.window_ms / 1000

        if respond and total_ms < spec.window_ms:
            onset_us = t_stim + int(premotor * 1000)
            hit_us = t_stim + int(total_ms * 1000)
            self._motion.append((onset_us, hit_us))
            await asyncio.sleep(total_ms / 1000)
            target = spec.target_id
            if not spec.is_nogo and rng.random() < cfg.p_wrong_target and len(self.targets) > 1:
                target = rng.choice([t for t in self.targets if t != spec.target_id])
            await self.emit(
                "response", t_us=hit_us, block_id=block_id, trial_no=spec.trial_no, target_id=target,
                force=round(rng.uniform(1.0, 8.0), 2),
                data={"truth": {"premotor_ms": round(premotor, 3), "movement_ms": round(mt, 3), "onset_us": onset_us}},
            )
            result["responded"] = True
        else:
            await asyncio.sleep(window_s)

        await self.emit("stimulus_off", block_id=block_id, trial_no=spec.trial_no, target_id=spec.target_id)
        await asyncio.sleep(spec.iti_ms / 1000)
        return result

    # ------------------------------------------------------------------ sensor streams

    def _in_motion(self, t_us: int) -> float:
        """0..1 intensity of the arm movement at hub time t (bell-shaped burst after onset)."""
        self._motion = [(a, b) for a, b in self._motion if b + 500_000 > t_us]
        for onset, end in self._motion:
            if onset <= t_us <= end + 100_000:
                span = max(1, end + 100_000 - onset)
                return math.sin(math.pi * (t_us - onset) / span)
        return 0.0

    async def _stream_loop(self, kind: str, sensor: str, rate_hz: float, channels: list[str], sample_fn) -> None:
        dt_us = int(1e6 / rate_hz)
        n = self.cfg.batch_size
        next_t = self.now_us()
        channel = f"stream/{kind}/{sensor}"
        topic = topics.stream(self.cfg.station, kind, sensor)
        while True:
            # Sleep until the last sample of this batch has been "taken".
            wait_us = next_t + (n - 1) * dt_us - self.now_us()
            if wait_us > 0:
                await asyncio.sleep(wait_us / 1e6)
            samples = [sample_fn(next_t + i * dt_us) for i in range(n)]
            batch = StreamBatch(
                device_id=self.cfg.device_id, boot_id=self.boot_id, seq=self._next_seq(channel),
                stream=kind, sensor_id=sensor, rate_hz=rate_hz, t0_us=next_t, dt_us=dt_us,
                channels=channels, samples=samples,
            )
            next_t += n * dt_us
            if not self._offline:
                await self._send(topic, batch, qos=0)

    def _imu_sample(self, t_us: int) -> list[float]:
        g = self.rng.gauss
        m = self._in_motion(t_us)
        return [
            round(g(0, 0.05) + 12 * m, 4), round(g(0, 0.05) + 3 * m, 4), round(G + g(0, 0.05) - 2 * m, 4),
            round(g(0, 0.8) + 150 * m, 3), round(g(0, 0.8), 3), round(g(0, 0.8) + 40 * m, 3),
        ]

    def _balance_sample(self, _t_us: int) -> list[float]:
        # Mean-reverting random walk of CoP; reaches shift weight in proportion to motion.
        for i in (0, 1):
            self._sway[i] = 0.97 * self._sway[i] + self.rng.gauss(0, 0.01)
        x, y = max(-0.9, min(0.9, self._sway[0])), max(-0.9, min(0.9, self._sway[1]))
        w = self.cfg.body_mass_kg / 4
        g = self.rng.gauss
        return [
            round(w * (1 - x) * (1 + y) + g(0, 0.05), 3),  # front-left
            round(w * (1 + x) * (1 + y) + g(0, 0.05), 3),  # front-right
            round(w * (1 - x) * (1 - y) + g(0, 0.05), 3),  # back-left
            round(w * (1 + x) * (1 - y) + g(0, 0.05), 3),  # back-right
        ]

    async def _imu_loop(self, sensor: str) -> None:
        await self._stream_loop("imu", sensor, self.cfg.imu_hz, IMU_CHANNELS, self._imu_sample)

    async def _balance_loop(self, sensor: str) -> None:
        await self._stream_loop("balance", sensor, self.cfg.balance_hz, BALANCE_CHANNELS, self._balance_sample)

    # ------------------------------------------------------------------ helpers

    def random_block(self, n_trials: int = 10, nogo_ratio: float = 0.0, fp_range=(1000, 2500)) -> StartBlockArgs:
        """A self-generated block, for demos when no session engine is driving the hub yet."""
        trials = [
            TrialSpec(
                trial_no=i,
                target_id=self.rng.choice(self.targets),
                colour="red" if (nogo := self.rng.random() < nogo_ratio) else "green",
                is_nogo=nogo,
                foreperiod_ms=self.rng.randint(*fp_range),
            )
            for i in range(n_trials)
        ]
        return StartBlockArgs(block_id=f"demo-{uuid.uuid4().hex[:6]}", trials=trials)
