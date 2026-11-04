"""B0: auth, roles, athlete visibility, consent, data-subject functions, audit."""

from __future__ import annotations

from datetime import datetime

from conftest import PASSWORD, login


def create_user(client, admin_h, email, role):
    r = client.post("/users", headers=admin_h, json={"email": email, "full_name": email, "role": role, "password": PASSWORD})
    assert r.status_code == 201, r.text
    return r.json()


def create_athlete(client, h, **body):
    r = client.post("/athletes", headers=h, json={"group": "athlete", **body})
    assert r.status_code == 201, r.text
    return r.json()


def test_login_and_me(client):
    h = login(client, "admin@academy-a.in")
    me = client.get("/me", headers=h).json()
    assert me["email"] == "admin@academy-a.in" and me["role"] == "admin"


def test_bad_credentials_and_missing_token(client):
    assert client.post("/auth/token", data={"username": "admin@academy-a.in", "password": "nope"}).status_code == 401
    assert client.get("/me").status_code == 401
    assert client.get("/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_deactivated_user_cannot_use_token(client):
    admin = login(client, "admin@academy-a.in")
    coach = create_user(client, admin, "coach@academy-a.in", "coach")
    coach_h = login(client, "coach@academy-a.in")
    assert client.patch(f"/users/{coach['id']}", headers=admin, json={"is_active": False}).status_code == 200
    assert client.get("/me", headers=coach_h).status_code == 401


def test_only_admin_manages_users(client):
    admin = login(client, "admin@academy-a.in")
    create_user(client, admin, "coach@academy-a.in", "coach")
    coach = login(client, "coach@academy-a.in")
    r = client.post("/users", headers=coach, json={"email": "x@academy-a.in", "full_name": "x", "role": "admin", "password": PASSWORD})
    assert r.status_code == 403
    assert client.get("/users", headers=coach).status_code == 403
    me_id = client.get("/me", headers=admin).json()["id"]
    assert client.patch(f"/users/{me_id}", headers=admin, json={"role": "coach"}).status_code == 400


def test_athlete_crud_and_generated_codes(client):
    h = login(client, "admin@academy-a.in")
    a1 = create_athlete(client, h, display_name="Asha", sport="Cricket", dominant_hand="right")
    a2 = create_athlete(client, h, sport="Football")
    assert a1["code"] == "ATH-0001" and a2["code"] == "ATH-0002"
    assert a1["consent"] == {"data": False, "video": False, "research": False}
    assert client.post("/athletes", headers=h, json={"group": "athlete", "code": "ATH-0001"}).status_code == 409

    r = client.patch(f"/athletes/{a1['id']}", headers=h, json={"position": "batter"})
    assert r.json()["position"] == "batter"
    assert [a["code"] for a in client.get("/athletes?sport=cricket", headers=h).json()] == ["ATH-0001"]
    assert len(client.get("/athletes?q=ash", headers=h).json()) == 1


def test_org_isolation(client):
    a = login(client, "admin@academy-a.in")
    b = login(client, "admin@academy-b.in")
    ath = create_athlete(client, a, display_name="Only in A")
    assert client.get(f"/athletes/{ath['id']}", headers=b).status_code == 404
    assert client.get("/athletes", headers=b).json() == []
    assert client.patch(f"/athletes/{ath['id']}", headers=b, json={"sport": "x"}).status_code == 404


def test_linked_users_see_only_their_athletes(client):
    admin = login(client, "admin@academy-a.in")
    mine = create_athlete(client, admin, display_name="Kid", group="child")
    other = create_athlete(client, admin, display_name="Someone else")
    athlete_user = create_user(client, admin, "kid@academy-a.in", "athlete")
    parent_user = create_user(client, admin, "parent@academy-a.in", "parent")

    # relation rules: athletes link as self, parents as guardian
    bad = client.post(f"/users/{parent_user['id']}/athlete-links", headers=admin, json={"athlete_id": mine["id"], "relation": "self"})
    assert bad.status_code == 400
    for user, rel in ((athlete_user, "self"), (parent_user, "guardian")):
        r = client.post(f"/users/{user['id']}/athlete-links", headers=admin, json={"athlete_id": mine["id"], "relation": rel})
        assert r.status_code == 201, r.text

    for email in ("kid@academy-a.in", "parent@academy-a.in"):
        h = login(client, email)
        assert [a["id"] for a in client.get("/athletes", headers=h).json()] == [mine["id"]]
        assert client.get(f"/athletes/{other['id']}", headers=h).status_code == 404
        assert client.patch(f"/athletes/{mine['id']}", headers=h, json={"sport": "x"}).status_code == 403
        assert client.post("/athletes", headers=h, json={"group": "athlete"}).status_code == 403


def test_consent_rules(client):
    h = login(client, "admin@academy-a.in")
    adult = create_athlete(client, h, birth_year=datetime.now().year - 30)
    minor = create_athlete(client, h, birth_year=datetime.now().year - 12)
    assert minor["is_minor"] and not adult["is_minor"]

    base = {"type": "data", "text_version": "v1.0", "signed_by": "Participant"}
    assert client.post(f"/athletes/{minor['id']}/consents", headers=h, json=base).status_code == 422
    assert client.post(f"/athletes/{minor['id']}/consents", headers=h, json={**base, "guardian_name": "Parent"}).status_code == 201

    c1 = client.post(f"/athletes/{adult['id']}/consents", headers=h, json=base).json()
    c2 = client.post(f"/athletes/{adult['id']}/consents", headers=h, json={**base, "text_version": "v1.1"}).json()
    consents = client.get(f"/athletes/{adult['id']}/consents", headers=h).json()
    assert [c["active"] for c in consents] == [False, True], "new consent supersedes the old one"
    assert client.get(f"/athletes/{adult['id']}/consent-status", headers=h).json()["data"] is True

    r = client.post(f"/athletes/{adult['id']}/consents/{c2['id']}/withdraw", headers=h)
    assert r.json()["active"] is False
    assert client.get(f"/athletes/{adult['id']}/consent-status", headers=h).json()["data"] is False
    assert c1["id"] != c2["id"]


def test_athlete_can_withdraw_own_consent(client):
    admin = login(client, "admin@academy-a.in")
    ath = create_athlete(client, admin)
    consent = client.post(f"/athletes/{ath['id']}/consents", headers=admin,
                          json={"type": "video", "text_version": "v1", "signed_by": "Me"}).json()
    user = create_user(client, admin, "me@academy-a.in", "athlete")
    client.post(f"/users/{user['id']}/athlete-links", headers=admin, json={"athlete_id": ath["id"], "relation": "self"})
    me = login(client, "me@academy-a.in")
    assert client.post(f"/athletes/{ath['id']}/consents", headers=me,
                       json={"type": "video", "text_version": "v1", "signed_by": "Me"}).status_code == 403
    assert client.post(f"/athletes/{ath['id']}/consents/{consent['id']}/withdraw", headers=me).json()["active"] is False


def test_anonymise_export_delete_and_audit(client):
    h = login(client, "admin@academy-a.in")
    ath = create_athlete(client, h, display_name="Ravi", birth_year=1999, history_notes="ACL 2023", goals="faster")
    client.post(f"/athletes/{ath['id']}/consents", headers=h, json={"type": "data", "text_version": "v1", "signed_by": "Ravi K"})

    export = client.get(f"/athletes/{ath['id']}/export", headers=h).json()
    assert export["athlete"]["display_name"] == "Ravi" and len(export["consents"]) == 1

    anon = client.post(f"/athletes/{ath['id']}/anonymise", headers=h).json()
    assert anon["display_name"] is None and anon["birth_year"] is None and anon["history_notes"] is None
    assert anon["code"] == ath["code"] and anon["anonymised_at"]
    assert client.get(f"/athletes/{ath['id']}/consents", headers=h).json()[0]["signed_by"] == "[redacted]"
    assert client.patch(f"/athletes/{ath['id']}", headers=h, json={"display_name": "back"}).status_code == 409

    assert client.delete(f"/athletes/{ath['id']}", headers=h).status_code == 204
    assert client.get(f"/athletes/{ath['id']}", headers=h).status_code == 404

    actions = [e["action"] for e in client.get(f"/audit?entity=athlete&entity_id={ath['id']}", headers=h).json()]
    for expected in ("create", "consent_given", "export", "anonymise", "delete"):
        assert expected in actions
    # Org B's admin must not see Org A's audit trail
    assert client.get("/audit?entity=athlete", headers=login(client, "admin@academy-b.in")).json() == []


def test_logins_are_audited(client, sessionmaker):
    from sqlalchemy import select

    from svs.models import AuditLog

    client.post("/auth/token", data={"username": "admin@academy-a.in", "password": "wrong"})
    login(client, "admin@academy-a.in")
    with sessionmaker() as db:
        actions = [(a.action, a.detail) for a in db.scalars(select(AuditLog).order_by(AuditLog.id))]
    assert ("login_failed", {"email": "admin@academy-a.in"}) in actions
    assert any(action == "login" for action, _ in actions)


def test_device_endpoints_without_gateway(client):
    h = login(client, "admin@academy-a.in")
    assert client.get("/devices", headers=h).json() == []
    r = client.post("/stations/station-1/commands", headers=h, json={"cmd": "ping"})
    assert r.status_code == 503
    assert client.get("/health").json()["gateway"] is False
