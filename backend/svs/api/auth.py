from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..config import Settings
from ..deps import current_user, get_db, get_settings_dep
from ..models import User
from ..schemas import MeOut, TokenOut
from ..security import create_access_token, verify_password

router = APIRouter(tags=["auth"])


@router.post("/auth/token", response_model=TokenOut)
def login(
    form: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
) -> TokenOut:
    """OAuth2 password flow. ``username`` is the user's email."""
    user = db.scalars(select(User).where(User.email == form.username.lower())).first()
    if user is None or not user.is_active or not verify_password(form.password, user.password_hash):
        audit.record(db, None, "login_failed", "user", None, email=form.username.lower())
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password")
    token = create_access_token(
        user_id=user.id,
        org_id=user.org_id,
        role=user.role.value,
        secret=settings.resolved_jwt_secret(),
        ttl_minutes=settings.jwt_ttl_minutes,
    )
    audit.record(db, user, "login", "user", user.id)
    db.commit()
    return TokenOut(access_token=token, expires_in=settings.jwt_ttl_minutes * 60)


@router.get("/me", response_model=MeOut)
def me(user: User = Depends(current_user)) -> User:
    return user
