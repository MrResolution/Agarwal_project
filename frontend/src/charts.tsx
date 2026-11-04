// Hand-built SVG charts in the dashboard style (no chart library).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { RESULT_COLOUR, rtColour } from "./lib";

function useWidth<T extends HTMLElement>(fallback = 400) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.floor(e!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / p) * p;
};

// ---------------------------------------------------------------- smooth line / area
export interface LinePoint { label: string; value: number | null; tip?: ReactNode }
export function LineChart({ points, height = 170, colour = "#1f5eff", area = true, goal, unit = "", yMin }: {
  points: LinePoint[]; height?: number; colour?: string; area?: boolean; goal?: number | null; unit?: string; yMin?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 34, r: 12, t: 14, b: 24 };
  const vals = points.map((p) => p.value).filter((v): v is number => v != null);
  if (!vals.length) return <div ref={ref} className="empty" style={{ height }}>No data yet</div>;
  const lo = yMin ?? Math.min(...vals, goal ?? Infinity) * 0.9;
  const hi = niceMax(Math.max(...vals, goal ?? -Infinity) * 1.05);
  const x = (i: number) => pad.l + (points.length === 1 ? (w - pad.l - pad.r) / 2 : (i / (points.length - 1)) * (w - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (height - pad.t - pad.b);
  const pts = points.map((p, i) => (p.value == null ? null : [x(i), y(p.value)] as [number, number]));
  const valid = pts.filter(Boolean) as [number, number][];
  let d = "";
  valid.forEach(([px, py], i) => {
    if (i === 0) { d += `M${px},${py}`; return; }
    const [qx, qy] = valid[i - 1]!;
    const cx = (qx + px) / 2;
    d += ` C${cx},${qy} ${cx},${py} ${px},${py}`;
  });
  const gid = `g${colour.replace("#", "")}`;
  const ticks = [lo, (lo + hi) / 2, hi];
  const step = Math.max(1, Math.ceil(points.length / 7));
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <svg width={w} height={height} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGElement).getBoundingClientRect();
          const rel = (e.clientX - r.left - pad.l) / (w - pad.l - pad.r);
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
        }}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={colour} stopOpacity=".22" />
            <stop offset="1" stopColor={colour} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="#eef0f3" strokeDasharray="3 5" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#9aa0aa">{Math.round(t)}</text>
          </g>
        ))}
        {points.map((p, i) => i % step === 0 || i === points.length - 1 ? (
          <text key={i} x={x(i)} y={height - 6} fontSize="11" fill="#9aa0aa"
            textAnchor={points.length > 1 && i === 0 ? "start" : points.length > 1 && i === points.length - 1 ? "end" : "middle"}>{p.label}</text>
        ) : null)}
        {goal != null && <>
          <line x1={pad.l} x2={w - pad.r} y1={y(goal)} y2={y(goal)} stroke="#1f5eff" strokeDasharray="5 5" strokeOpacity=".6" />
          <rect x={pad.l + 2} y={y(goal) - 18} width="64" height="16" rx="5" fill="#1f5eff" />
          <text x={pad.l + 34} y={y(goal) - 7} textAnchor="middle" fontSize="10" fill="#fff">Baseline {Math.round(goal)}</text>
        </>}
        {area && valid.length > 1 && <path d={`${d} L${valid[valid.length - 1]![0]},${height - pad.b} L${valid[0]![0]},${height - pad.b} Z`} fill={`url(#${gid})`} />}
        <path d={d} fill="none" stroke={colour} strokeWidth="2.6" strokeLinecap="round" />
        {valid.length <= 1 && valid.map(([px, py], i) => <circle key={i} cx={px} cy={py} r="5" fill={colour} />)}
        {hover != null && pts[hover] && <>
          <line x1={pts[hover]![0]} x2={pts[hover]![0]} y1={pad.t} y2={height - pad.b} stroke="#d6d9e0" />
          <circle cx={pts[hover]![0]} cy={pts[hover]![1]} r="9" fill={colour} fillOpacity=".18" />
          <circle cx={pts[hover]![0]} cy={pts[hover]![1]} r="5" fill={colour} stroke="#fff" strokeWidth="2" />
        </>}
      </svg>
      {hover != null && pts[hover] && (
        <div className="chart-tip" style={{ left: pts[hover]![0], top: pts[hover]![1] - 8 }}>
          {points[hover]!.tip ?? <><b>{points[hover]!.value?.toFixed(0)}{unit}</b> <span className="muted">{points[hover]!.label}</span></>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- lollipop bars (recent runs)
export function Lollipops({ items, height = 150, goal, unit = " ms", invert = true }: {
  items: { label: string; value: number | null; highlight?: boolean }[]; height?: number; goal?: number | null; unit?: string; invert?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const vals = items.map((i) => i.value).filter((v): v is number => v != null);
  if (!vals.length) return <div ref={ref} className="empty" style={{ height }}>No completed runs yet</div>;
  const pad = { l: 8, r: 8, t: 26, b: 22 };
  const lo = Math.min(...vals, goal ?? Infinity) * 0.85, hi = Math.max(...vals, goal ?? -Infinity) * 1.08;
  // invert: faster (smaller RT) draws taller
  const y = (v: number) => pad.t + (invert ? (v - lo) / (hi - lo || 1) : 1 - (v - lo) / (hi - lo || 1)) * (height - pad.t - pad.b);
  const gap = (w - pad.l - pad.r) / items.length;
  return (
    <div ref={ref}>
      <svg width={w} height={height}>
        {goal != null && <line x1={pad.l} x2={w - pad.r} y1={y(goal)} y2={y(goal)} stroke="#1f5eff" strokeDasharray="4 5" strokeOpacity=".5" />}
        {items.map((it, i) => {
          const cx = pad.l + gap * (i + 0.5);
          const base = height - pad.b;
          return (
            <g key={i}>
              {Array.from({ length: 5 }).map((_, k) => (
                <line key={k} x1={cx - 10 + k * 5} x2={cx - 10 + k * 5} y1={base} y2={base - 6 - ((k * 7 + i * 3) % 11)} stroke="#eef0f3" strokeWidth="2" />
              ))}
              {it.value != null && <>
                <line x1={cx} x2={cx} y1={base} y2={y(it.value)} stroke={it.highlight ? "#cff25c" : "#d7dae1"} strokeWidth={it.highlight ? 6 : 2} strokeLinecap="round" />
                <circle cx={cx} cy={y(it.value)} r={it.highlight ? 8 : 5} fill={it.highlight ? "#cff25c" : "#aab0bb"} stroke={it.highlight ? "#fff" : "none"} strokeWidth="2" />
                {it.highlight && <text x={cx} y={y(it.value) - 14} textAnchor="middle" fontSize="11.5" fill="#0f1420">{Math.round(it.value)}{unit}</text>}
              </>}
              <text x={cx} y={height - 5} textAnchor="middle" fontSize="11" fill="#9aa0aa">{it.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- histogram
export function Histogram({ bins, height = 160, highlight }: { bins: { from: number; to: number; count: number }[]; height?: number; highlight?: number | null }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const used = bins.filter((b) => b.count > 0);
  if (!used.length) return <div ref={ref} className="empty" style={{ height }}>No valid responses</div>;
  const first = bins.findIndex((b) => b.count > 0), last = bins.length - 1 - [...bins].reverse().findIndex((b) => b.count > 0);
  const view = bins.slice(Math.max(0, first - 1), Math.min(bins.length, last + 2));
  const max = Math.max(...view.map((b) => b.count));
  const pad = { l: 6, r: 6, t: 10, b: 22 };
  const bw = (w - pad.l - pad.r) / view.length;
  return (
    <div ref={ref}>
      <svg width={w} height={height}>
        {view.map((b, i) => {
          const h = (b.count / max) * (height - pad.t - pad.b);
          const on = highlight != null && highlight >= b.from && highlight < b.to;
          return (
            <g key={i}>
              <rect x={pad.l + i * bw + 3} y={height - pad.b - h} width={Math.max(2, bw - 6)} height={Math.max(h, b.count ? 3 : 0)} rx="6"
                fill={on ? "#1f5eff" : "#cff25c"} />
              {b.count > 0 && <text x={pad.l + i * bw + bw / 2} y={height - pad.b - h - 4} textAnchor="middle" fontSize="10.5" fill="#6b717d">{b.count}</text>}
              {i % Math.max(1, Math.ceil(view.length / 8)) === 0 && (
                <text x={pad.l + i * bw + bw / 2} y={height - 6} textAnchor="middle" fontSize="10.5" fill="#9aa0aa">{b.from}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- sparkline (live)
export function Sparkline({ values, height = 70, colour = "#1f5eff", fill = true }: { values: number[]; height?: number; colour?: string; fill?: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  if (values.length < 2) return <div ref={ref} style={{ height }} />;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, 6 + (1 - (v - lo) / span) * (height - 12)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x!.toFixed(1)},${y!.toFixed(1)}`).join(" ");
  return (
    <div ref={ref}>
      <svg width={w} height={height}>
        {fill && <path d={`${d} L${w},${height} L0,${height} Z`} fill={colour} fillOpacity=".08" />}
        <path d={d} fill="none" stroke={colour} strokeWidth="2.2" strokeLinejoin="round" />
        <circle cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r="4.5" fill={colour} stroke="#fff" strokeWidth="2" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- hexagonal skill radar
export function Radar({ axes, size = 230 }: { axes: { label: string; value: number | null }[]; size?: number }) {
  const c = size / 2, r = size / 2 - 34;
  const n = axes.length;
  const pt = (i: number, f: number) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [c + Math.cos(a) * r * f, c + Math.sin(a) * r * f];
  };
  const ring = (f: number) => axes.map((_, i) => pt(i, f).join(",")).join(" ");
  const shape = axes.map((a, i) => pt(i, (a.value ?? 0) / 100).join(",")).join(" ");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ maxWidth: "100%" }}>
      <defs>
        <radialGradient id="rg" cx="50%" cy="50%" r="60%">
          <stop offset="0" stopColor="#cff25c" stopOpacity=".95" />
          <stop offset=".55" stopColor="#ffd36a" stopOpacity=".55" />
          <stop offset="1" stopColor="#ff9a7a" stopOpacity=".35" />
        </radialGradient>
      </defs>
      {[1, 0.75, 0.5, 0.25].map((f) => <polygon key={f} points={ring(f)} fill={f === 1 ? "#f6f7f9" : "none"} stroke="#e6e8ec" />)}
      {axes.map((_, i) => { const [x, y] = pt(i, 1); return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="#eceef2" />; })}
      <polygon points={shape} fill="url(#rg)" stroke="#9fc02a" strokeWidth="1.5" strokeLinejoin="round" />
      {axes.map((a, i) => {
        const [x, y] = pt(i, 1.2);
        return (
          <g key={a.label}>
            <text x={x} y={y! - 2} textAnchor="middle" fontSize="11.5" fill="#3a4150">{a.label}</text>
            <text x={x} y={y! + 12} textAnchor="middle" fontSize="11" fill="#9aa0aa">{a.value ?? "–"}</text>
          </g>
        );
      })}
      <circle cx={c} cy={c} r="17" fill="#fff" stroke="#e6e8ec" />
      <path d={`M${c - 8},${c} h4 l2,-6 l4,12 l2,-6 h4`} fill="none" stroke="#0f1420" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- ring gauge
export function Gauge({ value, size = 120, label, colour = "#cff25c" }: { value: number | null; size?: number; label?: string; colour?: string }) {
  const r = size / 2 - 10, c = Math.PI * 2 * r;
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef0f3" strokeWidth="10" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colour} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: "stroke-dasharray .5s" }} />
      <text x="50%" y="50%" textAnchor="middle" dy="6" fontSize={size / 5.2} fill="#0f1420">{value == null ? "–" : `${Math.round(v * 100)}%`}</text>
      {label && <text x="50%" y="50%" textAnchor="middle" dy={size / 5} fontSize="10.5" fill="#9aa0aa">{label}</text>}
    </svg>
  );
}

// ---------------------------------------------------------------- dot matrix (activity)
export function DotMatrix({ columns, rows = 6, height = 150 }: { columns: { label: string; value: number; tone?: number }[]; rows?: number; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const max = Math.max(1, ...columns.map((c) => c.value));
  const cw = w / Math.max(1, columns.length);
  const r = Math.min(cw * 0.32, (height - 20) / rows * 0.34);
  const colours = ["#1f5eff", "#cff25c", "#8fb4ff", "#d6e3ff"];
  return (
    <div ref={ref}>
      <svg width={w} height={height}>
        {columns.map((col, i) => {
          const filled = Math.round((col.value / max) * rows);
          return Array.from({ length: rows }).map((_, k) => {
            const on = k < filled;
            const cy = height - 16 - k * ((height - 20) / rows) - r;
            return <circle key={`${i}-${k}`} cx={cw * i + cw / 2} cy={cy} r={r}
              fill={on ? colours[(i + k + (col.tone ?? 0)) % (k === filled - 1 ? 1 : colours.length)] : "#f1f2f5"} />;
          });
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- target arc (layout / heatmap / live)
export interface ArcTarget { id: string; angle: number; row: string; fill?: string; label?: string; sub?: string; ring?: string; pulse?: boolean }
export function TargetArc({ targets, height = 220, athlete = true }: { targets: ArcTarget[]; height?: number; athlete?: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  // One ring of targets around the athlete; sub-labels sit radially outside each target.
  const cx = w / 2, cy = height - 30;
  const labelRoom = targets.some((t) => t.sub) ? 26 : 8;
  const R = Math.max(60, Math.min(w / 2 - 30 - labelRoom, height - 54 - labelRoom));
  const span = targets.length > 1 ? Math.abs(targets[targets.length - 1]!.angle - targets[0]!.angle) / (targets.length - 1) : 40;
  const chord = 2 * R * Math.sin(((span || 20) * Math.PI) / 360);
  const rad = Math.max(13, Math.min(22, chord * 0.4));
  return (
    <div ref={ref}>
      <svg width={w} height={height}>
        <path d={`M${cx - R},${cy} A${R},${R} 0 0 1 ${cx + R},${cy}`} fill="none" stroke="#eef0f3" strokeWidth="2" strokeDasharray="4 6" />
        {athlete && <>
          <circle cx={cx} cy={cy} r="15" fill="#0f1420" />
          <circle cx={cx} cy={cy - 4} r="4.5" fill="#cff25c" />
          <text x={cx} y={cy + 27} textAnchor="middle" fontSize="11" fill="#9aa0aa">athlete</text>
        </>}
        {targets.map((t) => {
          const a = (-90 + t.angle) * (Math.PI / 180);
          const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
          const lx = cx + Math.cos(a) * (R + rad + 14), ly = cy + Math.sin(a) * (R + rad + 14);
          const dark = t.fill && !["#f1f2f5", "#eceef2"].includes(t.fill);
          return (
            <g key={t.id}>
              {t.pulse && <circle cx={x} cy={y} r={rad + 8} fill={t.fill} opacity=".25"><animate attributeName="r" values={`${rad};${rad + 12};${rad}`} dur="1s" repeatCount="indefinite" /></circle>}
              <circle cx={x} cy={y} r={rad} fill={t.fill ?? "#f1f2f5"} stroke={t.ring ?? "#fff"} strokeWidth="3" style={{ transition: "fill .12s" }} />
              <text x={x} y={y + 4} textAnchor="middle" fontSize={rad > 17 ? 12 : 10.5} fontWeight="600" fill={dark ? "#0f1420" : "#6b717d"}>{t.label ?? t.id}</text>
              {t.sub && <text x={lx} y={ly + 4} textAnchor={Math.abs(lx - cx) < 12 ? "middle" : lx < cx ? "end" : "start"} fontSize="11" fill="#3a4150">{t.sub}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- centre-of-pressure plot
export function CopPlot({ path = [], live, size = 220, half = 60 }: { path?: [number, number][]; live?: { x: number; y: number } | null; size?: number; half?: number }) {
  const s = (v: number) => size / 2 + (v / half) * (size / 2 - 14);
  const sy = (v: number) => size / 2 - (v / half) * (size / 2 - 14);
  const d = path.map(([x, y], i) => `${i ? "L" : "M"}${s(x).toFixed(1)},${sy(y).toFixed(1)}`).join(" ");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ maxWidth: "100%" }}>
      <rect x="4" y="4" width={size - 8} height={size - 8} rx="22" fill="#f6f7f9" stroke="#e6e8ec" />
      {[0.33, 0.66].map((f) => <circle key={f} cx={size / 2} cy={size / 2} r={(size / 2 - 14) * f} fill="none" stroke="#e6e8ec" strokeDasharray="3 5" />)}
      <line x1={size / 2} x2={size / 2} y1="14" y2={size - 14} stroke="#e6e8ec" />
      <line y1={size / 2} y2={size / 2} x1="14" x2={size - 14} stroke="#e6e8ec" />
      <text x={size / 2} y="22" textAnchor="middle" fontSize="10" fill="#9aa0aa">front</text>
      <text x={size - 12} y={size / 2 - 6} textAnchor="end" fontSize="10" fill="#9aa0aa">right</text>
      {d && <path d={d} fill="none" stroke="#1f5eff" strokeOpacity=".55" strokeWidth="1.6" strokeLinejoin="round" />}
      {live && <>
        <circle cx={s(live.x)} cy={sy(live.y)} r="14" fill="#cff25c" fillOpacity=".45" />
        <circle cx={s(live.x)} cy={sy(live.y)} r="7" fill="#1f5eff" stroke="#fff" strokeWidth="2.5" />
      </>}
    </svg>
  );
}

// ---------------------------------------------------------------- per-trial strip
export function TrialStrip({ trials, height = 150 }: { trials: { trial_no: number; rt_ms: number | null; result: string; excluded: string | null }[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const vals = trials.map((t) => t.rt_ms).filter((v): v is number => v != null);
  const hi = niceMax(Math.max(600, ...vals) * 1.05), lo = 0;
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const x = (i: number) => pad.l + (trials.length === 1 ? 0.5 : i / (trials.length - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <svg width={w} height={height}>
        {[0, hi / 4, hi / 2, (hi * 3) / 4, hi].map((t) => <g key={t}>
          <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="#eef0f3" strokeDasharray="3 5" />
          <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#9aa0aa">{t}</text>
        </g>)}
        {trials.map((t, i) => {
          const v = t.rt_ms ?? hi * 0.04;
          return (
            <g key={t.trial_no} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <line x1={x(i)} x2={x(i)} y1={height - pad.b} y2={y(v)} stroke="#f1f2f5" strokeWidth="6" strokeLinecap="round" />
              <circle cx={x(i)} cy={y(v)} r={hover === i ? 7 : 5} fill={RESULT_COLOUR[t.result] ?? "#ccc"}
                stroke={t.excluded ? "#0f1420" : "#fff"} strokeWidth="2" strokeDasharray={t.excluded ? "2 2" : undefined} />
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: x(hover), top: y(trials[hover]!.rt_ms ?? hi * 0.04) - 6 }}>
          Trial {trials[hover]!.trial_no + 1} · <b>{trials[hover]!.rt_ms != null ? `${trials[hover]!.rt_ms!.toFixed(0)} ms` : "no response"}</b> · {trials[hover]!.result.replace("_", " ")}
          {trials[hover]!.excluded && " (outlier)"}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- horizontal split bar (decision vs movement)
export function SplitBar({ a, b, labels = ["Decision", "Movement"] }: { a: number | null; b: number | null; labels?: [string, string] }) {
  if (a == null || b == null) return <div className="muted" style={{ fontSize: 13 }}>Needs wrist IMU data</div>;
  const t = a + b;
  return (
    <div>
      <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", background: "#f1f2f5" }}>
        <span style={{ width: `${(a / t) * 100}%`, background: "#1f5eff" }} />
        <span style={{ width: `${(b / t) * 100}%`, background: "#cff25c" }} />
      </div>
      <div className="row between mt-8" style={{ fontSize: 13 }}>
        <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "#1f5eff", marginRight: 6 }} />{labels[0]} <b>{a.toFixed(0)} ms</b></span>
        <span>{labels[1]} <b>{b.toFixed(0)} ms</b><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "#cff25c", marginLeft: 6 }} /></span>
      </div>
    </div>
  );
}

export { rtColour };
