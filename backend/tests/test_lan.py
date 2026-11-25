"""Real-hardware networking path: broker on the Wi-Fi interface, mDNS discovery, hub over LAN IP."""

from __future__ import annotations

import asyncio
import socket
import time

import pytest
from amqtt.broker import Broker
from sqlalchemy import select

from conftest import migrated_settings
from svs.broker import broker_config
from svs.db import make_engine, make_sessionmaker
from svs.gateway import Gateway
from svs.models import DeviceEvent
from svs.network import BrokerAdvertiser, discover_brokers, lan_ipv4_addresses
from svs.simulator import SimConfig, SimHub
from svs.transport import MqttTransport

LAN_IPS = lan_ipv4_addresses()
pytestmark = [pytest.mark.mqtt, pytest.mark.skipif(not LAN_IPS, reason="no LAN IPv4 address (not on Wi-Fi)")]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("0.0.0.0", 0))
        return s.getsockname()[1]


async def until(cond, timeout=10.0):
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.05)


def test_lan_addresses_exclude_loopback():
    assert all(not ip.startswith(("127.", "169.254.")) for ip in LAN_IPS)


async def test_mdns_advertise_and_discover():
    port = free_port()
    adv = BrokerAdvertiser(port, instance=f"svs-test-{port}")
    await adv.start()
    try:
        found = []
        for _ in range(3):  # multicast can take a moment on Windows
            found = [b for b in await discover_brokers(timeout=2.0) if b.port == port]
            if found:
                break
        assert found, "advertised broker not discovered"
        assert found[0].host in LAN_IPS
    finally:
        await adv.stop()


async def test_hub_over_lan_ip(tmp_path):
    port = free_port()
    broker = Broker(broker_config("0.0.0.0", port))
    await broker.start()
    settings = migrated_settings(tmp_path, sync_interval_s=0.2, mqtt_port=port)
    engine = make_engine(settings.resolved_database_url())
    sm = make_sessionmaker(engine)
    gw = Gateway(MqttTransport("127.0.0.1", port, client_id="gw"), sm, settings)
    lan_ip = LAN_IPS[0]
    hub = SimHub(MqttTransport(lan_ip, port, client_id="hub"), SimConfig(seed=2, status_interval_s=0.3, ip=lan_ip, ssid="test"))
    try:
        await gw.start()
        await hub.start()
        await until(lambda: "hub-01" in gw.devices and gw.devices["hub-01"].status.get("ip") == lan_ip)
        assert (await gw.send_command("station-1", "start_block", hub.random_block(2, fp_range=(100, 150)).model_dump())).ok

        def done() -> bool:
            with sm() as db:
                return db.scalars(select(DeviceEvent).where(DeviceEvent.type == "block_done")).first() is not None

        await until(done, timeout=15)
    finally:
        await hub.stop()
        await gw.stop()
        await broker.shutdown()
        engine.dispose()
