from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient

from svs.config import Settings
from svs.db import make_engine, make_sessionmaker
from svs.main import create_app
from svs.manage import alembic_config
from svs.models import Organisation, Role, User
from svs.security import hash_password

PASSWORD = "correct-horse-battery"


def migrated_settings(tmp_path: Path, **overrides) -> Settings:
    """Settings pointing at a fresh SQLite DB built by the real Alembic migrations."""
    params = {"jwt_secret": "test-secret-at-least-32-bytes-long!!", "run_gateway": False, **overrides}
    # _env_file=None: ignore the developer's backend/.env (e.g. SVS_OPEN_ACCESS=true) so tests are hermetic.
    settings = Settings(_env_file=None, data_dir=tmp_path, **params)
    cfg = alembic_config(settings.resolved_database_url())
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")
    return settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return migrated_settings(tmp_path)


@pytest.fixture
def sessionmaker(settings: Settings):
    engine = make_engine(settings.resolved_database_url())
    yield make_sessionmaker(engine)
    engine.dispose()


def make_org_with_admin(sm, org_name: str, email: str) -> tuple[int, int]:
    with sm() as db:
        org = Organisation(name=org_name)
        db.add(org)
        db.flush()
        admin = User(org_id=org.id, email=email, full_name="Admin", role=Role.admin,
                     password_hash=hash_password(PASSWORD))
        db.add(admin)
        db.commit()
        return org.id, admin.id


@pytest.fixture
def client(settings: Settings, sessionmaker):
    make_org_with_admin(sessionmaker, "Org A", "admin@academy-a.in")
    make_org_with_admin(sessionmaker, "Org B", "admin@academy-b.in")
    with TestClient(create_app(settings)) as c:
        yield c


def login(client: TestClient, email: str, password: str = PASSWORD) -> dict[str, str]:
    r = client.post("/auth/token", data={"username": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}
