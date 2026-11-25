from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..deps import get_db, require_admin
from ..models import STAFF_ROLES, Athlete, AuditLog, LinkRelation, Role, User, UserAthleteLink
from ..schemas import AthleteLinkIn, AthleteLinkOut, AuditOut, UserCreate, UserOut, UserUpdate
from ..security import hash_password

router = APIRouter(tags=["users"])

# Which link relation is allowed for which (non-staff) role.
_LINK_RULES = {
    Role.athlete: {LinkRelation.self_},
    Role.patient: {LinkRelation.self_},
    Role.parent: {LinkRelation.guardian},
}


def _get_org_user(db: Session, admin: User, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None or user.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), admin: User = Depends(require_admin)) -> list[User]:
    return list(db.scalars(select(User).where(User.org_id == admin.org_id).order_by(User.id)))


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)) -> User:
    email = body.email.lower()
    if db.scalars(select(User).where(User.email == email)).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this email already exists")
    user = User(
        org_id=admin.org_id,
        email=email,
        full_name=body.full_name,
        role=body.role,
        password_hash=hash_password(body.password),
    )
    db.add(user)
    db.flush()
    audit.record(db, admin, "create", "user", user.id, role=user.role.value)
    db.commit()
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int, body: UserUpdate, db: Session = Depends(get_db), admin: User = Depends(require_admin)
) -> User:
    user = _get_org_user(db, admin, user_id)
    changes = body.model_dump(exclude_unset=True)
    if user.id == admin.id and (changes.get("is_active") is False or changes.get("role", Role.admin) != Role.admin):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot deactivate or demote yourself")
    if "password" in changes:
        user.password_hash = hash_password(changes.pop("password"))
        changes["password"] = "changed"
    for key in ("full_name", "role", "is_active"):
        if key in changes:
            setattr(user, key, changes[key])
    audit.record(db, admin, "update", "user", user.id, fields=sorted(changes))
    db.commit()
    return user


@router.post("/users/{user_id}/athlete-links", response_model=AthleteLinkOut, status_code=201)
def link_athlete(
    user_id: int, body: AthleteLinkIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)
) -> UserAthleteLink:
    user = _get_org_user(db, admin, user_id)
    if user.role in STAFF_ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Staff already see every athlete in the organisation")
    if body.relation not in _LINK_RULES[user.role]:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Role '{user.role.value}' cannot have relation '{body.relation.value}'"
        )
    athlete = db.get(Athlete, body.athlete_id)
    if athlete is None or athlete.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Athlete not found")
    if body.relation == LinkRelation.self_:
        clash = db.scalars(
            select(UserAthleteLink).where(
                UserAthleteLink.athlete_id == athlete.id, UserAthleteLink.relation == LinkRelation.self_
            )
        ).first()
        if clash and clash.user_id != user.id:
            raise HTTPException(status.HTTP_409_CONFLICT, "This athlete already has a 'self' login")
    link = db.get(UserAthleteLink, (user.id, athlete.id))
    if link is None:
        link = UserAthleteLink(user_id=user.id, athlete_id=athlete.id, relation=body.relation)
        db.add(link)
    else:
        link.relation = body.relation
    audit.record(db, admin, "link", "user", user.id, athlete_id=athlete.id, relation=body.relation.value)
    db.commit()
    return link


@router.delete("/users/{user_id}/athlete-links/{athlete_id}", status_code=204)
def unlink_athlete(
    user_id: int, athlete_id: int, db: Session = Depends(get_db), admin: User = Depends(require_admin)
) -> Response:
    _get_org_user(db, admin, user_id)
    link = db.get(UserAthleteLink, (user_id, athlete_id))
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Link not found")
    db.delete(link)
    audit.record(db, admin, "unlink", "user", user_id, athlete_id=athlete_id)
    db.commit()
    return Response(status_code=204)


@router.get("/audit", response_model=list[AuditOut])
def list_audit(
    entity: str | None = None,
    entity_id: str | None = None,
    limit: int = 200,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> list[AuditLog]:
    stmt = select(AuditLog).where(AuditLog.org_id == admin.org_id)
    if entity:
        stmt = stmt.where(AuditLog.entity == entity)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    return list(db.scalars(stmt.order_by(AuditLog.id.desc()).limit(min(limit, 1000))))
