# AI Vision-Motor & Sports Reflex Assessment and Training System
**Complete Project Documentation & Architecture Guide**

---

## 1. What This Product Is (In Simple Words)
This project is an affordable, portable, and smart training system that measures and improves **reaction speed, peripheral vision, body balance, and hand-eye/foot-eye coordination**. 

While commercial systems exist for individual parts of this (like reaction light pods or balance plates), this platform combines **four systems into one unified setup**:
1. **Smart LED Targets** that light up and measure how fast you react and hit them.
2. **A Smart Balance Board** that tracks your weight distribution and stability while you stand or move.
3. **Wearable Motion Sensors (IMUs)** on the wrists, ankles, or waist that detect the exact microsecond your body starts moving.
4. **A Camera with AI Pose Tracking** that watches your posture, joint angles, and balance in real time.

### Who Uses It & What Problems It Solves
* **Athletes (Cricket, Football, Tennis, Badminton, Boxing, etc.):** Helps players react faster, scan their surroundings better (peripheral vision), and make quicker split-second decisions under pressure.
* **Injury & Stroke Rehabilitation Patients:** Helps physiotherapists track a patient's recovery safely using controlled weight-shifting games and gentle reach drills.
* **Elderly Individuals:** Measures body sway and trains balance to prevent dangerous falls.
* **Children:** Uses fun color and memory light games to build motor skills and coordination.

---

## 2. Core Rule of the System: Assessment vs. Training
A key scientific rule built into this product is that **testing (assessment) and practicing (training) are kept separate**:
* **Assessment Mode** uses strict, repeatable tests to measure your true baseline (for example, your exact reaction time in milliseconds).
* **Training Mode** uses adaptive games that automatically get harder as you improve (increasing speed, adding distractor lights, or requiring you to balance while hitting targets).

---

## 3. How the Hardware Works (The Physical Setup)

### A. The Brain (Main Hub)
* **ESP32-S3 Microcontroller:** Acts as the central hub. It controls the lights, reads the sensors, and sends data over Wi-Fi/Bluetooth to the computer.
* **Wireless Target Nodes (ESP-NOW):** If the LED targets are placed far apart on a wall or court, smaller ESP32 chips inside each target talk instantaneously to the main hub using a fast wireless protocol called **ESP-NOW**.

### B. The Input Sensors
1. **Smart LED Targets (`WS2812B` LEDs + Buttons/Force Sensors):** 6 to 12 light-up pods. When a pod lights up, the user hits it. Arcade buttons, touch pads, or Force-Sensitive Resistors (`FSR402`) detect the hit and how hard it was pressed.
2. **Wearable Motion Sensors (`MPU6050` IMUs):** Small sensors strapped to the wrist or ankle. They measure acceleration and tilt 100 times per second ($100\text{ Hz}$) so the system knows the exact moment your hand starts moving—even before you touch the target.
3. **Smart Balance Board (4x $50\text{ kg}$ Load Cells + `HX711` Amplifiers):** Two flat wooden/acrylic boards with weight sensors at all four corners. By comparing the weight on the front-left, front-right, back-left, and back-right corners, the system calculates your **Centre of Pressure (CoP)** to see if you are leaning or wobbling.
4. **Distance Sensors (`HC-SR04P` Ultrasonic / `VL53L0X` Laser):** Measure how close a hand or foot is getting to a target.
5. **Camera (1080p Webcam at $30\text{--}60\text{ fps}$):** Placed on a tripod in front of the user to capture full-body posture.

### C. Why the Hardware Timing Is Special
Never use the time a Wi-Fi message arrives at a laptop to measure reaction speed, because Wi-Fi can lag. Instead, the **ESP32-S3 records the exact microsecond (`esp_timer_get_time()`)** a light turns on and the exact microsecond a button is pressed right on the chip using hardware interrupts. This keeps timing error under $5\text{ milliseconds}$.

---

## 4. Step-by-Step Walkthrough: How a Single Drill Works

Imagine an athlete steps up to use the system for a **Combined Balance & Reflex Drill**:

1. **Setup & Login:** The athlete stands on the balance board facing a wall of 8 LED targets and a webcam. The coach selects the athlete's profile and starts a 15-minute session from the dashboard.
2. **Stimulus (The Light Turns On):** After a random pause, Target #4 lights up green. The ESP32 records the exact microsecond the light turned on ($T_{\text{stimulus}}$).
3. **Reaction Phase (Brain Processing):** The athlete sees the green light and decides to move their right hand. The moment their wrist begins to move, the wrist IMU sensor detects the acceleration spike and records the **Movement Onset Time** ($T_{\text{onset}}$).
4. **Movement Phase (Reaching & Hitting):** The athlete reaches out and hits Target #4. The button inside Target #4 registers the hit ($T_{\text{hit}}$). Meanwhile, the balance board records how much their body swayed while reaching, and the webcam tracks their shoulder and spine angles.
5. **Instant Math:**
   * **True Reaction Time (Brain Speed):** $T_{\text{onset}} - T_{\text{stimulus}}$ (How fast they saw and reacted).
   * **Movement Time (Hand Speed):** $T_{\text{hit}} - T_{\text{onset}}$ (How fast their arm moved to the target).
   * **Total Response Time:** $T_{\text{hit}} - T_{\text{stimulus}}$.
