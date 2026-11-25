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
| **Live session** | Pick athlete + protocol (consent is checked) → **Start**. The target arc (the hub's 6 touch-sensor targets) lights the active target and flashes each touch by result. Shows trial progress, a live response feed with classification, live centre-of-pressure dot and trail, wrist-motion trace, and a **Body tracking** card (camera + skeleton, live posture, posture at the last touch). **Stop block** and an always-visible **E-STOP** |
| **Body tracking** | Webcam feed with a **33-point skeleton** from MediaPipe Pose, running in the browser (`src/pose/`). Live side/forward lean, shoulder and hip tilt, joint angles left vs right, 10 s sway and wrist speed with a 20 s chart, a framing checklist, Lite/Full model choice, and the **posture at each touch** of the running block (hand used, lean, knees, wrist speed). A **simulated athlete** source works without a camera. Video is never recorded or uploaded |
| **Analysis** | Per block: KPIs (median RT, accuracy, d′, CV, false starts), trial-by-trial strip, RT histogram, **target heatmap** (median RT by position), decision vs movement split (IMU), left/right asymmetry and central/peripheral bands, balance sway metrics with the CoP path, the full trial table, coach insights and **CSV export** |
| **Athletes** | List and search, add/edit profiles. The profile page has progress vs baseline per protocol, consent (record / withdraw; guardian required for minors), run history and a data export |
| **Devices** | Gateway stats (events, samples, duplicates, gaps, rejects), hubs with battery, IP/SSID/RSSI, targets and sensors, how to connect a hub, clock-sync quality per hub, and alerts with resolve |

## Layout and motion

- **Full-bleed layout** with a sticky, blurred top bar; the pill navigation has an indicator that slides to the active page.
- **Responsive grid:** 12 columns on desktop. At 1200 px and below, cards are full width unless marked `t-6`, which pairs them two per row; dense packing fills any holes, so no row is left half-empty. KPI tiles wrap and stretch to fill each line. Below 760 px everything stacks in one column.
- **Animation:**
  - cards and KPI tiles rise in one after another, and pages fade in
  - numbers count up; lines draw in; bars, dots and the radar grow in; gauges sweep
  - the live target pulses, and the feed and toasts slide in
  - all motion is switched off when the OS setting `prefers-reduced-motion` is on
- **Robustness:**
  - an error boundary around each page and the two live dashboard cards, so one failing widget can't blank the screen
  - loading skeletons shaped like the content they replace
  - charts measure their container before first paint, so they never jump or overflow
  - menus and dialogs close on Escape or an outside click

## Notes

- The **skill radar** uses transparent rules, shown when you hover the radar (e.g. Speed: median RT 220 ms = 100, 650 ms = 0). It is a training aid, not a validated composite score (research doc §6).
- **Coach insights** are rule-based and explainable (asymmetry ≥ 6 %, peripheral cost > 40 ms, false starts ≥ 10 %, etc.; see `src/lib.ts`).
- Server timestamps are UTC; the UI shows local time. Day buckets on the dashboard use the browser's timezone.
- There is no athlete/parent view yet. Those roles see a short notice after signing in.
- **Body tracking:**
  - `@mediapipe/tasks-vision` is pinned at 0.10.35 and loaded lazily.
  - Its wasm runtime is served from `node_modules` by a small plugin in `vite.config.ts`, at `/mediapipe/wasm/`.
  - The pose model downloads from Google's model storage the first time, unless a copy is placed in `public/models/` (see [Setup and operations](../docs/setup-and-operations.md#body-tracking-camera)).
  - The camera needs `localhost` or https.
