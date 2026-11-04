"""Request/response models for the REST API."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from .models import AthleteGroup, ConsentType, Laterality, LinkRelation, Role


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- auth / users


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    role: Role
    password: str = Field(min_length=8, max_length=200)


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    role: Role | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=200)


class UserOut(ORM):
    id: int
    org_id: int
    email: str
    full_name: str
    role: Role
    is_active: bool
    created_at: datetime


class AthleteLinkIn(BaseModel):
    athlete_id: int
    relation: LinkRelation


class AthleteLinkOut(ORM):
    user_id: int
    athlete_id: int
    relation: LinkRelation


class MeOut(UserOut):
    athlete_links: list[AthleteLinkOut] = []


# ---------------------------------------------------------------- athletes


class AthleteBase(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    birth_year: int | None = Field(default=None, ge=1900, le=2100)
    group: AthleteGroup
    sport: str | None = Field(default=None, max_length=64)
    position: str | None = Field(default=None, max_length=64)
    dominant_hand: Laterality | None = None
    dominant_foot: Laterality | None = None
    visual_correction: str | None = Field(default=None, max_length=200)
    history_notes: str | None = None
    goals: str | None = None


class AthleteCreate(AthleteBase):
    code: str | None = Field(
        default=None, max_length=64, description="Anonymised participant ID; generated if omitted"
    )


class AthleteUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    birth_year: int | None = Field(default=None, ge=1900, le=2100)
    group: AthleteGroup | None = None
    sport: str | None = Field(default=None, max_length=64)
    position: str | None = Field(default=None, max_length=64)
    dominant_hand: Laterality | None = None
    dominant_foot: Laterality | None = None
    visual_correction: str | None = Field(default=None, max_length=200)
    history_notes: str | None = None
    goals: str | None = None


class ConsentStatus(BaseModel):
    data: bool
    video: bool
    research: bool


class AthleteOut(ORM, AthleteBase):
    id: int
    org_id: int
    code: str
    is_minor: bool
    anonymised_at: datetime | None
    created_at: datetime
    updated_at: datetime
    consent: ConsentStatus


# ---------------------------------------------------------------- consent


class ConsentCreate(BaseModel):
    type: ConsentType
    text_version: str = Field(min_length=1, max_length=32)
    signed_by: str = Field(min_length=1, max_length=200)
    guardian_name: str | None = Field(default=None, max_length=200)
    signed_at: datetime | None = None
    notes: str | None = None


class ConsentOut(ORM):
    id: int
    athlete_id: int
    type: ConsentType
    text_version: str
    signed_by: str
    guardian_name: str | None
    signed_at: datetime
    withdrawn_at: datetime | None
    recorded_by_id: int | None
    notes: str | None
    active: bool


# ---------------------------------------------------------------- audit / devices


class AuditOut(ORM):
    id: int
    at: datetime
    user_id: int | None
    action: str
    entity: str
    entity_id: str | None
    detail: dict[str, Any]


class DeviceOut(ORM):
    id: str
    station: str
    kind: str
    label: str | None
    firmware: str | None
    boot_id: str | None
    online: bool
    battery_pct: float | None
    rssi: float | None
    first_seen: datetime
    last_seen: datetime | None
    last_status: dict[str, Any]


class DeviceEventOut(ORM):
    id: int
    station: str
    device_id: str
    boot_id: str
    seq: int
    type: str
    block_id: str | None
    trial_no: int | None
    target_id: str | None
    t_hub_us: int
    t_server_us: int | None
    clock_quality: str
    received_at: datetime
    backfill: bool
    payload: dict[str, Any]


class DeviceAlertOut(ORM):
    id: int
    at: datetime
    station: str
    device_id: str | None
    kind: str
    severity: str
    message: str
    detail: dict[str, Any]
    resolved_at: datetime | None


class CommandIn(BaseModel):
    cmd: str = Field(pattern="^(start_block|stop|estop|config|ping)$")
    args: dict[str, Any] = {}
    timeout_s: float | None = Field(default=None, gt=0, le=30)
