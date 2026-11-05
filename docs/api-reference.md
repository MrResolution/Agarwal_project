# API reference

The backend is a FastAPI app on `http://127.0.0.1:8000`. Interactive docs, where you can try each call, are at **`/docs`** (Swagger) and **`/redoc`**. This page is the overview: who may call what, the main request bodies, and the live WebSocket feed.

The dashboard calls the same API through the Vite proxy, as `/api/...` on its own origin. Paths below are written without the `/api` prefix.

**Contents:** [Authentication](#authentication) · [Roles](#roles) · [Errors](#errors) · [Auth and account](#auth-and-account) · [Users and audit](#users-and-audit) · [Athletes and consent](#athletes-and-consent) · [Protocols and runs](#protocols-and-runs) · [Analysis and dashboard](#analysis-and-dashboard) · [Devices and stations](#devices-and-stations) · [Live WebSocket](#live-websocket)

---

## Authentication

1. Get a token with the OAuth2 password flow. The form field `username` is the account's **email**:

   ```bash
   curl -X POST http://127.0.0.1:8000/auth/token -d "username=coach@yourdomain.in" -d "password=$SVS_PASSWORD"
   ```

   The response is `{"access_token": "...", "token_type": "bearer", "expires_in": 28800}`. The token is valid for 8 h by default (`SVS_JWT_TTL_MINUTES`).

2. Send it on every request:

   ```
   Authorization: Bearer <access_token>
   ```

**Open access:** when `SVS_OPEN_ACCESS=true`, requests from the same computer **with no token** are treated as the first active admin. `GET /auth/mode` reports whether the caller qualifies. See [Setup and operations](setup-and-operations.md#open-access-no-sign-in).

---

## Roles

| Level | Roles | Can see |
|---|---|---|
| **Admin** | `admin` | Everything in the organisation, plus user management, the audit log and hard delete |
| **Staff** | `admin`, `coach`, `therapist` | Every athlete in the organisation; can start runs, record consent and use the device endpoints |
| **Signed in** | any role | Staff see all athletes. `athlete`, `patient` and `parent` accounts see only the athletes linked to them (`self` or `guardian`) |

Records from another organisation, or athletes a non-staff user isn't linked to, return **404**, so their IDs aren't revealed.

---

## Errors

Errors are JSON: `{"detail": "..."}`.

| Status | When |
|---|---|
| 401 | Missing, expired or invalid token |
| 403 | Signed in, but the role isn't allowed |
| 404 | Not found, or not visible to you |
| 409 | Conflicts: no active data consent, no online hub on the station, hub rejected the block, new consent on an anonymised record |
| 422 | Validation: bad body or parameters, unknown protocol, guardian missing for a minor's consent |
| 504 | The hub didn't acknowledge a command within the timeout (3 s by default) |

---

## Auth and account

| Method | Path | Access | Description |
|---|---|---|---|
| `POST` | `/auth/token` | public | Sign in (form fields `username`, `password`). Failed and successful logins are audited |
| `GET` | `/auth/mode` | public | `{"open_access": true\|false}` for this caller |
| `GET` | `/health` | public | `{"status": "ok", "version", "gateway", "mqtt_connected"}`: is the API up and connected to the broker |
| `GET` | `/me` | signed in | Current user, with `athlete_links` |

---

## Users and audit

All admin only.

| Method | Path | Description |
|---|---|---|
| `GET` | `/users` | Users in your organisation |
| `POST` | `/users` | Create a user: `email`, `full_name`, `role`, `password` (min 8 chars) |
| `PATCH` | `/users/{id}` | Change `full_name`, `role`, `is_active` or `password` |
| `POST` | `/users/{id}/athlete-links` | Link a login to an athlete: `{"athlete_id": 3, "relation": "self" \| "guardian"}` |
| `DELETE` | `/users/{id}/athlete-links/{athlete_id}` | Remove that link |
| `GET` | `/audit?entity=&entity_id=&limit=200` | Audit log, newest first (max 1000) |

---

## Athletes and consent

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/athletes?group=&sport=&q=` | signed in | List visible athletes. `q` matches the code or name |
| `POST` | `/athletes` | staff | Create; body below |
| `GET` | `/athletes/{id}` | signed in | One athlete, with `consent` status and `is_minor` |
| `PATCH` | `/athletes/{id}` | staff | Update any profile field |
| `DELETE` | `/athletes/{id}` | admin | Hard delete (right to erasure); consents and login links go with it |
| `POST` | `/athletes/{id}/anonymise` | staff | Clear identifying fields and redact consent signers; keeps the code and results |
| `GET` | `/athletes/{id}/export` | signed in | Everything held about the athlete, as JSON (data-subject access) |
| `GET` | `/athletes/{id}/consents` | signed in | Consent history |
| `POST` | `/athletes/{id}/consents` | staff | Record a consent; body below |
| `POST` | `/athletes/{id}/consents/{consent_id}/withdraw` | staff, or the athlete / linked guardian | Withdraw a consent |
| `GET` | `/athletes/{id}/consent-status` | signed in | `{"data": bool, "video": bool, "research": bool}` |

**Create athlete** (only `group` is required):

```json
{
  "display_name": "Asha K",
  "group": "athlete",
  "birth_year": 2006,
  "sport": "cricket",
  "position": "batter",
  "dominant_hand": "right",
  "dominant_foot": "right",
  "visual_correction": null,
  "goals": "Faster reaction to short-pitched deliveries"
}
```

- `group`: `athlete` · `patient` · `elderly` · `child`
- `dominant_hand`, `dominant_foot`: `left` · `right` · `both`
- `code`: optional; generated as `ATH-000n` if omitted

**Record consent:**

```json
{ "type": "data", "text_version": "v1", "signed_by": "Asha K", "guardian_name": null }
```

- `type`: `data` (required before any run) · `video` · `research`
- `guardian_name` is **required for minors**: a birth year under 18 years ago, or group `child`.
- A new consent of the same type **supersedes** the active one, so there is at most one active consent per type.
- `signed_at` defaults to now; `notes` is optional.

---

## Protocols and runs

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/protocols` | signed in | The five built-in protocols with their defaults ([table](metrics-reference.md#protocols)) |
| `POST` | `/athletes/{id}/runs` | staff | Start a run; body below. Returns the run, including the exact `plan` sent to the hub |
| `GET` | `/athletes/{id}/runs?protocol=&limit=50` | signed in | The athlete's runs, newest first, with a compact `summary` |
| `GET` | `/runs/{id}` | signed in | `{"run": ..., "analysis": ...}`: the run with its plan, and the full analysis |
| `POST` | `/runs/{id}/stop` | staff | Stop the block cleanly. Add `?estop=true` for an emergency stop (all targets off) |
| `GET` | `/athletes/{id}/trends?protocol=` | signed in | Per protocol: completed runs, the baseline and % change, `change_status: "unverified"` ([how](metrics-reference.md#baselines-and-trends)) |

**Start a run:**

```json
{ "protocol": "go_nogo", "station": "station-1", "params": { "n_trials": 30 }, "seed": 12345, "notes": "pre-season" }
```

- `protocol`: `simple_rt` · `choice_rt` · `go_nogo` · `peripheral` · `speed_drill`
- `params` (optional overrides): `n_trials`, `foreperiod_ms` (`[lo, hi]`), `window_ms`, `iti_ms`, `nogo_ratio`, `targets` (`all` · `centre` = the single most central target · `peripheral` = every target outside the central band)
- **Targets:** the plan uses the hub's own target list from its status heartbeat (6 touch-sensor targets, `T1`–`T6`, on the standard station)
- `seed` (optional): give the same seed and parameters to repeat the exact trial sequence

**What happens on start:**
1. Check data consent → **409** if missing.
2. Find an online hub on the station → **409** if none.
3. Generate the seeded plan and store the run (`status: "sent"`).
4. Send `start_block` and wait for the hub's `ack` → **504** on timeout; **409** if the hub rejects it. The run is then marked `failed`, with the error stored.

**Run status:** `sent` → `running` → `done` or `aborted`, or `failed` if it never started. The status comes from hub events ([lifecycle](architecture.md#run-lifecycle)).

---

## Analysis and dashboard

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/stations/{station}/blocks?limit=30` | staff | Every block seen on the station, including simulator demo blocks: status, event and stimulus counts, and the linked run and athlete if any |
| `GET` | `/blocks/{block_id}/analysis` | staff | Full analysis of any block |
| `GET` | `/overview?days=42&tz_offset_min=-330` | staff | Dashboard aggregate. `tz_offset_min` is the browser's `Date.getTimezoneOffset()`, for local-day buckets |
| `GET` | `/athletes-stats` | staff | Per athlete: run counts, runs this week, latest result and the last 10 median RTs |

**Analysis object** (from `/runs/{id}` and `/blocks/{id}/analysis`):

| Field | Contents |
|---|---|
| `block_id`, `station`, `device_id`, `boot_id`, `status`, `duration_s` | Identity and state |
| `started_at_us`, `ended_at_us` | Server time of the first and last event (µs since epoch) |
| `summary` | Counts by result, `rt` / `premotor` / `movement` statistics, accuracy and error rates, `dprime`, `criterion`, `per_target`, `by_side`, `by_band`, `histogram`, `quality`, and the `rules` used |
| `trials` | One object per trial: target, colour, `is_nogo`, timestamps, `rt_ms`, `premotor_ms`, `movement_ms`, `result`, `excluded` |
| `balance` | Sway metrics and the CoP `path`, or `{"status": "no_load"}`, or `null` without a balance stream |
| `imu_sensor`, `layout` | Which IMU was used, and the target positions |

Every formula is in the [Metrics reference](metrics-reference.md).

---

## Devices and stations

All staff only.

| Method | Path | Description |
|---|---|---|
| `GET` | `/devices?station=` | Hubs with online state, firmware, boot ID, battery, RSSI and last status (targets, sensors, IP, SSID) |
| `GET` | `/devices/{id}` | One hub |
| `GET` | `/alerts?station=&open_only=false&kind=&limit=100` | Alerts, newest first ([kinds](setup-and-operations.md#alerts)) |
| `POST` | `/alerts/{id}/resolve` | Mark an alert resolved |
| `GET` | `/stations/{station}/events?block_id=&type=&limit=200` | Raw hub events, oldest first (max 5000) |
| `POST` | `/stations/{station}/commands` | Send a raw command and wait for the `ack`. Body: `{"cmd": "start_block"\|"stop"\|"estop"\|"config"\|"ping", "args": {}, "timeout_s": 3}` |
| `GET` | `/gateway` | Live gateway state: `connected`, `stats` (messages, events, duplicates, gaps, invalid, stream samples, alerts by kind…), `parquet` rows and files, `devices` (online, boot ID, stalled streams), `clocks` (sync quality per hub boot), `sequences` (per-channel counts) |
| `GET` | `/network` | `laptop_ips`, `broker`, `mdns` (hostname, service, TXT), `hub_should_connect_to` (`IP:port` list), and `hubs` with each one's IP, SSID, RSSI and firmware |

A raw `start_block` is how demo blocks can be run without an athlete; the body format is in the [Hub MQTT data scheme](hub-mqtt-data-scheme.md).

---

## Live WebSocket

```
ws://127.0.0.1:8000/ws/stations/{station}?token=<access_token>
```

- **Access:** staff only. Browsers can't set headers on a WebSocket, so the token goes in the query string. Under open access, a local client may omit it.
- **All stations:** use `*` as the station.
- **Bad or missing token:** the socket closes with code **1008**.
- **Direction:** the feed is server → client only; anything the client sends is ignored.
- **First messages:** on connect, the server sends one `device_status` per known hub, so a late joiner isn't blank.

| `type` | When | Main fields |
|---|---|---|
| `device_status` | Every hub heartbeat (~2 s) and on connect | `device_id`, `status` (online, boot ID, battery, RSSI, targets, sensors, IP, SSID…) |
| `event` | Every new hub event (after duplicates are removed) | `event` (the contract event: `type`, `block_id`, `trial_no`, `target_id`, `t_us`, `data`…), `t_server_us`, `clock_quality`, `latency_ms` |
| `alert` | Every new alert | `id`, `kind`, `severity`, `device_id`, `message`, `detail` |
| `telemetry.imu` / `telemetry.balance` | Latest sample per sensor, at most 20 Hz | `device_id`, `sensor_id`, `channels`, `sample`, `t_hub_us`, `t_server_us`, `clock_quality` |

Event types are `block_started`, `stimulus_on`, `response`, `false_start`, `stimulus_off`, `block_done`, `block_aborted` and `error`. Their payloads are specified in the [Hub MQTT data scheme](hub-mqtt-data-scheme.md).

**Example** (browser console, open access):

```js
const ws = new WebSocket(`ws://${location.host}/api/ws/stations/station-1`);
ws.onmessage = (m) => console.log(JSON.parse(m.data));
```
