# Backend: API, device gateway and hub simulator

Milestones **B0–B1** from [`docs/dashboard-functional-research.md`](../docs/dashboard-functional-research.md):

| Milestone | What's here |
|---|---|
| **B0** | FastAPI app, SQLAlchemy models + Alembic migrations, login (JWT) with roles, athlete/patient profiles, consent records, data-subject export/anonymise/delete, append-only audit log |
| **B1** | MQTT contract, a **simulated ESP32-S3 hub** with fault injection, and the **device gateway**: validation, duplicate suppression, gap detection, hub→server clock mapping, events → SQL, streams → Parquet, device health/alerts, commands with acks, and a live WebSocket feed |

Sessions, trial plans and scoring come next (B2–B3). The UI is deliberately out of scope for now. Drive everything through the API docs at `/docs`.

## Setup (Windows PowerShell; on Linux/macOS use `.venv/bin/`)

```bash
cd backend
py -3.13 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
.venv\Scripts\python -m svs.manage init-db
.venv\Scripts\python -m svs.manage create-admin --org "Demo Academy" --email admin@yourdomain.in
```

Data goes into `backend/data/` (gitignored): `svs.db`, `streams/` (Parquet) and a generated `.jwt_secret`.

## Run everything locally (three terminals)

```bash
.venv\Scripts\python -m svs.broker                       # 1. MQTT broker on :1883 (pure Python; use Mosquitto in production)
.venv\Scripts\uvicorn --factory svs.main:create_app      # 2. API + gateway on :8000 -> open http://127.0.0.1:8000/docs
.venv\Scripts\python -m svs.simulator --demo 3 --dup 0.05 --drop 0.02 --drift-ppm 40   # 3. fake hub
```

**With real hardware** (ESP32-S3 hub and laptop on the same router/phone hotspot), start the broker with `--lan` instead. It listens on the Wi-Fi network and advertises itself over mDNS, so the hub finds the laptop without a hard-coded IP. `GET /network` shows the address hubs should use and each connected hub's IP, SSID and signal. `python -m svs.simulator --discover` runs the simulator through the same mDNS path the firmware uses. Firmware, flashing and firewall setup are in [`../firmware/README.md`](../firmware/README.md).

Without `--demo` the simulator waits for commands. You can start a block by hand with `POST /stations/station-1/commands`:

```json
{"cmd": "start_block", "args": {"block_id": "b1", "trials": [
  {"trial_no": 0, "target_id": "T3", "foreperiod_ms": 1500},
  {"trial_no": 1, "target_id": "T6", "foreperiod_ms": 2100, "colour": "red", "is_nogo": true}]}}
```

Useful endpoints: `GET /devices`, `GET /alerts`, `GET /stations/{station}/events`, `GET /gateway` (live stats, clock-sync quality, per-channel duplicate/lost counts), and the WebSocket `ws://…/ws/stations/{station}?token=<JWT>`.

**Open access (no sign-in).** For local prototype use, put `SVS_OPEN_ACCESS=true` in `backend/.env` (gitignored). The dashboard then opens without email and password:
- Token-less requests from **this machine only** (loopback) act as the first active admin, or as `SVS_OPEN_ACCESS_EMAIL` if set. Other devices on the Wi-Fi still have to sign in, and a bad token is still rejected.
- Delete the line to require sign-in again.

Settings are environment variables prefixed `SVS_` (see `svs/config.py`), e.g. `SVS_MQTT_HOST`, `SVS_DATABASE_URL=postgresql+psycopg://…`, `SVS_RUN_GATEWAY=false`.

## Analysis and protocol runs

`svs/analysis/` holds pure functions of stored data, so every result can be recomputed:

- **`scoring.py`** classifies each trial, in this order:
  1. false start (press during the foreperiod)
  2. anticipation (RT under 100 ms)
  3. no-go false alarm
  4. wrong target
  5. hit
  6. correct rejection
  7. miss
  8. invalid (block aborted)

  Outliers (more than 3 robust SDs) are flagged, never dropped. Summary statistics:
  - RT median, mean, SD, IQR, MAD, CV, p10 and p90; accuracy; omission, commission and false-start rates
  - **d′ and c** with the log-linear correction
  - per-target, left/right asymmetry and central/mid/peripheral bands; histogram
  - quality flag: insufficient data below 5 valid hits

  It also does **movement-onset detection** from the wrist IMU, which splits RT into decision and movement time.
- **`balance.py`** computes centre of pressure from the 4 load cells, then path length, mean velocity, RMS, range and the 95 % ellipse area.
- **`protocols.py`** has five built-in protocols (simple RT, choice RT, go/no-go, peripheral, speed drill). The **seeded, balanced trial-plan generator** means the same seed always gives the same plan.

API endpoints:

