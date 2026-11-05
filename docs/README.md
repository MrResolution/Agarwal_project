# Documentation

Start with the **Project overview**, then follow the path for your role.

| Document | What it covers | Read it if you… |
|---|---|---|
| [Project overview](project-overview.md) | What VisionReflex is, the physical setup, key ideas, vocabulary, one run end to end, repository map, current status | are new to the project |
| [Dashboard guide](dashboard-guide.md) | Every page and card of the coach dashboard, with screenshots, and a five-step typical session | coach, train or assess athletes |
| [Metrics reference](metrics-reference.md) | Protocols, trial classification, RT statistics, d′, decision/movement split, balance, skill radar, coach insights, baselines | want to know exactly what a number means |
| [Setup and operations](setup-and-operations.md) | Install, run, simulator options, real hardware, open access, settings, data and backups, alerts, troubleshooting | install or look after the system |
| [Architecture](architecture.md) | Components, backend modules, data model, run lifecycle, device gateway, frontend, security, tests | develop the backend or frontend |
| [API reference](api-reference.md) | Authentication, roles, every REST endpoint, request bodies, the live WebSocket feed | integrate with or script against the API |
| [Hub MQTT data scheme](hub-mqtt-data-scheme.md) | Topics, message formats, clock sync, commands and broker discovery the ESP32-S3 firmware must implement | write or test hub firmware |
| [Dashboard functional research](dashboard-functional-research.md) | The original research and build plan behind the dashboard | want the reasoning behind the design |

## Reading paths

- **Coach or therapist:**
  1. [Overview](project-overview.md)
  2. [Dashboard guide](dashboard-guide.md)
  3. [Metrics reference](metrics-reference.md), when a number needs explaining
- **Setting up a laptop:**
  1. [Setup and operations](setup-and-operations.md)
  2. [Dashboard guide → Troubleshooting](dashboard-guide.md#troubleshooting)
- **Developer:**
  1. [Overview](project-overview.md)
  2. [Architecture](architecture.md)
  3. [API reference](api-reference.md)
  4. [Metrics reference](metrics-reference.md)
  5. The component READMEs: [backend](../backend/README.md), [frontend](../frontend/README.md), [firmware](../firmware/README.md)
- **Firmware:**
  1. [Hub MQTT data scheme](hub-mqtt-data-scheme.md)
  2. [firmware/README.md](../firmware/README.md)
  3. [Setup → Simulator options](setup-and-operations.md#simulator-options), to compare against the reference hub

## Screenshots

All 15 screenshots are in [`screenshots/`](screenshots/). They were captured from the running system with the simulated hub, and are used in the [Dashboard guide](dashboard-guide.md) and the [root README](../README.md).

## Diagrams

The overview and architecture documents use [Mermaid](https://mermaid.js.org/) diagrams, which GitHub renders directly. In other viewers they appear as code blocks.
