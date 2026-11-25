// Simulated athlete: a software stand-in for the camera, like the hub simulator stands in for the
// hardware. It produces MediaPipe-shaped landmarks for an athlete in a ready stance with natural
// sway, and reaches for whichever target the hub lights (or demo targets when no block is running).
import { arcLayout, DEFAULT_TARGETS } from "../lib";
import { LM, type Lm, type P2, type P3, type PoseFrame } from "./landmarks";

export const SIM_W = 1280, SIM_H = 720;
const FOCAL = 820, CAM_DIST = 2.9, CAM_Y = -0.08; // virtual camera on a tripod at hip height, 2.9 m away

// Body dimensions (m) for a ~1.75 m athlete.
const HIP_HALF = 0.095, SH_HALF = 0.185, TRUNK = 0.5, THIGH = 0.43, SHANK = 0.42, UPPER = 0.29, FORE = 0.26;
const STANCE_HALF = 0.15, ANKLE_Z = -0.05, ANKLE_H = 0.07;
const TARGET_R = 0.72, TARGET_Y = -0.4;
const NOGO_TWITCH = 0.12;

const v3 = (x: number, y: number, z: number): P3 => ({ x, y, z });
const add = (a: P3, b: P3): P3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: P3, b: P3): P3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: P3, k: number): P3 => v3(a.x * k, a.y * k, a.z * k);
const dot = (a: P3, b: P3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: P3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: P3): P3 => mul(a, 1 / (len(a) || 1));
const cross = (a: P3, b: P3): P3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const lerp = (a: P3, b: P3, t: number) => add(a, mul(sub(b, a), t));
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const smooth = (t: number) => { const c = clamp01(t); return c * c * (3 - 2 * c); };
const rad = (d: number) => (d * Math.PI) / 180;
const legDist = (kneeFlexDeg: number) => Math.sqrt(THIGH ** 2 + SHANK ** 2 + 2 * THIGH * SHANK * Math.cos(rad(kneeFlexDeg)));
/** Vertical hip-to-ankle drop for a knee flexion, with the feet a little wider than the hips. */
const vert = (k: number) => Math.sqrt(Math.max(0, legDist(k) ** 2 - (STANCE_HALF - HIP_HALF) ** 2 - ANKLE_Z ** 2));

/** Two-bone IK: middle joint (knee/elbow) bending towards `pole`, and the reachable end point. */
function ik2(a: P3, c: P3, l1: number, l2: number, pole: P3): { mid: P3; end: P3 } {
  const ac = sub(c, a);
  const dir = norm(ac);
  const d = Math.min(len(ac), (l1 + l2) * 0.995);
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const p = norm(sub(pole, mul(dir, dot(pole, dir))));
  return { mid: add(a, add(mul(dir, l1 * cosA), mul(p, l1 * sinA))), end: add(a, mul(dir, d)) };
}

interface Reach { target: string; theta: number; side: "L" | "R"; nogo: boolean; t0: number; tHit: number | null; tOff: number | null; demo: boolean; premotor: number }

export class SimAthlete {
  private targets = arcLayout(DEFAULT_TARGETS);
  private reach: Reach | null = null;
  private lastHubEvent = -Infinity;
  private nextDemo = 0;
  private noise = new Float32Array(33 * 2);
  private seed = 7;
  /** The lit target (from the hub, or a demo target), for drawing the scene. */
  lit: { target: string; colour: string; demo: boolean } | null = null;

  setTargets(n: number) { if (n > 0 && n !== this.targets.length) this.targets = arcLayout(n); }
  get demoMode() { return this.reach?.demo ?? this.lit?.demo ?? false; }

