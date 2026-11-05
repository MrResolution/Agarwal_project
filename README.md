# AI Vision-Motor & Sports Reflex Assessment and Training System

An affordable, portable, and smart training system combining LED reaction targets, balance tracking, wearable motion sensors (IMUs), and AI pose estimation to assess and train reaction speed, peripheral vision, balance, and coordination.

![VisionReflex coach dashboard](docs/screenshots/02-dashboard.png)

## Repository Contents

- **[`frontend/`](frontend/README.md)**: coach dashboard (React + TypeScript): dashboard, live session, analysis, athletes, devices.
- **[`backend/`](backend/README.md)**: FastAPI API, device gateway, analysis engine (reaction scoring, decision/movement split, balance), hub simulator.
- **[`firmware/`](firmware/README.md)**: reference ESP32-S3 hub firmware.
- **`docs/`**: [dashboard functional research](docs/dashboard-functional-research.md), the [hub MQTT data scheme](docs/hub-mqtt-data-scheme.md) and [screenshots](docs/screenshots/).
- **`info/`**
  - [`Sports Vision & Reflex System Documentation.md`](info/Sports%20Vision%20&%20Reflex%20System%20Documentation.md): Comprehensive system documentation, hardware architecture, sensor integration, state machines, and implementation blueprints.
  - `EyeInnovate_Components_Software_Datasets.pdf`: Component specifications, software overview, and dataset details.
  - `Sports_Vision_Assessment_Training_Report.pdf`: System assessment and training research report.

## Quick start (laptop, simulated hub)

From `backend/`, run each in its own terminal:
1. `python -m svs.broker --lan`
2. `uvicorn --factory svs.main:create_app`
3. `python -m svs.simulator --discover`

Then, from `frontend/`, run `npm install && npm run dev` and open the URL it prints.

## Screenshots

Captured from the running system with the simulated hub; all data is real output of the analysis engine.

### Live session

A block running on the hub: the lit target (T4), trial progress, response feed with classification, live KPIs, centre of pressure from the balance board, wrist-motion bursts and an always-visible E-STOP.

![Live session mid-block](docs/screenshots/03-live-session-running.png)

### Analysis report

Per-block scoring:
- median RT, accuracy, d′, consistency and false starts
- a trial-by-trial chart and rule-based coach insights
- RT distribution and a target heatmap
- the decision vs movement split from the wrist IMU, plus left/right and eccentricity comparisons
- balance sway and the full trial table, with CSV export

![Analysis report](docs/screenshots/04-analysis-report.png)

### Athletes

| Athlete list | Athlete profile |
|---|---|
| ![Athletes](docs/screenshots/05-athletes.png) | ![Athlete profile](docs/screenshots/06-athlete-profile.png) |
| Latest RT, accuracy, runs and trend per athlete; consent status at a glance | Progress vs baseline per protocol, consent records, run history |

### Devices and sign-in

| Devices | Sign-in |
|---|---|
| ![Devices](docs/screenshots/07-devices.png) | ![Login](docs/screenshots/01-login.png) |
| Gateway data quality, hub health, Wi-Fi setup for real hardware, clock sync, alerts | Full-screen sign-in; can be switched off for local use (see `backend/README.md`) |

![Add athlete dialog](docs/screenshots/08-add-athlete-dialog.png)

### Tablet and phone

The layout adapts to every width: cards pair up two per row on tablets and stack on phones.

<table>
  <tr>
    <td width="34%"><img src="docs/screenshots/09-dashboard-tablet.png" alt="Dashboard on a tablet"></td>
    <td width="22%"><img src="docs/screenshots/10-dashboard-phone.png" alt="Dashboard on a phone"><br><img src="docs/screenshots/11-dashboard-phone-live-station.png" alt="Live station card on a phone"></td>
    <td width="22%"><img src="docs/screenshots/13-live-session-phone.png" alt="Live session on a phone"><br><img src="docs/screenshots/14-live-session-phone-targets.png" alt="Targets on a phone"></td>
    <td width="22%"><img src="docs/screenshots/15-analysis-phone.png" alt="Analysis on a phone"><br><img src="docs/screenshots/12-dashboard-phone-recent-runs.png" alt="Recent runs on a phone"></td>
  </tr>
  <tr>
    <td>Tablet (1024 px)</td><td>Phone: dashboard</td><td>Phone: live session</td><td>Phone: analysis and runs</td>
  </tr>
</table>
