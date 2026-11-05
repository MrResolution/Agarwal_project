import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity, Bone, Check, Cpu, FlipHorizontal, Lightbulb, ListOrdered, PersonStanding, Play, Ruler, ScanLine, ShieldCheck,
  Spline, Square, Video, Waves, X,
} from "lucide-react";
import { Gauge, TimeSeries } from "../charts";
import { RESULT_COLOUR, RESULT_LABEL } from "../lib";
import { LEAN_ALERT, LEAN_WARN, leanTone, sideLabel, type LR, type Region } from "../pose/metrics";
import { PoseCanvas, usePose } from "../pose/PoseContext";
import type { CameraInfo, PoseTracker, Snapshot, Source } from "../pose/tracker";
import { Card, Empty } from "../ui";

const REGIONS: { key: Region; label: string }[] = [
  { key: "head", label: "Head" }, { key: "shoulders", label: "Shoulders" }, { key: "hips", label: "Hips" },
  { key: "knees", label: "Knees" }, { key: "ankles", label: "Feet" },
];
const f0 = (v: number | null | undefined, unit = "") => (v == null ? "–" : `${v.toFixed(0)}${unit}`);
const f1 = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(1));

export default function Tracking() {
  const [tracker, snap] = usePose();
  const [choice, setChoice] = useState<Source>(snap.source ?? "camera");
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const running = snap.status === "running";
  const busy = snap.status === "starting" || snap.status === "loading";

  useEffect(() => { if (snap.source) setChoice(snap.source); }, [snap.source]);
  // Camera names are only readable once permission has been granted, so refresh after starting.
  useEffect(() => { tracker.listCameras().then(setCameras).catch(() => setCameras([])); }, [tracker, snap.status]);

  const start = (src: Source = choice) => { setChoice(src); void tracker.start(src, src === "camera" ? deviceId || undefined : undefined); };
  const idleButtons = (
    <div className="row wrap" style={{ justifyContent: "center", gap: 8, marginTop: 14 }}>
      <button className="btn lime" onClick={() => start("camera")}><Video size={16} />Start camera</button>
      <button className="btn ghost light" onClick={() => start("sim")}><PersonStanding size={16} />Simulated athlete</button>
    </div>
  );

  return (
    <div>
      <div className="headline">
        <div className="title">
          <h1>Body tracking</h1>
          <div className="sub">
            <span className={`pulse ${running ? "" : "off"}`} />
            {running ? (snap.source === "camera" ? `Camera: ${snap.cameraLabel ?? "on"}` : "Simulated athlete (no camera needed)")
              : busy ? snap.message : snap.status === "error" ? "Stopped: see the message on the feed" : "Camera off"}
            {running && snap.frameSize && <span className="chip">{snap.frameSize.w}×{snap.frameSize.h}</span>}
            <span className="chip"><ShieldCheck size={13} />Not recorded</span>
          </div>
        </div>
        <div className="seg" role="group" aria-label="Video source">
          <button className={choice === "camera" ? "on" : ""} onClick={() => setChoice("camera")} disabled={busy}>Camera</button>
          <button className={choice === "sim" ? "on" : ""} onClick={() => setChoice("sim")} disabled={busy}>Simulated athlete</button>
        </div>
        {choice === "camera" && cameras.length > 1 && (
          <select className="select pill" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="Camera" disabled={busy}>
            <option value="">Default camera</option>
            {cameras.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
          </select>
        )}
        {running || busy
          ? <button className="btn dark" onClick={() => tracker.stop()}><Square size={15} />Stop</button>
          : <button className="btn primary" onClick={() => start()}><Play size={16} />{choice === "camera" ? "Start camera" : "Start simulation"}</button>}
      </div>

      <div className="grid g-dash">
        <Card className="span-8" i={0} icon={<ScanLine size={18} />} iconTone="blue" title="Camera feed" sub="33-point skeleton · MediaPipe Pose, running in this browser"
          action={<OverlayToggles tracker={tracker} snap={snap} />}>
          <PoseCanvas idle={idleButtons} />
          <div className="row between wrap mt-12" style={{ fontSize: 13, gap: 8 }}>
            <span className="muted">Coloured by the athlete's side. Solid line: trunk axis against the dashed vertical. Dashes under the feet: base of support, with the hips marked.</span>
            {running && snap.source === "camera" && <span className="chip">{snap.delegate ?? "–"} · {snap.model} model</span>}
          </div>
        </Card>

        <div className="span-4 stack t-row">
          <PostureCard snap={snap} />
          <JointCard snap={snap} />
        </div>

        <StabilityCard snap={snap} />
        <QualityCard tracker={tracker} snap={snap} />
        <ResponsesCard snap={snap} />
        <PrivacyCard />
      </div>
    </div>
  );
}

function OverlayToggles({ tracker, snap }: { tracker: PoseTracker; snap: Snapshot }) {
  const o = snap.overlay;
  const items: { key: keyof typeof o; label: string; icon: ReactNode }[] = [
    { key: "skeleton", label: "Skeleton", icon: <Bone size={13} /> },
    { key: "angles", label: "Angles", icon: <Ruler size={13} /> },
    { key: "trails", label: "Trails", icon: <Spline size={13} /> },
    { key: "mirror", label: "Mirror", icon: <FlipHorizontal size={13} /> },
  ];
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {items.map((it) => (
        <button key={it.key} className={`chip toggle ${o[it.key] ? "on" : ""}`} aria-pressed={o[it.key]} onClick={() => tracker.setOverlay({ [it.key]: !o[it.key] })}>
          {it.icon}{it.label}
        </button>
      ))}
    </div>
  );
}

