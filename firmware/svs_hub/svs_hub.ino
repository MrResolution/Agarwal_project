// SVS hub reference firmware (ESP32-S3) - implements the MQTT contract in backend/svs/contract.
//
// Wi-Fi: joins a router / phone hotspot, finds the laptop broker via mDNS, publishes:
//   svs/{station}/hub/status   retained heartbeat (+ Last-Will offline)       QoS1
//   svs/{station}/events       stimulus_on / response / false_start / ...      QoS1
//   svs/{station}/stream/imu/{id}, svs/{station}/stream/balance/{id}  batches  QoS0
//   svs/{station}/sync/pong    clock-sync reply                               QoS0
//   svs/{station}/hub/ack      command acknowledgements                       QoS1
// and subscribes to svs/{station}/hub/cmd and svs/{station}/sync/ping.
//
// Timing rule: every t_us is esp_timer_get_time() taken at the hardware event (touch-sensor ISR,
// right after the LED frame is latched). Network timing is never used for reaction time.
//
// Targets: N_TARGETS (6) WS2812B rings, each with a digital touch sensor (e.g. TTP223) on its own GPIO.
//
// Libraries (Arduino Library Manager): espMqttClient (bertmelis), ArduinoJson 7,
// Adafruit NeoPixel, Adafruit MPU6050.
// Board: ESP32S3 Dev Module, Arduino-ESP32 core 3.x, PSRAM "OPI PSRAM" for N16R8.

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Wire.h>
#include <espMqttClient.h>
#include <ArduinoJson.h>
#include <Adafruit_NeoPixel.h>
#include "config.h"
#if ENABLE_IMU
#include <Adafruit_MPU6050.h>
#endif

// =============================================================== globals

static espMqttClient mqtt;
static Adafruit_NeoPixel strip(N_TARGETS * LEDS_PER_TARGET, LED_PIN, NEO_GRB + NEO_KHZ800);
#if ENABLE_IMU
static Adafruit_MPU6050 mpu;
static bool imuOk = false;
#endif

static char bootId[9];
static char tStatus[64], tCmd[64], tAck[64], tEvents[64], tImu[80], tBal[80], tPing[64], tPong[64];
static char willPayload[160];
static IPAddress brokerIp;
static bool haveBroker = false;
static uint32_t lastMqttAttemptMs = 0;
static uint8_t failedConnects = 0;
static bool flushOfflinePending = false;

static uint32_t seqEvents = 0, seqImu = 0, seqBal = 0;

// --------------------------------------------------------------- touch ISR (timestamp only)
// One interrupt per touch pin. The ISR stamps the time and queues (target, time); the main loop
// classifies and publishes. A small queue keeps near-simultaneous touches on two targets apart.
struct Touch { int64_t tUs; uint8_t target; };
static const uint8_t TOUCH_QUEUE = 16;
static Touch touchQ[TOUCH_QUEUE];
static volatile uint8_t touchHead = 0, touchTail = 0;
static portMUX_TYPE touchMux = portMUX_INITIALIZER_UNLOCKED;
static int64_t lastTouchUs[N_TARGETS];

void IRAM_ATTR onTouch(void* arg) {
  int64_t t = esp_timer_get_time();  // the authoritative response timestamp
  portENTER_CRITICAL_ISR(&touchMux);
  uint8_t next = (touchHead + 1) % TOUCH_QUEUE;
  if (next != touchTail) {  // full queue only at impossible touch rates: drop
    touchQ[touchHead].tUs = t;
    touchQ[touchHead].target = (uint8_t)(uintptr_t)arg;
    touchHead = next;
  }
  portEXIT_CRITICAL_ISR(&touchMux);
}

// --------------------------------------------------------------- trial block state
struct Trial {
  uint16_t trialNo;
  uint8_t target;  // 0-based
  char colour[8];
  uint32_t foreperiodMs, windowMs, itiMs;
  bool nogo;
};
static const int MAX_TRIALS = 64;
static Trial trials[MAX_TRIALS];
static int nTrials = 0, cur = 0;
static char blockId[40];
enum BlockState { IDLE, FOREPERIOD, STIMULUS, ITI };
static BlockState state = IDLE;
static int64_t phaseEndUs = 0, stimUs = 0;
static int cntTrials = 0, cntResponses = 0, cntFalseStarts = 0;

