"""Local MQTT broker (pure Python, via amqtt) for machines without Mosquitto.

    python -m svs.broker            # this machine only (127.0.0.1), for the simulator
    python -m svs.broker --lan      # whole Wi-Fi network + mDNS advert, for real ESP32 hubs

With ``--lan`` the ESP32-S3 hub, on the same router/hotspot, finds this broker through
mDNS (``_mqtt._tcp`` / ``svs-gateway.local``) or connects to one of the printed IPs.
For a deployment beyond a prototype use Eclipse Mosquitto with TLS and per-device logins.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging

from amqtt.broker import Broker

from .network import HOSTNAME, BrokerAdvertiser, lan_ipv4_addresses


def broker_config(host: str = "127.0.0.1", port: int = 1883) -> dict:
    return {
        "listeners": {"default": {"type": "tcp", "bind": f"{host}:{port}"}},
        "plugins": {"amqtt.plugins.authentication.AnonymousAuthPlugin": {"allow_anonymous": True}},
    }


async def run(host: str, port: int, advertise: bool) -> None:
    broker = Broker(broker_config(host, port))
    await broker.start()
    advertiser = None
    if advertise:
        advertiser = BrokerAdvertiser(port)
        try:
            await advertiser.start()
        except Exception as exc:  # mDNS is a convenience; the broker still works without it
            logging.warning("mDNS advertisement failed (%s); hubs must use an IP below", exc)
            advertiser = None
    logging.info("MQTT broker listening on %s:%d (Ctrl+C to stop)", host, port)
    if host in ("0.0.0.0", ""):
        ips = lan_ipv4_addresses()
        logging.info("hubs on this Wi-Fi can connect to: %s", ", ".join(f"{ip}:{port}" for ip in ips) or "(no LAN IP found)")
        if advertiser:
            logging.info("advertised via mDNS as %s and service _mqtt._tcp (svs=1)", HOSTNAME.rstrip("."))
        logging.info("Windows: allow inbound TCP %d in the firewall for the Wi-Fi network profile", port)
    try:
        await asyncio.Event().wait()
    finally:
        if advertiser:
            await advertiser.stop()
        await broker.shutdown()


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m svs.broker", description="Local MQTT broker")
    p.add_argument("--lan", action="store_true", help="listen on all interfaces and advertise via mDNS (real hardware)")
    p.add_argument("--host", help="bind address (default 127.0.0.1, or 0.0.0.0 with --lan)")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--no-mdns", action="store_true", help="with --lan, skip the mDNS advertisement")
    a = p.parse_args()
    host = a.host or ("0.0.0.0" if a.lan else "127.0.0.1")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    for noisy in ("amqtt", "transitions", "zeroconf"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(run(host, a.port, advertise=a.lan and not a.no_mdns))


if __name__ == "__main__":
    main()