function Metric({ label, value, note, tone = "ok" }: { label: string; value: ReactNode; note?: ReactNode; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className={`metric ${tone}`}>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {note && <div className="n">{note}</div>}
    </div>
  );
}

function PostureCard({ snap }: { snap: Snapshot }) {
  const m = snap.metrics;
  const tilt = (v: number | null | undefined) => (v == null ? "–" : Math.abs(v) < 0.5 ? "level" : `${v > 0 ? "left" : "right"} higher`);
  const over = m?.pelvis && m.ankles.L && m.ankles.R ? m.pelvis.x >= Math.min(m.ankles.L.x, m.ankles.R.x) && m.pelvis.x <= Math.max(m.ankles.L.x, m.ankles.R.x) : null;
  return (
    <Card i={1} icon={<PersonStanding size={18} />} iconTone="lime" title="Posture now" sub="Trunk and pelvis, live">
      <div className="metric-grid">
        <Metric label="Side lean" value={sideLabel(m?.trunkLean ?? null)} tone={leanTone(m?.trunkLean ?? null)} note="trunk vs vertical" />
        <Metric label="Forward lean" value={f0(m?.trunkForward, "°")} note="estimate" />
        <Metric label="Shoulder tilt" value={f0(m?.shoulderTilt == null ? null : Math.abs(m.shoulderTilt), "°")} note={tilt(m?.shoulderTilt)} />
        <Metric label="Hip tilt" value={f0(m?.hipTilt == null ? null : Math.abs(m.hipTilt), "°")} note={tilt(m?.hipTilt)} />
      </div>
      <div className="row between mt-12" style={{ fontSize: 13 }}>
        <span className="muted">Stance <b className="ink">{m?.stance != null ? `${m.stance.toFixed(1)}× hip width` : "–"}</b></span>
        <span className={`chip ${over == null ? "" : over ? "green" : "amber"}`}>{over == null ? "Base: –" : over ? "Centred over feet" : "Outside base"}</span>
      </div>
    </Card>
  );
}

function LRRow({ label, v, max = 180 }: { label: string; v: LR | undefined; max?: number }) {
  const L = v?.L ?? null, R = v?.R ?? null;
  const diff = L != null && R != null ? Math.abs(L - R) : null;
  const w = (x: number | null) => `${x == null ? 0 : Math.min(100, (x / max) * 100)}%`;
  return (
    <div className="lr-row">
      <span className="lbl">{label}</span>
      <span className="val">{f0(L, "°")}</span>
      <span className="bar l"><i style={{ width: w(L) }} /></span>
      <span className="bar r"><i style={{ width: w(R) }} /></span>
      <span className="val">{f0(R, "°")}</span>
      <span className={`diff ${diff != null && diff >= 15 ? "warn" : ""}`} title="Left–right difference">{diff == null ? "" : `Δ${diff.toFixed(0)}`}</span>
    </div>
  );
}