// --------------------------------------------------------------- offline event buffer (RAM; SD card later)
static const int OFFLINE_SLOTS = 64;
static char offlineBuf[OFFLINE_SLOTS][448];
static int offHead = 0, offCount = 0;

// =============================================================== helpers

static void targetId(int idx, char* out, size_t n) { snprintf(out, n, "T%d", idx + 1); }

static int parseTargetId(const char* s) {
  if (!s || (s[0] != 'T' && s[0] != 't')) return -1;
  int n = atoi(s + 1);
  return (n >= 1 && n <= N_TARGETS) ? n - 1 : -1;
}

static uint32_t colourValue(const char* c) {
  if (!strcmp(c, "red")) return strip.Color(255, 0, 0);
  if (!strcmp(c, "blue")) return strip.Color(0, 0, 255);
  if (!strcmp(c, "yellow")) return strip.Color(255, 160, 0);
  if (!strcmp(c, "white")) return strip.Color(255, 255, 255);
  return strip.Color(0, 255, 0);  // green (default)
}

static void setTarget(int idx, uint32_t colour) {
  for (int i = 0; i < LEDS_PER_TARGET; i++) strip.setPixelColor(idx * LEDS_PER_TARGET + i, colour);
}

static void allOff() {
  strip.clear();
  strip.show();
}

static float batteryPct() {
#if BATTERY_ADC_PIN >= 0
  float v = analogReadMilliVolts(BATTERY_ADC_PIN) / 1000.0f * BATTERY_DIVIDER;
  float p = (v - BATTERY_EMPTY_V) / (BATTERY_FULL_V - BATTERY_EMPTY_V) * 100.0f;
  return constrain(p, 0.0f, 100.0f);
#else
  return NAN;
#endif
}

static bool publishJson(const char* topic, JsonDocument& doc, uint8_t qos, bool retain = false) {
  static char buf[2048];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (n == 0 || n >= sizeof(buf)) return false;
  if (!mqtt.connected()) return false;
  return mqtt.publish(topic, qos, retain, buf) != 0;
}

