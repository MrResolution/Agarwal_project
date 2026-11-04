"""Payload schemas (JSON) for every topic in :mod:`svs.contract.topics`.

Rules every sender follows:

* ``device_id`` + ``boot_id`` identify one power-on of one device. ``boot_id`` changes on
  every reboot, and ``seq`` restarts at 0, so sequence numbers are never compared across boots.
* ``seq`` increases by exactly 1 per message *per channel* (``events``, and each stream
  topic separately). The gateway uses it to drop duplicates and detect lost messages.
* ``t_us`` / ``t0_us`` are **hub clock** microseconds (``esp_timer_get_time()``), captured at the
  hardware event. They are the only timestamps used for reaction time. Network arrival time is
  diagnostics only.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONTRACT_VERSION = 1


class _Msg(BaseModel):
    # Ignore unknown fields so newer firmware can add fields without breaking the gateway.
    model_config = ConfigDict(extra="ignore")


class Envelope(_Msg):
    v: int = CONTRACT_VERSION
    device_id: str = Field(min_length=1, max_length=64)
    boot_id: str = Field(min_length=1, max_length=64)
    seq: int = Field(ge=0)


# ----------------------------------------------------------------- status (retained)


class TargetStatus(_Msg):
    id: str
    online: bool = True
    battery_pct: float | None = None


class HubStatus(_Msg):
    """Heartbeat published retained every few seconds; also the Last-Will (``online=false``)."""

    v: int = CONTRACT_VERSION
    device_id: str
    boot_id: str
    online: bool
    t_us: int | None = None
    firmware: str | None = None
    battery_pct: float | None = None
    rssi: float | None = None
    uptime_s: float | None = None
    errors: list[str] = []
    targets: list[TargetStatus] = []
    sensors: list[str] = []  # stream sensor ids this hub publishes, e.g. ["imu/wrist_r", "balance/board"]


# ----------------------------------------------------------------- events

EventType = Literal[
    "block_started",
    "stimulus_on",
    "stimulus_off",
    "response",
    "false_start",
    "block_done",
    "block_aborted",
    "error",
]


class HubEvent(Envelope):
    type: EventType
    t_us: int = Field(ge=0)
    block_id: str | None = None
    trial_no: int | None = None
    target_id: str | None = None
    colour: str | None = None
    force: float | None = None  # peak FSR reading for a hit, if the target has one
    backfill: bool = False  # true when replayed from the SD-card buffer after an outage
    data: dict[str, Any] = {}


# ----------------------------------------------------------------- streams


class StreamBatch(Envelope):
    """N consecutive samples at a fixed rate. Sample i was taken at ``t0_us + i * dt_us``."""

    stream: Literal["imu", "balance"]
    sensor_id: str
    rate_hz: float = Field(gt=0)
    t0_us: int = Field(ge=0)
    dt_us: int = Field(gt=0)
    channels: list[str] = Field(min_length=1)
    samples: list[list[float]] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_shape(self) -> StreamBatch:
        width = len(self.channels)
        for row in self.samples:
            if len(row) != width:
                raise ValueError(f"every sample must have {width} values ({self.channels})")
        return self


IMU_CHANNELS = ["ax", "ay", "az", "gx", "gy", "gz"]  # m/s^2, deg/s
BALANCE_CHANNELS = ["fl", "fr", "bl", "br"]  # kg per corner load cell


# ----------------------------------------------------------------- clock sync


class SyncPing(_Msg):
    id: str
    t0: int  # server clock, us


class SyncPong(_Msg):
    id: str
    device_id: str
    boot_id: str
    t0: int  # echoed server send time
    t1: int  # hub clock when the ping was received
    t2: int  # hub clock when the pong was sent


# ----------------------------------------------------------------- commands

CommandName = Literal["start_block", "stop", "estop", "config", "ping"]


class Command(_Msg):
    cmd_id: str
    cmd: CommandName
    args: dict[str, Any] = {}


class TrialSpec(_Msg):
    trial_no: int = Field(ge=0)
    target_id: str
    colour: str = "green"
    foreperiod_ms: int = Field(ge=0, le=60_000)  # wait before the stimulus
    window_ms: int = Field(default=1500, gt=0, le=60_000)  # response window after stimulus onset
    is_nogo: bool = False
    iti_ms: int = Field(default=500, ge=0, le=60_000)  # pause after the trial


class StartBlockArgs(_Msg):
    block_id: str
    trials: list[TrialSpec] = Field(min_length=1)


class CommandAck(_Msg):
    v: int = CONTRACT_VERSION
    device_id: str
    boot_id: str
    cmd_id: str
    ok: bool
    error: str | None = None
    t_us: int | None = None
