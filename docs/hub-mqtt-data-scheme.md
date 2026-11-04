# Hub ↔ Server MQTT Data Scheme

**Contract version:** 1
**Applies to:** ESP32-S3 hub firmware (`firmware/svs_hub/`), the hub simulator, and the device gateway
**Source of truth:** [`backend/svs/contract/messages.py`](../backend/svs/contract/messages.py) and [`topics.py`](../backend/svs/contract/topics.py). If this document and the code disagree, the code wins. Please report the mismatch.

The ESP32 does not broadcast to the network. It **publishes JSON messages to the MQTT broker** running on the laptop, and the device gateway subscribes to them. The hub and laptop are on the same Wi-Fi network (router or phone hotspot). The hub finds the broker through mDNS (see [Broker discovery](#broker-discovery)).

---

## 1. Topic map

`{station}` is the hub's `STATION_ID` (e.g. `station-1`). One station = one hub plus its targets and sensors.

| Topic | Direction | QoS | Retained | Message | Rate |
|---|---|---|---|---|---|
| `svs/{station}/hub/status` | hub → server | 1 | **yes** | [Status](#3-status-heartbeat) (also the Last-Will) | every 2 s |
| `svs/{station}/events` | hub → server | 1 | no | [Event](#4-timing-events) | per hardware event |
| `svs/{station}/stream/imu/{sensor_id}` | hub → server | 0 | no | [Stream batch](#5-sensor-streams) | IMU rate ÷ batch size |
| `svs/{station}/stream/balance/{sensor_id}` | hub → server | 0 | no | [Stream batch](#5-sensor-streams) | balance rate ÷ batch size |
| `svs/{station}/hub/cmd` | server → hub | 1 | no | [Command](#7-commands) | on demand |
| `svs/{station}/hub/ack` | hub → server | 1 | no | [Command ack](#7-commands) | one per command |
| `svs/{station}/sync/ping` | server → hub | 0 | no | [Sync ping](#6-clock-sync) | every 2 s |
| `svs/{station}/sync/pong` | hub → server | 0 | no | [Sync pong](#6-clock-sync) | one per ping |

The hub **subscribes** to `hub/cmd` (QoS 1) and `sync/ping` (QoS 0) and **publishes** to everything else.

---

## 2. Rules for every hub message

| Field | Type | Rule |
|---|---|---|
| `v` | int | Contract version. Always `1`. |
| `device_id` | string (1–64) | Unique per hub, e.g. `"hub-01"`. Never changes. |
| `boot_id` | string (1–64) | **New random value on every power-on**, e.g. 8 hex characters `"3fa91c07"`. Tells the server the hub restarted, so clocks and sequence numbers start over. |
| `seq` | int ≥ 0 | Starts at **0 on each boot** and increases by **exactly 1** per message. There is a **separate counter per channel**: one for `events`, one for each stream topic. Status, acks and pongs carry no `seq`. |
| `t_us`, `t0_us`, `t1`, `t2` | int (µs) | Hub clock from `esp_timer_get_time()`, captured **at the hardware event**: in the button interrupt, or right after the LED frame is latched. **Never** the time a message is sent. These are the only timestamps used for reaction time. |

Why these rules matter:
- **Duplicates:** MQTT QoS 1 may deliver a message twice. The gateway drops any repeated `(device_id, boot_id, channel, seq)`.
- **Lost data:** a skipped `seq` is reported as a `data_gap` alert.
- **Bad messages:** anything that doesn't match the schema is rejected with a `bad_message` alert and does not stop ingest.
- **Forward compatibility:** unknown extra fields are ignored, so newer firmware can add fields without breaking the server.

---

## 3. Status heartbeat

**Topic:** `svs/{station}/hub/status`. QoS 1, **retained**, every ~2 s and immediately after connecting.

```json
{
  "v": 1,
  "device_id": "hub-01",
  "boot_id": "3fa91c07",
  "online": true,
  "t_us": 15234567,
  "firmware": "0.1.0",
  "battery_pct": 87.5,
  "rssi": -58,
  "uptime_s": 15.2,
  "ip": "10.220.9.120",
  "mac": "34:85:18:AB:CD:EF",
  "ssid": "MyHotspot",
  "errors": [],
  "targets": [
    {"id": "T1", "online": true, "battery_pct": null},
    {"id": "T2", "online": true}
  ],
  "sensors": ["imu/wrist_r", "balance/board"]
}
```

| Field | Required | Notes |
|---|---|---|
| `online` | yes | `true` in heartbeats, `false` in the Last-Will |
| `t_us` | no | hub clock at send time |
| `firmware` | no | version string, stored on the device record |
| `battery_pct` | no | 0–100; omit if no battery sensing. Below 15 % raises a `low_battery` alert |
| `rssi` | no | Wi-Fi signal (dBm) |
| `uptime_s` | no | seconds since boot |
| `ip`, `mac`, `ssid` | no | shown by `GET /network` for setup and diagnostics |
| `errors` | no | short error codes, e.g. `["imu_not_found"]` |
| `targets` | no | one entry per LED target: `id`, `online`, optional `battery_pct` (for wireless nodes) |
| `sensors` | no | stream ids this hub publishes, as `"{kind}/{sensor_id}"` |

**Last-Will.** Register it when connecting: same topic, QoS 1, retained. The broker publishes it if the hub disappears without disconnecting.

```json
{"v": 1, "device_id": "hub-01", "boot_id": "3fa91c07", "online": false}
```

If no heartbeat arrives for 8 s, the server also marks the hub offline (`device_offline: heartbeat lost`).

---

## 4. Timing events

**Topic:** `svs/{station}/events`. QoS 1. Each event uses the `events` sequence counter.

### Example: one trial

```json
{"v":1,"device_id":"hub-01","boot_id":"3fa91c07","seq":12,
 "type":"stimulus_on","t_us":18234567,
 "block_id":"b1","trial_no":3,"target_id":"T4","colour":"green",
 "data":{"is_nogo":false}}
```
```json
{"v":1,"device_id":"hub-01","boot_id":"3fa91c07","seq":13,
 "type":"response","t_us":18601234,
 "block_id":"b1","trial_no":3,"target_id":"T4","force":4.2}
```
```json
{"v":1,"device_id":"hub-01","boot_id":"3fa91c07","seq":14,
 "type":"stimulus_off","t_us":18602010,
 "block_id":"b1","trial_no":3,"target_id":"T4"}
```

The server calculates **reaction time = `response.t_us − stimulus_on.t_us` = 366.667 ms**. Both timestamps come from the same hub clock, so no clock synchronisation is needed for reaction time.

### Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | one of the event types below |
| `t_us` | int | yes | hub clock at the hardware event |
| `block_id` | string | for block/trial events | the `block_id` from `start_block` |
| `trial_no` | int | for trial events | the `trial_no` from the trial spec |
| `target_id` | string | for trial events | `"T1"`…`"TN"`. For `response` / `false_start` this is the target **actually pressed** |
| `colour` | string | `stimulus_on` | `green`, `red`, `blue`, `yellow`, `white` |
| `force` | float | no | peak FSR reading for a hit, if the target has one |
| `backfill` | bool | no | `true` when replayed after a Wi-Fi outage (default `false`) |
| `data` | object | no | type-specific extras (below) |

### Event types

| `type` | Send when | Extra content |
|---|---|---|
| `block_started` | right after accepting `start_block` | `data.n_trials` |
| `stimulus_on` | the LED has visibly turned on (stamp right after `strip.show()` returns) | `trial_no`, `target_id`, `colour`, `data.is_nogo` |
| `response` | a target is pressed while the stimulus is on | `trial_no`, `target_id` (pressed), optional `force` |
| `false_start` | a target is pressed during the foreperiod, before the light | `trial_no`, `target_id` (pressed) |
| `stimulus_off` | the LED turns off (after a response, or the window expires) | `trial_no`, `target_id` |
| `block_done` | every trial in the block has finished | `data: {"trials", "responses", "false_starts"}` |
| `block_aborted` | the block was stopped by `stop` / `estop` | `data.reason` (`"stop"` / `"estop"`) |
| `error` | a hardware or firmware fault | `data` (free form, e.g. `{"code": "E1"}`) |

The hub only **reports what happened**. Hit, wrong target, miss, no-go false alarm and correct rejection are all decided by the server.

### Trial lifecycle on the hub

```
start_block ─► block_started
   for each trial:
     FOREPERIOD  (wait foreperiod_ms; any press here ─► false_start)
     LED ON      ─► stimulus_on
     WINDOW      (until window_ms; first press ─► response, ends the window)
     LED OFF     ─► stimulus_off
     ITI         (wait iti_ms)
   ─► block_done
stop / estop at any time ─► LEDs off ─► block_aborted
```

### Offline backfill

If the broker is unreachable, keep events in a buffer: RAM (the reference firmware holds 64) or the SD card. Replay them in order after reconnecting, with `"backfill": true` and their **original** `seq` and `t_us`. Replaying is always safe, because the server stores each `(device_id, boot_id, seq)` once.

---

## 5. Sensor streams

**Topics:** `svs/{station}/stream/imu/{sensor_id}` and `svs/{station}/stream/balance/{sensor_id}`. QoS 0. Each topic has its own sequence counter.

Samples are taken at a fixed rate and sent in batches (the reference firmware uses 10 per message). **Sample *i* was taken at `t0_us + i × dt_us`.**

### IMU (e.g. wrist MPU6050)

```json
{"v":1,"device_id":"hub-01","boot_id":"3fa91c07","seq":240,
 "stream":"imu","sensor_id":"wrist_r","rate_hz":100,
 "t0_us":18200000,"dt_us":10000,
 "channels":["ax","ay","az","gx","gy","gz"],
 "samples":[
   [0.021,-0.048,9.812,0.42,-0.18,0.07],
   [0.034,-0.041,9.805,0.51,-0.11,0.02]
 ]}
```

| Channel | Unit |
|---|---|
| `ax`, `ay`, `az` | m/s² |
| `gx`, `gy`, `gz` | deg/s |

### Balance board (4 × load cell via HX711)

```json
{"v":1,"device_id":"hub-01","boot_id":"3fa91c07","seq":120,
 "stream":"balance","sensor_id":"board","rate_hz":50,
 "t0_us":18200000,"dt_us":20000,
 "channels":["fl","fr","bl","br"],
 "samples":[
   [17.62,17.31,17.55,17.48],
   [17.60,17.35,17.51,17.50]
 ]}
```

| Channel | Meaning | Unit |
|---|---|---|
| `fl`, `fr`, `bl`, `br` | front-left, front-right, back-left, back-right corner | kg (after tare and calibration) |

### Fields

| Field | Type | Rule |
|---|---|---|
| `stream` | `"imu"` \| `"balance"` | must match the topic's `{kind}` |
| `sensor_id` | string | must match the topic's `{sensor_id}` |
| `rate_hz` | float > 0 | nominal sample rate |
| `t0_us` | int | hub clock of the **first** sample in this batch |
| `dt_us` | int > 0 | interval between samples (`1 000 000 / rate_hz`) |
| `channels` | string[] (≥ 1) | column names |
| `samples` | number[][] (≥ 1) | **every row must have exactly `len(channels)` values** |

Streams are not buffered when offline. A pause shows up as a `stream_stall` alert, and lost batches as a periodic `data_gap` summary.

**Size.** A 10-sample IMU batch is about 500–700 bytes. Set the MQTT client's buffer to at least 2 KB.

---

## 6. Clock sync

The server sends a ping every ~2 s. The hub must reply **immediately**.

**Ping.** Topic `svs/{station}/sync/ping` (server → hub):
```json
{"id": "a1b2c3d4e5", "t0": 1730745600123456}
```

**Pong.** Topic `svs/{station}/sync/pong` (hub → server):
```json
{"id": "a1b2c3d4e5", "device_id": "hub-01", "boot_id": "3fa91c07",
 "t0": 1730745600123456, "t1": 18234000, "t2": 18234050}
```

| Field | Value |
|---|---|
| `id`, `t0` | copied **unchanged** from the ping |
| `t1` | hub clock when the ping was received (take it first) |
| `t2` | hub clock just before publishing the pong |

From many exchanges the server fits `server_time ≈ a × hub_time + b`, which gives the offset and drift. Hub events and streams can then be placed on the same wall-clock timeline as the camera and other devices.

---

## 7. Commands

**Command.** Topic `svs/{station}/hub/cmd` (server → hub), QoS 1:

```json
{"cmd_id": "7f3e9a1b2c4d", "cmd": "start_block", "args": {
  "block_id": "b1",
  "trials": [
    {"trial_no": 0, "target_id": "T3", "colour": "green", "foreperiod_ms": 1500,
     "window_ms": 1500, "is_nogo": false, "iti_ms": 500},
    {"trial_no": 1, "target_id": "T6", "colour": "red", "foreperiod_ms": 2100,
     "window_ms": 1500, "is_nogo": true, "iti_ms": 500}
  ]}}
```

| `cmd` | Hub action | `args` |
|---|---|---|
| `start_block` | validate, ack, then run the trials | `block_id`, `trials[]` (below) |
| `stop` | end the running block, LEDs off, send `block_aborted` | none |
| `estop` | **LEDs off immediately**, then ack and send `block_aborted` | none |
| `ping` | just ack (connectivity check) | none |
| `config` | apply runtime settings (none defined yet) | key/value pairs |

**Trial spec** (each entry in `trials`):

| Field | Type | Default | Range |
|---|---|---|---|
| `trial_no` | int | none | ≥ 0 |
| `target_id` | string | none | `"T1"`…`"TN"` |
| `colour` | string | `"green"` | `green` / `red` / `blue` / `yellow` / `white` |
| `foreperiod_ms` | int | none | 0–60000 (wait before the light) |
| `window_ms` | int | 1500 | 1–60000 (response window after the light) |
| `is_nogo` | bool | `false` | the athlete should **not** press |
| `iti_ms` | int | 500 | 0–60000 (pause after the trial) |

The reference firmware accepts up to 64 trials per block, and commands up to 8 KB.

**Ack.** Topic `svs/{station}/hub/ack` (hub → server), QoS 1. Send one for **every** command:

```json
{"v": 1, "device_id": "hub-01", "boot_id": "3fa91c07",
 "cmd_id": "7f3e9a1b2c4d", "ok": true, "t_us": 18300000}
```

Rejecting a command:

```json
{"v": 1, "device_id": "hub-01", "boot_id": "3fa91c07",
 "cmd_id": "7f3e9a1b2c4d", "ok": false, "error": "busy: a block is already running", "t_us": 18300000}
```

Standard error strings: `"busy: a block is already running"`, `"invalid args: …"`, `"unknown targets"`, `"unknown command"`.

If no ack arrives within 3 s, the server raises a `command_timeout` alert and the API returns HTTP 504.

---

## 8. Broker discovery

The laptop runs `python -m svs.broker --lan`. The hub looks for the broker in this order:

1. **mDNS service** `_mqtt._tcp` whose TXT record has `svs=1` (on Arduino: `MDNS.queryService("mqtt", "tcp")`, then `MDNS.txt(i, "svs") == "1"`)
2. **mDNS host** `svs-gateway.local` (`MDNS.queryHost("svs-gateway")`)
3. `FALLBACK_BROKER_IP` from `config.h`

It connects on port **1883** with client id = `device_id`, keep-alive 10 s, and the Last-Will above. If three connection attempts fail, it discovers again, because the laptop may have a new IP.

---

## 9. Checking your firmware

| Check | How |
|---|---|
| Compare with a known-good sender | `python -m svs.simulator -v` sends exactly these messages |
| See what arrives, live | WebSocket `ws://<laptop>:8000/ws/stations/station-1?token=<JWT>` |
| Stored events | `GET /stations/station-1/events` |
| Rejected / lost / duplicate counts per channel, clock-sync quality | `GET /gateway` |
| Malformed messages | `GET /alerts?kind=bad_message` (the alert detail contains the validation error) |
| Network / IP / signal | `GET /network` |
