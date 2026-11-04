"""WebSocket live feed per station: device status, events, alerts and throttled telemetry.

Connect with ``/ws/stations/{station}?token=<JWT>`` (browsers cannot set auth headers on
WebSockets). Use station ``*`` to receive every station.
"""

from __future__ import annotations

import asyncio
import contextlib

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status

from ..deps import user_from_token
from ..models import STAFF_ROLES

router = APIRouter(tags=["live"])


@router.websocket("/ws/stations/{station}")
async def station_feed(websocket: WebSocket, station: str, token: str = "") -> None:
    app = websocket.app
    db = app.state.sessionmaker()
    try:
        user = user_from_token(token, db, app.state.settings)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    finally:
        db.close()
    if user.role not in STAFF_ROLES:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    gateway = getattr(app.state, "gateway", None)
    if gateway is None:
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    await websocket.accept()
    queue = gateway.live.subscribe(station)
    # Send the current device states first so a client that joins late is not blank.
    for dev in gateway.devices.values():
        if station in ("*", dev.station):
            await websocket.send_json({"type": "device_status", "device_id": dev.device_id, "status": dev.status})

    async def pump() -> None:
        while True:
            await websocket.send_json(await queue.get())

    async def drain() -> None:
        while True:  # we only read to notice disconnects; client commands arrive in B2
            await websocket.receive_text()

    tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        for t in tasks:
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, Exception):
                await t
        gateway.live.unsubscribe(station, queue)
