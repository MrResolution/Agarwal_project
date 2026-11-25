// Body tracking engine: camera (MediaPipe Pose Landmarker, in the browser) or the simulated athlete.
// One tracker lives for the whole app, so the camera keeps running when you switch pages; every
// mounted <PoseCanvas> is redrawn each frame, and React gets a throttled snapshot (8 Hz).
//
// Privacy: frames and landmarks never leave this browser. Nothing is recorded or uploaded.
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { DEFAULT_TARGETS } from "../lib";
import { drawPose, type Overlay, type Trails } from "./draw";
import type { P2, PoseFrame } from "./landmarks";
import { computeMetrics, guidance, type Guidance, type PoseMetrics } from "./metrics";
import { SimAthlete } from "./simulator";

export type Source = "camera" | "sim";
export type Status = "idle" | "starting" | "loading" | "running" | "error";
export type ModelKind = "lite" | "full";

export interface HistoryPoint { t: number; lean: number | null; forward: number | null; offsetCm: number | null; knee: number | null }
export interface Stability { swayRmsCm: number | null; swaySpeedCms: number | null; peakLean: number | null; seconds: number }
export interface ResponsePosture {
  key: string; trialNo: number; target: string; touched: string | null; result: string; hand: "L" | "R" | null;
  lean: number | null; forward: number | null; knee: number | null; peakSpeed: number | null; rtMs: number | null;
}
export interface CameraInfo { deviceId: string; label: string }

export interface Snapshot {
  source: Source | null; status: Status; message: string | null; error: string | null;
  fps: number | null; inferenceMs: number | null; delegate: "GPU" | "CPU" | null; model: ModelKind;
  frameSize: { w: number; h: number } | null; cameraLabel: string | null;
  metrics: PoseMetrics | null; guidance: Guidance; tracked: boolean;
  history: HistoryPoint[]; stability: Stability; wristSpeed: { L: number | null; R: number | null };
  responses: ResponsePosture[]; blockId: string | null; lit: string | null; overlay: Overlay; demo: boolean;
}

const WASM_BASE = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_FILE = (k: ModelKind) => `pose_landmarker_${k}.task`;
const MODEL_REMOTE = (k: ModelKind) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${k}/float16/1/${MODEL_FILE(k)}`;
const HISTORY_MS = 20_000, SWAY_MS = 10_000, EMIT_MS = 125;
const OVERLAY_KEY = "svs.pose.overlay";

class ModelError extends Error {}

/** Use a model file in frontend/public/models/ if one was put there (offline use), else Google's. */
async function resolveModel(k: ModelKind): Promise<string> {
  const local = `${import.meta.env.BASE_URL}models/${MODEL_FILE(k)}`;
  try {
    const r = await fetch(local, { method: "HEAD" });
    if (r.ok && !(r.headers.get("content-type") ?? "").includes("text/html")) return local;
  } catch { /* fall through */ }
  return MODEL_REMOTE(k);
}

function describeError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  const msg = (e as Error)?.message ?? String(e);
  if (msg === "INSECURE") return "The camera only works on a secure page. Open the dashboard on this computer at http://localhost:5173, or over https.";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access was blocked. Allow the camera for this site (the icon in the address bar), then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found. Plug in a webcam, or try the simulated athlete.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is busy in another app. Close that app, then try again.";
  if (e instanceof ModelError) return `Couldn't load the pose model (${msg}). It downloads from storage.googleapis.com the first time: check the internet connection, or put the .task file in frontend/public/models/.`;
  return msg || "Body tracking stopped unexpectedly.";
}

function loadOverlay(): Overlay {
  // Mirrored by default (selfie view): the athlete's left is on screen left, matching the target arc.
  const d: Overlay = { skeleton: true, angles: true, trails: true, mirror: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem(OVERLAY_KEY) ?? "{}") }; } catch { return d; }
}

