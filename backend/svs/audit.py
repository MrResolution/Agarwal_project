"""Append-only audit trail helper. The caller commits the surrounding transaction."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from .models import AuditLog, User


def record(
    db: Session,
    user: User | None,
    action: str,
    entity: str,
    entity_id: Any = None,
    **detail: Any,
) -> None:
    db.add(
        AuditLog(
            org_id=user.org_id if user else None,
            user_id=user.id if user else None,
            action=action,
            entity=entity,
            entity_id=None if entity_id is None else str(entity_id),
            detail=detail,
        )
    )
