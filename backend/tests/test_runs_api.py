"""Runs end to end: API -> plan -> gateway -> real broker -> simulator -> events/streams -> analysis."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from conftest import PASSWORD, make_org_with_admin, migrated_settings
from svs.db import make_engine, make_sessionmaker
from svs.main import create_app
from svs.simulator import SimConfig, SimHub
from svs.transport import MqttTransport
from test_mqtt_e2e import broker_thread  # noqa: F401  (fixture)

pytestmark = pytest.mark.mqtt
FAST = {"n_trials": 8, "foreperiod_ms": [250, 450], "iti_ms": 150, "window_ms": 1500}


def test_run_lifecycle_and_analysis(tmp_path, broker_thread):  # noqa: F811
    settings = migrated_settings(tmp_path, run_gateway=True, mqtt_port=broker_thread, sync_interval_s=0.3,
                                 parquet_flush_s=0.5)
    engine = make_engine(settings.resolved_database_url())
    make_org_with_admin(make_sessionmaker(engine), "Org", "admin@academy-a.in")
    engine.dispose()

    with TestClient(create_app(settings)) as client:
        tok = client.post("/auth/token", data={"username": "admin@academy-a.in", "password": PASSWORD}).json()["access_token"]
        h = {"Authorization": f"Bearer {tok}"}
        assert {p["key"] for p in client.get("/protocols", headers=h).json()} >= {"simple_rt", "choice_rt", "go_nogo"}
        ath = client.post("/athletes", headers=h, json={"group": "athlete", "display_name": "Test", "sport": "Cricket"}).json()

        # No hub online yet / no consent -> refused
        r = client.post(f"/athletes/{ath['id']}/runs", headers=h, json={"protocol": "choice_rt", "params": FAST})
        assert r.status_code == 409 and "consent" in r.json()["detail"]
        client.post(f"/athletes/{ath['id']}/consents", headers=h, json={"type": "data", "text_version": "v1", "signed_by": "T"})
        r = client.post(f"/athletes/{ath['id']}/runs", headers=h, json={"protocol": "choice_rt", "params": FAST})
        assert r.status_code == 409 and "No online hub" in r.json()["detail"]

        hub = SimHub(MqttTransport("127.0.0.1", broker_thread, client_id="hub-runs"),
                     SimConfig(seed=9, status_interval_s=0.3, p_false_start=0.0, p_miss=0.0, p_wrong_target=0.0))
        client.portal.call(hub.start)
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if client.get("/devices", headers=h).json():
                    break
                time.sleep(0.1)
            r = client.post(f"/athletes/{ath['id']}/runs", headers=h,
                            json={"protocol": "choice_rt", "params": FAST, "seed": 1234})
            assert r.status_code == 201, r.text
            run = r.json()
            assert run["seed"] == 1234 and len(run["plan"]) == 8 and run["status"] == "sent"

            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                detail = client.get(f"/runs/{run['id']}", headers=h).json()
                if detail["run"]["status"] == "done":
                    break
                time.sleep(0.3)
            assert detail["run"]["status"] == "done"
            time.sleep(1.2)  # let the IMU stream reach Parquet
            a = client.get(f"/runs/{run['id']}", headers=h).json()["analysis"]
            s = a["summary"]
            assert s["trials"] == 8 and s["counts"]["hit"] == 8 and s["accuracy"] == 1.0
            assert 200 < s["rt"]["median"] < 900

            # Reaction time from hub timestamps equals the simulator's ground truth.
            truth = {e.trial_no: e.data["truth"] for e in hub.events_emitted if e.type == "response"}
            for t in a["trials"]:
                exp = truth[t["trial_no"]]["premotor_ms"] + truth[t["trial_no"]]["movement_ms"]
                assert t["rt_ms"] == pytest.approx(exp, abs=0.01)
            # IMU movement-onset split is within 30 ms of the true onset for most trials.
            close = [abs(t["premotor_ms"] - truth[t["trial_no"]]["premotor_ms"]) <= 30
                     for t in a["trials"] if t["premotor_ms"] is not None]
            assert len(close) >= 6 and sum(close) >= 6
            assert a["balance"]["status"] == "ok" and a["balance"]["mean_load_kg"] == pytest.approx(70, abs=2)

            runs = client.get(f"/athletes/{ath['id']}/runs", headers=h).json()
            assert runs[0]["block_id"] == run["block_id"]
            blocks = client.get("/stations/station-1/blocks", headers=h).json()
            assert blocks[0]["run_id"] == run["id"] and blocks[0]["status"] == "done"
            assert client.get(f"/blocks/{run['block_id']}/analysis", headers=h).json()["summary"]["trials"] == 8

            ov = client.get("/overview", headers=h).json()
            assert ov["athletes"] == 1 and ov["runs_total"] == 1 and ov["devices_online"] == 1
            assert ov["recent_runs"][0]["athlete_code"] == ath["code"]
            board = ov["leaderboards"]["choice_rt"]
            assert board[0]["athlete_id"] == ath["id"] and board[0]["run_id"] == run["id"]
            assert "go_nogo" not in ov["leaderboards"], "rankings never mix protocols"

            stats = client.get("/athletes-stats", headers=h).json()[str(ath["id"])]
            assert stats["runs"] == 1 and stats["completed"] == 1 and stats["this_week"] == 1
            assert stats["latest"]["run_id"] == run["id"] and stats["latest"]["median_rt"] == s["rt"]["median"]

            # Stop a running block
            run2 = client.post(f"/athletes/{ath['id']}/runs", headers=h,
                               json={"protocol": "go_nogo", "params": {"n_trials": 20}}).json()
            time.sleep(0.5)
            assert client.post(f"/runs/{run2['id']}/stop", headers=h).status_code == 200
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if client.get(f"/runs/{run2['id']}", headers=h).json()["run"]["status"] == "aborted":
                    break
                time.sleep(0.2)
            assert client.get(f"/runs/{run2['id']}", headers=h).json()["run"]["status"] == "aborted"
        finally:
            client.portal.call(hub.stop)
