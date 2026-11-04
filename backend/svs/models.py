"""ORM models for B0 (orgs, users, athletes, consent, audit) and B1 (devices, events, alerts).

Later milestones add Protocol/ProtocolVersion, Session/Block/Trial, CalibrationRecord, etc.
"""

from __future__ import annotations

import enum
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Role(str, enum.Enum):
    admin = "admin"
    coach = "coach"
    therapist = "therapist"
    athlete = "athlete"
    patient = "patient"
    parent = "parent"


STAFF_ROLES = frozenset({Role.admin, Role.coach, Role.therapist})


class AthleteGroup(str, enum.Enum):
    athlete = "athlete"
    patient = "patient"
    elderly = "elderly"
    child = "child"


class Laterality(str, enum.Enum):
    left = "left"
    right = "right"
    both = "both"


class ConsentType(str, enum.Enum):
    data = "data"  # required to record any session data
    video = "video"  # required to store camera frames / landmarks
    research = "research"  # required to include data in anonymised research exports


class LinkRelation(str, enum.Enum):
    self_ = "self"  # the user *is* this athlete/patient
    guardian = "guardian"  # parent/guardian of a minor


def _enum(e: type[enum.Enum], name: str) -> Enum:
    # Store enum *values* (e.g. "self") rather than member names; non-native for SQLite/Postgres parity.
    return Enum(e, name=name, native_enum=False, values_callable=lambda x: [m.value for m in x], length=32)


