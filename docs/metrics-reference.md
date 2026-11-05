# Metrics reference

How every number on the dashboard is calculated. The scoring lives in `backend/svs/analysis/`. The skill radar and coach insights are display rules in `frontend/src/lib.ts`, and body tracking is computed in the browser by `frontend/src/pose/`. Everything below is taken from that code.

**Contents:** [Protocols](#protocols) · [Target layout](#target-layout) · [Trial classification](#trial-classification) · [Reaction-time statistics](#reaction-time-statistics) · [Accuracy and error rates](#accuracy-and-error-rates) · [Sensitivity d′](#sensitivity-d) · [Side and band comparisons](#side-and-band-comparisons) · [Decision and movement time](#decision-and-movement-time) · [Balance](#balance) · [Body tracking](#body-tracking) · [Skill radar](#skill-radar) · [Coach insights](#coach-insights) · [Baselines and trends](#baselines-and-trends) · [Dashboard aggregates](#dashboard-aggregates)

---

## Protocols

The station has **6 touch-sensor targets** (T1–T6). Trial counts and target choices below are for that station.

| Key | Name | Kind | Trials | Foreperiod | Window | ITI | No-go | Targets |
|---|---|---|---|---|---|---|---|---|
| `simple_rt` | Simple reaction | assessment | 20 | 1000–2500 ms | 1500 ms | 600 ms | 0 % | Centre only (T3) |
| `choice_rt` | Choice reaction | assessment | 24 | 1000–2500 ms | 1500 ms | 600 ms | 0 % | All 6 (4 trials each) |
| `go_nogo` | Go / No-Go | assessment | 30 | 1000–2500 ms | 1500 ms | 600 ms | 25 % (8 trials) | All 6 (5 trials each) |
| `peripheral` | Peripheral response | training | 24 | 1000–2500 ms | 1500 ms | 600 ms | 0 % | Outer targets: T1, T2, T5, T6 (6 trials each) |
| `speed_drill` | Speed drill | training | 30 | 600–1400 ms | 900 ms | 400 ms | 0 % | All 6 (5 trials each) |

- **Foreperiod:** a random wait before the LED comes on, drawn uniformly from the range for every trial.
- **Window:** how long the athlete has to respond once the LED is on.
- **ITI:** the inter-trial interval, the pause after the LED goes off.
- **Overrides:** a run can override `n_trials`, `foreperiod_ms`, `window_ms`, `iti_ms`, `nogo_ratio` and `targets`. Other keys are ignored. The dashboard only exposes the trial count (1–64).
- **Peripheral** is peripheral-response *training*: it is not a fixation-controlled visual-field test. It uses every target **outside the central band** (`targets: "peripheral"`), because on a 6-target arc the ≥ 45° band alone would leave only T1 and T6.

### How a trial plan is generated

A plan is fully determined by **(protocol, parameters, seed)**, so any block can be regenerated exactly. The seed is random unless one is given, and it's stored on the run.

1. Each eligible target appears equally often, as far as the trial count allows.
2. The order is shuffled, then reshuffled (up to 200 times) until **no target appears more than 3 times in a row**.
3. No-go trials (`round(n_trials × nogo_ratio)`) are spread at random, **never on the first trial**. They are shown red; go trials are green.
4. Each trial gets its own foreperiod from the range.

---

## Target layout

Each target is an LED ring with a **touch sensor**. Until per-device calibration exists, targets sit evenly on a horizontal arc from −70° (left) to +70° (right), alternating upper and lower rows. With the station's 6 targets:

| Target | T1 | T2 | T3 | T4 | T5 | T6 |
|---|---|---|---|---|---|---|
| Angle | −70° | −42° | −14° | +14° | +42° | +70° |
| Side | left | left | left | right | right | right |
| Band | peripheral | mid | central | central | mid | peripheral |
| Row | upper | lower | upper | lower | upper | lower |

- **Side:** *centre* for targets less than 10° from straight ahead (none on the 6-target arc), otherwise left or right.
- **Band** (eccentricity): central < 20°, mid 20–45°, peripheral ≥ 45°.
- **Target count:** the hub reports its targets in every status heartbeat. Plans and the analysis layout use that count, so a hub with a different number of targets still works.
- **Older blocks:** blocks recorded on a larger station keep their own layout. The analysis uses the highest target number seen in the block if it's more than the hub reports.

---

## Trial classification

Each trial that reached the hub is given exactly one result. The rules are checked in order and the **first match wins**:

| # | Condition | Result | Dashboard label | Colour |
|---|---|---|---|---|
| 1 | A `false_start` event (a touch during the foreperiod) | `false_start` | False start | orange |
| 2 | Response with RT < **100 ms** | `anticipation` | Anticipation | orange |
| 3 | Touch on a no-go (red) trial | `false_alarm` | No-go touch | red |
| 4 | Touch on a different target | `wrong_target` | Wrong target | amber |
| 5 | Touch on the lit target | `hit` | Hit | blue |
| 6 | No response on a no-go trial, trial completed | `correct_rejection` | Correct no-go | lime |
| 7 | No response on a go trial, trial completed | `miss` | Miss | grey |
| 8 | Trial never completed (block stopped mid-trial) | `invalid` | Invalid | light grey |

- **RT** = `response.t_us − stimulus_on.t_us`, both taken on the hub's clock (see [Project overview](project-overview.md#key-ideas)).
- **Completed** means the hub sent `stimulus_off`. A trial whose foreperiod never ended (block stopped first) has no `stimulus_on` and isn't counted at all.
- **Outliers:** with at least 5 hits, a hit more than **3 robust SDs** from the median hit RT (robust SD = 1.4826 × MAD) is marked `excluded = "outlier"`. It stays in the trial table and the trial chart (dashed ring), keeps its *hit* result for accuracy, but is left out of the RT statistics.
- **Quality:** a block with fewer than **5 valid hits** (hits that aren't outliers) is marked `insufficient_data`. It's still shown, with a warning, but is left out of leaderboards and baselines.

---

## Reaction-time statistics

Computed from **valid hits** only (hits, outliers excluded).

| Statistic | Definition |
|---|---|
| Median | Middle value. **The headline RT everywhere on the dashboard** (robust to the odd slow trial) |
| Mean, SD | Arithmetic mean and sample standard deviation |
| IQR | p75 − p25 (linear interpolation) |
| MAD | Median absolute deviation from the median |
| CV | SD / mean: the consistency measure (lower = more consistent) |
| p10, p90 | 10th and 90th percentiles |
| Min, max | Fastest and slowest valid hit |

**RT distribution:** valid hits in 50 ms bins from 100 to 1000 ms. Values outside that range are counted in the first or last bin.

**Target heatmap:** each target's median valid-hit RT, coloured on a scale running from the fastest to the slowest target **in that block** (lime → blue → orange). Targets that lit but were never hit correctly show "no hits".

---

## Accuracy and error rates

*Go trials* and *no-go trials* exclude invalid trials. *Scored trials* are all trials except invalid ones.

| Metric | Formula | Shown as |
|---|---|---|
| **Accuracy** | hits / go trials | KPI tile, lists, trends |
| Overall accuracy | (hits + correct rejections) / scored trials | API only |
| Omission rate | misses / go trials | API only |
| Commission rate | no-go touches / no-go trials | Coach insight |
| **False-start rate** | (false starts + anticipations) / scored trials | KPI tile (as a count), Control axis |

Wrong-target responses count against accuracy (they are go trials without a hit).

---

## Sensitivity d′

Only for blocks with no-go trials (Go / No-Go, or a custom `nogo_ratio`). It measures how well the athlete separates *go* from *no-go*, independent of how willing they are to touch.

```
H  = (hits + 0.5)         / (go trials + 1)        ← log-linear correction:
FA = (no-go touches + 0.5) / (no-go trials + 1)       avoids infinite z for 0 % or 100 %
d′ = z(H) − z(FA)
c  = −(z(H) + z(FA)) / 2                            ← criterion (bias), API only
```

`z` is the inverse of the standard normal CDF. Rough guide: d′ ≈ 0 means no discrimination; higher is better. A **positive c** means a cautious responder (touches less), a **negative c** an impulsive one.

---

## Side and band comparisons

- **Left / right:** median valid-hit RT for targets on each side.
- **Asymmetry index** = (right − left) / ((right + left) / 2) × 100 %. **Positive = right side slower.**
- **Bands:** median valid-hit RT for central, mid and peripheral targets. The *Where the time goes* card marks the fastest group in lime.

These are only defined when the block used targets in both groups (e.g. not for Simple reaction, which uses T4 only).

---

## Decision and movement time

The wrist IMU splits each response into **decision (pre-motor) time**, from stimulus to movement onset, and **movement time**, from onset to hit.

**Movement-onset detection**, per hit or wrong-target trial:

1. **Resting vector:** the mean acceleration over the **200 ms before the stimulus**, so the method works whichever way the sensor is strapped on.
2. **Signal:** each sample's distance from that resting vector, in m/s².
3. **Threshold:** the larger of *baseline mean + 4 × baseline SD* and *baseline mean + 0.35 m/s²*. The 0.35 floor stops a very still baseline from triggering on noise.
4. **Onset:** the first of **2 consecutive samples** above the threshold, between the stimulus and the response.

No onset (or fewer than 3 baseline samples) leaves both values empty for that trial. The block summary uses valid hits only.

- **When it's computed:** only once the block has finished (done or aborted), reading the IMU stream from 1 s before the first event to 1 s after the last.
- **No wrist IMU:** if no IMU stream was recorded, decision and movement time show "–".

---

## Balance

From the 4-corner balance board (front-left, front-right, back-left, back-right, in kg), with load-cell spacing 360 × 360 mm:

```
W     = fl + fr + bl + br
CoP_x = 180 × ((fr + br) − (fl + bl)) / W    ← medio-lateral (ML), + = right
CoP_y = 180 × ((fl + fr) − (bl + br)) / W    ← antero-posterior (AP), + = front
```

1. **Load filter:** samples with W < **10 kg** are dropped (nobody standing). With fewer than 10 loaded samples, the card shows "Nobody was standing on the board".
2. **Smoothing:** CoP is smoothed with a 5-sample centred moving average (zero phase).
3. **Metrics** over the block's time span (first to last event):

| Metric | Definition |
|---|---|
| Mean velocity | Path length / duration, in mm/s. **The headline sway number** |
| Path length | Total distance the CoP travelled, in mm |
| 95 % ellipse area | π × 5.991 × √(λ₁λ₂) mm², from the eigenvalues of the CoP covariance |
| RMS ML / AP | Root-mean-square distance from the mean CoP, per axis |
| Range ML / AP | Max − min per axis (API only) |
| Mean load | Mean W, in kg |

The **live** balance panel uses the same CoP formula in the browser, without smoothing, for display only.

---

## Body tracking

The camera view runs **MediaPipe Pose Landmarker** in the browser. Each frame gives 33 landmarks, as normalised image positions and as metric "world" positions in metres centred on the hips. Code: `frontend/src/pose/metrics.ts` and `tracker.ts`.

- **Visible:** a landmark is used only when MediaPipe's visibility is at least **0.5**.
- **Live only:** nothing here is stored. Frames and landmarks stay in the browser.
- **Estimates:** these are training-aid numbers from a single 2-D camera, not motion-capture measurements.

**Joint angles** come from the 3-D world landmarks, so they don't depend much on where the camera stands:

| Metric | Definition |
|---|---|
| Knee flexion | 180° − angle(hip, knee, ankle). 0° = straight leg |
| Hip flexion | 180° − angle(shoulder, hip, knee). 0° = trunk and thigh in line |
| Elbow flexion | 180° − angle(shoulder, elbow, wrist). 0° = straight arm |
| Shoulder elevation | angle(hip, shoulder, elbow). 0° = arm by the side, 90° = horizontal |
| Left–right difference (Δ) | \|left − right\| per joint; **15° or more** is flagged amber |

**Trunk and pelvis:**
- **Trunk vector:** from mid-hip to mid-shoulder.
- **Lateral axis:** right hip → left hip, kept horizontal.
- **Forward axis:** at right angles to the lateral axis and vertical.

| Metric | Definition |
|---|---|
| Side lean | Angle of the trunk vector from vertical, towards the lateral axis. **+ = towards the athlete's left.** Amber at **10°**, red at **20°** (a possible loss of balance) |
| Forward lean | The same, towards the forward axis. Labelled an *estimate*, because depth is MediaPipe's weakest axis |
| Shoulder tilt, hip tilt | Height difference between the left and right joint, as an angle. + = left side higher |
| Stance | Ankle width / hip width (horizontal distances) |
| Centred over feet | Whether the mid-hip point lies between the ankles in the image |

**Movement** uses image positions, converted to metres by the athlete's own shoulder width: the world shoulder distance in metres ÷ the image distance in pixels, smoothed.

| Metric | Definition |
|---|---|
| Lateral sway (RMS) | RMS of the mid-hip's horizontal position about its mean, over the last **10 s**, in cm |
| Sway speed | Horizontal path length of the mid-hip ÷ duration, last 10 s, in cm/s |
| Hip offset (chart) | The mid-hip's horizontal distance from its 10 s mean, in cm. + = towards the athlete's left |
| Peak side lean | Largest absolute side lean in the last 10 s |
| Wrist speed | Frame-to-frame wrist movement × scale ÷ time, smoothed, in m/s |

**Posture at each touch:** the tracker listens to the hub's live events.
- From each `stimulus_on`, it adds up how far each wrist moves.
- At the `response`, it records:
  - **hand:** the wrist that travelled further (blank if neither moved more than 2 cm)
  - side lean, forward lean and mean knee flexion at that moment
  - the peak speed of that hand
  - the RT from the hub's own timestamps
- The result label uses the same first-pass rules as the Live page, so the Analysis page stays authoritative.
- **Timing:** camera frames are matched to hub events by arrival time in the browser, so the snapshot is within roughly one frame and the network delay (tens of ms) of the touch. It's not time-synchronised like the IMU.

**Framing check:** in priority order, the first failing check is shown:
1. No pose found
2. Feet out of frame
3. Head cut off
4. Shoulders or hips hidden
5. Mean visibility of the 12 main joints below **70 %**

---

## Skill radar

The dashboard's six-axis radar puts the athlete's **latest completed run** on simple 0–100 scales. These scales are **display conventions, not norms**: they make the shape readable, and the thresholds are deliberately easy to explain.

| Axis | Input | 100 | 0 | Formula (clamped to 0–100) |
|---|---|---|---|---|
| Speed | Median RT | ≤ 220 ms | ≥ 650 ms | 100 − (median − 220) / 4.3 |
| Accuracy | Hits / go trials | 100 % | 0 % | accuracy × 100 |
| Consistency | RT CV | 0 | ≥ 0.4 | 100 − CV × 250 |
| Control | False-start rate | 0 % | ≥ 25 % | 100 − rate × 400 |
| Symmetry | \|Asymmetry index\| | 0 % | ≥ 25 % | 100 − \|AI\| × 4 |
| Periphery | Peripheral − central median RT | 0 ms | ≥ 200 ms | 100 − gap / 2 |

An axis with no input (e.g. Symmetry after Simple reaction) is left empty.

---

## Coach insights

Plain-language suggestions generated from a block by fixed rules, so every one can be traced back to a number. All the rules that apply are shown:

| Trigger | Message (summary) |
|---|---|
| Quality is `insufficient_data` (< 5 valid hits) | Results are indicative; repeat the block |
| \|Asymmetry\| ≥ **6 %** | Named side is slower by *n* ms; add choice drills on that side |
| Peripheral − central median > **40 ms** | Peripheral targets cost *n* ms more; the peripheral protocol trains this |
| False-start rate ≥ **10 %** | Too many early starts; lengthen and vary the foreperiod |
| Commission rate ≥ **25 %** | Response inhibition is limiting; slow down, prioritise accuracy |
| RT CV ≥ **0.20** | High variability; consistency work before speed work |
| Decision and movement both available | Decision share > **60 %** → train cue recognition; otherwise → work on reach efficiency and starting posture |
| Balance OK and sway velocity > **25 mm/s** | Stability drops under reaction load |
| None of the above | Balanced profile; progress one difficulty dimension (speed, targets or no-go ratio) |

The dashboard's Skill overview card shows the insights for the athlete's latest completed run; the Analysis page shows them for the selected block.

---

## Baselines and trends

The athlete profile's **Progress vs baseline** chart (`GET /athletes/{id}/trends`):

- **One series per protocol.** Runs from different protocols are never mixed.
- **Points:** completed (`done`) runs with a cached summary, oldest first. Aborted and failed runs are left out.
- **Baseline:** the mean median RT (and mean accuracy) of the **first two completed runs with quality `ok`** for that protocol. It's the athlete's own reference, not a population norm.
- **Change** for every point: (median RT − baseline) / baseline × 100 %. **Negative = faster than baseline.**
- **Change status: `unverified`.** The system can't yet tell a real change from normal day-to-day variation. That needs test-retest reliability (ICC) and a minimal detectable change (MDC) per protocol, which is planned. Until then, treat small changes as noise.

---

## Dashboard aggregates

| Number | Definition |
|---|---|
| Hero: median reaction | Median of the median RTs of the **20 most recent completed runs** |
| Hero: mean accuracy | Mean accuracy of the 20 most recent completed runs that have one |
| Runs this week | Runs started in the last 7 days, any status |
| Training activity | Runs per day for the last 14 days, bucketed by **your browser's local date** |
| Fastest reactions | Per protocol: each athlete's **latest** completed run with quality `ok`, sorted by median RT |
| Athletes list: latest RT | Median RT of the athlete's latest completed run; the trend line shows up to the last 10 |
| Live KPIs (Live session page) | Computed in the browser from the live event feed (stimulus → response). **The Analysis page is authoritative** |

**Just-finished runs:** a run's summary is cached about 15 s after the block ends. Until then, lists and rankings use the live analysis, so a run appears straight away.
