"""FastAPI dependencies: DB session, current user, role checks, athlete visibility."""

from __future__ import annotations

from collections.abc import Iterator

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from .config import Settings
from .models import STAFF_ROLES, Athlete, Role, User, UserAthleteLink
from .security import decode_access_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[Session]:
    db: Session = request.app.state.sessionmaker()
    try:
        yield db
    finally:
        db.close()


def user_from_token(token: str, db: Session, settings: Settings) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        claims = decode_access_token(token, settings.resolved_jwt_secret())
        user_id = int(claims["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise unauthorized from None
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise unauthorized
    return user


def current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
) -> User:
    return user_from_token(token, db, settings)


def require_roles(*roles: Role):
    allowed = frozenset(roles)

    def _check(user: User = Depends(current_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role does not allow this action")
        return user

    return _check


require_staff = require_roles(*STAFF_ROLES)
require_admin = require_roles(Role.admin)


def visible_athletes(user: User) -> Select[tuple[Athlete]]:
    """The single place that decides which athlete records a user may see.

    Staff see every athlete in their organisation; athletes/patients/parents see only
    the records they are explicitly linked to.
    """
    stmt = select(Athlete).where(Athlete.org_id == user.org_id)
    if user.role not in STAFF_ROLES:
        linked = select(UserAthleteLink.athlete_id).where(UserAthleteLink.user_id == user.id)
        stmt = stmt.where(Athlete.id.in_(linked))
    return stmt


def get_visible_athlete(db: Session, user: User, athlete_id: int) -> Athlete:
    athlete = db.scalars(visible_athletes(user).where(Athlete.id == athlete_id)).first()
    if athlete is None:
        # 404 (not 403) so other organisations' IDs are not disclosed.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Athlete not found")
    return athlete
