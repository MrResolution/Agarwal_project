"""Device registry, alerts, recent events, gateway diagnostics and hub commands."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..deps import get_db, require_staff
from ..gateway import CommandError, Gateway
from ..models import Device, DeviceAlert, DeviceEvent, User
from ..network import HOSTNAME, SERVICE_TYPE, lan_ipv4_addresses
from ..schemas import CommandIn, DeviceAlertOut, DeviceEventOut, DeviceOut

router = APIRouter(tags=["devices"])


def get_gateway(request: Request) -> Gateway:
    gw = getattr(request.app.state, "gateway", None)
    if gw is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Device gateway is not running")
    return gw


@router.get("/devices", response_model=list[DeviceOut])
def list_devices(station: str | None = None, db: Session = Depends(get_db), _: User = Depends(require_staff)) -> list[Device]:
    stmt = select(Device)
    if station:
        stmt = stmt.where(Device.station == station)
    return list(db.scalars(stmt.order_by(Device.station, Device.id)))


@router.get("/devices/{device_id}", response_model=DeviceOut)
def get_device(device_id: str, db: Session = Depends(get_db), _: User = Depends(require_staff)) -> Device:
    dev = db.get(Device, device_id)
    if dev is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    return dev


@router.get("/alerts", response_model=list[DeviceAlertOut])
def list_alerts(
    station: str | None = None,
    open_only: bool = False,
    kind: str | None = None,
    limit: int = 100,
    db: Session = Depends(get_db),
    _: User = Depends(require_staff),
) -> list[DeviceAlert]:
    stmt = select(DeviceAlert)
    if station:
        stmt = stmt.where(DeviceAlert.station == station)
    if open_only:
        stmt = stmt.where(DeviceAlert.resolved_at.is_(None))
    if kind:
        stmt = stmt.where(DeviceAlert.kind == kind)
    return list(db.scalars(stmt.order_by(DeviceAlert.id.desc()).limit(min(limit, 1000))))


@router.post("/alerts/{alert_id}/resolve", response_model=DeviceAlertOut)
def resolve_alert(alert_id: int, db: Session = Depends(get_db), user: User = Depends(require_staff)) -> DeviceAlert:
    alert = db.get(DeviceAlert, alert_id)
    if alert is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Alert not found")
    if alert.resolved_at is None:
        alert.resolved_at = datetime.now(timezone.utc)
        audit.record(db, user, "resolve", "alert", alert.id, kind=alert.kind)
        db.commit()
    return alert


@router.get("/stations/{station}/events", response_model=list[DeviceEventOut])
def station_events(
    station: str,
    block_id: str | None = None,
    type: str | None = None,
    limit: int = 200,
    db: Session = Depends(get_db),
    _: User = Depends(require_staff),
) -> list[DeviceEvent]:
    stmt = select(DeviceEvent).where(DeviceEvent.station == station)
    if block_id:
        stmt = stmt.where(DeviceEvent.block_id == block_id)
    if type:
        stmt = stmt.where(DeviceEvent.type == type)
    rows = list(db.scalars(stmt.order_by(DeviceEvent.id.desc()).limit(min(limit, 5000))))
    rows.reverse()
    return rows


@router.post("/stations/{station}/commands")
async def send_command(
    station: str,
    body: CommandIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
) -> dict[str, Any]:
    """Send a command to a station's hub and wait for its ack.

    Until the session engine (B2) exists this is also how a block is started by hand.
    """
    gw = get_gateway(request)
    audit.record(db, user, "command", "station", station, cmd=body.cmd)
    db.commit()
    try:
        ack = await gw.send_command(station, body.cmd, body.args, body.timeout_s)
    except CommandError as exc:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, str(exc)) from None
    if not ack.ok:
        raise HTTPException(status.HTTP_409_CONFLICT, {"message": "hub rejected the command", "ack": ack.model_dump()})
    return ack.model_dump()


@router.get("/gateway")
def gateway_status(request: Request, _: User = Depends(require_staff)) -> dict[str, Any]:
    return get_gateway(request).snapshot()


@router.get("/network")
def network_info(request: Request, _: User = Depends(require_staff)) -> dict[str, Any]:
    """What a hub on the same Wi-Fi needs to reach this system, plus each hub's reported address."""
    settings = request.app.state.settings
    gw = getattr(request.app.state, "gateway", None)
    port = settings.mqtt_port
    hubs = []
    if gw is not None:
        for dev in gw.devices.values():
            st = dev.status
            hubs.append({"device_id": dev.device_id, "station": dev.station, "online": dev.online,
                         "ip": st.get("ip"), "ssid": st.get("ssid"), "rssi": st.get("rssi"),
                         "firmware": st.get("firmware")})
    local_broker = settings.mqtt_host in ("127.0.0.1", "localhost", "0.0.0.0")
    return {
        "laptop_ips": lan_ipv4_addresses(),
        "broker": {"host_for_gateway": settings.mqtt_host, "port": port, "on_this_machine": local_broker},
        "mdns": {"hostname": HOSTNAME.rstrip("."), "service": SERVICE_TYPE, "txt": {"svs": "1"}},
        "hub_should_connect_to": [f"{ip}:{port}" for ip in lan_ipv4_addresses()] if local_broker else [f"{settings.mqtt_host}:{port}"],
        "hubs": hubs,
    }
