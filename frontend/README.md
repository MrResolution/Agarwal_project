# Frontend: coach dashboard

React 18 + TypeScript + Vite, with charts built from plain SVG (no chart library). It talks only to the backend API, proxied at `/api`, and its live WebSocket.

## Run

The backend must be running first (broker, then API + gateway; see [`../backend/README.md`](../backend/README.md)). Then:

```bash
npm install
npm run dev
```

Open the URL Vite prints (default http://localhost:5173; it uses the next free port if that one is taken). Sign in with a coach, therapist or admin account. The API is expected on `http://127.0.0.1:8000`; set `SVS_API` to point elsewhere.

Other commands: `npm run typecheck`, and `npm run build` (static files in `dist/`).

## Pages

| Page | What it does |
|---|---|
| **Dashboard** | Hero stats (recent median RT, accuracy, runs this week). **Skill overview** for a chosen athlete: six-axis radar, median RT for the last runs vs. baseline, and rule-based coach insights. Also training activity, a calendar of session days, a live station card (latest RT, signal, battery, targets), progress & goals, recent runs and fastest reactions |
| **Live session** | Pick athlete + protocol (consent is checked) → **Start**. The target arc lights the active target and flashes each response by result. Shows trial progress, a live response feed with classification, live centre-of-pressure dot and trail, and wrist-motion trace. **Stop block** and an always-visible **E-STOP** |
| **Analysis** | Per block: KPIs (median RT, accuracy, d′, CV, false starts), trial-by-trial strip, RT histogram, **target heatmap** (median RT by position), decision vs movement split (IMU), left/right asymmetry and central/peripheral bands, balance sway metrics with the CoP path, the full trial table, coach insights and **CSV export** |
| **Athletes** | List and search, add/edit profiles. The profile page has progress vs baseline per protocol, consent (record / withdraw; guardian required for minors), run history and a data export |
| **Devices** | Gateway stats (events, samples, duplicates, gaps, rejects), hubs with battery, IP/SSID/RSSI, targets and sensors, how to connect a hub, clock-sync quality per hub, and alerts with resolve |

## Notes

- The **skill radar** uses transparent rules, shown when you hover the radar (e.g. Speed: median RT 220 ms = 100, 650 ms = 0). It is a training aid, not a validated composite score (research doc §6).
- **Coach insights** are rule-based and explainable (asymmetry ≥ 6 %, peripheral cost > 40 ms, false starts ≥ 10 %, etc.; see `src/lib.ts`).
- Server timestamps are UTC; the UI shows local time. Day buckets on the dashboard use the browser's timezone.
- There is no athlete/parent view yet. Those roles see a short notice after signing in.