| Method | Path | What it does |
|---|---|---|
| `GET` | `/protocols` | List the built-in protocols |
| `POST` | `/athletes/{id}/runs` | Start a run (`protocol`, `params`, optional `seed`): checks data consent and an online hub, generates the plan, sends `start_block` |
| `GET` | `/athletes/{id}/runs` | The athlete's runs |
| `GET` | `/runs/{id}` | Run + full analysis |
| `POST` | `/runs/{id}/stop[?estop=true]` | Stop a running block |
| `GET` | `/athletes/{id}/trends` | Change vs. the athlete's baseline (first 2 completed runs), labelled *unverified* until test-retest reliability exists |
| `GET` | `/stations/{station}/blocks` | Every block, including demo blocks |
| `GET` | `/blocks/{block_id}/analysis` | Analysis of any block |
| `GET` | `/overview` | Dashboard aggregate |

How runs behave:
- While a block runs, analysis uses events only. Sensor streams are read once it finishes, and results are cached about 15 s later, once the streams are on disk.
- A block with no hub events for 5 minutes is closed as aborted, with a reason.

## Tests

```bash
.venv\Scripts\python -m pytest -q
```

45 tests. They cover the analysis engine (every classification rule, statistics, d′, plans, onset detection, sway, stream pruning) and a full run end to end; plus the role/visibility matrix, org isolation, consent rules (guardian for minors, supersede, withdraw), anonymise/export/delete and audit. On the gateway side they cover sequence and clock maths and simulator↔gateway runs with duplicates, drops, outage + SD backfill, reboot, Last-Will, heartbeat loss, command timeouts, e-stop and malformed input. Two end-to-end tests run over a real MQTT broker, including the authenticated WebSocket feed. Use `-m "not mqtt"` to skip the broker tests.

## MQTT contract (what the ESP32-S3 firmware must implement)

Defined in `svs/contract/topics.py` and `svs/contract/messages.py`; the simulator is the reference implementation. Every message, with examples and field rules, is documented in [`docs/hub-mqtt-data-scheme.md`](../docs/hub-mqtt-data-scheme.md).

| Topic | Direction | QoS | Payload |
|---|---|---|---|
| `svs/{station}/hub/status` | hub→server, **retained**, also the Last-Will (`online:false`) | 1 | `HubStatus` heartbeat every ~2 s |
| `svs/{station}/hub/cmd` | server→hub | 1 | `Command` `start_block` / `stop` / `estop` / `config` / `ping` |
| `svs/{station}/hub/ack` | hub→server | 1 | `CommandAck` (`ok`, `error`) |
| `svs/{station}/events` | hub→server | 1 | `HubEvent`: `block_started`, `stimulus_on`, `response`, `false_start`, `stimulus_off`, `block_done`, `block_aborted`, `error` |
| `svs/{station}/stream/{imu\|balance}/{sensor}` | hub→server | 0 | `StreamBatch`: N samples at a fixed rate |
| `svs/{station}/sync/ping` → `…/sync/pong` | server→hub→server | 0 | NTP-style clock sync (`t0`, `t1`, `t2`) |

Rules:
- Every message carries `device_id`, `boot_id` (new random value on each power-on) and `seq` (+1 per message, counted separately per channel, restarting at 0 on boot).
- All `t_us` values are `esp_timer_get_time()` captured at the hardware event. They are the only times used for reaction time.
- When Wi-Fi drops, buffer events to the SD card and replay them later with `"backfill": true`. Replays are safe because the server ignores duplicates.

## Layout

```
svs/
  config.py, db.py, models.py, security.py, deps.py, audit.py, schemas.py, main.py, manage.py, broker.py
  api/        auth, users (+audit), athletes (+consent), devices (+alerts, commands, gateway), live (WebSocket)
  contract/   topics + message schemas shared by gateway, simulator and firmware
  transport/  MqttTransport (paho, works on any asyncio loop) and MemoryBus (in-process, for tests)
  gateway/    gateway.py, seq.py (dedupe/gaps), clock.py (clock mapping), sink.py (Parquet), live.py (fan-out)
  simulator/  hub.py (ex-Gaussian RT model, IMU/balance streams, faults), __main__.py (CLI)
migrations/   Alembic (0001_initial_schema)
tests/
```

## Known limits / next steps

- Events that arrive before the first clock sync are stamped with arrival time (`clock_quality = "arrival"`). Reaction times are unaffected because they use hub timestamps only.
- Gap detection can't see messages lost at the very end of a stream. Stall detection (`stream_stall`) covers that case.
- Duplicate suppression for streams is held in memory, so a gateway restart during an SD-card replay of *streams* could store a batch twice. Events are protected by a database unique constraint.
- The dev broker allows anonymous access. Production needs Mosquitto with TLS and per-device credentials.
