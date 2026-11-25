from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Message:
    topic: str
    payload: bytes
    retain: bool = False


@dataclass(frozen=True)
class Will:
    """Last-Will: published by the broker if the client vanishes without disconnecting."""

    topic: str
    payload: bytes
    qos: int = 1
    retain: bool = True


class Transport(Protocol):
    @property
    def connected(self) -> bool: ...

    async def connect(self, will: Will | None = None) -> None: ...

    async def subscribe(self, pattern: str, qos: int = 0) -> None: ...

    async def publish(self, topic: str, payload: bytes | str, qos: int = 0, retain: bool = False) -> None: ...

    def messages(self) -> AsyncIterator[Message]: ...

    async def close(self) -> None:
        """Clean disconnect (no Last-Will)."""

    async def drop(self) -> None:
        """Abrupt loss of connection (broker publishes the Last-Will). Used for fault injection."""