  private rand() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  /** Hub events from the station's live feed. */
  onEvent(e: { type: string; target_id?: string; colour?: string; data?: { is_nogo?: boolean } }, now: number) {
    this.lastHubEvent = now;
    if (e.type === "stimulus_on" && e.target_id) {
      const t = this.targets.find((x) => x.id === e.target_id);
      if (!t) return;
      const nogo = !!e.data?.is_nogo;
      this.lit = { target: t.id, colour: e.colour ?? (nogo ? "red" : "green"), demo: false };
      this.reach = { target: t.id, theta: t.angle, side: t.angle < 0 ? "L" : "R", nogo, t0: now, tHit: null, tOff: null, demo: false, premotor: 190 + this.rand() * 70 };
    } else if (e.type === "response") {
      if (this.reach && this.reach.tHit == null) this.reach.tHit = now;
    } else if (e.type === "stimulus_off") {
      this.lit = null;
      if (this.reach && this.reach.tOff == null) this.reach.tOff = now;
    } else if (e.type === "block_done" || e.type === "block_aborted") {
      this.lit = null;
    }
  }

  /** 0..1: how far the arm is towards the target right now. */
  private reachLevel(now: number): number {
    const r = this.reach;
    if (!r) return 0;
    const t = now - r.t0;
    if (r.nogo) { // inhibited: a small twitch, then still
      const lvl = NOGO_TWITCH * Math.sin(Math.PI * clamp01((t - r.premotor) / 380));
      if (t > 1400) this.reach = null;
      return Math.max(0, lvl);
    }
    let p = smooth((t - r.premotor) / 300);
    if (r.tHit != null) p = Math.max(p, smooth((now - r.tHit) / 60));
    const holdUntil = r.tHit != null ? r.tHit + 180 : r.tOff != null ? r.tOff : r.t0 + 1100;
    if (now > holdUntil) {
      const back = 1 - smooth((now - holdUntil) / 450);
      if (back <= 0) { this.reach = null; return 0; }
      return Math.min(p, back);
    }
    return p;
  }

  private demoTick(now: number) {
    if (now - this.lastHubEvent < 6000) return; // a real block is driving the athlete
    if (this.reach?.demo && this.reach.tHit == null && now - this.reach.t0 > 520) {
      this.reach.tHit = now;
      setTimeout(() => { if (this.lit?.demo) this.lit = null; }, 160);
    }
    if (!this.reach && now >= this.nextDemo) {
      const t = this.targets[Math.floor(this.rand() * this.targets.length)]!;
      this.lit = { target: t.id, colour: "green", demo: true };
      this.reach = { target: t.id, theta: t.angle, side: t.angle < 0 ? "L" : "R", nogo: false, t0: now, tHit: null, tOff: null, demo: true, premotor: 200 + this.rand() * 60 };
      this.nextDemo = now + 2300 + this.rand() * 1400;
    }
  }

  /** Room frame = body frame shifted by the pelvis offset; targets and the floor are fixed in it. */
  private targetRoom(theta: number): P3 {
    return v3(-Math.sin(rad(theta)) * TARGET_R, TARGET_Y, -Math.cos(rad(theta)) * TARGET_R - 0.05);
  }

  project(p: P3): P2 {
    const z = p.z + CAM_DIST;
    return { x: SIM_W / 2 + (FOCAL * p.x) / z, y: SIM_H / 2 + (FOCAL * (p.y - CAM_Y)) / z };
  }