function JointCard({ snap }: { snap: Snapshot }) {
  const m = snap.metrics;
  return (
    <Card i={2} icon={<Ruler size={18} />} iconTone="blue" title="Joint angles" sub="Flexion in degrees · left | right">
      <div className="lr-head"><span /><span>Left</span><span /><span /><span>Right</span><span /></div>
      <LRRow label="Knee" v={m?.knee} max={150} />
      <LRRow label="Hip" v={m?.hip} max={150} />
      <LRRow label="Elbow" v={m?.elbow} max={150} />
      <LRRow label="Shoulder" v={m?.shoulder} max={180} />
      <p className="hint mt-12">Δ marks left–right differences of 15° or more. Shoulder is arm elevation from the trunk.</p>
    </Card>
  );
}

function StabilityCard({ snap }: { snap: Snapshot }) {
  const st = snap.stability;
  const now = snap.history.length ? snap.history[snap.history.length - 1]!.t : 0;
  const series = [
    { key: "lean", label: "Side lean (°)", colour: "#1f5eff", unit: "°", values: snap.history.map((h) => ({ t: (h.t - now) / 1000, v: h.lean })) },
    { key: "off", label: "Hip offset (cm)", colour: "#8db000", unit: "cm", values: snap.history.map((h) => ({ t: (h.t - now) / 1000, v: h.offsetCm })) },
  ];
  const wrist = Math.max(snap.wristSpeed.L ?? 0, snap.wristSpeed.R ?? 0);
  return (
    <Card className="span-8" i={3} icon={<Waves size={18} />} iconTone="lime" title="Stability" sub="Last 20 s · + = towards the athlete's left">
      <div className="mini-kpis">
        <div><div className="v">{f1(st.swayRmsCm)}<small>cm</small></div><div className="l">Lateral sway (RMS, 10 s)</div></div>
        <div><div className="v">{f1(st.swaySpeedCms)}<small>cm/s</small></div><div className="l">Sway speed</div></div>
        <div className={leanTone(st.peakLean)}><div className="v">{f0(st.peakLean == null ? null : Math.abs(st.peakLean), "°")}</div><div className="l">Peak side lean (10 s)</div></div>
        <div><div className="v">{snap.tracked ? wrist.toFixed(1) : "–"}<small>m/s</small></div><div className="l">Wrist speed now</div></div>
      </div>
      <div className="mt-12">
        {snap.history.length > 2
          ? <TimeSeries series={series} limit={LEAN_WARN} limitLabel={`±${LEAN_WARN}° lean`} height={190} />
          : <Empty icon={<Activity size={20} />}>Sway and trunk lean are charted here once tracking starts.</Empty>}
      </div>
      <div className="legend mt-8">
        {series.map((s) => <span key={s.key}><i style={{ background: s.colour }} />{s.label}</span>)}
        <span><i style={{ background: "#ffb020" }} />Lean flag (alert at {LEAN_ALERT}°)</span>
      </div>
    </Card>
  );
}

