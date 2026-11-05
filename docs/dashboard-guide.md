# Dashboard guide

A page-by-page guide for coaches and therapists. Every number on screen is explained in the [Metrics reference](metrics-reference.md); this guide covers what each part is for and how to use it.

**Contents:** [Signing in](#signing-in) · [Navigation](#navigation) · [Dashboard](#dashboard) · [Live session](#live-session) · [Body tracking](#body-tracking) · [Analysis](#analysis) · [Athletes](#athletes) · [Athlete profile](#athlete-profile) · [Devices](#devices) · [Phones and tablets](#phones-and-tablets) · [Troubleshooting](#troubleshooting)

---

## A typical session in five steps

1. **Athletes → Add athlete** to create the profile (once).
2. On the athlete's profile, **Consent → Record** a *Data* consent (once). Sessions are blocked without it.
3. **Live session:** pick the athlete and a protocol, then press **Start**. Optionally press **Start camera** in the Body tracking card first, to watch posture too.
4. Watch the targets, feed, balance and body tracking live. Press **Stop block** to end early, or **E-STOP** in an emergency.
5. Press **View analysis** for the full report, and check **Progress vs baseline** on the profile over the following weeks.

---

## Signing in

![Sign-in](screenshots/01-login.png)

Sign in with the coach or therapist account your admin created. *Show password* is the eye icon.

> **No sign-in on the coaching laptop:** with `SVS_OPEN_ACCESS=true` in `backend/.env`, the dashboard opens directly on that computer. The account menu then shows an **Open access** tag. Other devices on the network still have to sign in. See [Setup and operations](setup-and-operations.md#open-access-no-sign-in).

---

## Navigation

- **Top bar:** stays at the top as you scroll.
  - The **pill menu** switches pages: Dashboard · Live session · Body tracking · Analysis · Athletes · Devices. On tablets it shows icons only; hover to see each name.
  - **Camera on** (red dot) or **Simulation** (green dot) appears while body tracking is running, on every page. Click it to open Body tracking.
  - The **bell** shows the count of open warnings and critical alerts, and opens the Devices page.
  - The **avatar** shows your account and role, plus Sign out (or the Open access note).
- **Arrow buttons (↗)** in card headers open the related page.
- **Esc** or a click outside closes any menu or dialog.

---

## Dashboard

![Dashboard](screenshots/02-dashboard.png)

| Card | What it tells you |
|---|---|
| **Greeting line** | Date, number of athletes and how many hubs are online |
| **Hero (blue)** | Median reaction time and mean accuracy over the 20 most recent completed runs, and runs started in the last 7 days. The arrow opens Live session |
| **Skill overview** | For the athlete chosen in the dropdown, from their latest completed run:<br>• the **six-axis radar** (Speed, Accuracy, Consistency, Control, Symmetry, Periphery; 0–100, rules in the [reference](metrics-reference.md#skill-radar))<br>• median RT of their last runs vs their **baseline** (dashed line)<br>• **Coach insight**: rule-based training suggestions. The arrow opens that run's analysis |
| **Training activity** | Runs per day for the last 14 days (today highlighted in blue), and the **protocol mix** bar underneath |
| **Live station** | Hub status (*Online*, *Running* or *Offline*). During a block it shows the latest response and a live RT trace. When idle, it shows the last run's median and the target layout (lime = target ready). Bottom row: Wi-Fi signal, battery, targets ready |
| **Progress & goals** | An activity dot matrix for the last 3 weeks, and progress bars: weekly sessions (target 10), recent accuracy, athletes with data consent, hubs online |
| **Recent runs** | The latest 6 runs; click one to open its analysis |
| **Fastest reactions** | A leaderboard **within one protocol**, chosen in the dropdown. Bars show each median RT relative to the fastest (shorter RT = fuller bar) |
| **Schedule** | Calendar of days with runs: lime = 1–2 runs, blue = 3+, ring = today. Arrows move between months |

---

## Live session

![Live session during a block](screenshots/03-live-session-running.png)

**Before you start:**
1. **Athlete:** choose who is on the station. If data consent is missing you'll see an amber warning with a link to record it, and Start stays disabled.
2. **Protocol:** pick one of five (details in the [reference](metrics-reference.md#protocols)). The tag shows *assessment* (a repeatable measurement) or *training* (practice).
3. **Trials:** leave blank for the protocol default, or enter 1–64.
4. **Start:** the button names the protocol. If it's disabled, the hint beside it says why (*Hub offline*, *Choose an athlete* or *Data consent missing*).

**During the block:**
- **Targets arc:** the station's **6 touch-sensor targets, T1–T6**, drawn from the hub's own target list. The view is from behind the athlete, so T1 is on the athlete's left.
  - The **lit target pulses** in its cue colour: green = go, red = no-go.
  - On a touch it flashes the result colour: blue hit, amber wrong target, red no-go touch, orange early.
  - The number beside each target is its latest RT.
- **Progress:** *Trial n of N* and the progress bar.
- **KPI tiles:** last response, median of hits, accuracy and error count. These are computed live in the browser; the Analysis page is authoritative.
- **Response feed:** the newest result per trial, e.g. "Wrong target (touched T5)".
- **Balance:** a live centre-of-pressure dot with a trail, the load in kg, and medio-lateral and antero-posterior position in mm.
- **Wrist motion:** acceleration deviation from gravity. Each burst is a reach.
- **Body tracking** (bottom card):
  - the camera feed with the skeleton, beside live side lean, forward lean, knee bend and lateral sway
  - **Last touch:** the target, the hand used, trunk lean, knees and wrist speed at the moment of the touch
  - **Start camera** or **Simulated athlete** turns it on; ↗ opens the full [Body tracking](#body-tracking) page

**Stopping:**
- **Stop block** ends the block cleanly; the run is marked *aborted*.
- **E-STOP** (red, bottom right, always visible) turns all targets off immediately, even when no block is running from this page.
- After a block finishes, **View analysis** appears next to Start.

---

## Body tracking

![Body tracking with the simulated athlete during a block](screenshots/16-body-tracking.png)

A webcam watches the athlete. **MediaPipe Pose** runs inside the browser and draws a 33-point skeleton over the video, with the athlete's posture, joint angles and stability alongside. How every number is worked out is in the [Metrics reference](metrics-reference.md#body-tracking).

**Starting it:**
1. Put the webcam on a tripod **2.5–3.5 m in front of the athlete, at hip height**, with the whole body in frame.
2. Choose **Camera**, pick the webcam if there's more than one, and press **Start camera**. Allow camera access when the browser asks.
3. The first start downloads the pose model, about 6 MB; later starts are instant.
4. No webcam? Choose **Simulated athlete**. A software athlete stands on the board and reaches for whichever target the hub lights. With no block running, it reaches for demo targets and shows a *Demo motion* tag.

The camera keeps running when you switch pages; the top bar shows **Camera on**. Press **Stop** here or in the Live session card to turn it off.

| Card | What it shows |
|---|---|
| **Camera feed** | The video with the skeleton. **Blue = the athlete's left, lime = right.**<br>• **Trunk axis:** a solid line against a dashed vertical; it turns amber at 10° of side lean and red at 20°.<br>• **Base of support:** dashes under the feet, with a diamond for the hips; lime when centred, amber when outside.<br>• **Angle labels:** flexion at the elbows and knees.<br>• **Trails:** the hips, and the wrists while reaching.<br>Toggles: **Skeleton**, **Angles**, **Trails** and **Mirror**. Mirror is on by default, so the athlete's left is on the left, as on the target arc |
| **Posture now** | Side lean, forward lean (an estimate), shoulder tilt and hip tilt; stance width as a multiple of hip width; whether the hips are centred over the feet |
| **Joint angles** | Knee, hip, elbow and shoulder, left beside right. **Δ** marks a left–right difference of 15° or more |
| **Stability** | Lateral sway (RMS) and sway speed over the last 10 s, peak side lean and wrist speed. The chart shows the last 20 s of side lean (blue) and hip offset (green) against the ±10° lean flag |
| **Tracking quality** | How visible the body is, a checklist (head, shoulders, hips, knees, feet), and a framing tip such as *Feet are out of frame*. Model choice: **Lite** (fast) or **Full** (more accurate); also shows whether it runs on GPU or CPU, the model time per frame and the frame rate |
| **Posture at each touch** | One row per touch in the current block: target, result, **which hand reached**, side and forward lean, knee bend, peak wrist speed and RT. Matched live to the hub's events |
| **Privacy and setup** | Video stays on this computer. Frames and landmarks are **not recorded or uploaded**, so watching live needs no video consent. Camera placement tips |

> **Body tracking supports coaching; it isn't a measurement.** A single camera estimates angles, and forward lean is the least reliable. Use it to spot patterns (always reaching with one hand, leaning into one side), not for clinical values.

---

## Analysis

![Analysis report](screenshots/04-analysis-report.png)

**Blocks rail (top):**
- Recent blocks as cards: athlete, protocol, age, trial count and status. Scroll with the arrows.
- *Athlete runs* / *Include demo* toggles blocks that the simulator ran without an athlete.
- The selected card has a blue outline.

**Report header:** athlete · protocol, date and time, trial count, duration, **seed** (to repeat the exact sequence), status. Buttons: **Athlete profile**, **Refresh**, **Export CSV** (one row per trial; the header notes the protocol, seed and "not a diagnosis").

| Section | How to read it |
|---|---|
| **KPI tiles** | Median reaction (with mean and IQR), accuracy (hits / go trials), sensitivity d′ (only with no-go trials), consistency CV, false starts |
| **Trial by trial** | One dot per trial, its RT, coloured by result. A dashed ring marks an outlier, kept but excluded from the statistics. Hover for details |
| **Coach insight** | Rule-based suggestions from this block ([rules](metrics-reference.md#coach-insights)) |
| **RT distribution** | Valid hits in 50 ms bins; the bin holding the median is blue. p10 / median / p90 underneath |
| **Target heatmap** | Each target coloured by its median RT, lime (fastest) to orange (slowest), with the ms beside it. "no hits" means the target lit but was never hit correctly |
| **Where the time goes** | Decision vs movement split from the wrist IMU, left vs right side with the asymmetry %, and central / mid / peripheral bands. Lime marks the fastest group |
| **Balance during the block** | The CoP path plus mean velocity, path length, 95 % ellipse area, RMS ML/AP and mean load. "Nobody was standing on the board" means the load was under 10 kg |
| **Trials** | Every trial, including invalid ones: target, cue, result, RT, decision, movement, the target actually touched |

> **Results appear in two stages.** While a block is running, results come from the events only. Decision time and balance fill in once the block ends. The summary is finalised about 15 s after the end, once the last sensor data is on disk.

---

## Athletes

![Athletes](screenshots/05-athletes.png)

- **Summary tiles:** number of athletes, data consent on file, athletes active this week, and the median of each athlete's latest RT.
- **Athlete cards:**
  - name, code, sport and position, plus a consent badge
  - latest RT, accuracy and completed/total runs
  - a **trend line** of recent median RTs, and the latest protocol with how long ago it ran
- **Search:** filters by name or code as you type.
- **Add athlete:**

![Add athlete](screenshots/08-add-athlete-dialog.png)

Only *Group* is required. A blank name uses the generated code (`ATH-000n`), and a birth year under 18 years ago (or the *child* group) marks the athlete as a minor, which requires a guardian on consent.

---

## Athlete profile

![Athlete profile](screenshots/06-athlete-profile.png)

| Section | Use |
|---|---|
| **KPI tiles** | Latest median RT and accuracy, decision time, completed runs, consent status |
| **Progress vs baseline** | Median RT per completed run for the selected protocol tab. The dashed line is the **baseline**: the mean of the first two completed runs with enough valid hits. Hover a point for its accuracy and % change vs baseline. Change stays *unverified* until reliability has been measured |
| **Consent** | Tiles for Data (required), Video and Research (optional), and the history below. **Record** adds a consent: a new one of the same type supersedes the old one, and minors need a guardian. **Withdraw** ends it; staff, the athlete or a linked guardian can withdraw |
| **Runs** | Every run with status, trial count, median RT, accuracy, d′ and decision time. Click a row for its analysis |
| **Profile** | Handedness, footedness, birth year, visual correction, goals. **Edit** changes them; **Export data** downloads everything held about the athlete as JSON |
| **Start session** | Opens Live session with this athlete preselected (disabled without data consent) |

---

## Devices

![Devices](screenshots/07-devices.png)

| Section | What to check |
|---|---|
| **KPI tiles** | Gateway connection and message count; events stored and duplicates dropped; sensor samples streamed and Parquet files; lost messages (gap reports); rejected (malformed) messages. Counts run *since gateway start* |
| **Hubs** | Per hub: battery ring, online dot, station, firmware, boot ID, last seen, IP/SSID/signal, target chips T1–T6 (blue = OK, red = offline) and sensor streams. **Ping** checks the round trip. The summary row shows hubs online, targets ready, sensor streams and longest uptime |
| **Connect a hub** | The `IP:1883` address a hub on the same Wi-Fi should use, the mDNS name, and the clock-sync quality per hub (± uncertainty in ms, drift in ppm) |
| **Alerts** | Newest first. *Info* items (online, resumed) need no action; resolve *warning* and *critical* ones once handled. Kinds are listed in [Setup and operations](setup-and-operations.md#alerts) |

---

## Phones and tablets

The dashboard works on any screen. On a tablet, cards pair up two per row; on a phone they stack, and the menu scrolls sideways.

| Tablet | Phone |
|---|---|
| <img src="screenshots/09-dashboard-tablet.png" width="420" alt="Tablet"> | <img src="screenshots/10-dashboard-phone.png" width="200" alt="Phone dashboard"> <img src="screenshots/13-live-session-phone.png" width="200" alt="Phone live session"> <img src="screenshots/17-body-tracking-phone.png" width="200" alt="Phone body tracking"> |

The camera only opens on a secure page: on the laptop itself (`localhost`) or over https. A phone on the Wi-Fi can view the other pages, but it can't open its own camera over plain http.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| **Start is disabled** | Read the hint next to it: hub offline, no athlete selected, or no data consent |
| **"Hub offline"** | Hub not powered or not on Wi-Fi, or the broker isn't running. On Devices, check *Connect a hub*; for real hardware, the laptop firewall must allow TCP 1883 |
| **Start → "Hub rejected the block"** | The hub is already running a block (stop it first), or the plan names a target it doesn't have |
| **Start → timeout (504)** | The hub didn't acknowledge within 3 s. Check its Wi-Fi signal on Devices |
| **Decision time / balance shows "–"** | No wrist IMU or balance stream during the block, or the block finished seconds ago. Press Refresh after ~15 s |
| **A run stays "Running"** | It finishes when the hub sends `block_done`; if the hub went silent, the run is closed as aborted after 5 min |
| **Lost messages > 0** | Weak Wi-Fi. Timing events are re-sent where possible; sensor gaps only affect sway and onset for the affected seconds |
| **Blank page after an update** | Hard-refresh the browser (Ctrl+F5). The error panel's **Retry** re-renders a section that failed |
| **"Camera access was blocked"** | Allow the camera for this site (the camera icon in the address bar), then press Start camera again |
| **"No camera found" / "camera is busy"** | Plug in the webcam, or close the other app using it (video calls) |
| **"Couldn't load the pose model"** | The first start downloads it from Google; check the internet connection. For offline use see [Setup and operations](setup-and-operations.md#body-tracking-camera) |
| **Skeleton jumps or vanishes** | Follow the tip on the feed: whole body in frame, even light, plain background. Try the **Full** model on a fast laptop |
