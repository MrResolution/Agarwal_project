"""Open-access mode: no sign-in from this machine, still refused from anywhere else."""

from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import make_org_with_admin, migrated_settings
from svs.db import make_engine, make_sessionmaker
from svs.main import create_app

LOCAL = ("127.0.0.1", 50001)
REMOTE = ("10.220.9.50", 50001)  # another device on the Wi-Fi


def app_with(tmp_path, **overrides):
    settings = migrated_settings(tmp_path, **overrides)
    engine = make_engine(settings.resolved_database_url())
    make_org_with_admin(make_sessionmaker(engine), "Org", "admin@academy-a.in")
    engine.dispose()
    return create_app(settings)


def test_off_by_default(tmp_path):
    app = app_with(tmp_path)
    with TestClient(app, client=LOCAL) as c:
        assert c.get("/auth/mode").json() == {"open_access": False}
        assert c.get("/me").status_code == 401
        assert c.get("/athletes").status_code == 401


def test_local_requests_act_as_admin(tmp_path):
    app = app_with(tmp_path, open_access=True)
    with TestClient(app, client=LOCAL) as c:
        assert c.get("/auth/mode").json() == {"open_access": True}
        me = c.get("/me").json()
        assert me["email"] == "admin@academy-a.in" and me["role"] == "admin"
        r = c.post("/athletes", json={"group": "athlete", "display_name": "No login"})
        assert r.status_code == 201
        assert c.get("/audit").json()[0]["user_id"] == me["id"], "actions are still attributed"
        # An explicit bad token is still rejected rather than silently falling back.
        assert c.get("/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_other_devices_still_need_to_sign_in(tmp_path):
    app = app_with(tmp_path, open_access=True)
    with TestClient(app, client=REMOTE) as c:
        assert c.get("/auth/mode").json() == {"open_access": False}
        assert c.get("/me").status_code == 401
        assert c.get("/athletes").status_code == 401


def test_open_access_email_picks_the_account(tmp_path):
    app = app_with(tmp_path, open_access=True, open_access_email="nobody@academy-a.in")
    with TestClient(app, client=LOCAL) as c:
        assert c.get("/auth/mode").json() == {"open_access": False}, "unknown account -> no open access"
        assert c.get("/me").status_code == 401
