"""Local development MQTT broker (pure Python, via amqtt) for machines without Mosquitto.

    python -m svs.broker --port 1883

For a real deployment use Eclipse Mosquitto with TLS and per-device credentials.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging

from amqtt.broker import Broker


def broker_config(host: str = "127.0.0.1", port: int = 1883) -> dict:
    return {
        "listeners": {"default": {"type": "tcp", "bind": f"{host}:{port}"}},
        "plugins": {"amqtt.plugins.authentication.AnonymousAuthPlugin": {"allow_anonymous": True}},
    }


async def run(host: str, port: int) -> None:
    broker = Broker(broker_config(host, port))
    await broker.start()
    logging.info("MQTT broker listening on %s:%d (Ctrl+C to stop)", host, port)
    try:
        await asyncio.Event().wait()
    finally:
        await broker.shutdown()


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m svs.broker", description="Local dev MQTT broker")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=1883)
    a = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    for noisy in ("amqtt", "transitions"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(run(a.host, a.port))


if __name__ == "__main__":
    main()
