// Draws one tracked frame: the camera image (or the simulated studio), then the 33-point skeleton,
// the trunk axis against vertical, the base of support, motion trails and joint-angle labels.
import { CONNECTIONS, LM, SIDE_COLOUR, sideOf, type P2, type PoseFrame } from "./landmarks";
import { VISIBLE, leanTone, type PoseMetrics } from "./metrics";
import type { SimAthlete } from "./simulator";

export interface Overlay { skeleton: boolean; angles: boolean; trails: boolean; mirror: boolean }
export interface Trails { pelvis: P2[]; L: P2[]; R: P2[] }

export interface DrawInput {
  frame: PoseFrame | null;
  metrics: PoseMetrics | null;
  video: HTMLVideoElement | null;
  sim: SimAthlete | null;
  trails: Trails;
}

const TONE: Record<string, string> = { ok: "#cff25c", warn: "#ffb020", bad: "#ff3b30" };

export function drawPose(canvas: HTMLCanvasElement, input: DrawInput, o: Overlay, compact: boolean) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const cw = canvas.width, ch = canvas.height;
  const fw = input.frame?.width || input.video?.videoWidth || 1280;
  const fh = input.frame?.height || input.video?.videoHeight || 720;
  const s = Math.min(cw / fw, ch / fh);
  const ox = (cw - fw * s) / 2, oy = (ch - fh * s) / 2;
  const T = (p: P2): P2 => ({ x: ox + (o.mirror ? fw - p.x : p.x) * s, y: oy + p.y * s });

  ctx.save();
  ctx.fillStyle = "#0f1420";
  ctx.fillRect(0, 0, cw, ch);
  if (input.video && input.video.readyState >= 2) {
    ctx.save();
    if (o.mirror) { ctx.translate(ox + fw * s, oy); ctx.scale(-1, 1); ctx.drawImage(input.video, 0, 0, fw * s, fh * s); }
    else ctx.drawImage(input.video, ox, oy, fw * s, fh * s);
    ctx.restore();
    ctx.fillStyle = "rgba(15,20,32,0.14)"; // a little contrast for the overlay
    ctx.fillRect(0, 0, cw, ch);
  } else if (input.sim) {
    input.sim.drawScene(ctx, T, s, cw, ch);
  }

  const img = input.frame?.image;
  if (!img || !o.skeleton) { ctx.restore(); return; }
  const m = input.metrics;
  const lw = Math.max(2, Math.min(5.5, cw / (compact ? 360 : 300)));
  const P = (i: number) => T({ x: img[i]!.x * fw, y: img[i]!.y * fh });
  const ok = (i: number) => (img[i]?.visibility ?? 0) >= VISIBLE;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Trails: pelvis path and the wrists during reaches.
  if (o.trails) {
    const trail = (pts: P2[], colour: string, width: number) => {
      if (pts.length < 2) return;
      for (let i = 1; i < pts.length; i++) {
        const a = T(pts[i - 1]!), b = T(pts[i]!);
        ctx.strokeStyle = colour;
        ctx.globalAlpha = (i / pts.length) * 0.85;
        ctx.lineWidth = width;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    trail(input.trails.L, SIDE_COLOUR.L, lw * 1.1);
    trail(input.trails.R, SIDE_COLOUR.R, lw * 1.1);
    trail(input.trails.pelvis, "#ffffff", lw * 0.8);
  }

  // Base of support: the line between the ankles, and whether the pelvis is over it.
  if (m?.ankles.L && m.ankles.R && m.pelvis) {
    const a = T(m.ankles.L), b = T(m.ankles.R), p = T(m.pelvis);
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    const inside = p.x >= lo && p.x <= hi;
    const y = Math.max(a.y, b.y) + lw * 3;
    ctx.setLineDash([lw * 2, lw * 2]);
    ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = lw * 0.8;
    ctx.beginPath(); ctx.moveTo(lo, y); ctx.lineTo(hi, y); ctx.stroke();
    ctx.setLineDash([]);
    const px = Math.max(lo - lw * 6, Math.min(hi + lw * 6, p.x));
    ctx.fillStyle = inside ? "#cff25c" : "#ffb020";
    ctx.beginPath(); ctx.moveTo(px, y - lw * 2.2); ctx.lineTo(px + lw * 2, y); ctx.lineTo(px, y + lw * 2.2); ctx.lineTo(px - lw * 2, y); ctx.closePath(); ctx.fill();
  }

  // Trunk axis vs a vertical plumb line from mid-hip.
  if (ok(LM.lShoulder) && ok(LM.rShoulder) && ok(LM.lHip) && ok(LM.rHip)) {
    const hs = P(LM.lHip), hr = P(LM.rHip), ss = P(LM.lShoulder), sr = P(LM.rShoulder);
    const hip = { x: (hs.x + hr.x) / 2, y: (hs.y + hr.y) / 2 }, sh = { x: (ss.x + sr.x) / 2, y: (ss.y + sr.y) / 2 };
    const L = Math.hypot(sh.x - hip.x, sh.y - hip.y);
    ctx.setLineDash([lw * 1.6, lw * 1.8]);
    ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = lw * 0.7;
    ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(hip.x, hip.y - L * 1.12); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = TONE[leanTone(m?.trunkLean ?? null)]!; ctx.lineWidth = lw * 1.05;
    ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(hip.x + (sh.x - hip.x) * 1.12, hip.y + (sh.y - hip.y) * 1.12); ctx.stroke();
  }

  // Bones, coloured by the athlete's side (left blue, right lime).
  for (const [a, b] of CONNECTIONS) {
    if (!ok(a) || !ok(b)) continue;
    const face = a <= 10 && b <= 10;
    if (compact && face) continue;
    const sa = sideOf(a), sb = sideOf(b);
    const pa = P(a), pb = P(b);
    ctx.strokeStyle = "rgba(15,20,32,0.55)"; ctx.lineWidth = (face ? lw * 0.5 : lw) + 2.2;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.strokeStyle = sa === sb ? SIDE_COLOUR[sa] : "#ffffff"; ctx.lineWidth = face ? lw * 0.5 : lw;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }
  // Joints
  for (let i = 0; i < img.length; i++) {
    if (!ok(i) || (compact && i > 0 && i <= 10) || (i >= 17 && i <= 22)) continue;
    const p = P(i);
    const r = i <= 10 ? lw * 0.75 : lw * 1.35;
    ctx.fillStyle = "#0f1420";
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = SIDE_COLOUR[sideOf(i)];
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
  }

  // Joint-angle labels at elbows and knees (flexion, degrees).
  if (o.angles && m) {
    const fs = Math.max(11, Math.min(15, cw / (compact ? 70 : 82)));
    ctx.font = `600 ${fs}px Outfit, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    const centreX = m.pelvis ? T(m.pelvis).x : cw / 2;
    const tag = (i: number, v: number | null) => {
      if (v == null || !ok(i)) return;
      const p = P(i);
      const text = `${Math.round(v)}°`;
      const tw = ctx.measureText(text).width + fs * 0.9, th = fs * 1.6;
      const outward = p.x >= centreX ? 1 : -1;
      const x = outward > 0 ? p.x + lw * 3 : p.x - lw * 3 - tw, y = p.y - th / 2;
      ctx.fillStyle = "rgba(15,20,32,0.78)";
      roundRect(ctx, x, y, tw, th, th / 2); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.textAlign = "center";
      ctx.fillText(text, x + tw / 2, y + th / 2 + 0.5);
    };
    tag(LM.lElbow, m.elbow.L); tag(LM.rElbow, m.elbow.R);
    tag(LM.lKnee, m.knee.L); tag(LM.rKnee, m.knee.R);
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