// Events carry a per-channel seq. When offline they are kept (marked backfill) and replayed
// on reconnect; the gateway de-duplicates, so a replay is always safe.
static void publishEvent(const char* type, int64_t tUs, int trialNo, int target, const char* colour,
                         float force, JsonDocument* data) {
  JsonDocument doc;
  doc["v"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["boot_id"] = bootId;
  doc["seq"] = seqEvents++;
  doc["type"] = type;
  doc["t_us"] = tUs;
  if (blockId[0]) doc["block_id"] = blockId;
  if (trialNo >= 0) doc["trial_no"] = trialNo;
  if (target >= 0) {
    char id[6];
    targetId(target, id, sizeof(id));
    doc["target_id"] = id;
  }
  if (colour) doc["colour"] = colour;
  if (!isnan(force)) doc["force"] = force;
  if (data) doc["data"] = data->as<JsonObjectConst>();

  if (mqtt.connected() && !flushOfflinePending) {
    if (publishJson(tEvents, doc, 1)) return;
  }
  doc["backfill"] = true;
  int slot = (offHead + offCount) % OFFLINE_SLOTS;
  if (offCount == OFFLINE_SLOTS) {  // full: drop the oldest (the gateway will report the gap)
    offHead = (offHead + 1) % OFFLINE_SLOTS;
    offCount--;
  }
  serializeJson(doc, offlineBuf[slot], sizeof(offlineBuf[slot]));
  offCount++;
}

static void flushOffline() {
  while (offCount > 0 && mqtt.connected()) {
    if (mqtt.publish(tEvents, 1, false, offlineBuf[offHead]) == 0) return;  // client queue full; retry next loop
    offHead = (offHead + 1) % OFFLINE_SLOTS;
    offCount--;
  }
  if (offCount == 0) flushOfflinePending = false;
}

static void sendAck(const char* cmdId, bool ok, const char* error) {
  JsonDocument doc;
  doc["v"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["boot_id"] = bootId;
  doc["cmd_id"] = cmdId;
  doc["ok"] = ok;
  if (error) doc["error"] = error;
  doc["t_us"] = esp_timer_get_time();
  publishJson(tAck, doc, 1);
}

static void publishStatus(bool online) {
  JsonDocument doc;
  doc["v"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["boot_id"] = bootId;
  doc["online"] = online;
  doc["t_us"] = esp_timer_get_time();
  doc["firmware"] = FIRMWARE_VERSION;
  float b = batteryPct();
  if (!isnan(b)) doc["battery_pct"] = b;
  doc["rssi"] = WiFi.RSSI();
  doc["uptime_s"] = millis() / 1000.0;
  doc["ip"] = WiFi.localIP().toString();
  doc["mac"] = WiFi.macAddress();
  doc["ssid"] = WiFi.SSID();
  JsonArray targets = doc["targets"].to<JsonArray>();
  for (int i = 0; i < N_TARGETS; i++) {
    char id[6];
    targetId(i, id, sizeof(id));
    JsonObject t = targets.add<JsonObject>();
    t["id"] = id;
    t["online"] = true;  // wired targets; ESP-NOW nodes would report their own state
  }
  JsonArray sensors = doc["sensors"].to<JsonArray>();
#if ENABLE_IMU
  if (imuOk) sensors.add("imu/" IMU_SENSOR_ID);
#endif
#if ENABLE_BALANCE
  sensors.add("balance/" BALANCE_SENSOR_ID);
#endif
  publishJson(tStatus, doc, 1, true);
}

// =============================================================== block execution

static void stopBlock(const char* reason) {
  if (state == IDLE) return;
  allOff();
  JsonDocument d;
  d["reason"] = reason;
  publishEvent("block_aborted", esp_timer_get_time(), -1, -1, nullptr, NAN, &d);
  state = IDLE;
  blockId[0] = 0;
}

static void startTrial(int i) {
  cur = i;
  state = FOREPERIOD;
  phaseEndUs = esp_timer_get_time() + (int64_t)trials[i].foreperiodMs * 1000;
}

static void finishTrial() {
  const Trial& t = trials[cur];
  setTarget(t.target, 0);
  strip.show();
  publishEvent("stimulus_off", esp_timer_get_time(), t.trialNo, t.target, nullptr, NAN, nullptr);
  cntTrials++;
  state = ITI;
  phaseEndUs = esp_timer_get_time() + (int64_t)t.itiMs * 1000;
}

static void runBlock() {
  if (state == IDLE) return;
  int64_t now = esp_timer_get_time();
  const Trial& t = trials[cur];
  switch (state) {
    case FOREPERIOD:
      if (now >= phaseEndUs) {
        setTarget(t.target, colourValue(t.colour));
        strip.show();
        stimUs = esp_timer_get_time();  // frame latched: the stimulus is now visible
        JsonDocument d;
        d["is_nogo"] = t.nogo;
        publishEvent("stimulus_on", stimUs, t.trialNo, t.target, t.colour, NAN, &d);
        state = STIMULUS;
        phaseEndUs = stimUs + (int64_t)t.windowMs * 1000;
      }
      break;
    case STIMULUS:
      if (now >= phaseEndUs) finishTrial();  // no response in the window (miss, or correct no-go)
      break;
    case ITI:
      if (now >= phaseEndUs) {
        if (cur + 1 < nTrials) {
          startTrial(cur + 1);
        } else {
          JsonDocument d;
          d["trials"] = cntTrials;
          d["responses"] = cntResponses;
          d["false_starts"] = cntFalseStarts;
          publishEvent("block_done", esp_timer_get_time(), -1, -1, nullptr, NAN, &d);
          state = IDLE;
          blockId[0] = 0;
        }
      }
      break;
    default:
      break;
  }
}

// Called from loop(): drain the touch queue, apply the lockout, classify, publish.
static void handleTouches() {
  while (true) {
    Touch tc;
    bool any = false;
    portENTER_CRITICAL(&touchMux);
    if (touchTail != touchHead) {
      tc = touchQ[touchTail];
      touchTail = (touchTail + 1) % TOUCH_QUEUE;
      any = true;
    }
    portEXIT_CRITICAL(&touchMux);
    if (!any) return;

    uint8_t target = tc.target;
    if (target >= N_TARGETS) continue;
    if (lastTouchUs[target] && tc.tUs - lastTouchUs[target] < (int64_t)TOUCH_LOCKOUT_MS * 1000) continue;
    lastTouchUs[target] = tc.tUs;

    if (state == FOREPERIOD) {
      publishEvent("false_start", tc.tUs, trials[cur].trialNo, target, nullptr, NAN, nullptr);
      cntFalseStarts++;
    } else if (state == STIMULUS) {
      // Any touch ends the trial; the server decides hit / wrong target / no-go false alarm.
      publishEvent("response", tc.tUs, trials[cur].trialNo, target, nullptr, NAN, nullptr);
      cntResponses++;
      finishTrial();
    }
  }
}

// =============================================================== commands & clock sync

static void handleCommand(const char* payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  const char* cmdId = doc["cmd_id"] | "";
  const char* cmd = doc["cmd"] | "";

  if (!strcmp(cmd, "ping")) {
    sendAck(cmdId, true, nullptr);
  } else if (!strcmp(cmd, "stop") || !strcmp(cmd, "estop")) {
    if (!strcmp(cmd, "estop")) allOff();  // lights off first, then report
    sendAck(cmdId, true, nullptr);
    stopBlock(cmd);
  } else if (!strcmp(cmd, "start_block")) {
    if (state != IDLE) return sendAck(cmdId, false, "busy: a block is already running");
    JsonObject args = doc["args"];
    JsonArray arr = args["trials"];
    if (arr.isNull() || arr.size() == 0) return sendAck(cmdId, false, "invalid args: trials missing");
    if (arr.size() > MAX_TRIALS) return sendAck(cmdId, false, "invalid args: too many trials");
    int n = 0;
    for (JsonObject t : arr) {
      int target = parseTargetId(t["target_id"] | "");
      if (target < 0) return sendAck(cmdId, false, "unknown targets");
      Trial& tr = trials[n++];
      tr.trialNo = t["trial_no"] | (n - 1);
      tr.target = target;
      strlcpy(tr.colour, t["colour"] | "green", sizeof(tr.colour));
      tr.foreperiodMs = t["foreperiod_ms"] | 1000;
      tr.windowMs = t["window_ms"] | 1500;
      tr.itiMs = t["iti_ms"] | 500;
      tr.nogo = t["is_nogo"] | false;
    }
    nTrials = n;
    strlcpy(blockId, args["block_id"] | "block", sizeof(blockId));
    cntTrials = cntResponses = cntFalseStarts = 0;
    sendAck(cmdId, true, nullptr);
    JsonDocument d;
    d["n_trials"] = nTrials;
    publishEvent("block_started", esp_timer_get_time(), -1, -1, nullptr, NAN, &d);
    startTrial(0);
  } else if (!strcmp(cmd, "config")) {
    sendAck(cmdId, true, "no runtime config keys supported yet");
  } else {
    sendAck(cmdId, false, "unknown command");
  }
}

static void handlePing(const char* payload, size_t len) {
  int64_t t1 = esp_timer_get_time();
  JsonDocument in;
  if (deserializeJson(in, payload, len)) return;
  JsonDocument out;
  out["id"] = in["id"];
  out["device_id"] = DEVICE_ID;
  out["boot_id"] = bootId;
  out["t0"] = in["t0"];
  out["t1"] = t1;
  out["t2"] = esp_timer_get_time();
  publishJson(tPong, out, 0);
}

// espMqttClient may deliver a large payload in pieces; reassemble before parsing.
static char rxBuf[8192];
static void onMessage(const espMqttClientTypes::MessageProperties&, const char* topic, const uint8_t* payload,
                      size_t len, size_t index, size_t total) {
  if (total >= sizeof(rxBuf)) return;  // too big for this firmware; the command will time out
  memcpy(rxBuf + index, payload, len);
  if (index + len < total) return;
  rxBuf[total] = 0;
  if (!strcmp(topic, tPing)) handlePing(rxBuf, total);
  else if (!strcmp(topic, tCmd)) handleCommand(rxBuf, total);
}

// =============================================================== networking

static bool discoverBroker() {
  int n = MDNS.queryService("mqtt", "tcp");
  for (int i = 0; i < n; i++) {
    if (MDNS.txt(i, "svs") == "1") {
      brokerIp = MDNS.address(i);
      Serial.printf("[net] broker via mDNS service: %s:%d\n", brokerIp.toString().c_str(), MDNS.port(i));
      return true;
    }
  }
  IPAddress ip = MDNS.queryHost("svs-gateway", 2000);
  if (ip != IPAddress((uint32_t)0)) {
    brokerIp = ip;
    Serial.printf("[net] broker via svs-gateway.local: %s\n", ip.toString().c_str());
    return true;
  }
  if (strlen(FALLBACK_BROKER_IP) && brokerIp.fromString(FALLBACK_BROKER_IP)) {
    Serial.printf("[net] broker via fallback IP: %s\n", FALLBACK_BROKER_IP);
    return true;
  }
  Serial.println("[net] no broker found (is `python -m svs.broker --lan` running?)");
  return false;
}

static void maintainConnection() {
  if (WiFi.status() != WL_CONNECTED) return;  // WiFi auto-reconnects
  if (mqtt.connected()) return;
  uint32_t now = millis();
  if (now - lastMqttAttemptMs < 2000) return;
  lastMqttAttemptMs = now;
  if (!haveBroker || failedConnects >= 3) {  // laptop may have a new IP: look again
    haveBroker = discoverBroker();
    failedConnects = 0;
    if (!haveBroker) return;
  }
  mqtt.setServer(brokerIp, BROKER_PORT);
  mqtt.connect();
  failedConnects++;
}

static void onConnect(bool) {
  Serial.println("[mqtt] connected");
  failedConnects = 0;
  mqtt.subscribe(tCmd, 1);
  mqtt.subscribe(tPing, 0);
  publishStatus(true);
  if (offCount) flushOfflinePending = true;
}

static void onDisconnect(espMqttClientTypes::DisconnectReason reason) {
  Serial.printf("[mqtt] disconnected (%u)\n", (unsigned)reason);
}

// =============================================================== sensors

#if ENABLE_IMU
static float imuBuf[IMU_BATCH][6];
static int imuN = 0;
static int64_t imuT0 = 0, imuNext = 0;
static const int64_t IMU_DT = 1000000LL / IMU_HZ;

static void sampleImu() {
  if (!imuOk) return;
  int64_t now = esp_timer_get_time();
  if (now < imuNext) return;
  if (imuN == 0) imuT0 = imuNext ? imuNext : now;
  imuNext = (imuNext ? imuNext : now) + IMU_DT;
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  const float R2D = 57.29578f;
  float* s = imuBuf[imuN++];
  s[0] = a.acceleration.x; s[1] = a.acceleration.y; s[2] = a.acceleration.z;
  s[3] = g.gyro.x * R2D;   s[4] = g.gyro.y * R2D;   s[5] = g.gyro.z * R2D;
  if (imuN < IMU_BATCH) return;
  imuN = 0;
  if (!mqtt.connected()) return;  // streams are not buffered offline
  JsonDocument doc;
  doc["v"] = 1; doc["device_id"] = DEVICE_ID; doc["boot_id"] = bootId; doc["seq"] = seqImu++;
  doc["stream"] = "imu"; doc["sensor_id"] = IMU_SENSOR_ID; doc["rate_hz"] = IMU_HZ;
  doc["t0_us"] = imuT0; doc["dt_us"] = IMU_DT;
  JsonArray ch = doc["channels"].to<JsonArray>();
  for (const char* c : {"ax", "ay", "az", "gx", "gy", "gz"}) ch.add(c);
  JsonArray samples = doc["samples"].to<JsonArray>();
  for (int i = 0; i < IMU_BATCH; i++) {
    JsonArray row = samples.add<JsonArray>();
    for (int j = 0; j < 6; j++) row.add(serialized(String(imuBuf[i][j], 3)));
  }
  publishJson(tImu, doc, 0);
}
#endif

#if ENABLE_BALANCE
// The four HX711s share one SCK line, so they must be clocked together: read all four
// DOUT lines on the same 24 clock pulses (+1 pulse selects channel A, gain 128).
static portMUX_TYPE hxMux = portMUX_INITIALIZER_UNLOCKED;
static long hxOffset[4] = {0, 0, 0, 0};

static bool hxReady() {
  for (int i = 0; i < 4; i++)
    if (digitalRead(HX711_DOUT[i]) != LOW) return false;
  return true;
}

static void hxReadRaw(long out[4]) {
  uint32_t v[4] = {0, 0, 0, 0};
  portENTER_CRITICAL(&hxMux);  // keep pulses short (<60 us high would power the chips down)
  for (int bit = 0; bit < 24; bit++) {
    digitalWrite(HX711_SCK, HIGH);
    delayMicroseconds(1);
    for (int i = 0; i < 4; i++) v[i] = (v[i] << 1) | (digitalRead(HX711_DOUT[i]) ? 1 : 0);
    digitalWrite(HX711_SCK, LOW);
    delayMicroseconds(1);
  }
  digitalWrite(HX711_SCK, HIGH);
  delayMicroseconds(1);
  digitalWrite(HX711_SCK, LOW);
  portEXIT_CRITICAL(&hxMux);
  for (int i = 0; i < 4; i++) out[i] = (v[i] & 0x800000) ? (long)(v[i] | 0xFF000000) : (long)v[i];
}

static void hxTare() {
  long sum[4] = {0, 0, 0, 0}, raw[4];
  int got = 0;
  uint32_t until = millis() + 1500;
  while (got < 16 && millis() < until) {
    if (hxReady()) {
      hxReadRaw(raw);
      for (int i = 0; i < 4; i++) sum[i] += raw[i];
      got++;
    }
    delay(5);
  }
  for (int i = 0; i < 4; i++) hxOffset[i] = got ? sum[i] / got : 0;
  Serial.printf("[balance] tared with %d samples (stand off the board at boot)\n", got);
}

static float balBuf[BALANCE_BATCH][4];
static int balN = 0;
static int64_t balT0 = 0, balNext = 0;
static const int64_t BAL_DT = 1000000LL / BALANCE_HZ;
static float lastKg[4] = {0, 0, 0, 0};

static void sampleBalance() {
  if (hxReady()) {  // keep the latest conversion; publish on a fixed schedule
    long raw[4];
    hxReadRaw(raw);
    for (int i = 0; i < 4; i++) lastKg[i] = (raw[i] - hxOffset[i]) / HX711_SCALE[i];
  }
  int64_t now = esp_timer_get_time();
  if (now < balNext) return;
  if (balN == 0) balT0 = balNext ? balNext : now;
  balNext = (balNext ? balNext : now) + BAL_DT;
  memcpy(balBuf[balN++], lastKg, sizeof(lastKg));
  if (balN < BALANCE_BATCH) return;
  balN = 0;
  if (!mqtt.connected()) return;
  JsonDocument doc;
  doc["v"] = 1; doc["device_id"] = DEVICE_ID; doc["boot_id"] = bootId; doc["seq"] = seqBal++;
  doc["stream"] = "balance"; doc["sensor_id"] = BALANCE_SENSOR_ID; doc["rate_hz"] = BALANCE_HZ;
  doc["t0_us"] = balT0; doc["dt_us"] = BAL_DT;
  JsonArray ch = doc["channels"].to<JsonArray>();
  for (const char* c : {"fl", "fr", "bl", "br"}) ch.add(c);
  JsonArray samples = doc["samples"].to<JsonArray>();
  for (int i = 0; i < BALANCE_BATCH; i++) {
    JsonArray row = samples.add<JsonArray>();
    for (int j = 0; j < 4; j++) row.add(serialized(String(balBuf[i][j], 3)));
  }
  publishJson(tBal, doc, 0);
}
#endif

// =============================================================== setup / loop

void setup() {
  Serial.begin(115200);
  delay(200);
  snprintf(bootId, sizeof(bootId), "%08lx", (unsigned long)esp_random());
  Serial.printf("\n[svs] %s %s boot %s\n", DEVICE_ID, FIRMWARE_VERSION, bootId);

  snprintf(tStatus, sizeof(tStatus), "svs/%s/hub/status", STATION_ID);
  snprintf(tCmd, sizeof(tCmd), "svs/%s/hub/cmd", STATION_ID);
  snprintf(tAck, sizeof(tAck), "svs/%s/hub/ack", STATION_ID);
  snprintf(tEvents, sizeof(tEvents), "svs/%s/events", STATION_ID);
  snprintf(tImu, sizeof(tImu), "svs/%s/stream/imu/%s", STATION_ID, IMU_SENSOR_ID);
  snprintf(tBal, sizeof(tBal), "svs/%s/stream/balance/%s", STATION_ID, BALANCE_SENSOR_ID);
  snprintf(tPing, sizeof(tPing), "svs/%s/sync/ping", STATION_ID);
  snprintf(tPong, sizeof(tPong), "svs/%s/sync/pong", STATION_ID);

  strip.begin();
  strip.setBrightness(LED_BRIGHTNESS);
  allOff();

  Wire.begin(I2C0_SDA, I2C0_SCL, 400000);
  // Touch sensors: TTP223 modules calibrate at power-on, so keep hands off the pads while booting.
  for (int i = 0; i < N_TARGETS; i++) {
    pinMode(TOUCH_PINS[i], TOUCH_ACTIVE_HIGH ? INPUT_PULLDOWN : INPUT_PULLUP);
    attachInterruptArg(digitalPinToInterrupt(TOUCH_PINS[i]), onTouch, (void*)(uintptr_t)i,
                       TOUCH_ACTIVE_HIGH ? RISING : FALLING);
  }

#if ENABLE_IMU
  imuOk = mpu.begin(0x68, &Wire);
  if (imuOk) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_1000_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);
  } else {
    Serial.println("[imu] MPU6050 not found; IMU stream disabled");
  }
#endif
#if ENABLE_BALANCE
  pinMode(HX711_SCK, OUTPUT);
  digitalWrite(HX711_SCK, LOW);
  for (int i = 0; i < 4; i++) pinMode(HX711_DOUT[i], INPUT);
  hxTare();
#endif

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);  // modem sleep adds 100+ ms of jitter to MQTT traffic
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[wifi] joining %s", WIFI_SSID);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
    delay(250);
    Serial.print('.');
  }
  Serial.printf("\n[wifi] %s ip=%s\n", WiFi.status() == WL_CONNECTED ? "connected" : "not yet connected",
                WiFi.localIP().toString().c_str());
  MDNS.begin(DEVICE_ID);

  snprintf(willPayload, sizeof(willPayload),
           "{\"v\":1,\"device_id\":\"%s\",\"boot_id\":\"%s\",\"online\":false}", DEVICE_ID, bootId);
  mqtt.setClientId(DEVICE_ID);
  mqtt.setKeepAlive(10);
  mqtt.setWill(tStatus, 1, true, willPayload);
  mqtt.onConnect(onConnect);
  mqtt.onDisconnect(onDisconnect);
  mqtt.onMessage(onMessage);
}

void loop() {
  mqtt.loop();
  maintainConnection();
  if (flushOfflinePending) flushOffline();
  handleTouches();
  runBlock();
#if ENABLE_IMU
  sampleImu();
#endif
#if ENABLE_BALANCE
  sampleBalance();
#endif
  static uint32_t lastStatus = 0;
  if (mqtt.connected() && millis() - lastStatus >= 2000) {
    lastStatus = millis();
    publishStatus(true);
  }
}
