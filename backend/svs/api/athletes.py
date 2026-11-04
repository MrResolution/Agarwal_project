"""Athlete/patient profiles, consent records and data-subject functions (export, anonymise, delete)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import audit
from ..deps import current_user, get_db, get_visible_athlete, require_admin, require_staff, visible_athletes
from ..models import (
    Athlete,
    AthleteGroup,
    Consent,
    ConsentType,
    LinkRelation,
    User,
)
from ..schemas import (
    AthleteCreate,
    AthleteOut,
    AthleteUpdate,
    ConsentCreate,
    ConsentOut,
    ConsentStatus,
)

router = APIRouter(prefix="/athletes", tags=["athletes"])

REDACTED = "[redacted]"


def consent_status(athlete: Athlete) -> ConsentStatus:
    active = {c.type for c in athlete.consents if c.active}
    return ConsentStatus(
        data=ConsentType.data in active,
        video=ConsentType.video in active,
        research=ConsentType.research in active,
    )


def has_active_consent(athlete: Athlete, kind: ConsentType) -> bool:
    """Used by later milestones (e.g. the session engine refuses to start without data consent)."""
    return any(c.type == kind and c.active for c in athlete.consents)


def to_out(athlete: Athlete) -> AthleteOut:
    data = {c: getattr(athlete, c) for c in AthleteOut.model_fields if hasattr(athlete, c) and c != "is_minor"}
    return AthleteOut(**data, is_minor=athlete.is_minor(), consent=consent_status(athlete))


def _next_code(db: Session, org_id: int) -> str:
    count = db.scalar(select(func.count()).select_from(Athlete).where(Athlete.org_id == org_id)) or 0
    n = count + 1
    while db.scalars(select(Athlete.id).where(Athlete.org_id == org_id, Athlete.code == f"ATH-{n:04d}")).first():
        n += 1
    return f"ATH-{n:04d}"


# ------------------------------------------------------------------------------- profiles


@router.get("", response_model=list[AthleteOut])
def list_athletes(
    group: AthleteGroup | None = None,
    sport: str | None = None,
    q: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> list[AthleteOut]:
    stmt = visible_athletes(user)
    if group:
        stmt = stmt.where(Athlete.group == group)
    if sport:
        stmt = stmt.where(func.lower(Athlete.sport) == sport.lower())
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(Athlete.code).like(like), func.lower(Athlete.display_name).like(like)))
    return [to_out(a) for a in db.scalars(stmt.order_by(Athlete.code))]


@router.post("", response_model=AthleteOut, status_code=status.HTTP_201_CREATED)
def create_athlete(body: AthleteCreate, db: Session = Depends(get_db), user: User = Depends(require_staff)) -> AthleteOut:
    athlete = Athlete(org_id=user.org_id, **body.model_dump(exclude={"code"}))
    athlete.code = body.code or _next_code(db, user.org_id)
    db.add(athlete)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "An athlete with this code already exists") from None
    audit.record(db, user, "create", "athlete", athlete.id, code=athlete.code)
    db.commit()
    return to_out(athlete)


@router.get("/{athlete_id}", response_model=AthleteOut)
def get_athlete(athlete_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)) -> AthleteOut:
    athlete = get_visible_athlete(db, user, athlete_id)
    audit.record(db, user, "view", "athlete", athlete.id)
    db.commit()
    return to_out(athlete)


@router.patch("/{athlete_id}", response_model=AthleteOut)
def update_athlete(
    athlete_id: int, body: AthleteUpdate, db: Session = Depends(get_db), user: User = Depends(require_staff)
) -> AthleteOut:
    athlete = get_visible_athlete(db, user, athlete_id)
    if athlete.anonymised_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "Anonymised records cannot be edited")
    changes = body.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(athlete, key, value)
    audit.record(db, user, "update", "athlete", athlete.id, fields=sorted(changes))
    db.commit()
    return to_out(athlete)


@router.delete("/{athlete_id}", status_code=204)
def delete_athlete(athlete_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Response:
    """Hard delete (right to erasure). Consents and login links are removed with the record."""
    athlete = get_visible_athlete(db, user, athlete_id)
    code = athlete.code
    db.delete(athlete)
    audit.record(db, user, "delete", "athlete", athlete_id, code=code)
    db.commit()
    return Response(status_code=204)


@router.post("/{athlete_id}/anonymise", response_model=AthleteOut)
def anonymise_athlete(athlete_id: int, db: Session = Depends(get_db), user: User = Depends(require_staff)) -> AthleteOut:
    """Remove identifying fields but keep the coded record so research data stays usable."""
    athlete = get_visible_athlete(db, user, athlete_id)
    athlete.display_name = None
    athlete.birth_year = None
    athlete.history_notes = None
    athlete.goals = None
    athlete.visual_correction = None
    for consent in athlete.consents:
        consent.signed_by = REDACTED
        if consent.guardian_name:
            consent.guardian_name = REDACTED
        consent.notes = None
    for link in list(athlete.user_links):
        db.delete(link)
    athlete.anonymised_at = datetime.now(timezone.utc)
    audit.record(db, user, "anonymise", "athlete", athlete.id)
    db.commit()
    db.refresh(athlete)
    return to_out(athlete)


@router.get("/{athlete_id}/export")
def export_athlete(athlete_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict[str, Any]:
    """Everything held about one person (data-subject access request). Sessions/trials join in B2+."""
    athlete = get_visible_athlete(db, user, athlete_id)
    audit.record(db, user, "export", "athlete", athlete.id)
    db.commit()
    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "athlete": to_out(athlete).model_dump(mode="json"),
        "consents": [ConsentOut.model_validate(c).model_dump(mode="json") for c in athlete.consents],
        "linked_users": [
            {"user_id": link.user_id, "relation": link.relation.value} for link in athlete.user_links
        ],
    }


# ------------------------------------------------------------------------------- consent


@router.get("/{athlete_id}/consents", response_model=list[ConsentOut])
def list_consents(athlete_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[Consent]:
    return list(get_visible_athlete(db, user, athlete_id).consents)


@router.post("/{athlete_id}/consents", response_model=ConsentOut, status_code=201)
def record_consent(
    athlete_id: int, body: ConsentCreate, db: Session = Depends(get_db), user: User = Depends(require_staff)
) -> Consent:
    athlete = get_visible_athlete(db, user, athlete_id)
    if athlete.anonymised_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "Anonymised records cannot take new consent")
    if athlete.is_minor() and not body.guardian_name:
        raise HTTPException(
            422, "Parent/guardian consent is required for a minor (guardian_name)"
        )
    # A new consent of the same type supersedes (withdraws) the previous one, so there is
    # always at most one active consent per type and its form version is unambiguous.
    now = datetime.now(timezone.utc)
    for prev in athlete.consents:
        if prev.type == body.type and prev.active:
            prev.withdrawn_at = now
    consent = Consent(
        athlete_id=athlete.id,
        type=body.type,
        text_version=body.text_version,
        signed_by=body.signed_by,
        guardian_name=body.guardian_name,
        signed_at=body.signed_at or now,
        recorded_by_id=user.id,
        notes=body.notes,
    )
    db.add(consent)
    db.flush()
    audit.record(db, user, "consent_given", "athlete", athlete.id, consent_id=consent.id, type=body.type.value)
    db.commit()
    return consent


@router.post("/{athlete_id}/consents/{consent_id}/withdraw", response_model=ConsentOut)
def withdraw_consent(
    athlete_id: int, consent_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Consent:
    """Staff, the athlete themself, or a linked guardian may withdraw consent at any time."""
    athlete = get_visible_athlete(db, user, athlete_id)
    if not user.is_staff:
        link = next((lk for lk in user.athlete_links if lk.athlete_id == athlete.id), None)
        if link is None or link.relation not in (LinkRelation.self_, LinkRelation.guardian):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed")
    consent = db.get(Consent, consent_id)
    if consent is None or consent.athlete_id != athlete.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Consent not found")
    if consent.withdrawn_at is None:
        consent.withdrawn_at = datetime.now(timezone.utc)
        audit.record(db, user, "consent_withdrawn", "athlete", athlete.id, consent_id=consent.id, type=consent.type.value)
        db.commit()
    return consent


@router.get("/{athlete_id}/consent-status", response_model=ConsentStatus)
def get_consent_status(athlete_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)) -> ConsentStatus:
    return consent_status(get_visible_athlete(db, user, athlete_id))