interface Pending { key: string; trialNo: number; target: string; nogo: boolean; tStimUs: number | null; path: { L: number; R: number }; peak: { L: number; R: number } }

export class PoseTracker {
  private listeners = new Set<() => void>();
  private snap: Snapshot;
  private canvases = new Map<HTMLCanvasElement, boolean>(); // canvas -> compact
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private landmarker: PoseLandmarker | null = null;
  private landmarkerModel: ModelKind | null = null;
  private delegate: "GPU" | "CPU" | null = null;
  private sim: SimAthlete | null = null;
  private raf = 0;
  private runId = 0;
  private lastVideoTime = -1;
  private source: Source | null = null;
  private status: Status = "idle";
  private message: string | null = null;
  private error: string | null = null;
  private cameraLabel: string | null = null;
  private deviceId: string | undefined;
  private model: ModelKind = "lite";
  private overlay: Overlay = loadOverlay();
  private nTargets = DEFAULT_TARGETS;

  private frame: PoseFrame | null = null;
  private metrics: PoseMetrics | null = null;
  private fps: number | null = null;
  private inference: number | null = null;
  private lastFrameT = 0;
  private lastEmit = 0;
  private lastHist = 0;
  private scale: number | null = null; // metres per source pixel, smoothed
  private pelvisBuf: { t: number; x: number }[] = [];
  private smoothPelvis: P2 | null = null;
  private history: HistoryPoint[] = [];
  private trails: Trails = { pelvis: [], L: [], R: [] };
  private wristPrev: { L: { t: number; p: P2 } | null; R: { t: number; p: P2 } | null } = { L: null, R: null };
  private wristSpeed: { L: number | null; R: number | null } = { L: null, R: null };
  private pending = new Map<string, Pending>();
  private responses: ResponsePosture[] = [];
  private blockId: string | null = null;
  private lit: string | null = null;

  constructor() { this.snap = this.build(); }

  // ------------------------------------------------------------------ React plumbing
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snap;
  private emit() {
    this.lastEmit = performance.now();
    this.snap = this.build();
    this.listeners.forEach((fn) => fn());
  }

  attach(canvas: HTMLCanvasElement, compact: boolean) { this.canvases.set(canvas, compact); this.drawOne(canvas, compact); }
  detach(canvas: HTMLCanvasElement) { this.canvases.delete(canvas); }
  redraw() { this.canvases.forEach((compact, c) => this.drawOne(c, compact)); }

  setOverlay(patch: Partial<Overlay>) {
    this.overlay = { ...this.overlay, ...patch };
    try { localStorage.setItem(OVERLAY_KEY, JSON.stringify(this.overlay)); } catch { /* private mode */ }
    this.redraw();
    this.emit();
  }
  setTargets(n: number) { if (n > 0) { this.nTargets = n; this.sim?.setTargets(n); } }
  async setModel(k: ModelKind) {
    if (k === this.model) return;
    this.model = k;
    if (this.source === "camera" && this.status !== "idle") await this.start("camera", this.deviceId);
    else this.emit();
  }
  async listCameras(): Promise<CameraInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "videoinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  // ------------------------------------------------------------------ start / stop
  async start(source: Source, deviceId?: string) {
    this.stop(false);
    const id = ++this.runId;
    this.source = source;
    this.deviceId = deviceId;
    this.error = null;
    this.reset();
    if (source === "sim") {
      this.sim = new SimAthlete();
      this.sim.setTargets(this.nTargets);
      this.cameraLabel = "Simulated athlete";
      this.status = "running"; this.message = null;
      this.emit();
      this.loop(id);
      return;
    }
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("INSECURE");
      this.setStatus("starting", "Waiting for camera permission…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      if (id !== this.runId) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      this.cameraLabel = track?.label || "Camera";
      track?.addEventListener("ended", () => { if (id === this.runId) this.fail("The camera was disconnected."); });
      const video = this.videoEl();
      video.srcObject = stream;
      await video.play();
      const cached = this.landmarker && this.landmarkerModel === this.model;
      this.setStatus("loading", cached ? "Starting tracking…" : `Loading the pose model (${this.model === "lite" ? "about 6 MB" : "about 9 MB"}, first time only)…`);
      await this.ensureLandmarker();
      if (id !== this.runId) return;
      this.status = "running"; this.message = null;
      this.emit();
      this.loop(id);
    } catch (e) {
      if (id === this.runId) this.fail(describeError(e));
    }
  }

