"""Run a simulated hub against a real MQTT broker.

    python -m svs.simulator --station station-1 --demo 5 --drop 0.02 --dup 0.02 --drift-ppm 40
    python -m svs.simulator --discover --demo 2     # find the broker over mDNS, like real firmware
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import socket

from ..network import discover_brokers
from ..transport.mqtt import MqttTransport
from .hub import SimConfig, SimHub


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m svs.simulator", description=__doc__.splitlines()[0])
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--discover", action="store_true",
                   help="find the broker on the LAN via mDNS (_mqtt._tcp, svs=1) instead of --host")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--station", default="station-1")
    p.add_argument("--device", default="hub-01")
    p.add_argument("--targets", type=int, default=6, help="number of touch-sensor targets")
    p.add_argument("--seed", type=int)
    p.add_argument("--drop", type=float, default=0.0, help="probability of losing a sequenced message")
    p.add_argument("--dup", type=float, default=0.0, help="probability of duplicating a sequenced message")
    p.add_argument("--drift-ppm", type=float, default=0.0, help="hub clock drift vs real time")
    p.add_argument("--demo", type=int, default=0, metavar="N",
                   help="run N self-generated blocks (no session engine needed); 0 = wait for commands")
    p.add_argument("--trials", type=int, default=10, help="trials per demo block")
    p.add_argument("--nogo", type=float, default=0.2, help="no-go ratio in demo blocks")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args()


def _local_ip_towards(host: str) -> str | None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect((host, 1))
            return s.getsockname()[0]
        except OSError:
            return None


async def main() -> None:
    a = parse_args()
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(name)s %(message)s")
    host, port = a.host, a.port
    if a.discover:
        found = await discover_brokers(timeout=3.0)
        if not found:
            raise SystemExit("no SVS broker found via mDNS; start it with `python -m svs.broker --lan`")
        host, port = found[0].host, found[0].port
        logging.info("discovered broker %s at %s:%d", found[0].name, host, port)
    cfg = SimConfig(
        station=a.station, device_id=a.device, n_targets=a.targets, seed=a.seed,
        drop_rate=a.drop, dup_rate=a.dup, drift_ppm=a.drift_ppm,
        ip=_local_ip_towards(host), ssid="simulated",
    )
    hub = SimHub(MqttTransport(host, port, client_id=f"sim-{a.device}"), cfg)
    await hub.start()
    logging.info("simulated hub %s (boot %s) online on %s:%s station=%s", a.device, hub.boot_id, host, port, a.station)
    try:
        for i in range(a.demo):
            block = hub.random_block(a.trials, nogo_ratio=a.nogo)
            logging.info("demo block %d/%d: %s", i + 1, a.demo, block.block_id)
            await hub.run_block(block)
        if a.demo:
            logging.info("demo finished; still streaming. Ctrl+C to stop.")
        await asyncio.Event().wait()
    finally:
        await hub.stop()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
