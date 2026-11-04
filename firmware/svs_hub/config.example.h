// Copy this file to config.h and fill in your values. config.h is gitignored (it holds the Wi-Fi password).
#pragma once

// ---------------------------------------------------------------- network (router / phone hotspot)
#define WIFI_SSID "your-hotspot-name"
#define WIFI_PASSWORD "your-hotspot-password"

// Broker discovery order: mDNS service _mqtt._tcp with TXT svs=1  ->  mDNS host svs-gateway.local  ->  this IP.
// Leave empty to rely on mDNS only. Run `python -m svs.broker --lan` on the laptop; it prints the IP to use.
#define FALLBACK_BROKER_IP ""
#define BROKER_PORT 1883

// ---------------------------------------------------------------- identity
#define STATION_ID "station-1"   // one station = one hub and its targets/sensors
#define DEVICE_ID "hub-01"       // unique per hub
#define FIRMWARE_VERSION "0.1.0"

// ---------------------------------------------------------------- targets (LED + button)
#define N_TARGETS 8
#define LED_PIN 16               // WS2812B data, through the 74AHCT125 level shifter
#define LEDS_PER_TARGET 12       // 12-LED ring per target, rings chained in target order T1..TN
#define LED_BRIGHTNESS 120       // 0-255; full white draws ~60 mA per LED

// Buttons: MCP23017 at 0x20 on I2C bus 0, target i on expander pin i (GPA0..), INTA -> MCP_INT_PIN.
// The ISR on MCP_INT_PIN takes the timestamp, so the I2C read afterwards adds no timing error.
#define MCP_ADDR 0x20
#define MCP_INT_PIN 10
#define BUTTON_DEBOUNCE_MS 150

// ---------------------------------------------------------------- I2C bus 0
#define I2C0_SDA 8
#define I2C0_SCL 9

// ---------------------------------------------------------------- wrist IMU (MPU6050 at 0x68 on I2C bus 0)
#define ENABLE_IMU 1
#define IMU_SENSOR_ID "wrist_r"
#define IMU_HZ 100               // research doc recommends >= 500 Hz for <5 ms movement-onset resolution
#define IMU_BATCH 10

// ---------------------------------------------------------------- balance board (4 x HX711, shared SCK)
#define ENABLE_BALANCE 1
#define BALANCE_SENSOR_ID "board"
#define BALANCE_HZ 50            // HX711 RATE pin high = 80 SPS
#define BALANCE_BATCH 10
#define HX711_SCK 42
static const int HX711_DOUT[4] = {38, 39, 40, 41};               // front-left, front-right, back-left, back-right
static const float HX711_SCALE[4] = {21500.0f, 21500.0f, 21500.0f, 21500.0f};  // raw counts per kg: calibrate!

// ---------------------------------------------------------------- battery (optional)
#define BATTERY_ADC_PIN -1       // ADC1 pin with a voltage divider, or -1 if not fitted
#define BATTERY_DIVIDER 2.0f     // Vbat = Vpin * divider
#define BATTERY_EMPTY_V 6.4f     // 2S Li-ion
#define BATTERY_FULL_V 8.4f
