"""MQTT transport built on paho-mqtt's network thread, bridged into asyncio.

paho runs its own I/O thread (``loop_start``), so this works on any asyncio event loop,
including the Windows Proactor loop that ``aiomqtt`` cannot use.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator

import paho.mqtt.client as paho
from paho.mqtt.enums import CallbackAPIVersion

from .base import Message, Will

log = logging.getLogger(__name__)


class MqttTransport:
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 1883,
        client_id: str | None = None,
        username: str | None = None,
        password: str | None = None,
        keepalive: int = 10,
    ) -> None:
        self.host, self.port, self.keepalive = host, port, keepalive
        self.client_id = client_id or f"svs-{uuid.uuid4().hex[:8]}"
        self._username, self._password = username, password
        self._client: paho.Client | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[Message] = asyncio.Queue()
        self._subs: dict[str, int] = {}
        self._connected_evt = asyncio.Event()

    @property
    def connected(self) -> bool:
        return self._connected_evt.is_set()

    async def connect(self, will: Will | None = None, timeout: float = 10.0) -> None:
        self._loop = asyncio.get_running_loop()
        c = paho.Client(CallbackAPIVersion.VERSION2, client_id=self.client_id, clean_session=True)
        if self._username:
            c.username_pw_set(self._username, self._password)
        if will:
            c.will_set(will.topic, will.payload, qos=will.qos, retain=will.retain)
        c.reconnect_delay_set(min_delay=1, max_delay=10)
        c.on_connect = self._on_connect
        c.on_disconnect = self._on_disconnect
        c.on_message = self._on_message
        self._client = c
        c.connect_async(self.host, self.port, keepalive=self.keepalive)
        c.loop_start()
        try:
            await asyncio.wait_for(self._connected_evt.wait(), timeout)
        except TimeoutError:
            c.loop_stop()
            raise ConnectionError(f"could not connect to MQTT broker at {self.host}:{self.port}") from None

    # -- paho callbacks (network thread)
    def _on_connect(self, client, _userdata, _flags, reason_code, _props) -> None:
        if reason_code.is_failure:
            log.warning("MQTT connect refused: %s", reason_code)
            return
        for pattern, qos in self._subs.items():  # restore subscriptions after a reconnect
            client.subscribe(pattern, qos)
        self._loop.call_soon_threadsafe(self._connected_evt.set)

    def _on_disconnect(self, _client, _userdata, _flags, reason_code, _props) -> None:
        log.info("MQTT disconnected (%s)", reason_code)
        self._loop.call_soon_threadsafe(self._connected_evt.clear)

    def _on_message(self, _client, _userdata, msg) -> None:
        self._loop.call_soon_threadsafe(self._queue.put_nowait, Message(msg.topic, bytes(msg.payload), msg.retain))

    # -- async API
    async def subscribe(self, pattern: str, qos: int = 0) -> None:
        self._subs[pattern] = qos
        if self._client is not None:
            self._client.subscribe(pattern, qos)

    async def publish(self, topic: str, payload: bytes | str, qos: int = 0, retain: bool = False) -> None:
        if self._client is None:
            raise ConnectionError("not connected")
        self._client.publish(topic, payload, qos=qos, retain=retain)

    async def messages(self) -> AsyncIterator[Message]:
        while True:
            yield await self._queue.get()

    async def close(self) -> None:
        c, self._client = self._client, None
        if c is not None:
            c.disconnect()
            await asyncio.to_thread(c.loop_stop)
        self._connected_evt.clear()

    async def drop(self) -> None:
        """Kill the socket without sending DISCONNECT, so the broker fires the Last-Will."""
        c, self._client = self._client, None
        if c is not None:
            await asyncio.to_thread(c.loop_stop)
            sock = c.socket()
            if sock is not None:
                sock.close()
        self._connected_evt.clear()
