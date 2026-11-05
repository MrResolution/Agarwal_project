# Metrics reference

How every number on the dashboard is calculated. The scoring lives in `backend/svs/analysis/`. The skill radar and coach insights are display rules in `frontend/src/lib.ts`. Everything below is taken from that code.

**Contents:** [Protocols](#protocols) · [Target layout](#target-layout) · [Trial classification](#trial-classification) · [Reaction-time statistics](#reaction-time-statistics) · [Accuracy and error rates](#accuracy-and-error-rates) · [Sensitivity d′](#sensitivity-d) · [Side and band comparisons](#side-and-band-comparisons) · [Decision and movement time](#decision-and-movement-time) · [Balance](#balance) · [Skill radar](#skill-radar) · [Coach insights](#coach-insights) · [Baselines and trends](#baselines-and-trends) · [Dashboard aggregates](#dashboard-aggregates)

---

## Protocols

| Key | Name | Kind | Trials | Foreperiod | Window | ITI | No-go | Targets |
|---|---|---|---|---|---|---|---|---|
| `simple_rt` | Simple reaction | assessment | 20 | 1000–2500 ms | 1500 ms | 600 ms | 0 % | Centre only (T4) |
| `choice_rt` | Choice reaction | assessment | 24 | 1000–2500 ms | 1500 ms | 600 ms | 0 % | All 8 |
| `go_nogo` | Go / No-Go | assessment | 30 | 1000–2500 ms | 1500 ms | 600 ms | 25 % (8 trials) | All 8 |
| `peripheral` | Peripheral response | training | 24 | 1000–2500 ms | 1500 ms | 600 ms | 0 % | Peripheral band (T1, T2, T7, T8) |
| `speed_drill` | Speed drill | training | 30 | 600–1400 ms | 900 ms | 400 ms | 0 % | All 8 |

- **Foreperiod:** a random wait before the LED comes on, drawn uniformly from the range for every trial.
- **Window:** how long the athlete has to respond once the LED is on.
- **ITI:** the inter-trial interval, the pause after the LED goes off.
- **Overrides:** a run can override `n_trials`, `foreperiod_ms`, `window_ms`, `iti_ms`, `nogo_ratio` and `targets`. Other keys are ignored. The dashboard only exposes the trial count (1–64).
- **Peripheral** is peripheral-response *training*: it is not a fixation-controlled visual-field test.

### How a trial plan is generated

A plan is fully determined by **(protocol, parameters, seed)**, so any block can be regenerated exactly. The seed is random unless one is given, and it's stored on the run.

1. Each eligible target appears equally often, as far as the trial count allows.
2. The order is shuffled, then reshuffled (up to 200 times) until **no target appears more than 3 times in a row**.
3. No-go trials (`round(n_trials × nogo_ratio)`) are spread at random, **never on the first trial**. They are shown red; go trials are green.
4. Each trial gets its own foreperiod from the range.

---

## Target layout

Until per-device calibration exists, targets sit on a horizontal arc from −70° (left) to +70° (right), alternating upper and lower rows. With 8 targets:

| Target | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 |
|---|---|---|---|---|---|---|---|---|
| Angle | −70° | −50° | −30° | −10° | +10° | +30° | +50° | +70° |
| Side | left | left | left | left | right | right | right | right |
| Band | peripheral | peripheral | mid | central | central | mid | peripheral | peripheral |
| Row | upper | lower | upper | lower | upper | lower | upper | lower |

- **Side:** *centre* for targets less than 10° from straight ahead (none in the 8-target layout), otherwise left or right.
- **Band** (eccentricity): central < 20°, mid 20–45°, peripheral ≥ 45°.

---

## Trial classification

Each trial that reached the hub is given exactly one result. The rules are checked in order and the **first match wins**:

| # | Condition | Result | Dashboard label | Colour |
|---|---|---|---|---|
| 1 | A `false_start` event during the foreperiod | `false_start` | False start | orange |
| 2 | Response with RT < **100 ms** | `anticipation` | Anticipation | orange |
| 3 | Response on a no-go (red) trial | `false_alarm` | No-go press | red |
| 4 | Response on a different target | `wrong_target` | Wrong target | amber |
| 5 | Response on the lit target | `hit` | Hit | blue |
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
| Commission rate | no-go presses / no-go trials | Coach insight |
| **False-start rate** | (false starts + anticipations) / scored trials | KPI tile (as a count), Control axis |

Wrong-target responses count against accuracy (they are go trials without a hit).

---

## Sensitivity d′

Only for blocks with no-go trials (Go / No-Go, or a custom `nogo_ratio`). It measures how well the athlete separates *go* from *no-go*, independent of how willing they are to press.

```
H  = (hits + 0.5)         / (go trials + 1)        ← log-linear correction:
FA = (no-go presses + 0.5) / (no-go trials + 1)       avoids infinite z for 0 % or 100 %
d′ = z(H) − z(FA)
c  = −(z(H) + z(FA)) / 2                            ← criterion (bias), API only
```

`z` is the inverse of the standard normal CDF. Rough guide: d′ ≈ 0 means no discrimination; higher is better. A **positive c** means a cautious responder (presses less), a **negative c** an impulsive one.

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
