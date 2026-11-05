// Formatting, colour scales, coach insights and small hooks.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Analysis, CompactSummary, Summary } from "./api";
import { wsUrl } from "./api";

// ---------------------------------------------------------------- formatting
export const ms = (v: number | null | undefined, d = 0) => (v == null ? "–" : `${v.toFixed(d)}`);
export const pct = (v: number | null | undefined, d = 0) => (v == null ? "–" : `${(v * 100).toFixed(d)}%`);
export const num = (v: number | null | undefined, d = 2) => (v == null ? "–" : v.toFixed(d));
/** Server timestamps are UTC; SQLite drops the zone, so treat zone-less ISO strings as UTC. */
export function toDate(iso: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}
/** Axis labels for a series of timestamps: dates if they span days, otherwise clock times. */
export function axisLabels(isos: string[]): string[] {
  const ds = isos.map(toDate);
  const sameDay = ds.length > 0 && ds.every((d) => d.toDateString() === ds[0]!.toDateString());
  const labels = ds.map((d) => sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }));
  // Identical labels are useless on an axis: fall back to run numbers.
  return new Set(labels).size < labels.length ? labels.map((_, i) => `Run ${i + 1}`) : labels;
}
export function when(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = toDate(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export function initials(name: string | null | undefined, fallback = "?") {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") : fallback;
}
export const athleteLabel = (a: { display_name?: string | null; name?: string | null; code?: string | null }) =>
  a.display_name || a.name || a.code || "Athlete";

// ---------------------------------------------------------------- target layout
/** The station has 6 touch-sensor targets; a hub reports its own count in its status heartbeat. */
export const DEFAULT_TARGETS = 6;
/** Default arc (matches backend analysis/layout.py): n targets from -70° to +70°, alternating rows. */
export function arcLayout(n: number = DEFAULT_TARGETS) {
  return Array.from({ length: n }, (_, i) => ({
    id: `T${i + 1}`, angle: n > 1 ? -70 + (140 / (n - 1)) * i : 0, row: i % 2 === 0 ? "upper" : "lower",
  }));
}

// ---------------------------------------------------------------- colours
export const RESULT_COLOUR: Record<string, string> = {
  hit: "#1f5eff", wrong_target: "#ffb020", miss: "#c5c8d0", false_alarm: "#ff3b30",
  correct_rejection: "#cff25c", false_start: "#ff7a45", anticipation: "#ff7a45", invalid: "#e1e2e7",
};
export const RESULT_LABEL: Record<string, string> = {
  hit: "Hit", wrong_target: "Wrong target", miss: "Miss", false_alarm: "No-go touch", correct_rejection: "Correct no-go",
  false_start: "False start", anticipation: "Anticipation", invalid: "Invalid",
};
/** RT -> colour from lime (fast) through blue to red (slow), relative to a range. */
export function rtColour(v: number | null, lo = 250, hi = 650): string {
  if (v == null) return "#eceef2";
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  const stops = [[207, 242, 92], [143, 180, 255], [31, 94, 255], [255, 122, 69]];
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const c = stops[i]!.map((a, k) => Math.round(a + (stops[i + 1]![k]! - a) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---------------------------------------------------------------- skill profile (0-100, transparent rules)
export interface Skill { key: string; label: string; value: number | null; detail: string }
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
export function skillProfile(s: CompactSummary | Summary | null | undefined, peripheralDelta?: number | null): Skill[] {
  if (!s) return [];
  const median = "median_rt" in s ? s.median_rt : s.rt?.median ?? null;
  const cv = "cv" in s && typeof s.cv === "number" ? s.cv : "rt" in s ? s.rt?.cv ?? null : null;
  const asym = "asymmetry_index_pct" in s ? s.asymmetry_index_pct : (s as Summary).by_side?.asymmetry_index_pct ?? null;
  const fsr = s.false_start_rate ?? null;
  return [
    { key: "speed", label: "Speed", value: median == null ? null : clamp(100 - (median - 220) / 4.3), detail: "Median RT: 220 ms = 100, 650 ms = 0" },
    { key: "accuracy", label: "Accuracy", value: s.accuracy == null ? null : clamp(s.accuracy * 100), detail: "Hits / go trials" },
    { key: "consistency", label: "Consistency", value: cv == null ? null : clamp(100 - cv * 250), detail: "RT coefficient of variation: 0 = 100, 0.4 = 0" },
    { key: "control", label: "Control", value: fsr == null ? null : clamp(100 - fsr * 400), detail: "False starts + anticipations: 0 % = 100, 25 % = 0" },
    { key: "symmetry", label: "Symmetry", value: asym == null ? null : clamp(100 - Math.abs(asym) * 4), detail: "|Left–right asymmetry|: 0 % = 100, 25 % = 0" },
    { key: "periphery", label: "Periphery", value: peripheralDelta == null ? null : clamp(100 - peripheralDelta / 2), detail: "Peripheral vs central RT gap: 0 ms = 100, 200 ms = 0" },
  ];
}

// ---------------------------------------------------------------- coach insights (rule-based, explainable)
export function insights(a: Analysis | null): string[] {
  if (!a) return [];
  const s = a.summary;
  const out: string[] = [];
  if (s.quality !== "ok") out.push(`Only ${s.valid_hits} valid hits. Results are indicative; repeat the block before drawing conclusions.`);
  const { left, right, asymmetry_index_pct: ai } = s.by_side;
  if (left && right && ai != null && Math.abs(ai) >= 6)
    out.push(`${ai > 0 ? "Right" : "Left"}-side targets are ${Math.abs(right - left).toFixed(0)} ms slower (${Math.abs(ai).toFixed(1)} % asymmetry). Add ${ai > 0 ? "right" : "left"}-side choice drills.`);
  const c = s.by_band.central, p = s.by_band.peripheral;
  if (c && p && p - c > 40) out.push(`Peripheral targets cost ${(p - c).toFixed(0)} ms more than central ones. The peripheral-response protocol trains this.`);
  if ((s.false_start_rate ?? 0) >= 0.1) out.push(`${pct(s.false_start_rate)} of trials started early. Lengthen and vary the foreperiod to discourage anticipation.`);
  if ((s.commission_rate ?? 0) >= 0.25) out.push(`Touched on ${pct(s.commission_rate)} of no-go cues. Response inhibition is the limiting factor; slow down and prioritise accuracy.`);
  if ((s.rt.cv ?? 0) >= 0.2) out.push(`Reaction times vary a lot (CV ${num(s.rt.cv)}). Consistency work before speed work.`);
  if (s.premotor.median && s.movement.median) {
    const share = s.premotor.median / (s.premotor.median + s.movement.median);
    out.push(share > 0.6
      ? `${(share * 100).toFixed(0)} % of response time is decision time (${ms(s.premotor.median)} ms). Train cue recognition rather than arm speed.`
      : `Movement takes ${ms(s.movement.median)} ms of the response. Work on reach efficiency and starting posture.`);
  }
  if (a.balance?.status === "ok" && (a.balance.mean_velocity_mm_s ?? 0) > 25)
    out.push(`Sway velocity ${num(a.balance.mean_velocity_mm_s, 1)} mm/s while responding. Stability drops under reaction load.`);
  if (!out.length) out.push("Balanced profile with no outliers. Progress one difficulty dimension (speed, targets or no-go ratio).");
  return out;
}

// ---------------------------------------------------------------- CoP from four corners (mm)
export function copFromCorners(v: number[], lx = 360, ly = 360): { x: number; y: number; w: number } | null {
  const [fl, fr, bl, br] = v as [number, number, number, number];
  const w = fl + fr + bl + br;
  if (!(w > 10)) return null;
  return { x: (lx / 2) * ((fr + br) - (fl + bl)) / w, y: (ly / 2) * ((fl + fr) - (bl + br)) / w, w };
}

// ---------------------------------------------------------------- hooks
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try { setData(await fnRef.current()); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    load();
    if (!pollMs) return;
    const id = setInterval(() => load(true), pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload: () => load(true), setData };
}

export interface FeedMessage { type: string; [k: string]: any }
/** Live station feed over WebSocket with automatic reconnect. `enabled=false` keeps it closed. */
export function useStationFeed(station: string, onMessage: (m: FeedMessage) => void, enabled = true) {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onMessage);
  cb.current = onMessage;
  useEffect(() => {
    if (!enabled) { setConnected(false); return; }
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      ws = new WebSocket(wsUrl(station));
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => { try { cb.current(JSON.parse(e.data)); } catch { /* ignore */ } };
      ws.onclose = () => { setConnected(false); if (!closed) retry = setTimeout(open, 1500); };
    };
    open();
    return () => { closed = true; clearTimeout(retry); ws?.close(); };
  }, [station, enabled]);
  return connected;
}
