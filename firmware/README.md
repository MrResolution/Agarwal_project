# Hub firmware (ESP32-S3)

`svs_hub/svs_hub.ino` is the reference firmware for the hub. It implements the MQTT contract in [`backend/svs/contract/`](../backend/svs/contract/), documented message by message in [`docs/hub-mqtt-data-scheme.md`](../docs/hub-mqtt-data-scheme.md); the Python simulator (`python -m svs.simulator`) implements the same contract, so anything that works with the simulator works with this firmware.

> Status: written against the contract and the pin plan in `info/EyeInnovate_Components_Software_Datasets.pdf`, but **not yet compiled or run on hardware**. Expect to fix small library-API details on the first build, and check timing on the bench (research doc §10, Stage 1).

## Network setup: router or phone hotspot

```
 ESP32-S3 hub ──Wi-Fi──┐
                       ├── router / hotspot (access point)
 Laptop ───────Wi-Fi───┘      laptop runs: MQTT broker (:1883) + API/gateway (:8000)
```

1. Join the laptop to the hotspot, then start the broker in LAN mode. It prints the laptop's IP and advertises itself over mDNS:
   ```bash
   .venv\Scripts\python -m svs.broker --lan
   ```
2. **Windows firewall:** allow inbound TCP 1883 on the Wi-Fi network, or the hub can't connect. Run this yourself in an *administrator* PowerShell:
   ```bash
   New-NetFirewallRule -DisplayName "SVS MQTT broker" -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow -Profile Private,Public
   ```
   Some phone hotspots isolate clients from each other ("AP/client isolation"). If the hub joins but can't reach the laptop, turn that off, or use the laptop's own Mobile Hotspot as the access point.
3. Start the API and gateway as usual (`uvicorn --factory svs.main:create_app`). `GET /network` shows the IPs a hub should use and every connected hub's reported IP, SSID and signal.

How the hub finds the broker (no IP needs to be hard-coded):
1. mDNS service `_mqtt._tcp` with TXT `svs=1`
2. mDNS host `svs-gateway.local`
3. `FALLBACK_BROKER_IP` in `config.h`

It looks again whenever three connection attempts fail, so a laptop that gets a new IP is found automatically.

## Build and flash

1. Copy `svs_hub/config.example.h` to `svs_hub/config.h` (gitignored) and set the Wi-Fi SSID and password, `STATION_ID`/`DEVICE_ID`, and the load-cell scale factors.
2. **Arduino IDE 2.x:** use board *ESP32S3 Dev Module* (Arduino-ESP32 core **3.x**) with PSRAM set to *OPI PSRAM*. Install these libraries: **espMqttClient** (bertmelis), **ArduinoJson** 7, **Adafruit NeoPixel**, **Adafruit MPU6050**.
   **PlatformIO** (alternative): from `firmware/`, run `pio run -t upload -t monitor`.
3. Open the serial monitor at 115200. You should see Wi-Fi join, broker discovery and `[mqtt] connected`. The hub then appears in `GET /devices` and on the `/ws/stations/station-1` feed.

## Touch-sensor targets

The station has **6 targets (T1–T6)**. Each is a WS2812B LED ring with a digital touch sensor (e.g. a TTP223 module), on an arc in front of the athlete at −70°, −42°, −14°, +14°, +42° and +70°.

| Target | T1 | T2 | T3 | T4 | T5 | T6 |
|---|---|---|---|---|---|---|
| Touch sensor OUT → GPIO | 4 | 5 | 6 | 7 | 17 | 18 |
| LED ring (chained on GPIO 16) | LEDs 0–11 | 12–23 | 24–35 | 36–47 | 48–59 | 60–71 |

- **Wiring:** each touch module needs VCC (3.3 V), GND, and OUT to its GPIO. Change the pins in `TOUCH_PINS` in `config.h` if your board differs. Avoid GPIO 0, 3, 45 and 46 (strapping pins), 19 and 20 (USB) and 35–37 (octal PSRAM on N16R8).
- **Polarity:** TTP223 modules drive OUT **high** while touched, the default (`TOUCH_ACTIVE_HIGH 1`). For a module jumpered to active-low, set it to 0.
- **Power-on calibration:** TTP223 modules calibrate when they power up. Keep hands off the pads while the hub boots.
- **Changing the count:** set `N_TARGETS` and list that many pins. The hub reports its targets in every status heartbeat, and the server lays out the arc and plans trials from that count.

## What it does

| Function | Implementation |
|---|---|
| Targets | `N_TARGETS` (6) WS2812B rings chained on GPIO 16; target *i* = LEDs `i*LEDS_PER_TARGET…` |
| Touch sensors | One GPIO interrupt per target. **The ISR stamps `esp_timer_get_time()`** and queues the target and time; the main loop classifies and publishes. A 150 ms lockout per target (`TOUCH_LOCKOUT_MS`) ignores re-triggers |
| Stimulus time | Stamped right after `strip.show()` returns (the frame is latched and visible) |
| Blocks | `start_block` → per trial: foreperiod (a touch here = `false_start`) → LED on (`stimulus_on`) → touch (`response`) or window timeout → LED off (`stimulus_off`) → ITI → … → `block_done`. `stop`/`estop` → `block_aborted`. The server classifies hits, wrong targets and no-go false alarms |
| Wrist IMU | MPU6050 at `IMU_HZ` (default 100 Hz), batches of 10 → `stream/imu/wrist_r` |
| Balance board | 4 × HX711 on a **shared SCK** (GPIO 42), so all four are clocked together and read in parallel. Tared at boot (keep the board empty). Calibrate `HX711_SCALE` with a known weight |
| Clock sync | Replies to `sync/ping` with hub times `t1`/`t2`; the gateway fits offset and drift |
| Reliability | QoS 1 for events/acks/status; Last-Will publishes `online:false`; events produced while disconnected are kept in a 64-slot RAM buffer and replayed with `backfill:true` (the gateway de-duplicates) |

## Known gaps (next firmware steps)

- Offline buffer is RAM only (64 events). Move it to the MicroSD card for long outages.
- No FSR hit-force or distance sensors yet (`force` is left out of events).
- No ESP-NOW wireless target nodes yet. Targets are wired to the hub.
- For movement-onset timing below 5 ms, raise `IMU_HZ` to 500+ and consider reading the IMU from a timer task.
- MQTT is plain TCP with no login. That's acceptable on a private hotspot for a prototype; production needs Mosquitto with TLS and per-device credentials.
