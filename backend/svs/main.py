"""FastAPI application factory.

    uvicorn --factory svs.main:create_app          # API + gateway (needs an MQTT broker; see svs.broker)
    SVS_RUN_GATEWAY=false uvicorn --factory svs.main:create_app   # API only
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import __version__
from .api import athletes, auth, devices, live, users
from .config import Settings, get_settings
from .db import make_engine, make_sessionmaker
from .gateway import Gateway
from .transport.base import Transport
from .transport.mqtt import MqttTransport

log = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    transport_factory: Callable[[], Transport] | None = None,
) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = make_engine(settings.resolved_database_url())
        app.state.settings = settings
        app.state.engine = engine
        app.state.sessionmaker = make_sessionmaker(engine)
        app.state.gateway = None
        if settings.run_gateway:
            transport = (transport_factory or (lambda: MqttTransport(
                settings.mqtt_host, settings.mqtt_port, client_id="svs-gateway",
                username=settings.mqtt_username, password=settings.mqtt_password,
            )))()
            gateway = Gateway(transport, app.state.sessionmaker, settings)
            try:
                await gateway.start()
                app.state.gateway = gateway
            except ConnectionError as exc:
                log.error("gateway disabled: %s (start a broker with `python -m svs.broker`)", exc)
        try:
            yield
        finally:
            if app.state.gateway is not None:
                await app.state.gateway.stop()
            engine.dispose()

    app = FastAPI(
        title="Sports Vision & Reflex System API",
        version=__version__,
        summary="Athletes, consent, devices and live hub data. Sessions/scoring arrive in later milestones.",
        lifespan=lifespan,
    )
    for module in (auth, users, athletes, devices, live):
        app.include_router(module.router)

    @app.get("/health", tags=["meta"])
    def health() -> dict:
        gw = app.state.gateway
        return {"status": "ok", "version": __version__, "gateway": bool(gw and gw.running),
                "mqtt_connected": bool(gw and gw.t.connected)}

    return app