function QualityCard({ tracker, snap }: { tracker: PoseTracker; snap: Snapshot }) {
  const m = snap.metrics;
  const g = snap.guidance;
  const vis = m ? m.visibility : null;
  return (
    <Card className="span-4 t-6" i={4} icon={<Cpu size={18} />} title="Tracking quality" sub="Is the whole body in view?">
      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: "none" }}>
          <Gauge value={vis} size={104} label="visible" colour={vis != null && vis < 0.7 ? "#ffb020" : "#cff25c"} />
        </div>
        <ul className="check-list">
          {REGIONS.map((r) => {
            const okR = !!m?.present[r.key];
            return <li key={r.key} className={okR ? "ok" : ""}>{okR ? <Check size={14} /> : <X size={14} />}{r.label}</li>;
          })}
        </ul>
      </div>
      <div className={`insight mt-12 tone-${snap.status === "running" ? g.tone : "idle"}`}>
        <h4><Lightbulb size={15} />{snap.status === "running" ? (g.tone === "ok" ? "Good framing" : "Adjust the camera") : "Waiting for video"}</h4>
        {snap.status === "running" ? g.text : "Start the camera or the simulated athlete."}
      </div>
      <div className="kv mt-12">
        <span>Model</span>
        <span className="seg sm">
          {(["lite", "full"] as const).map((k) => (
            <button key={k} className={snap.model === k ? "on" : ""} onClick={() => void tracker.setModel(k)} disabled={snap.source === "sim"}>{k === "lite" ? "Lite (fast)" : "Full (accurate)"}</button>
          ))}
        </span>
        <span>Runs on</span><span>{snap.source === "sim" ? "Simulation" : snap.delegate ?? "–"}</span>
        <span>Model time</span><span>{snap.inferenceMs != null ? `${snap.inferenceMs.toFixed(0)} ms / frame` : "–"}</span>
        <span>Frame rate</span><span>{snap.fps != null && snap.status === "running" ? `${Math.round(snap.fps)} fps` : "–"}</span>
      </div>
    </Card>
  );
}

function ResponsesCard({ snap }: { snap: Snapshot }) {
  const rows = snap.responses;
  return (
    <Card className="span-8" i={5} icon={<ListOrdered size={18} />} title="Posture at each touch"
      sub={snap.blockId ? `Block ${snap.blockId}${snap.source === "sim" ? " · simulated athlete" : ""}` : "Matched live to hub events on station-1"}
      action={<Link className="btn sm ghost" to="/live">Live session</Link>}>
      {rows.length ? (
        <div className="scroll-x" style={{ maxHeight: 330, overflowY: "auto" }}>
          <table className="table">
            <thead><tr><th>#</th><th>Target</th><th>Result</th><th>Hand</th><th>Side lean</th><th>Forward</th><th>Knees</th><th>Peak wrist</th><th>RT</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.trialNo + 1}</td>
                  <td>{r.target}{r.touched && r.touched !== r.target ? <span className="muted"> → {r.touched}</span> : null}</td>
                  <td><span className="dot-label"><i style={{ background: RESULT_COLOUR[r.result] }} />{RESULT_LABEL[r.result]}</span></td>
                  <td>{r.hand === "L" ? "Left" : r.hand === "R" ? "Right" : "–"}</td>
                  <td className={`tone-${leanTone(r.lean)}`}>{sideLabel(r.lean)}</td>
                  <td>{f0(r.forward, "°")}</td>
                  <td>{f0(r.knee, "°")}</td>
                  <td>{r.peakSpeed != null ? `${r.peakSpeed.toFixed(1)} m/s` : "–"}</td>
                  <td>{r.rtMs != null ? `${r.rtMs.toFixed(0)} ms` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon={<ListOrdered size={20} />}>
          {snap.status === "running"
            ? <>Start a block from <Link to="/live" style={{ color: "var(--blue)" }}>Live session</Link>. Each touch adds a row: which hand reached, trunk lean and knee bend at the moment of the touch.</>
            : "Start tracking, then run a block: the posture at every touch is listed here."}
        </Empty>
      )}
    </Card>
  );
}

function PrivacyCard() {
  return (
    <Card className="span-4 t-6" i={6} icon={<ShieldCheck size={18} />} iconTone="lime" title="Privacy and setup">
      <div className="insight tone-ok">
        <h4><ShieldCheck size={15} />Video stays on this computer</h4>
        Pose tracking runs inside this browser. Frames and landmarks are not recorded or sent to the server, so no video consent is needed to watch live.
      </div>
      <ul className="tips mt-12">
        <li>Camera on a tripod <b>2.5–3.5 m</b> in front of the athlete, at hip height.</li>
        <li>The whole body in frame, head to feet, with the athlete facing the camera.</li>
        <li>Even light and a plain background; avoid a bright window behind the athlete.</li>
        <li>The camera only opens on this computer (<span className="mono">localhost</span>) or over https.</li>
      </ul>
    </Card>
  );
}