  frame(now: number): PoseFrame {
    this.demoTick(now);
    const s = now / 1000;
    const e = this.reachLevel(now);
    const r = this.reach;
    const th = r ? rad(r.theta) : 0;
    const toward = r ? -Math.sin(th) : 0; // + = towards the athlete's left
    const fwdShare = r ? Math.cos(th) : 0;

    // Posture: ready stance with sway; reaching adds side and forward lean and deeper knees.
    const tl = 1.4 * Math.sin(2 * Math.PI * 0.17 * s) + 0.6 * Math.sin(2 * Math.PI * 0.53 * s + 0.7) + 7 * toward * e;
    const tf = 9 + 1.5 * Math.sin(2 * Math.PI * 0.11 * s) + 13 * fwdShare * e;
    const kneeFlex = 20 + 1.5 * Math.sin(2 * Math.PI * 0.21 * s) + 9 * e;
    const shiftX = 0.012 * Math.sin(2 * Math.PI * 0.23 * s) + 0.006 * Math.sin(2 * Math.PI * 0.61 * s + 1) + 0.035 * toward * e;
    const drop = vert(20) - vert(kneeFlex); // feet stay planted: the pelvis drops as the knees bend
    const offset = v3(shiftX, drop, 0);

    const T = norm(v3(Math.sin(rad(tl)), -Math.cos(rad(tl)) * Math.cos(rad(tf)), -Math.cos(rad(tl)) * Math.sin(rad(tf))));
    const lat = norm(sub(v3(1, 0, 0), mul(T, T.x)));
    const fwd = norm(cross(lat, T));
    const W: P3[] = new Array(33);

    // Pelvis and legs
    const hipTilt = 0.004 * Math.sin(2 * Math.PI * 0.23 * s);
    W[LM.lHip] = v3(HIP_HALF, -hipTilt, 0);
    W[LM.rHip] = v3(-HIP_HALF, hipTilt, 0);
    const v0 = vert(20);
    for (const [hip, knee, ankle, heel, foot, sg] of [[LM.lHip, LM.lKnee, LM.lAnkle, LM.lHeel, LM.lFoot, 1], [LM.rHip, LM.rKnee, LM.rAnkle, LM.rHeel, LM.rFoot, -1]] as const) {
      const anklePos = v3(sg * STANCE_HALF - shiftX, v0 - drop, ANKLE_Z);
      const leg = ik2(W[hip]!, anklePos, THIGH, SHANK, v3(sg * 0.18, 0, -1));
      W[knee] = leg.mid;
      W[ankle] = leg.end;
      W[heel] = add(leg.end, v3(0, 0.045, 0.06));
      W[foot] = add(leg.end, v3(sg * 0.02, 0.06, -0.15));
    }

    // Trunk and head
    const shMid = mul(T, TRUNK);
    W[LM.lShoulder] = add(shMid, mul(lat, SH_HALF));
    W[LM.rShoulder] = sub(shMid, mul(lat, SH_HALF));
    const head = add(shMid, mul(T, 0.2));
    const face = (up: number, side: number, ahead: number) => add(head, add(mul(T, up), add(mul(lat, side), mul(fwd, ahead))));
    W[LM.nose] = face(0, 0, 0.095);
    W[LM.lEyeIn] = face(0.035, 0.018, 0.08); W[LM.lEye] = face(0.037, 0.032, 0.078); W[LM.lEyeOut] = face(0.036, 0.047, 0.07);
    W[LM.rEyeIn] = face(0.035, -0.018, 0.08); W[LM.rEye] = face(0.037, -0.032, 0.078); W[LM.rEyeOut] = face(0.036, -0.047, 0.07);
    W[LM.lEar] = face(0.015, 0.075, 0.0); W[LM.rEar] = face(0.015, -0.075, 0.0);
    W[LM.mouthL] = face(-0.045, 0.025, 0.082); W[LM.mouthR] = face(-0.045, -0.025, 0.082);

    // Arms: ready position, the reaching arm travels to the lit target.
    for (const [sh, el, wr, pinky, index, thumb, sg, side] of [
      [LM.lShoulder, LM.lElbow, LM.lWrist, LM.lPinky, LM.lIndex, LM.lThumb, 1, "L"],
      [LM.rShoulder, LM.rElbow, LM.rWrist, LM.rPinky, LM.rIndex, LM.rThumb, -1, "R"],
    ] as const) {
      const shoulder = W[sh]!;
      const rest = add(shoulder, add(mul(lat, -0.02 * sg), add(mul(T, -0.27), mul(fwd, 0.22))));
      let goal = rest;
      if (r && r.side === side && e > 0) {
        const tgt = sub(this.targetRoom(r.theta), offset);
        goal = lerp(rest, tgt, e);
      }
      const arm = ik2(shoulder, goal, UPPER, FORE, add(mul(lat, 0.5 * sg), add(mul(T, -1), mul(fwd, -0.4))));
      W[el] = arm.mid;
      W[wr] = arm.end;
      const f = norm(sub(arm.end, arm.mid));
      W[index] = add(arm.end, add(mul(f, 0.085), mul(lat, 0.008 * sg)));
      W[pinky] = add(arm.end, add(mul(f, 0.07), mul(lat, 0.028 * sg)));
      W[thumb] = add(arm.end, add(mul(f, 0.05), add(mul(lat, -0.028 * sg), mul(fwd, 0.012))));
    }

    // Image landmarks: project the room-frame points, with smooth tracking-like jitter.
    const image: Lm[] = W.map((p, i) => {
      const q = this.project(add(p, offset));
      this.noise[i * 2] = this.noise[i * 2]! * 0.86 + (this.rand() - 0.5) * 0.7;
      this.noise[i * 2 + 1] = this.noise[i * 2 + 1]! * 0.86 + (this.rand() - 0.5) * 0.7;
      const hand = i >= 17 && i <= 22;
      return { x: (q.x + this.noise[i * 2]!) / SIM_W, y: (q.y + this.noise[i * 2 + 1]!) / SIM_H, z: p.z, visibility: (hand ? 0.9 : 0.975) - this.rand() * 0.02 };
    });
    const world = W.map((p) => v3(p.x + (this.rand() - 0.5) * 0.004, p.y + (this.rand() - 0.5) * 0.004, p.z + (this.rand() - 0.5) * 0.006));
    return { image, world, width: SIM_W, height: SIM_H, t: now };
  }

