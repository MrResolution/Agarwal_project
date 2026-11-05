"""End-to-end over a real MQTT broker (amqtt on localhost) using the paho transport.

Also checks the API's WebSocket live feed and command endpoint with the gateway running
inside the FastAPI app.
"""

from __future__ import annotations

import asyncio
import socket
import threading
import time

import pytest
from amqtt.broker import Broker
from fastapi.testclient import TestClient
from sqlalchemy import select

from conftest import PASSWORD, make_org_with_admin, migrated_settings
from svs.broker import broker_config
from svs.db import make_engine, make_sessionmaker
from svs.gateway import Gateway
from svs.models import DeviceAlert, DeviceEvent
from svs.simulator import SimConfig, SimHub
from svs.transport import MqttTransport

pytestmark = pytest.mark.mqtt


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def until(cond, timeout=10.0):
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.05)


@pytest.fixture
async def broker():
    port = free_port()
    b = Broker(broker_config("127.0.0.1", port))
    await b.start()
    yield port
    await b.shutdown()


@pytest.fixture
def broker_thread():
    """Broker on its own event loop in a thread, for synchronous (TestClient) tests."""
    port = free_port()
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()

    async def _start() -> Broker:  # the broker must be created on its own loop
        broker = Broker(broker_config("127.0.0.1", port))
        await broker.start()
        return broker

    b = asyncio.run_coroutine_threadsafe(_start(), loop).result(10)
    yield port
    asyncio.run_coroutine_threadsafe(b.shutdown(), loop).result(10)
    loop.call_soon_threadsafe(loop.stop)
    thread.join(5)


async def test_real_broker_block_and_last_will(tmp_path, broker):
    settings = migrated_settings(tmp_path, sync_interval_s=0.2, mqtt_port=broker)
    engine = make_engine(settings.resolved_database_url())
    sm = make_sessionmaker(engine)
    gw = Gateway(MqttTransport("127.0.0.1", broker, client_id="gw"), sm, settings)
    await gw.start()
    hub = SimHub(MqttTransport("127.0.0.1", broker, client_id="hub"), SimConfig(seed=3, status_interval_s=0.3))
    await hub.start()
    try:
        await until(lambda: (hub.cfg.device_id, hub.boot_id) in gw.clocks)
        block = hub.random_block(4, fp_range=(100, 200))
        ack = await gw.send_command("station-1", "start_block", block.model_dump())
        assert ack.ok

        def done() -> bool:
            with sm() as db:
                return db.scalars(select(DeviceEvent).where(DeviceEvent.type == "block_done")).first() is not None

        await until(done, timeout=20)
        with sm() as db:
            stored = list(db.scalars(select(DeviceEvent)))
        assert len(stored) == len(hub.events_emitted)
        q = gw.clocks[(hub.cfg.device_id, hub.boot_id)].quality()
        assert q["synced"] and q["rtt_min_us"] < 50_000

        # Abrupt connection loss -> broker publishes the hub's Last-Will -> offline alert.
        await hub.t.drop()
        for t in hub._tasks:
            t.cancel()

        def offline_alert() -> bool:
            with sm() as db:
                return db.scalars(select(DeviceAlert).where(DeviceAlert.kind == "device_offline")).first() is not None

        await until(offline_alert, timeout=15)
        assert gw.devices["hub-01"].online is False
    finally:
        await hub.stop()
        await gw.stop()
        engine.dispose()


def test_api_websocket_feed_and_commands(tmp_path, broker_thread):
    broker = broker_thread
    settings = migrated_settings(tmp_path, run_gateway=True, mqtt_port=broker, sync_interval_s=0.2)
    engine = make_engine(settings.resolved_database_url())
    make_org_with_admin(make_sessionmaker(engine), "Org", "admin@academy-a.in")
    engine.dispose()

    from svs.main import create_app

    with TestClient(create_app(settings)) as client:
        assert client.get("/health").json()["mqtt_connected"] is True
        token = client.post("/auth/token", data={"username": "admin@academy-a.in", "password": PASSWORD}).json()["access_token"]
        h = {"Authorization": f"Bearer {token}"}

        # The simulated hub must run on the app's event loop; TestClient exposes it as a portal.
        hub = SimHub(MqttTransport("127.0.0.1", broker, client_id="hub-ws"), SimConfig(seed=5, status_interval_s=0.3))
        client.portal.call(hub.start)
        try:
            with pytest.raises(Exception):
                with client.websocket_connect("/ws/stations/station-1?token=bad") as ws:
                    ws.receive_json()

            with client.websocket_connect(f"/ws/stations/station-1?token={token}") as ws:
                seen = set()
                deadline = time.monotonic() + 10
                while not {"device_status", "telemetry.imu", "telemetry.balance"} <= seen:
                    assert time.monotonic() < deadline, seen
                    seen.add(ws.receive_json()["type"])

            r = client.post("/stations/station-1/commands", headers=h, json={"cmd": "ping"})
            assert r.status_code == 200 and r.json()["ok"] is True
            assert [d["id"] for d in client.get("/devices", headers=h).json()] == ["hub-01"]
            snap = client.get("/gateway", headers=h).json()
            assert snap["connected"] and snap["stats"]["stream_batches"] > 0
        finally:
            client.portal.call(hub.stop)
