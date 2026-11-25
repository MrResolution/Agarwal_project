// Posture metrics from one pose frame. Joint angles use MediaPipe's metric world landmarks, so
// they don't depend on the camera angle; positions (sway, wrist speed) use image landmarks scaled
// to metres by the athlete's own shoulder width.
import { LM, type Lm, type P2, type P3, type PoseFrame } from "./landmarks";

const DEG = 180 / Math.PI;
export const VISIBLE = 0.5; // MediaPipe visibility needed before a landmark is used

const sub = (a: P3, b: P3): P3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: P3, b: P3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: P3) => Math.hypot(a.x, a.y, a.z);
const mid = (a: P3, b: P3): P3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const unit = (a: P3): P3 => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const cross = (a: P3, b: P3): P3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** Angle ABC in degrees. */
export function jointAngle(a: P3, b: P3, c: P3): number {
  const u = sub(a, b), v = sub(c, b);
  const cos = dot(u, v) / ((len(u) * len(v)) || 1);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * DEG;
}

export interface LR { L: number | null; R: number | null }
export type Region = "head" | "shoulders" | "hips" | "knees" | "ankles";

export interface PoseMetrics {
  visibility: number; // mean visibility of the 12 main joints, 0-1
  present: Record<Region, boolean>;
  trunkLean: number | null; // side lean of the trunk from vertical, deg; + = towards the athlete's left
  trunkForward: number | null; // forward lean, deg; + = forwards (an estimate: depth is the weakest axis)
  shoulderTilt: number | null; // deg; + = left shoulder higher
  hipTilt: number | null; // deg; + = left hip higher
  knee: LR; // flexion, deg (0 = straight)
  hip: LR; // flexion, deg (0 = trunk and thigh in line)
  elbow: LR; // flexion, deg (0 = straight)
  shoulder: LR; // elevation of the upper arm from the trunk, deg (0 = by the side, 90 = horizontal)
  stance: number | null; // ankle width / hip width
  pelvis: P2 | null; // mid-hip, source px
  wrists: { L: P2 | null; R: P2 | null };
  ankles: { L: P2 | null; R: P2 | null };
  metresPerPx: number | null; // image scale at the athlete, from shoulder width
}

const MAIN = [LM.lShoulder, LM.rShoulder, LM.lElbow, LM.rElbow, LM.lWrist, LM.rWrist, LM.lHip, LM.rHip, LM.lKnee, LM.rKnee, LM.lAnkle, LM.rAnkle];