  /** Studio backdrop: floor grid, balance board and the target arc, in source-frame pixels. */
  drawScene(ctx: CanvasRenderingContext2D, toCanvas: (p: P2) => P2, scale: number, cw: number, ch: number) {
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, "#1a2233"); g.addColorStop(0.62, "#121826"); g.addColorStop(1, "#0b0f18");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
    const floorY = vert(20) + ANKLE_H;
    const P = (x: number, y: number, z: number) => toCanvas(this.project(v3(x, y, z)));
    // floor grid
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    for (let x = -2.5; x <= 2.5001; x += 0.5) { const a = P(x, floorY, -1.4), b = P(x, floorY, 2.2); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    for (let z = -1.4; z <= 2.2001; z += 0.4) { const a = P(-2.5, floorY, z), b = P(2.5, floorY, z); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    // balance board
    const board = [P(-0.26, floorY, -0.3), P(0.26, floorY, -0.3), P(0.26, floorY, 0.24), P(-0.26, floorY, 0.24)];
    ctx.beginPath(); board.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
    ctx.fillStyle = "rgba(143,180,255,0.10)"; ctx.fill();
    ctx.strokeStyle = "rgba(143,180,255,0.35)"; ctx.stroke();
    // targets
    for (const t of this.targets) {
      const room = this.targetRoom(t.angle);
      const c = P(room.x, room.y, room.z);
      const r = ((FOCAL * 0.055) / (room.z + CAM_DIST)) * scale;
      const lit = this.lit?.target === t.id;
      const colour = this.lit?.colour === "red" ? "#ff3b30" : "#cff25c";
      ctx.save();
      if (lit) { ctx.shadowColor = colour; ctx.shadowBlur = 28 * scale; }
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = lit ? colour : "rgba(255,255,255,0.06)"; ctx.fill();
      ctx.lineWidth = Math.max(1.5, 2 * scale);
      ctx.strokeStyle = lit ? "#ffffff" : "rgba(255,255,255,0.28)"; ctx.stroke();
      ctx.restore();
      ctx.fillStyle = lit ? "#0f1420" : "rgba(255,255,255,0.55)";
      ctx.font = `600 ${Math.max(10, r * 0.75)}px Outfit, system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(t.id, c.x, c.y + 0.5);
    }
  }
}
