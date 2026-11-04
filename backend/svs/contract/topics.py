"""MQTT topic layout. Every topic is scoped to a *station* (one hub + its peripherals).

    svs/{station}/hub/status               retained heartbeat, Last-Will = offline   QoS1
    svs/{station}/hub/cmd                  server -> hub commands                    QoS1
    svs/{station}/hub/ack                  hub -> server command acknowledgements    QoS1
    svs/{station}/events                   discrete timing events                    QoS1
    svs/{station}/stream/{kind}/{sensor}   batched samples (kind = imu | balance)    QoS0
    svs/{station}/sync/ping                server -> hub clock-sync request          QoS0
    svs/{station}/sync/pong                hub -> server clock-sync reply            QoS0
"""

from __future__ import annotations

from dataclasses import dataclass

ROOT = "svs"


def status(station: str) -> str:
    return f"{ROOT}/{station}/hub/status"


def cmd(station: str) -> str:
    return f"{ROOT}/{station}/hub/cmd"


def ack(station: str) -> str:
    return f"{ROOT}/{station}/hub/ack"


def events(station: str) -> str:
    return f"{ROOT}/{station}/events"


def stream(station: str, kind: str, sensor: str) -> str:
    return f"{ROOT}/{station}/stream/{kind}/{sensor}"


def sync_ping(station: str) -> str:
    return f"{ROOT}/{station}/sync/ping"


def sync_pong(station: str) -> str:
    return f"{ROOT}/{station}/sync/pong"


# Subscriptions used by the gateway.
GATEWAY_SUBSCRIPTIONS = (
    f"{ROOT}/+/hub/status",
    f"{ROOT}/+/hub/ack",
    f"{ROOT}/+/events",
    f"{ROOT}/+/stream/#",
    f"{ROOT}/+/sync/pong",
)


@dataclass(frozen=True)
class ParsedTopic:
    station: str
    kind: str  # "status" | "ack" | "cmd" | "events" | "stream" | "ping" | "pong"
    stream_kind: str | None = None
    sensor: str | None = None


def parse(topic: str) -> ParsedTopic | None:
    parts = topic.split("/")
    if len(parts) < 3 or parts[0] != ROOT or not parts[1]:
        return None
    station, rest = parts[1], parts[2:]
    match rest:
        case ["hub", "status"]:
            return ParsedTopic(station, "status")
        case ["hub", "ack"]:
            return ParsedTopic(station, "ack")
        case ["hub", "cmd"]:
            return ParsedTopic(station, "cmd")
        case ["events"]:
            return ParsedTopic(station, "events")
        case ["stream", kind, sensor] if kind and sensor:
            return ParsedTopic(station, "stream", kind, sensor)
        case ["sync", "ping"]:
            return ParsedTopic(station, "ping")
        case ["sync", "pong"]:
            return ParsedTopic(station, "pong")
    return None


def matches(pattern: str, topic: str) -> bool:
    """MQTT wildcard matching (``+`` = one level, ``#`` = this level and everything below)."""
    p_parts = pattern.split("/")
    t_parts = topic.split("/")
    for i, p in enumerate(p_parts):
        if p == "#":
            return True
        if i >= len(t_parts):
            return False
        if p != "+" and p != t_parts[i]:
            return False
    return len(p_parts) == len(t_parts)
