"""Runtime settings, read from environment variables prefixed ``SVS_`` (or a ``.env`` file)."""

from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SVS_", env_file=".env", extra="ignore")

    # Storage
    data_dir: Path = Path("data")
    database_url: str | None = None  # default: sqlite file inside data_dir

    # Auth
    jwt_secret: str | None = None  # default: generated once and kept in data_dir/.jwt_secret
    jwt_ttl_minutes: int = 480
    # Open access: requests from this machine (loopback) without a token act as an admin, so the
    # dashboard opens without signing in. Off by default; for local prototype use only.
    open_access: bool = False
    open_access_email: str | None = None  # which account to act as; default = first active admin

    # MQTT / gateway
    mqtt_host: str = "127.0.0.1"
    mqtt_port: int = 1883
    mqtt_username: str | None = None
    mqtt_password: str | None = None
    run_gateway: bool = True
    stations: list[str] = ["station-1"]  # pinged for clock sync even before they announce themselves
    sync_interval_s: float = 2.0
    command_timeout_s: float = 3.0
    gap_grace_s: float = 2.0  # how long a missing seq may stay missing before it is reported as a gap
    stream_gap_summary_s: float = 10.0  # stream losses are summarised into one alert per channel per window
    stall_after_s: float = 3.0  # no stream data for this long while the hub is online -> stall alert
    status_stale_after_s: float = 8.0  # no status heartbeat for this long -> device marked offline
    low_battery_pct: float = 15.0
    parquet_flush_rows: int = 5000
    parquet_flush_s: float = 5.0
    live_telemetry_hz: float = 20.0  # max rate of telemetry forwarded to WebSocket clients per sensor

    @property
    def streams_dir(self) -> Path:
        return self.data_dir / "streams"

    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{(self.data_dir / 'svs.db').resolve().as_posix()}"

    def resolved_jwt_secret(self) -> str:
        if self.jwt_secret:
            return self.jwt_secret
        self.data_dir.mkdir(parents=True, exist_ok=True)
        path = self.data_dir / ".jwt_secret"
        if not path.exists():
            path.write_text(secrets.token_urlsafe(48), encoding="utf-8")
        self.jwt_secret = path.read_text(encoding="utf-8").strip()
        return self.jwt_secret


@lru_cache
def get_settings() -> Settings:
    return Settings()
