# Setup and operations

How to install, run, configure and look after the system on a coaching laptop. The commands assume Windows PowerShell; on Linux or macOS, use `.venv/bin/` instead of `.venv\Scripts\`.

**Contents:** [Requirements](#requirements) · [First-time install](#first-time-install) · [Running the system](#running-the-system) · [Simulator options](#simulator-options) · [Real hardware](#real-hardware) · [Body tracking (camera)](#body-tracking-camera) · [Open access (no sign-in)](#open-access-no-sign-in) · [Settings](#settings) · [Data and backups](#data-and-backups) · [Alerts](#alerts) · [Tests and checks](#tests-and-checks) · [Troubleshooting](#troubleshooting)

---

## Requirements

| Need | Version / notes |
|---|---|
| Python | 3.11 or newer (developed on 3.13: `py -3.13` on Windows) |
| Node.js | 18 or newer, with npm |
| Browser | Any current Chrome, Edge, Firefox or Safari. Body tracking runs best in Chrome or Edge (GPU) |
| Webcam (optional) | For body tracking: any USB or built-in webcam, 720p or better, on a tripod |
| Network | For real hardware: a router or phone hotspot that both the laptop and the hub join |

---

## First-time install

**Backend**, from `backend/`:

```bash
py -3.13 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
.venv\Scripts\python -m svs.manage init-db
.venv\Scripts\python -m svs.manage create-admin --org "Demo Academy" --email admin@yourdomain.in
```

- `init-db` applies the Alembic migrations and creates `backend/data/svs.db`. Run it again after pulling changes that add migrations; it's safe to repeat.
- `create-admin` prompts for a password (at least 8 characters). Add `--name "Full Name"` to set the display name. Further coach and therapist accounts are created by an admin through `POST /users` (see the [API reference](api-reference.md#users-and-audit)).

**Frontend**, from `frontend/`:

```bash
npm install
```

---

## Running the system

Four processes, each in its own terminal. Start them in this order:

| # | Where | Command | What it is |
|---|---|---|---|
| 1 | `backend/` | `.venv\Scripts\python -m svs.broker --lan` | MQTT broker on :1883. Drop `--lan` to listen on this computer only |
| 2 | `backend/` | `.venv\Scripts\uvicorn --factory svs.main:create_app` | API + device gateway on :8000. Interactive API docs at http://127.0.0.1:8000/docs |
| 3 | `backend/` | `.venv\Scripts\python -m svs.simulator --discover` | Simulated hub (skip this with real hardware) |
| 4 | `frontend/` | `npm run dev` | Dashboard on http://localhost:5173 (or the next free port; Vite prints the URL) |

Open the dashboard URL and sign in. On the **Devices** page the hub should show as online within a few seconds.

**Order matters only loosely:**
- The API keeps retrying the broker (every 1–10 s) and restores its subscriptions, so it's fine if the broker starts later or restarts.
- The simulator needs the broker to be running. With `--discover`, it also needs the broker started with `--lan`.
- The dashboard shows "Hub offline" until a hub is connected.

**Stopping:** Ctrl+C in each terminal. Runs in progress on the hub are closed automatically (see [Run lifecycle](architecture.md#run-lifecycle)).

---

## Simulator options

`python -m svs.simulator` is a software stand-in for the ESP32-S3 hub. It speaks the exact MQTT contract, streams IMU (100 Hz) and balance (50 Hz) data, and responds with a realistic human reaction model.

| Option | Default | Meaning |
|---|---|---|
| `--host` / `--port` | `127.0.0.1` / `1883` | Broker address |
| `--discover` | off | Find the broker over mDNS, the way real firmware does (needs `svs.broker --lan`) |
| `--station` | `station-1` | Station name the hub reports |
| `--device` | `hub-01` | Hub device ID |
| `--targets` | 6 | Number of touch-sensor targets (the station has 6) |
| `--seed` | random | Seed for the reaction model, for reproducible behaviour |
| `--drop` | 0 | Probability (0–1) of losing a sequenced message |
| `--dup` | 0 | Probability of delivering a message twice |
| `--drift-ppm` | 0 | Hub clock drift vs real time, in parts per million |
| `--demo N` | 0 | Run N self-generated blocks on start-up (not linked to an athlete); 0 = wait for commands from the dashboard |
| `--trials` | 10 | Trials per demo block |
| `--nogo` | 0.2 | No-go ratio in demo blocks |
| `-v` | off | Verbose logging |

**Behaviour model** (from `SimConfig` in `svs/simulator/hub.py`):
- **Decision time:** ex-Gaussian with μ = 230 ms, σ = 25 ms, τ = 50 ms.
- **Movement time:** normal, mean 180 ms and SD 35 ms, at least 60 ms.
- **Errors per trial:** 3 % false start, 3 % miss, 3 % wrong target, and 15 % no-go commission.
- **Body mass:** 70 kg on the balance board.
- **Battery:** starts at 96 % and drains 0.4 % per minute.

Each response event carries the ground truth in `data.truth`, so the tests can check the analysis against known answers.

**Examples:**

```bash
python -m svs.simulator --discover
```
Normal use with the dashboard: the hub waits for Start.

```bash
python -m svs.simulator --demo 3 --dup 0.05 --drop 0.02 --drift-ppm 40
```
Three demo blocks over an unreliable link, to see the gateway's duplicate and gap handling on the Devices page.

---

## Real hardware

1. Join the laptop and the ESP32-S3 hub to the **same Wi-Fi** (router or phone hotspot).
2. Start the broker with `--lan`. It listens on the Wi-Fi network and advertises itself over mDNS as `svs-gateway.local` (service `_mqtt._tcp`, TXT `svs=1`), so the hub finds the laptop without a hard-coded IP.
3. **Allow inbound TCP 1883** through the laptop's firewall. On Windows this needs an administrator; the exact command is in [firmware/README.md](../firmware/README.md).
4. Power the hub. The dashboard's **Devices → Connect a hub** card shows the `IP:1883` address the hub should use as a fallback, plus each connected hub's IP, SSID and signal strength.

**Targets:**
- The station has **6 targets, T1–T6**: an LED ring and a digital **touch sensor** (e.g. TTP223) each.
- Each sensor's output goes straight to its own ESP32-S3 GPIO, and the interrupt takes the timestamp.
- Pins, polarity and wiring are in [firmware/README.md](../firmware/README.md#touch-sensor-targets).
- Keep hands off the pads while the hub powers up: TTP223 modules calibrate at power-on.

The firmware's Wi-Fi credentials go in `firmware/svs_hub/config.h`, which is gitignored. The firmware is written against the contract but **has not yet been compiled or run on hardware**. The [Hub MQTT data scheme](hub-mqtt-data-scheme.md) is the specification it must meet.

---

## Body tracking (camera)

Body tracking runs entirely in the dashboard's browser tab, with no extra process and no backend involvement:

| Part | Where it comes from |
|---|---|
| Pose model | MediaPipe Pose Landmarker (Lite or Full). `@mediapipe/tasks-vision` is pinned at `0.10.35` in `frontend/package.json` |
| Runtime (wasm, ~11 MB) | Served by the Vite dev server at `/mediapipe/wasm/` from `node_modules`, and copied into `frontend/dist/` by `npm run build`. No CDN |
| Model file (~6 MB Lite, ~9 MB Full) | Downloaded from `storage.googleapis.com` on the first start, then cached by the browser, unless a local copy exists (below) |
| Camera | `getUserMedia`, 1280×720 at up to 30 fps. Only works on `localhost` or https |

**Setup:**
1. Use Chrome or Edge on the laptop and open the dashboard at `http://localhost:5173` (or the port Vite prints).
2. Put the webcam on a tripod 2.5–3.5 m in front of the athlete, at hip height, with the whole body in frame.
3. On **Body tracking**, press **Start camera** and allow access.
4. Expect about 25 ms of model time per frame on a laptop GPU. If the Runs on row says CPU, keep the **Lite** model.

