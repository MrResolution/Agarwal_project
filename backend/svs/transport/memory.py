"""In-process broker with MQTT-like semantics: wildcards, retained messages and Last-Will."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from ..contract.topics import matches
from .base import Message, Will


class MemoryBus:
    def __init__(self) -> None:
        self._clients: list[MemoryTransport] = []
        self._retained: dict[str, bytes] = {}

    def client(self, client_id: str = "") -> MemoryTransport:
        return MemoryTransport(self, client_id)

    # -- broker internals
    def _attach(self, client: MemoryTransport) -> None:
        if client not in self._clients:
            self._clients.append(client)

    def _detach(self, client: MemoryTransport) -> None:
        if client in self._clients:
            self._clients.remove(client)

    def _route(self, topic: str, payload: bytes, retain: bool) -> None:
        if retain:
            if payload:
                self._retained[topic] = payload
            else:
                self._retained.pop(topic, None)
        for c in list(self._clients):
            if any(matches(p, topic) for p in c._subs):
                c._queue.put_nowait(Message(topic, payload, False))

    def _send_retained(self, client: MemoryTransport, pattern: str) -> None:
        for topic, payload in self._retained.items():
            if matches(pattern, topic):
                client._queue.put_nowait(Message(topic, payload, True))


class MemoryTransport:
    def __init__(self, bus: MemoryBus, client_id: str) -> None:
        self._bus = bus
        self.client_id = client_id
        self._subs: list[str] = []
        self._queue: asyncio.Queue[Message] = asyncio.Queue()
        self._will: Will | None = None
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self, will: Will | None = None) -> None:
        self._will = will
        self._connected = True
        self._bus._attach(self)

    async def subscribe(self, pattern: str, qos: int = 0) -> None:
        if pattern not in self._subs:
            self._subs.append(pattern)
        self._bus._send_retained(self, pattern)

    async def publish(self, topic: str, payload: bytes | str, qos: int = 0, retain: bool = False) -> None:
        if not self._connected:
            raise ConnectionError("not connected")
        data = payload.encode() if isinstance(payload, str) else payload
        self._bus._route(topic, data, retain)

    async def messages(self) -> AsyncIterator[Message]:
        while True:
            yield await self._queue.get()

    async def close(self) -> None:
        self._connected = False
        self._bus._detach(self)

    async def drop(self) -> None:
        will = self._will
        await self.close()
        if will:
            self._bus._route(will.topic, will.payload, will.retain)
