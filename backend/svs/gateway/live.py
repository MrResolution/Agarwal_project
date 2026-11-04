"""In-process fan-out of live messages to WebSocket clients, per station."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any


class LiveHub:
    def __init__(self, queue_size: int = 1000) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self.queue_size = queue_size
        self.dropped = 0

    def subscribe(self, station: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self.queue_size)
        self._subs[station].add(q)
        return q

    def unsubscribe(self, station: str, q: asyncio.Queue) -> None:
        self._subs[station].discard(q)

    def subscriber_count(self, station: str | None = None) -> int:
        if station is not None:
            return len(self._subs.get(station, ()))
        return sum(len(s) for s in self._subs.values())

    def publish(self, station: str, message: dict[str, Any]) -> None:
        # A slow client must never block ingest: drop its oldest message instead.
        for q in list(self._subs.get(station, ())) + list(self._subs.get("*", ())):
            if q.full():
                try:
                    q.get_nowait()
                    self.dropped += 1
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(message)