export function computeMetrics(f: PoseFrame): PoseMetrics | null {
  const img = f.image;
  if (!img || img.length < 33) return null;
  const vis = (i: number) => (img[i]?.visibility ?? 0) >= VISIBLE;
  const all = (...ids: number[]) => ids.every(vis);
  // World landmarks when available; otherwise image landmarks in px (2-D angles).
  const W: P3[] = f.world && f.world.length >= 33 ? f.world : img.map((p) => ({ x: p.x * f.width, y: p.y * f.height, z: 0 }));
  const px = (p: Lm): P2 => ({ x: p.x * f.width, y: p.y * f.height });

  const visibility = MAIN.reduce((s, i) => s + (img[i]?.visibility ?? 0), 0) / MAIN.length;
  const present: Record<Region, boolean> = {
    head: all(LM.nose) && (vis(LM.lEar) || vis(LM.rEar) || vis(LM.lEye) || vis(LM.rEye)),
    shoulders: all(LM.lShoulder, LM.rShoulder),
    hips: all(LM.lHip, LM.rHip),
    knees: all(LM.lKnee, LM.rKnee),
    ankles: all(LM.lAnkle, LM.rAnkle),
  };

  const flex = (a: number, b: number, c: number) => (all(a, b, c) ? Math.round((180 - jointAngle(W[a]!, W[b]!, W[c]!)) * 10) / 10 : null);
  const angle = (a: number, b: number, c: number) => (all(a, b, c) ? Math.round(jointAngle(W[a]!, W[b]!, W[c]!) * 10) / 10 : null);

  let trunkLean: number | null = null, trunkForward: number | null = null, shoulderTilt: number | null = null, hipTilt: number | null = null, stance: number | null = null;
  if (present.shoulders && present.hips) {
    const hipMid = mid(W[LM.lHip]!, W[LM.rHip]!), shMid = mid(W[LM.lShoulder]!, W[LM.rShoulder]!);
    const d = sub(shMid, hipMid);
    // "Up" is -y in MediaPipe's world (and image) frame; the guard keeps an upright trunk near 0 deg.
    const up: P3 = { x: 0, y: d.y <= 0 ? -1 : 1, z: 0 };
    const hipsAxis = sub(W[LM.lHip]!, W[LM.rHip]!); // towards the athlete's left
    const lat = unit({ x: hipsAxis.x, y: 0, z: hipsAxis.z });
    const fwd = cross(lat, up); // the athlete's forward direction
    trunkLean = round1(Math.atan2(dot(d, lat), dot(d, up)) * DEG);
    trunkForward = round1(Math.atan2(dot(d, fwd), dot(d, up)) * DEG);
    const tilt = (a: P3, b: P3) => { const s = sub(a, b); const v = dot(s, up); return round1(Math.atan2(v, Math.sqrt(Math.max(0, dot(s, s) - v * v))) * DEG); };
    shoulderTilt = tilt(W[LM.lShoulder]!, W[LM.rShoulder]!);
    hipTilt = tilt(W[LM.lHip]!, W[LM.rHip]!);
    if (present.ankles) {
      const horiz = (a: P3, b: P3) => { const s = sub(a, b); const v = dot(s, up); return Math.sqrt(Math.max(0, dot(s, s) - v * v)); };
      const hw = horiz(W[LM.lHip]!, W[LM.rHip]!);
      if (hw > 0) stance = Math.round((horiz(W[LM.lAnkle]!, W[LM.rAnkle]!) / hw) * 100) / 100;
    }
  }

  let metresPerPx: number | null = null;
  if (present.shoulders && f.world) {
    const a = px(img[LM.lShoulder]!), b = px(img[LM.rShoulder]!);
    const pxW = Math.hypot(a.x - b.x, a.y - b.y);
    const mW = len(sub(f.world[LM.lShoulder]!, f.world[LM.rShoulder]!));
    if (pxW > 20 && mW > 0.15 && mW < 0.7) metresPerPx = mW / pxW;
  }

  const p = (i: number) => (vis(i) ? px(img[i]!) : null);
  const lh = p(LM.lHip), rh = p(LM.rHip);
  return {
    visibility, present, trunkLean, trunkForward, shoulderTilt, hipTilt, stance, metresPerPx,
    knee: { L: flex(LM.lHip, LM.lKnee, LM.lAnkle), R: flex(LM.rHip, LM.rKnee, LM.rAnkle) },
    hip: { L: flex(LM.lShoulder, LM.lHip, LM.lKnee), R: flex(LM.rShoulder, LM.rHip, LM.rKnee) },
    elbow: { L: flex(LM.lShoulder, LM.lElbow, LM.lWrist), R: flex(LM.rShoulder, LM.rElbow, LM.rWrist) },
    shoulder: { L: angle(LM.lHip, LM.lShoulder, LM.lElbow), R: angle(LM.rHip, LM.rShoulder, LM.rElbow) },
    pelvis: lh && rh ? { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 } : null,
    wrists: { L: p(LM.lWrist), R: p(LM.rWrist) },
    ankles: { L: p(LM.lAnkle), R: p(LM.rAnkle) },
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export const LEAN_WARN = 10; // deg of side lean that earns an amber flag
export const LEAN_ALERT = 20; // deg: possible loss of balance (research doc: trunk-lean trigger)

export function leanTone(v: number | null): "ok" | "warn" | "bad" {
  if (v == null) return "ok";
  const a = Math.abs(v);
  return a >= LEAN_ALERT ? "bad" : a >= LEAN_WARN ? "warn" : "ok";
}

export interface Guidance { tone: "ok" | "warn" | "bad"; text: string }
export function guidance(m: PoseMetrics | null): Guidance {
  if (!m) return { tone: "bad", text: "No one in view. The athlete should stand 2.5–3.5 m in front of the camera." };
  if (!m.present.ankles) return { tone: "warn", text: "Feet are out of frame. Step back, or tilt the camera down." };
  if (!m.present.head) return { tone: "warn", text: "Head is cut off. Step back, or raise the camera." };
  if (!m.present.shoulders || !m.present.hips) return { tone: "warn", text: "Face the camera so both shoulders and hips are visible." };
  if (m.visibility < 0.7) return { tone: "warn", text: "Tracking is weak. Add light, or use a plainer background." };
  return { tone: "ok", text: "Full body in view." };
}

/** "4° left", "2° right", "0°". */
export function sideLabel(v: number | null, pos = "left", neg = "right"): string {
  if (v == null) return "–";
  const a = Math.abs(v);
  return a < 0.5 ? "0°" : `${a.toFixed(0)}° ${v > 0 ? pos : neg}`;
}