  stop(emit = true) {
    this.runId++;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.sim = null;
    this.source = null;
    this.status = "idle";
    this.message = null;
    this.frame = null;
    this.metrics = null;
    this.redraw();
    if (emit) this.emit();
  }

  private fail(message: string) {
    const src = this.source;
    this.stop(false);
    this.source = src;
    this.status = "error";
    this.error = message;
    this.emit();
  }
  private setStatus(s: Status, message: string | null) { this.status = s; this.message = message; this.emit(); }

  private reset() {
    this.frame = null; this.metrics = null; this.fps = null; this.inference = null; this.lastFrameT = 0;
    this.scale = null; this.pelvisBuf = []; this.smoothPelvis = null; this.history = []; this.lastHist = 0;
    this.trails = { pelvis: [], L: [], R: [] }; this.wristPrev = { L: null, R: null }; this.wristSpeed = { L: null, R: null };
    this.pending.clear(); this.lastVideoTime = -1;
  }

  private videoEl(): HTMLVideoElement {
    if (this.video) return this.video;
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.autoplay = true;
    // Kept in the document (but invisible) so every browser keeps decoding frames.
    Object.assign(v.style, { position: "fixed", left: "-2px", top: "-2px", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    v.setAttribute("aria-hidden", "true");
    document.body.appendChild(v);
    this.video = v;
    return v;
  }

  private async ensureLandmarker() {
    if (this.landmarker && this.landmarkerModel === this.model) return;
    this.landmarker?.close();
    this.landmarker = null;
    let vision: typeof import("@mediapipe/tasks-vision");
    try { vision = await import("@mediapipe/tasks-vision"); } catch (e) { throw new ModelError((e as Error).message); }
    let fileset;
    try { fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE); } catch (e) { throw new ModelError(`runtime: ${(e as Error).message}`); }
    const modelAssetPath = await resolveModel(this.model);
    let lastErr: unknown = null;
    for (const delegate of ["GPU", "CPU"] as const) {
      try {
        this.landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: "VIDEO", numPoses: 1,
          minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        this.delegate = delegate;
        this.landmarkerModel = this.model;
        return;
      } catch (e) { lastErr = e; }
    }
    throw new ModelError((lastErr as Error)?.message ?? "unknown error");
  }

  // ------------------------------------------------------------------ frame loop
  private loop(id: number) {
    const tick = () => {
      if (id !== this.runId) return;
      const now = performance.now();
      if (this.sim) {
        if (now - this.lastFrameT >= 12) this.process(this.sim.frame(now), null); // every display frame, capped near 80 fps
      } else if (this.video && this.landmarker && this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = this.video.currentTime;
        const t0 = performance.now();
        try {
          const res = this.landmarker.detectForVideo(this.video, t0);
          this.process({ image: res.landmarks[0] ?? null, world: res.worldLandmarks[0] ?? null, width: this.video.videoWidth, height: this.video.videoHeight, t: t0 }, performance.now() - t0);
        } catch (e) { this.fail(describeError(e)); return; }
      }
      this.redraw();
      if (now - this.lastEmit >= EMIT_MS) this.emit();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private process(f: PoseFrame, inferenceMs: number | null) {
    const dt = this.lastFrameT ? f.t - this.lastFrameT : 0;
    this.lastFrameT = f.t;
    if (dt > 0) this.fps = this.fps == null ? 1000 / dt : this.fps * 0.92 + (1000 / dt) * 0.08;
    if (inferenceMs != null) this.inference = this.inference == null ? inferenceMs : this.inference * 0.9 + inferenceMs * 0.1;
    this.frame = f;
    const m = computeMetrics(f);
    this.metrics = m;
    if (m?.metresPerPx) this.scale = this.scale == null ? m.metresPerPx : this.scale * 0.95 + m.metresPerPx * 0.05;

    // Pelvis: lightly smoothed, buffered for sway, and trailed.
    if (m?.pelvis) {
      const p = this.smoothPelvis ? { x: this.smoothPelvis.x * 0.6 + m.pelvis.x * 0.4, y: this.smoothPelvis.y * 0.6 + m.pelvis.y * 0.4 } : m.pelvis;
      this.smoothPelvis = p;
      this.pelvisBuf.push({ t: f.t, x: p.x });
      this.trails.pelvis.push(p);
      if (this.trails.pelvis.length > 70) this.trails.pelvis.shift();
    } else {
      this.smoothPelvis = null;
      this.trails.pelvis.shift();
    }
    while (this.pelvisBuf.length && f.t - this.pelvisBuf[0]!.t > SWAY_MS) this.pelvisBuf.shift();

    // Wrists: speed in m/s, trails while moving, and path per hand for open reaches.
    for (const side of ["L", "R"] as const) {
      const w = m?.wrists[side] ?? null;
      const prev = this.wristPrev[side];
      let speed: number | null = null;
      if (w && prev && f.t > prev.t && this.scale) {
        const d = Math.hypot(w.x - prev.p.x, w.y - prev.p.y) * this.scale;
        speed = d / ((f.t - prev.t) / 1000);
        for (const p of this.pending.values()) { p.path[side] += d; p.peak[side] = Math.max(p.peak[side], speed); }
      }
      const old = this.wristSpeed[side];
      this.wristSpeed[side] = speed == null ? null : old == null ? speed : old * 0.6 + speed * 0.4;
      this.wristPrev[side] = w ? { t: f.t, p: w } : null;
      const tr = this.trails[side];
      if (w && (this.wristSpeed[side] ?? 0) > 0.35) { tr.push(w); if (tr.length > 26) tr.shift(); } else tr.shift();
    }

    if (f.t - this.lastHist >= 100) {
      this.lastHist = f.t;
      const mean = this.pelvisBuf.length ? this.pelvisBuf.reduce((s, p) => s + p.x, 0) / this.pelvisBuf.length : null;
      const offsetCm = this.smoothPelvis && mean != null && this.scale ? Math.round((this.smoothPelvis.x - mean) * this.scale * 1000) / 10 : null;
      const knees = [m?.knee.L, m?.knee.R].filter((v): v is number => v != null);
      this.history.push({ t: f.t, lean: m?.trunkLean ?? null, forward: m?.trunkForward ?? null, offsetCm, knee: knees.length ? knees.reduce((a, b) => a + b, 0) / knees.length : null });
      while (this.history.length && f.t - this.history[0]!.t > HISTORY_MS) this.history.shift();
    }
  }

  private drawOne(canvas: HTMLCanvasElement, compact: boolean) {
    drawPose(canvas, { frame: this.frame, metrics: this.metrics, video: this.sim ? null : this.status === "running" ? this.video : null, sim: this.sim, trails: this.trails }, this.overlay, compact);
  }

  // ------------------------------------------------------------------ hub events (live feed)
  onStationEvent(e: { type: string; block_id?: string; trial_no?: number; target_id?: string; t_us?: number; colour?: string; data?: { is_nogo?: boolean } }) {
    if (this.status !== "running") return;
    this.sim?.onEvent(e, performance.now());
    const key = `${e.block_id}:${e.trial_no}`;
    switch (e.type) {
      case "block_started":
        this.blockId = e.block_id ?? null; this.responses = []; this.pending.clear();
        break;
      case "stimulus_on":
        if (e.block_id && e.block_id !== this.blockId) { this.blockId = e.block_id; this.responses = []; }
        this.lit = e.target_id ?? null;
        this.pending.set(key, { key, trialNo: e.trial_no ?? 0, target: e.target_id ?? "?", nogo: !!e.data?.is_nogo, tStimUs: e.t_us ?? null, path: { L: 0, R: 0 }, peak: { L: 0, R: 0 } });
        break;
      case "response": {
        const p = this.pending.get(key);
        if (!p) break;
        this.pending.delete(key);
        const m = this.metrics;
        const moved = p.path.L + p.path.R > 0.02;
        const hand: "L" | "R" | null = moved ? (p.path.L >= p.path.R ? "L" : "R") : null;
        const rtMs = e.t_us != null && p.tStimUs != null ? (e.t_us - p.tStimUs) / 1000 : null;
        const touched = e.target_id ?? null;
        const result = rtMs != null && rtMs < 100 ? "anticipation" : p.nogo ? "false_alarm" : touched !== p.target ? "wrong_target" : "hit";
        const knees = [m?.knee.L, m?.knee.R].filter((v): v is number => v != null);
        this.responses = [{
          key, trialNo: p.trialNo, target: p.target, touched, result, hand,
          lean: m?.trunkLean ?? null, forward: m?.trunkForward ?? null,
          knee: knees.length ? knees.reduce((a, b) => a + b, 0) / knees.length : null,
          peakSpeed: hand ? Math.round(p.peak[hand] * 100) / 100 : null, rtMs,
        }, ...this.responses].slice(0, 40);
        break;
      }
      case "stimulus_off":
        this.lit = null; this.pending.delete(key);
        break;
      case "block_done": case "block_aborted":
        this.lit = null; this.pending.clear();
        break;
    }
  }

  // ------------------------------------------------------------------ snapshot
  private build(): Snapshot {
    const m = this.metrics;
    const buf = this.pelvisBuf;
    let swayRmsCm: number | null = null, swaySpeedCms: number | null = null;
    const seconds = buf.length > 1 ? (buf[buf.length - 1]!.t - buf[0]!.t) / 1000 : 0;
    if (this.scale && buf.length > 10 && seconds > 1) {
      const mean = buf.reduce((s, p) => s + p.x, 0) / buf.length;
      swayRmsCm = Math.sqrt(buf.reduce((s, p) => s + (p.x - mean) ** 2, 0) / buf.length) * this.scale * 100;
      let path = 0;
      for (let i = 1; i < buf.length; i++) path += Math.abs(buf[i]!.x - buf[i - 1]!.x);
      swaySpeedCms = (path * this.scale * 100) / seconds;
    }
    const recent = this.history.filter((h) => h.lean != null && this.lastFrameT - h.t <= SWAY_MS);
    const peakLean = recent.length ? recent.reduce((a, h) => (Math.abs(h.lean!) > Math.abs(a) ? h.lean! : a), 0) : null;
    const size = this.frame ? { w: this.frame.width, h: this.frame.height } : this.video?.videoWidth ? { w: this.video.videoWidth, h: this.video.videoHeight } : null;
    return {
      source: this.source, status: this.status, message: this.message, error: this.error,
      fps: this.fps, inferenceMs: this.inference, delegate: this.sim ? null : this.delegate, model: this.model,
      frameSize: size, cameraLabel: this.cameraLabel,
      metrics: m, guidance: guidance(m), tracked: !!m,
      history: this.history.slice(), stability: { swayRmsCm, swaySpeedCms, peakLean, seconds: Math.min(10, seconds) },
      wristSpeed: { ...this.wristSpeed }, responses: this.responses, blockId: this.blockId, lit: this.sim?.lit?.target ?? this.lit,
      overlay: this.overlay, demo: !!this.sim?.demoMode,
    };
  }
}
