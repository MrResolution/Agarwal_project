# Web Dashboard — Functional Research & Build Plan

**Product:** AI Vision-Motor & Sports Reflex Assessment and Training System
**Scope of this document:** what the dashboard must *do* (functions, data, algorithms, APIs, state handling). UI/visual design is deliberately out of scope.
**Sources:** `info/Sports Vision & Reflex System Documentation.md`, `info/Sports_Vision_Assessment_Training_Report.pdf`, `info/EyeInnovate_Components_Software_Datasets.pdf`, plus standard practice from reaction-time and posturography research.
**Date:** 4 Nov 2026

---

## 1. What the "dashboard" really is

It is not just a set of charts. Functionally it is the **control plane and system of record** for the whole product:

```
 ESP32-S3 hub ──MQTT──► Device Gateway ──► Session Engine ──► Scoring/Analytics ──► DB
 (LEDs, buttons,        (ingest, dedupe,   (state machine,    (RT, accuracy,
  IMUs, balance board)   clock mapping)     trial plans,       CoP sway, trends)
        ▲                                   adaptive diff.)           │
        └────────── commands (MQTT) ◄────────────┘                    ▼
                                                          REST + WebSocket API
 Webcam ─► CV worker (MediaPipe) ──────────────────────►  (consumed by any UI)
```

Everything the coach sees or does goes through the **REST + WebSocket API**. If that API is complete, any UI (React, Flutter, or a quick test page) can be put on top later. That matches the request: build the functions first.

**Recommended stack** (matches the project docs): Python 3.11, FastAPI, Pydantic v2, SQLAlchemy 2 + Alembic, SQLite to start and PostgreSQL later, Mosquitto with `aiomqtt`/`paho-mqtt`, NumPy/SciPy for signal processing, ReportLab for PDFs, pytest for tests.

---

## 2. Design rules taken from the source docs

These rules shape almost every function below. Breaking them produces data that can't be trusted.

1. **Assessment ≠ Training.** Assessment protocols are fixed, versioned and repeatable. Training protocols adapt. The two are stored and charted separately.
2. **Timestamps come from the hardware, never from network arrival.** RT is computed from the hub's `esp_timer_get_time()` µs values. Server receive time is stored only for diagnostics.
3. **Store the raw data and the derived data.** Every trial is stored at event level. Summaries can always be recomputed.
4. **Invalid trials are flagged, never silently dropped.** False starts, misses, dropouts and duplicates all stay in the record with a reason code.
5. **No single "vision score"** until it has been validated. Show component metrics. Any composite must be transparent and labelled.
6. **Only compare like with like.** Trends are grouped by protocol version, device configuration and conditions.
7. **No diagnostic claims.** Reports carry a "not a diagnosis" statement.

---

## 3. Function inventory

Priority: **P0** = required for an MVP that works with hardware, **P1** = required for pilot use, **P2** = later or advanced.

### M1. Auth, users & roles — P0
- Login, sessions, password reset. Use JWT or server-side sessions. Local-first deployment means offline login must work.
- Roles from the docs: `admin`, `coach/therapist`, `athlete`, `patient`, `parent`.
- Permission matrix (minimum):

| Action | admin | coach/therapist | athlete/patient | parent |
|---|---|---|---|---|
| Manage users/devices | ✔ | – | – | – |
| Create/edit athlete profiles | ✔ | ✔ (own org) | – | – |
| Run sessions | ✔ | ✔ | – | – |
| View results | ✔ | ✔ (assigned) | own only | linked child only |
| Export raw data / delete records | ✔ | ✔ (with audit) | request only | request only |

- Every athlete record has an organisation/owner scope. All queries filter on that scope, so access is enforced in one place.

### M2. Athlete / patient profiles & consent — P0
- Profile fields: anonymised ID, name (optional and separable), age band, group (athlete/patient/elderly/child), sport, position, dominant hand and foot, visual correction, relevant history, goals.
- **Consent records:** type (data, video, research use), signer, guardian for minors, date, version of the consent text, withdrawal date. Rules that must be enforced:
  - No session can start without valid data consent.
  - Video frames and landmarks are stored only with video consent. Otherwise only derived angles are kept.
- **Baseline context per session:** fatigue (1–10), sleep, time since last training, environment notes. The report asks for this.
- Data-subject functions: export everything held for one person, and hard-delete or anonymise on request (logged in the audit).