class Organisation(Base):
    __tablename__ = "organisations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organisations.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    full_name: Mapped[str] = mapped_column(String(200))
    role: Mapped[Role] = mapped_column(_enum(Role, "role"))
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    organisation: Mapped[Organisation] = relationship()
    athlete_links: Mapped[list[UserAthleteLink]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def is_staff(self) -> bool:
        return self.role in STAFF_ROLES


class Athlete(Base):
    """An athlete, patient, elderly user or child being assessed/trained."""

    __tablename__ = "athletes"
    __table_args__ = (UniqueConstraint("org_id", "code", name="uq_athlete_org_code"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organisations.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(64))  # anonymised participant ID, e.g. "ATH-0007"
    display_name: Mapped[str | None] = mapped_column(String(200))  # optional, removed on anonymise
    birth_year: Mapped[int | None] = mapped_column(Integer)
    group: Mapped[AthleteGroup] = mapped_column(_enum(AthleteGroup, "athlete_group"))
    sport: Mapped[str | None] = mapped_column(String(64))
    position: Mapped[str | None] = mapped_column(String(64))
    dominant_hand: Mapped[Laterality | None] = mapped_column(_enum(Laterality, "laterality"))
    dominant_foot: Mapped[Laterality | None] = mapped_column(_enum(Laterality, "laterality"))
    visual_correction: Mapped[str | None] = mapped_column(String(200))
    history_notes: Mapped[str | None] = mapped_column(Text)
    goals: Mapped[str | None] = mapped_column(Text)
    anonymised_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    consents: Mapped[list[Consent]] = relationship(
        back_populates="athlete", cascade="all, delete-orphan", order_by="Consent.signed_at"
    )
    user_links: Mapped[list[UserAthleteLink]] = relationship(
        back_populates="athlete", cascade="all, delete-orphan"
    )

    def is_minor(self, today: datetime | None = None) -> bool:
        if self.group == AthleteGroup.child:
            return True
        if self.birth_year is None:
            return False
        year = (today or utcnow()).year
        return year - self.birth_year < 18


class UserAthleteLink(Base):
    """Links a login (athlete/patient/parent) to the athlete records they may see."""

    __tablename__ = "user_athlete_links"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    athlete_id: Mapped[int] = mapped_column(ForeignKey("athletes.id", ondelete="CASCADE"), primary_key=True)
    relation: Mapped[LinkRelation] = mapped_column(_enum(LinkRelation, "link_relation"))

    user: Mapped[User] = relationship(back_populates="athlete_links")
    athlete: Mapped[Athlete] = relationship(back_populates="user_links")


class Consent(Base):
    __tablename__ = "consents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    athlete_id: Mapped[int] = mapped_column(ForeignKey("athletes.id", ondelete="CASCADE"), index=True)
    type: Mapped[ConsentType] = mapped_column(_enum(ConsentType, "consent_type"))
    text_version: Mapped[str] = mapped_column(String(32))  # version of the consent form wording
    signed_by: Mapped[str] = mapped_column(String(200))
    guardian_name: Mapped[str | None] = mapped_column(String(200))
    signed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    recorded_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    notes: Mapped[str | None] = mapped_column(Text)

    athlete: Mapped[Athlete] = relationship(back_populates="consents")

    @property
    def active(self) -> bool:
        return self.withdrawn_at is None


class AuditLog(Base):
    """Append-only record of who did what. Never updated or deleted by the application."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    org_id: Mapped[int | None] = mapped_column(Integer, index=True)
    user_id: Mapped[int | None] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(64))
    entity: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


# --------------------------------------------------------------------------- protocol runs


class BlockRun(Base):
    """One protocol block run for one athlete on one station.

    The trial plan is fully determined by (protocol, params, seed) and stored as sent, so the
    run can be repeated exactly. Results are derived from the hub events with ``block_id``.
    """

    __tablename__ = "block_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    block_id: Mapped[str] = mapped_column(String(64), unique=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organisations.id", ondelete="CASCADE"), index=True)
    athlete_id: Mapped[int] = mapped_column(ForeignKey("athletes.id", ondelete="CASCADE"), index=True)
    station: Mapped[str] = mapped_column(String(64))
    protocol: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # assessment | training
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    seed: Mapped[int] = mapped_column(Integer)
    plan: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="sent")  # sent|running|done|aborted|failed
    error: Mapped[str | None] = mapped_column(String(300))
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSON)  # cached once the block is final

    athlete: Mapped[Athlete] = relationship()


# --------------------------------------------------------------------------- devices (B1)


class Device(Base):
    """A hub or other device seen on the MQTT bus. Upserted by the gateway from status messages."""

    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # device_id from firmware
    station: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(32), default="hub")
    label: Mapped[str | None] = mapped_column(String(200))
    firmware: Mapped[str | None] = mapped_column(String(64))
    boot_id: Mapped[str | None] = mapped_column(String(64))
    online: Mapped[bool] = mapped_column(Boolean, default=False)
    battery_pct: Mapped[float | None] = mapped_column(Float)
    rssi: Mapped[float | None] = mapped_column(Float)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class DeviceEvent(Base):
    """A discrete hub event (stimulus on, response, false start, block done...).

    The unique constraint makes ingest idempotent: MQTT QoS1 redeliveries and SD-card
    backfills can be replayed any number of times without creating duplicates.
    """

    __tablename__ = "device_events"
    __table_args__ = (
        UniqueConstraint("device_id", "boot_id", "seq", name="uq_device_event_seq"),
        Index("ix_device_events_station_received", "station", "received_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    station: Mapped[str] = mapped_column(String(64))
    device_id: Mapped[str] = mapped_column(String(64))
    boot_id: Mapped[str] = mapped_column(String(64))
    seq: Mapped[int] = mapped_column(BigInteger)
    type: Mapped[str] = mapped_column(String(32))
    block_id: Mapped[str | None] = mapped_column(String(64), index=True)
    trial_no: Mapped[int | None] = mapped_column(Integer)
    target_id: Mapped[str | None] = mapped_column(String(32))
    t_hub_us: Mapped[int] = mapped_column(BigInteger)  # authoritative hardware timestamp
    t_server_us: Mapped[int | None] = mapped_column(BigInteger)  # hub time mapped to server clock
    clock_quality: Mapped[str] = mapped_column(String(16))  # "synced" | "arrival"
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    backfill: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class DeviceAlert(Base):
    __tablename__ = "device_alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    station: Mapped[str] = mapped_column(String(64), index=True)
    device_id: Mapped[str | None] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(32))  # data_gap, stream_stall, device_offline, low_battery...
    severity: Mapped[str] = mapped_column(String(16))  # info | warning | critical
    message: Mapped[str] = mapped_column(String(500))
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