**Offline use (no internet at the venue):** download the model once and put it in `frontend/public/models/`; the dashboard then uses the local copy automatically. These files are gitignored.

```bash
curl -L --create-dirs -o frontend/public/models/pose_landmarker_lite.task https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
```

For the Full model, use the same URL and file name with `full` in place of `lite`.

**Privacy:** frames and landmarks never leave the browser, and nothing is recorded. Watching live therefore needs no video consent. Storing video or landmarks later would require the athlete's **video** consent, as the consent model already provides.

**Without a camera:** the **Simulated athlete** source draws a synthetic 33-point athlete. It reaches for whichever target the hub lights, so the whole page and the Live session card can be demonstrated with the hub simulator alone.

---

## Open access (no sign-in)

For local prototype use, add this line to `backend/.env` (gitignored) and restart the API:

```
SVS_OPEN_ACCESS=true
```

- **Who it applies to:** requests from **this computer** (loopback) without a token act as the first active admin. To act as a specific account instead, also set `SVS_OPEN_ACCESS_EMAIL`.
- **Other devices** on the Wi-Fi still have to sign in.
- **A bad or expired token** is still rejected; open access only applies when there's no token at all.
- **On screen:** the dashboard skips the sign-in page and shows an *Open access* tag in the account menu.
- **To turn it off,** delete the line and restart the API.