### M3. Device registry, health & calibration — P0
- Register a hub and its target nodes, IMUs and balance board: device ID, type, firmware version, MAC, position/label (e.g. target #4 at "upper-left, 40° eccentricity").
- **Live health:** online/offline (via MQTT Last-Will), battery %, RSSI, error codes, last-seen time.
- **Calibration records** (stored as `CalibrationRecord`, each with a validity window):
  - Load-cell tare and scale factor per corner, checked with a known reference weight (target error under ±0.5 kg).
  - IMU zero offsets.
  - Measured latency per target from bench photodiode tests. Used to correct RT or to flag it.
  - Physical layout: target coordinates and the athlete's standing distance, from which target eccentricity angles are computed.
- **Preflight check function:** given a protocol, verify that every required device is online, its battery is above threshold, and its calibration is still valid. Return pass/fail with reasons. A session cannot start until preflight passes.

### M4. Protocol library & versioning — P0
- A **Protocol** is a definition. A **ProtocolVersion** is immutable. Editing a protocol creates a new version, so old results stay interpretable.
- Parameters a protocol version must express:
  - `kind`: assessment or training.
  - `task`: simple_rt, choice_rt, go_nogo, peripheral, static_balance, weight_shift, single_leg, combined, memory_sequence.
  - Blocks: practice block (unscored) followed by scored blocks.
  - Per block: number of trials, foreperiod distribution (e.g. uniform 1000–3000 ms, or non-aging exponential), stimulus duration, response window, eligible targets, colour → meaning map (green = go, red = no-go), no-go ratio, required response type.
  - Scoring rules: anticipation cutoff, outlier rule, minimum valid trials.
  - Endpoint definition: what counts as "the response" (movement onset, first touch, button press, or FSR threshold).
  - Required devices.
- The built-in protocols are the 8 game modes listed in the components PDF (§4.5).

### M5. Session orchestration — P0 (core of the system)
- Create a session: athlete + protocol version + device configuration + operator.
- **Trial-plan generator:** a deterministic, seeded RNG produces the full trial sequence: target, colour, foreperiod and go/no-go for each trial. The seed is stored, so any session can be reproduced exactly. Apply constraints such as "no more than 3 identical targets in a row" and a balanced count per target.
- **Execution split** (recommended):
  - The server sends **one block at a time** to the hub over MQTT.
  - The hub runs the timing-critical loop locally: foreperiod → LED on → capture response → LED off. It publishes events.
  - The server scores trials as they arrive and decides the next block.
  - This keeps timing on the chip while all game logic stays editable on the server.
- Session state machine and controls (pause, resume, abort, e-stop): see §6.
- **Session blocks follow the report's 15–20 min structure:** equipment check → warm-up → primary skill block → sport-specific block → cool-down/retest.

### M6. Live telemetry gateway — P0
- Subscribe to MQTT and validate every message against a schema (Pydantic). Deduplicate by `(device_id, boot_id, seq)`, because MQTT QoS 1 means "at least once".
- Map device clock → session clock (see §7).
- Fan out to WebSocket subscribers per session. Throttle high-rate streams for display: send CoP at about 20 Hz and decimate IMU data. Keep full-rate data for storage.
- Persist raw streams to Parquet per session (IMU at 100 Hz+, load cells at 50–80 Hz, pose at 30 fps). Do not insert rows into SQL per sample.
- Detect gaps (missing sequence numbers or a stalled stream) and raise a `data_gap` warning on the session.
- Ingest SD-card backfill: when the hub reconnects after an outage, it uploads buffered events. The gateway merges them idempotently.

### M7. Trial scoring engine — P0
Pure functions. Raw events go in; a scored trial comes out. These must be heavily unit-tested.

**Per trial:**
- `RT_total = t_response − t_stimulus`
- If an IMU is present: `RT_premotor = t_onset − t_stimulus` (brain/reaction time) and `MT = t_response − t_onset` (movement time).
- Result classification (in this order):
  1. Response **before** the stimulus, during the foreperiod → `false_start`.
  2. `RT < anticipation_cutoff` (default **100 ms**, configurable per protocol) → `anticipation`. Counts as a false start.
  3. No response within the window → `miss` (omission). On a no-go trial this is a `correct_rejection`.
  4. Response on a no-go trial → `false_alarm` (commission).
  5. Response on the wrong target → `wrong_target`.
  6. Device dropout during the trial → `invalid_hardware`.
  7. Otherwise → `hit`.
- Apply the per-target latency correction from calibration, if one exists.
- Record force (peak FSR) and the CoP excursion during the trial window, if available.

**Per block/session summaries:**
- Median RT (the primary measure, because it is robust), mean, SD, IQR, MAD, and coefficient of variation (RT variability is a useful metric in its own right).
- Counts and rates: hits, misses, false starts, false alarms, wrong targets, valid trial count.
- **Go/no-go sensitivity:** `d′ = Z(H) − Z(FA)` with the log-linear correction `H = (hits+0.5)/(go_trials+1)`, `FA = (fa+0.5)/(nogo_trials+1)`. Also the criterion `c = −(Z(H)+Z(FA))/2`.
- Outlier rule, predefined per protocol (e.g. exclude valid hits more than 3 MAD from the median). Excluded trials stay stored with `excluded_reason`.
- Breakdowns: by target, by zone (left/right/upper/lower/central/peripheral), and by eccentricity band.
- **Asymmetry index:** `AI = (RT_R − RT_L) / ((RT_R + RT_L)/2) × 100`.
- Quality gate: if valid trials < protocol minimum, mark the session result **"insufficient data"** and leave it out of trends.

**Movement-onset detection from the IMU** (needed for the premotor/motor split):
- Signal: `|a| − g` (or gyro magnitude) on the wrist/ankle IMU, low-pass filtered.
- Baseline: mean and SD over the 200 ms before the stimulus.
- Onset: first sample after the stimulus exceeding `mean + k·SD` (k ≈ 3–5) for N consecutive samples.
- ⚠ **At 100 Hz, onset resolution is 10 ms.** The MPU6050 can sample at up to 1 kHz. To meet the docs' <5 ms timing target, run the wrist IMU at ≥500 Hz and stamp samples on the hub.
- Validate the onset algorithm against labelled high-fps video (report §6, Stage 5).

### M8. Balance analytics — P0 for balance modes
- **CoP from 4 load cells** (corners FL, FR, BL, BR; sensor spacing `Lx` × `Ly`; `W` = sum of the four):
  - `CoP_x = (Lx/2) · ((FR + BR) − (FL + BL)) / W`  (medio-lateral)
  - `CoP_y = (Ly/2) · ((FL + FR) − (BL + BR)) / W`  (antero-posterior)
- **Filtering:** moving average or 1-pole low-pass live; zero-phase 4th-order Butterworth (~10 Hz) for stored analysis.
- **Standard sway metrics** (these let you compare against the PhysioNet Human Balance Evaluation Database for reference):
  - Total path length `Σ‖ΔCoP‖`, and mean velocity = path / duration
  - RMS distance from mean CoP; AP and ML range; AP and ML RMS
  - **95% confidence-ellipse area** = `π · 5.991 · √(λ₁ λ₂)` (λ = eigenvalues of the CoP covariance)
- **Mode-specific scoring:**
  - Static balance: the metrics above, plus eyes-open vs eyes-closed (Romberg ratio) if that condition is added.
  - Weight shift: time to reach each on-screen target, dwell accuracy, overshoot.
  - Single-leg: time in stance until loss (detected by load drop, or CoP leaving the base), plus sway.
  - Combined: CoP excursion per reach trial, correlated with RT.
- **Instability / fall alert (safety):** fire on a sudden load drop, CoP outside the base-of-support boundary, or a CV-pose trunk-lean threshold. Start with these rule-based triggers. Add the ML model (LSTM/1D-CNN trained on SisFall etc.) later, and only after validation.

### M9. Adaptive difficulty engine — P1 (training mode only)
- Difficulty is a vector of dimensions: `{stimulus_duration, foreperiod_range, n_active_targets, eccentricity_spread, nogo_ratio, distractors, balance_condition}`.
- **Rule** (from the docs; easy to explain to coaches):
  - After each block of N trials (e.g. 10): if accuracy ≥ 85% → step **one** dimension up, rotating through the dimensions in a fixed order.
  - If accuracy < 65% → step the most recently raised dimension back down.
  - Otherwise, hold.
- Alternative for single-dimension tasks: a **2-down/1-up staircase**, which converges near 70.7% accuracy and is well studied.
- Every change is written to a `DifficultyChange` log (block, dimension, from → to, reason). Without it, training data can't be interpreted. This is a hard requirement in the report.
- Store each athlete's last converged level so the next session starts there.

### M10. Results, baselines & trends — P0/P1
- **Session result:** all M7/M8 summaries, task settings, valid trial count, flags, and the comparison against the athlete's baseline.
- **Baseline:** the first N valid assessment sessions, or one explicitly marked by the coach, per protocol version.
- **Meaningful-change detection** (this is what makes trend charts honest):
  - From test–retest data: `SEM = SD · √(1 − ICC)` and `MDC95 = 1.96 · √2 · SEM`.
  - Flag a change as "real" only if it exceeds MDC95. Until reliability has been measured, show changes as "unverified".
- **Trend queries:** grouped by protocol version and device configuration. When the series crosses a version or configuration change, return an explicit `comparability_break` marker.
- **Coach overview:** list of athletes with last session, adherence (sessions done vs planned), key metrics vs baseline, and open safety/quality flags.
- **Norms:** the components PDF suggests "comparison with age-group reference values", but the report says to avoid unsupported normative rankings. **Recommendation:** keep a norms table in the system but switch it off until validated reference data exists (balance norms from PhysioNet can be cited, labelled with their source).

### M11. Reports & export — P1
- **PDF report** (ReportLab): athlete details (anonymised option), date, protocol and version, equipment configuration and firmware, test conditions, results with baseline comparison, limitations, and the "not a diagnosis" statement.
- **CSV/Parquet export:** the trial-level table, with every field listed in the components PDF §5.2. Optionally include raw streams.
- **Dataset export for ML:** anonymised, split by participant (70/15/15), as the data-collection protocol requires.
- Database backup and restore function (single-file SQLite copy or `pg_dump`).

### M12. Safety & alerts — P0
- **E-stop:** one API call/WebSocket message → the server publishes `cmd/estop` at QoS 1 → the hub turns all LEDs off and halts the block. The session moves to `ABORTED` with a reason. The hub should also have a physical stop button and a watchdog that stops the block if the server heartbeat is lost.
- Auto-pause on device disconnect, fall/instability alert, or low battery.
- Session time limit and enforced rest breaks, configurable per group (children, elderly).
- Symptom stop: "discomfort/dizziness" recorded as a stop reason.

### M13. Audit, logging & data governance — P1
- Append-only audit log: who viewed, exported, edited or deleted what, and when.
- Structured event log per session: device errors, warnings, state transitions.
- Retention policy per data type (e.g. raw video deleted after X days). Implement as a scheduled job.
- Encryption: TLS on the API, MQTT over TLS with per-device credentials, and encryption at rest for PostgreSQL deployments.

### M14. Sport profiles — P1
- A sport profile is configuration over the shared task engine, not new code. It holds: visual demands, a list of protocol versions with their order, target layout preset, response mapping (e.g. tennis: left targets = backhand), progression rules, and coach notes.
- Start with **cricket and football**, as the report recommends.

### M15. Computer-vision integration — P2
- The CV worker runs as a separate process. It publishes pose landmarks and derived angles (trunk lean, joint angles, symmetry) with frame timestamps to the same broker.
- The dashboard backend only consumes derived metrics, plus an optional low-res preview stream. Skeleton overlay is a UI concern.
- Camera-to-hub synchronisation needs a shared event, e.g. an LED flash visible in the frame at session start, to estimate the offset.

---

## 4. Data model

```
Organisation 1─* User (role)
Organisation 1─* Athlete 1─* Consent
Athlete      1─* Session *─1 ProtocolVersion *─1 Protocol
Session      *─1 DeviceConfig (snapshot: devices, firmware, layout, calibration ids)
Session      1─* Block 1─* Trial
Trial        1─* StimulusEvent, ResponseEvent, MovementOnset
Session      1─* DifficultyChange, SessionEvent (state/warnings), Alert
Session      1─1 SessionResult (derived summaries, JSON + key columns)
Device       1─* CalibrationRecord
Athlete      1─* TrainingPlan, Report
AuditLog (global, append-only)
RawStream files (Parquet per session/stream) referenced by Session
```

**Trial (key columns):** `id, session_id, block_no, trial_no, target_id, target_eccentricity_deg, stimulus_colour, is_nogo, foreperiod_ms, scheduled_onset_us, measured_onset_us, response_type, response_target_id, response_us, movement_onset_us, rt_total_ms, rt_premotor_ms, mt_ms, peak_force, result, excluded_reason, device_id, firmware, difficulty_level_json`.

**Session (key columns):** `id, athlete_id, protocol_version_id, kind, operator_id, seed, state, started_at, ended_at, stop_reason, device_config_snapshot_json, conditions_json (fatigue, environment…)`.

Snapshot the device configuration into the session, not just a foreign key. Devices change over time, and old sessions must keep showing what was actually used.

---

## 5. API surface

### 5.1 REST (FastAPI)
```
POST   /auth/login                       GET  /me
CRUD   /athletes            /athletes/{id}/consents
CRUD   /devices             POST /devices/{id}/calibrations
GET    /devices/status                    (live health snapshot)
CRUD   /protocols           POST /protocols/{id}/versions   (immutable once used)
POST   /sessions                          (athlete, protocol_version, device_config)
POST   /sessions/{id}/preflight
POST   /sessions/{id}/start | pause | resume | abort | estop
GET    /sessions/{id}                     (state + live summary)
GET    /sessions/{id}/trials              (paginated, filter by result)
GET    /sessions/{id}/result
GET    /athletes/{id}/trends?protocol=&metric=&from=&to=
GET    /athletes/{id}/baseline?protocol_version=
GET    /overview                          (coach dashboard aggregate)
GET    /sessions/{id}/report.pdf          GET /sessions/{id}/export.csv
GET    /export/dataset?anonymise=true
GET    /audit
```

### 5.2 WebSocket — `/ws/sessions/{id}`
Server → client messages (JSON, each with `type`, `ts`, `seq`):
`session_state`, `block_started`, `trial_started`, `trial_result` (scored trial), `telemetry.cop` (~20 Hz), `telemetry.imu` (decimated), `telemetry.pose` (derived angles), `device_status`, `alert` (fall, disconnect, low battery, data gap), `difficulty_changed`, `summary_update`.
Client → server: `pause`, `resume`, `estop`, `annotate`, the same actions as REST. Separately, a global `/ws/devices` socket for health.

Budget from the docs: **under 200 ms** from hub event to dashboard. Measure this end to end and expose it as a metric.

### 5.3 MQTT topics (hub ↔ gateway)
```
svs/{station}/hub/status          retained, + Last-Will "offline"       QoS1
svs/{station}/hub/cmd             start_block / stop / estop / config    QoS1
svs/{station}/hub/ack             command acknowledgements               QoS1
svs/{station}/events              stimulus_on, response, false_start,
                                  block_done (each: device_id, boot_id,
                                  seq, t_us)                             QoS1
svs/{station}/stream/imu/{id}     batched samples                        QoS0
svs/{station}/stream/balance/{id} batched load-cell samples              QoS0
svs/{station}/sync/ping|pong      clock-sync ping/pong                   QoS0
svs/{station}/cv/pose             derived pose metrics                   QoS0
```
Batch stream samples (e.g. 10 samples per message) to cut overhead. Sign or authenticate per device. Every command carries a `cmd_id`, and a command with no ack within its timeout raises an alert.

---

## 6. State machines

**Session**
```
CREATED ─preflight ok─► READY ─start─► RUNNING ─block done─► RUNNING (next block)
                                         │  ▲                     │
                               pause/    │  │ resume              └─all blocks─► COMPLETED
                               disconnect▼  │
                                        PAUSED
  any state ─estop/abort/fall alert─► ABORTED (stop_reason)
```
- Trials in flight when the session pauses or a device disconnects are marked `invalid_hardware`, not lost.
- `COMPLETED` triggers computation of the session result and baseline/trend updates.
- An aborted session keeps its partial data and is excluded from trends by default.

**Trial**
`SCHEDULED → FOREPERIOD → STIMULUS_ON → (RESPONDED | TIMED_OUT) → SCORED`. A response during FOREPERIOD goes straight to `false_start`.

---

## 7. Time synchronisation

- **The hub is the master clock.** LED onset and button press are stamped on the same chip, so RT needs no sync at all. This is the main reason for the architecture.
- **Wireless target nodes (ESP-NOW):** the hub syncs node clocks periodically, NTP-style: `offset = ((t1 − t0) + (t2 − t3)) / 2`. Pick the exchange with the lowest round-trip time. Nodes report hit times already converted to hub time.
- **Server mapping:** the gateway keeps a linear fit `server_time ≈ a · hub_time + b`, updated from sync pings. This gives drift correction and lets IMU, CoP and camera streams share one timeline for fusion and charts.
- **Hub reboot:** `boot_id` changes, so the mapping restarts. Never mix sequence numbers across boots.

---

## 8. Building without hardware: device simulator (do this first)

A small Python **hub simulator** makes it possible to build and test the whole dashboard before the electronics are ready:
- Speaks the exact MQTT contract from §5.3.
- Generates RTs from an **ex-Gaussian** distribution, which is realistic for human RT (e.g. μ≈250 ms, σ≈30, τ≈60). Adds configurable rates of false starts, misses, no-go errors and wrong targets.
- Generates CoP sway (filtered random walk) and IMU onset bursts.
- Injects faults: dropped messages, duplicates, disconnects, low battery, clock drift, reboots mid-session.

The same simulator then becomes the automated test harness for the report's "Stage 2 — software verification" list.

---

## 9. Verification plan (software)

| Area | Test |
|---|---|
| Scoring | Golden CSV fixtures: hand-computed RT, classification, median/MAD, d′, asymmetry. Property tests (e.g. RT is never negative for a scored hit). |
| Balance | Synthetic CoP with known path length and ellipse area; known-weight calibration check. |
| Plans | Same seed → identical plan; constraints respected; balanced target counts. |
| Ingest | Duplicate, out-of-order and missing-seq messages; SD-card backfill merge is idempotent. |
| Sessions | Every state transition; pause/resume; disconnect mid-trial; e-stop latency. |
| Adaptive | Simulated athlete at fixed skill → staircase converges; every change is logged. |
| Trends | Comparability breaks inserted across protocol-version changes; MDC flagging. |
| Security | Role matrix enforced on every endpoint; consent gate blocks session start. |
| Latency | Hub event → WebSocket client under 200 ms at full stream load. |

---

## 10. Suggested build order

| Milestone | Delivers | Depends on hardware? |
|---|---|---|
| **B0** | Repo skeleton, DB schema + migrations, auth/roles, athlete + consent CRUD | No |
| **B1** | MQTT contract + hub simulator + gateway (ingest, dedupe, clock map, Parquet) | No |
| **B2** | Protocol versioning, seeded trial-plan generator, session state machine, WebSocket live channel | No |
| **B3** | Scoring engine (M7) + session results + CSV export, fully unit-tested | No |
| **B4** | Balance analytics (M8), safety/e-stop/alerts (M12), device registry + preflight + calibration (M3) | Partly (calibration) |
| **B5** | Baselines, trends, MDC, coach overview (M10); adaptive difficulty (M9); PDF reports (M11) | No |
| **B6** | Swap simulator → real ESP32-S3; bench timing validation; sport profiles (cricket, football) | Yes |
| **B7** | CV worker integration, ML models, audit/retention polish | Yes |

B0–B5 can all be built and tested against the simulator. A thin test UI (or plain Swagger/WebSocket clients) is enough to drive them.

---

## 11. Open questions to resolve before building

1. **Age-group norms.** The components PDF wants them; the report warns against unsupported normative rankings. Decide whether to keep them off until validated (recommended above).
2. **IMU sample rate.** 100 Hz (as documented) limits movement-onset resolution to 10 ms. Should the wrist IMUs run at ≥500 Hz?
3. **Single station vs multi-station.** Single station → SQLite on a laptop/Pi. A whole academy or clinic → PostgreSQL plus central login. This changes M1 and M13.
4. **Who executes the trial loop.** This document recommends server-planned blocks executed on the hub. Firmware must agree on the block command format.
5. **Pilot sports and partner.** Cricket and football are recommended as the first two sport profiles.
6. **Video retention.** Store raw video at all, or only landmarks and derived angles?
7. **Default anticipation cutoff and response window** per protocol: 100 ms and 1500 ms are proposed defaults, to be confirmed with the pilot partner.
