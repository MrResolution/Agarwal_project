# AI Vision-Motor & Sports Reflex Assessment and Training System

An affordable, portable, and smart training system combining LED reaction targets, balance tracking, wearable motion sensors (IMUs), and AI pose estimation to assess and train reaction speed, peripheral vision, balance, and coordination.

## Repository Contents

- **[`frontend/`](frontend/README.md)**: coach dashboard (React + TypeScript): dashboard, live session, analysis, athletes, devices.
- **[`backend/`](backend/README.md)**: FastAPI API, device gateway, analysis engine (reaction scoring, decision/movement split, balance), hub simulator.
- **[`firmware/`](firmware/README.md)**: reference ESP32-S3 hub firmware.
- **`docs/`**: [dashboard functional research](docs/dashboard-functional-research.md) and the [hub MQTT data scheme](docs/hub-mqtt-data-scheme.md).

### Quick start (laptop, simulated hub)

From `backend/`, each in its own terminal: `python -m svs.broker --lan`, then `uvicorn --factory svs.main:create_app`, then `python -m svs.simulator --discover`. From `frontend/`: `npm install && npm run dev`, then open the printed URL.

- **`info/`**
  - [`Sports Vision & Reflex System Documentation.md`](info/Sports%20Vision%20&%20Reflex%20System%20Documentation.md): Comprehensive system documentation, hardware architecture, sensor integration, state machines, and implementation blueprints.
  - `EyeInnovate_Components_Software_Datasets.pdf`: Component specifications, software overview, and dataset details.
  - `Sports_Vision_Assessment_Training_Report.pdf`: System assessment and training research report.