6. **Live Feedback:** Within a fraction of a second, the dashboard updates with their speed, hit accuracy, and balance score, and the next light triggers.

---

## 5. How the Backend & Data Processing Are Built

The software backend is built in **Python** using **FastAPI** and handles both **real-time streaming** (for live feedback during a game) and **database storage** (for long-term tracking and AI analysis).

### Step 1: Data Transmission (MQTT & WebSockets)
* **ESP32 to Server (MQTT):** The ESP32-S3 sends sensor data packaged as lightweight JSON messages over Wi-Fi using **MQTT (Eclipse Mosquitto)**. MQTT is an ultra-fast messaging protocol designed for smart devices so data streams smoothly without lag. If Wi-Fi drops, the ESP32 saves data to an onboard MicroSD card.
* **Server to Dashboard (WebSockets):** The Python FastAPI server receives the MQTT stream, processes it, and pushes live results to the web/mobile app using **WebSockets** in under $200\text{ milliseconds}$.

### Step 2: Signal Cleaning & Sensor Fusion
Raw sensor data is noisy, so the Python backend cleans and combines it:
* **Filtering:** Uses a **Kalman Filter / Complementary Filter** to smooth out the wrist/ankle IMU motion data, and a **Low-Pass Moving Average Filter** to steady the balance board weight readings.
* **Sensor Fusion:** Aligns the timestamps of the LED targets, the balance board, the IMUs, and the camera frames so all data streams match up on the same timeline.

### Step 3: Computer Vision Pipeline (OpenCV + MediaPipe)
* Runs in Python alongside the backend.
* **MediaPipe Pose** tracks 33 body landmarks (shoulders, hips, knees, ankles) and **MediaPipe Hands** tracks 21 hand landmarks.
* Calculates joint angles, trunk lean, posture symmetry, and visual movement onset. If an elderly user or patient loses balance, it triggers an immediate fall/instability alert.

### Step 4: Machine Learning & Adaptive AI
* **Skill Classification (Random Forest / XGBoost):** Looks at reaction speed, accuracy, and sway to classify the user's current skill tier.
* **Instability & Fall Detection (LSTM / 1D-CNN):** Deep learning models trained on motion data detect unsteady movement patterns. Lightweight versions of these models (`TensorFlow Lite Micro`) can even run directly on the ESP32-S3 chip.
* **Adaptive Difficulty Engine:** If a user hits more than a set accuracy target (e.g., $>85\%$), the backend automatically increases one difficulty variable for the next round (faster lights, wider peripheral spread, or adding red "No-Go" distractor lights). If accuracy drops, it eases the difficulty back down.

### Step 5: Database Storage
* Uses **SQLite** for a single offline laptop/Raspberry Pi setup, or **PostgreSQL** for a multi-user academy or clinic.
* Stores structured tables for `Athletes`, `Sessions`, `Protocols`, and raw `Trials`, plus exports raw logs to CSV/Parquet for deeper research.

---

## 6. The User Interface & Analytics Dashboard

The dashboard (built with **React** for web and/or **Flutter** for mobile/tablets) serves as the control center for coaches, physiotherapists, and athletes. It is designed with large, high-contrast buttons, a simple setup wizard, and an always-visible emergency stop button so it is easy to use on a busy sports court or in a clinic.

During a workout, the **Live Session View** displays real-time telemetry: a live video feed overlaid with the user's 33-point body skeleton, an interactive Centre-of-Pressure (CoP) dot showing their live balance on the board, a trial counter, battery/connection status for all LED pods, and instant reaction-time readouts. Once a session ends, the **Results & Longitudinal Trends View** breaks down performance into clear visual analytics—including a reaction-time heatmap showing which target positions (left, right, high, low, peripheral) the user is slowest at, split charts comparing brain reaction time versus physical movement time, error rates (misses and false starts), and progress graphs comparing today's session against the user's personal baseline over weeks. Finally, coaches and therapists can click one button to generate a **PDF Progress Report** (via `ReportLab`) or export raw **CSV trial data** for clinical records.

---

## 7. Phased Build Roadmap & Budget Summary

To build this reliably without getting overwhelmed, the project is split into four clear phases:

| Phase | Focus Area | What You Build & Test |
| :--- | :--- | :--- |
| **Phase 1** | **Hardware & Sensors** | Wire the ESP32-S3 hub, 6–12 LED targets, buttons, IMUs, and the 4-load-cell balance board. Verify microsecond timing accuracy and stream raw data over MQTT. |
| **Phase 2** | **Computer Vision** | Set up the webcam and Python MediaPipe script to track the 33 body keypoints, calculate posture angles, and overlay the live skeleton. |
| **Phase 3** | **Data Processing & AI** | Add Kalman filtering, sensor fusion, the Adaptive Difficulty engine, and train the Random Forest / LSTM models using public and custom datasets. |
| **Phase 4** | **Dashboard & Final MVP** | Build the React/Flutter UI, connect FastAPI WebSockets for live charts, add sport-specific profiles (Cricket, Football, etc.), and enable PDF/CSV reports. |

* **Estimated Prototype Cost (Indian Market):** **₹6,000 – ₹9,000** for the core wired system with the balance board; **₹15,000 – ₹20,000** for the complete wireless MVP including a Raspberry Pi 5, webcam, and wireless ESP-NOW target pods.