Don't use open access on a shared or public computer: anyone at the keyboard has admin rights.

---

## Settings

All settings are environment variables prefixed `SVS_`, or lines in `backend/.env`. They're defined in `backend/svs/config.py`.

| Setting | Default | Meaning |
|---|---|---|
| `SVS_DATA_DIR` | `data` (relative to `backend/`) | Where the database, Parquet streams and JWT secret live |
| `SVS_DATABASE_URL` | SQLite in the data dir | Any SQLAlchemy URL, e.g. PostgreSQL (needs its driver installed) |
| `SVS_JWT_SECRET` | generated once into `data/.jwt_secret` | Token signing key |
| `SVS_JWT_TTL_MINUTES` | 480 (8 h) | How long a sign-in lasts |
| `SVS_OPEN_ACCESS` | `false` | See [Open access](#open-access-no-sign-in) |
| `SVS_OPEN_ACCESS_EMAIL` | first active admin | Account that open access acts as |
| `SVS_MQTT_HOST` / `SVS_MQTT_PORT` | `127.0.0.1` / `1883` | Broker the gateway connects to |
| `SVS_MQTT_USERNAME` / `SVS_MQTT_PASSWORD` | none | Broker credentials (for Mosquitto in production) |
| `SVS_RUN_GATEWAY` | `true` | `false` runs the API without the device gateway |
| `SVS_STATIONS` | `["station-1"]` | Stations pinged for clock sync before they announce themselves (JSON list) |
| `SVS_SYNC_INTERVAL_S` | 2.0 | Clock-sync ping interval |
| `SVS_COMMAND_TIMEOUT_S` | 3.0 | How long to wait for a hub `ack` |
| `SVS_GAP_GRACE_S` | 2.0 | How long a missing `seq` may stay missing before it's reported |
| `SVS_STREAM_GAP_SUMMARY_S` | 10.0 | Stream losses are summarised into one alert per sensor per window |
| `SVS_STALL_AFTER_S` | 3.0 | No stream data for this long while the hub is online → `stream_stall` |
| `SVS_STATUS_STALE_AFTER_S` | 8.0 | No heartbeat for this long → hub marked offline |
| `SVS_LOW_BATTERY_PCT` | 15 | Low-battery alert threshold (re-arms 5 % above it) |
| `SVS_PARQUET_FLUSH_ROWS` / `SVS_PARQUET_FLUSH_S` | 5000 / 5.0 | Stream buffer flush thresholds |
| `SVS_LIVE_TELEMETRY_HZ` | 20 | Max telemetry rate per sensor on the WebSocket feed |

**Frontend:** `SVS_API` (environment variable for `npm run dev`) points the `/api` proxy somewhere other than `http://127.0.0.1:8000`.

---

## Data and backups

Everything the system stores is under `backend/data/` (gitignored):

| Path | Contents |
|---|---|
| `svs.db` | SQLite database: accounts, athletes, consents, runs, hub events, devices, alerts, audit log |
| `streams/` | Parquet files of IMU and balance samples, one folder per station / stream / sensor / boot |
| `.jwt_secret` | Token signing key. Deleting it signs everyone out |

- **Back up:** stop the API, then copy the whole `backend/data/` folder.
- **Restore:** stop the API and put the folder back.
- **Start over:** stop everything, delete `backend/data/`, then run `init-db` and `create-admin` again.

**Privacy tools**, per athlete, on the profile page or through the API:
- **Export:** everything held about the athlete, as JSON.
- **Anonymise:** name, birth year, history notes, goals and visual correction are cleared; signer and guardian names on consents are redacted; login links are removed. The code (`ATH-000n`) and results are kept.
- **Delete** (admin only, right to erasure): the athlete record is removed together with its consents and login links.

Every view, edit, export and consent change is written to the audit log (`GET /audit`, admin only).

---

## Alerts

The gateway raises these on the **Devices** page and the live feed:

| Kind | Severity | Meaning | What to do |
|---|---|---|---|
| `device_online` | info | Hub connected | Nothing |
| `device_offline` | critical | Hub disconnected (MQTT Last-Will) or no heartbeat for 8 s | Check power and Wi-Fi |
| `device_rebooted` | warning | Hub came back with a new `boot_id` | A block running at the time can't finish and is closed as aborted after 5 min; check the power supply |
| `low_battery` | warning | Battery below 15 % | Charge the hub |
| `data_gap` | warning (events) / info (streams) | Messages missing from the sequence | Weak Wi-Fi; lost events can affect individual trials |
| `stream_stall` | warning | A sensor stopped sending for 3 s while the hub is online | Check the sensor's connection |
| `stream_resumed` | info | A stalled sensor is sending again | Nothing |
| `command_timeout` | critical | No `ack` within 3 s | Hub busy or out of range |
| `bad_message` | warning | A message failed schema validation (rate-limited) | Firmware bug; see the alert detail |

Resolve warnings and critical alerts once they're handled; the bell in the top bar counts the open ones.

---

## Tests and checks

```bash
cd backend
.venv\Scripts\python -m pytest -q
```
Runs 49 tests. Add `-m "not mqtt"` to skip the two that need a real broker.

```bash
cd frontend
npm run typecheck
npm run build
```
TypeScript check, then the production build (output in `frontend/dist/`).

What the tests cover is listed in [Architecture → Testing](architecture.md#testing).

---

## Troubleshooting

| Problem | Check |
|---|---|
| `uvicorn` exits with "address already in use" | Another API is already running on :8000. Close it or stop the old terminal |
| Simulator: "no SVS broker found via mDNS" | Start the broker with `--lan`, or run the simulator with `--host 127.0.0.1` instead of `--discover` |
| Dashboard loads but every card shows an error | The API isn't running, or it's on another address (set `SVS_API`) |
| Sign-in fails for every account | `backend/data/` was replaced or deleted; recreate the admin with `create-admin` |
| Real hub never appears | Same Wi-Fi? Firewall open for TCP 1883? Broker started with `--lan`? Is the IP on *Connect a hub* the one the hub uses? |
| Clock sync shows large ± values | Congested Wi-Fi. Reaction times are unaffected (they use hub timestamps); only cross-device alignment is less precise |
| Events show `clock_quality = "arrival"` | They arrived before the first clock sync with that hub, so they carry arrival time. Reaction times are unaffected |
| Camera won't start | Open the dashboard on the laptop itself (`localhost`), allow camera access, and close other apps using the webcam. The message on the feed says which of these it is |
| Pose model doesn't load | First start needs internet access to `storage.googleapis.com`, or a local copy in `frontend/public/models/` (see [Body tracking](#body-tracking-camera)) |

Dashboard-side symptoms (Start disabled, runs stuck on *Running*, missing decision time) are covered in the [Dashboard guide](dashboard-guide.md#troubleshooting).
