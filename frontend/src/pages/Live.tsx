import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BarChart3, OctagonX, Play, ShieldAlert, Square } from "lucide-react";
import { api, type Protocol, type Run } from "../api";
import { CopPlot, Sparkline, TargetArc, type ArcTarget } from "../charts";
import { copFromCorners, ms, RESULT_COLOUR, RESULT_LABEL, useAsync, useStationFeed, type FeedMessage } from "../lib";
import { Card, Empty, Kpi, Progress, Skeleton, StatusChip, useToast } from "../ui";

const STATION = "station-1";
const LAYOUT = Array.from({ length: 8 }, (_, i) => ({ id: `T${i + 1}`, angle: -70 + i * 20, row: i % 2 === 0 ? "upper" : "lower" }));
const COLOURS: Record<string, string> = { green: "#cff25c", red: "#ff3b30", blue: "#1f5eff", yellow: "#ffd33d", white: "#ffffff" };

interface LiveTrial { key: string; trial_no: number; target: string; nogo: boolean; t_stim: number; rt?: number; result?: string; pressed?: string }

export default function Live() {
  const toast = useToast();
  const [params] = useSearchParams();
  const athletes = useAsync(() => api.athletes(), []);
  const protocols = useAsync(() => api.protocols(), []);
  const [athleteId, setAthleteId] = useState<number | null>(params.get("athlete") ? Number(params.get("athlete")) : null);
  const [protocol, setProtocol] = useState("choice_rt");
  const [nTrials, setNTrials] = useState<number | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);

  // live state
  const [lit, setLit] = useState<{ target: string; colour: string } | null>(null);
  const [flash, setFlash] = useState<{ target: string; result: string } | null>(null);
  const [trials, setTrials] = useState<LiveTrial[]>([]);
  const [cop, setCop] = useState<{ x: number; y: number } | null>(null);
  const [copTrail, setCopTrail] = useState<[number, number][]>([]);
  const [imu, setImu] = useState<number[]>([]);
  const [hub, setHub] = useState<Record<string, any> | null>(null);
  const [blockDone, setBlockDone] = useState<string | null>(null);
  const open = useRef(new Map<string, LiveTrial>());
  const blockRef = useRef<string | null>(null);
  blockRef.current = run?.block_id ?? null;

  useEffect(() => {
    if (athleteId == null && athletes.data?.length) setAthleteId(athletes.data[0]!.id);
  }, [athletes.data, athleteId]);
  const athlete = athletes.data?.find((a) => a.id === athleteId) ?? null;
  const proto: Protocol | undefined = protocols.data?.find((p) => p.key === protocol);

  const connected = useStationFeed(STATION, (m: FeedMessage) => {
    if (m.type === "device_status") { setHub(m.status); return; }
    if (m.type === "telemetry.balance") {
      const c = copFromCorners(m.sample);
      setCop(c);
      if (c) setCopTrail((t) => [...t.slice(-120), [c.x, c.y]]);
      return;
    }
    if (m.type === "telemetry.imu") {
      const [ax, ay, az] = m.sample;
      setImu((v) => [...v.slice(-100), Math.abs(Math.hypot(ax, ay, az) - 9.81)]);
      return;
    }
    if (m.type !== "event") return;
    const e = m.event;
    const mine = !blockRef.current || e.block_id === blockRef.current;
    if (!mine) return;
    const key = `${e.block_id}:${e.trial_no}`;
    switch (e.type) {
      case "block_started":
        open.current.clear(); setTrials([]); setBlockDone(null);
        setRun((r) => (r && r.block_id === e.block_id ? { ...r, status: "running" } : r));
        break;
      case "stimulus_on": {
        const t: LiveTrial = { key, trial_no: e.trial_no, target: e.target_id, nogo: !!e.data?.is_nogo, t_stim: e.t_us };
        open.current.set(key, t);
        setLit({ target: e.target_id, colour: e.colour ?? "green" });
        setTrials((ts) => [...ts.filter((x) => x.key !== key), t]);
        break;
      }
      case "response": {
        const t = open.current.get(key);
        if (!t || t.result) break;
        t.rt = (e.t_us - t.t_stim) / 1000;
        t.pressed = e.target_id;
        t.result = t.rt < 100 ? "anticipation" : t.nogo ? "false_alarm" : e.target_id !== t.target ? "wrong_target" : "hit";
        setFlash({ target: e.target_id, result: t.result });
        setTrials((ts) => ts.map((x) => (x.key === key ? { ...t } : x)));
        break;
      }
      case "false_start":
        setFlash({ target: e.target_id, result: "false_start" });
        break;
      case "stimulus_off": {
        setLit(null);
        const t = open.current.get(key);
        if (t && !t.result) {
          t.result = t.nogo ? "correct_rejection" : "miss";
          setTrials((ts) => ts.map((x) => (x.key === key ? { ...t } : x)));
        }
        break;
      }
      case "block_done":
      case "block_aborted":
        setLit(null);
        setBlockDone(e.type === "block_done" ? "done" : "aborted");
        setRun((r) => (r ? { ...r, status: e.type === "block_done" ? "done" : "aborted" } : r));
        break;
    }
  });

  useEffect(() => { if (!flash) return; const id = setTimeout(() => setFlash(null), 450); return () => clearTimeout(id); }, [flash]);

  async function start() {
    if (!athlete || !proto) return;
    setBusy(true);
    try {
      const r = await api.startRun(athlete.id, { protocol, station: STATION, params: nTrials ? { n_trials: nTrials } : {} });
      setRun(r); setTrials([]); setBlockDone(null); open.current.clear();
      toast(`${proto.name} started for ${athlete.display_name || athlete.code}`);
    } catch (e) { toast((e as Error).message, true); }
    finally { setBusy(false); }
  }
  async function stop(estop = false) {
    try {
      if (run && !blockDone) await api.stopRun(run.id, estop);
      else await api.command(STATION, estop ? "estop" : "stop");
      toast(estop ? "Emergency stop sent: all targets off" : "Stop sent");
    } catch (e) { toast((e as Error).message, true); }
  }

  const scored = trials.filter((t) => t.result);
  const hits = scored.filter((t) => t.result === "hit");
  const hitRts = hits.map((t) => t.rt!).sort((a, b) => a - b);
  const mid = Math.floor(hitRts.length / 2);
  const median = !hitRts.length ? null : hitRts.length % 2 ? hitRts[mid]! : (hitRts[mid - 1]! + hitRts[mid]!) / 2;
  const goTrials = scored.filter((t) => !t.nogo);
  const total = run?.n_trials ?? 0;
  const running = run && !blockDone && run.status !== "failed";
  const lastRt = [...trials].reverse().find((t) => t.rt != null)?.rt ?? null;

  const arc: ArcTarget[] = useMemo(() => LAYOUT.map((t) => {
    const isLit = lit?.target === t.id;
    const isFlash = flash?.target === t.id;
    return {
      ...t,
      fill: isFlash ? RESULT_COLOUR[flash!.result] : isLit ? COLOURS[lit!.colour] ?? "#cff25c" : "#f1f2f5",
      ring: isLit ? "#0f1420" : "#fff",
      pulse: isLit,
      sub: (() => { const last = [...trials].reverse().find((x) => x.target === t.id && x.rt != null); return last ? `${last.rt!.toFixed(0)}` : undefined; })(),
    };
  }), [lit, flash, trials]);

  return (
    <>
      <div className="headline">
        <div style={{ marginRight: "auto" }}>
          <h1>Live session</h1>
          <div className="sub row" style={{ gap: 8 }}>
            <span className={`pulse ${connected && hub?.online ? "" : "off"}`} />
            {hub?.online ? `${STATION} · hub ${hub.device_id ?? ""} online` : "Hub offline. Check power and Wi-Fi."}
            {hub?.battery_pct != null && <span className="chip">{Math.round(hub.battery_pct)}% battery</span>}
            {hub?.rssi != null && <span className="chip">{Math.round(hub.rssi)} dBm</span>}
          </div>
        </div>
        {run && blockDone && <Link className="btn" to={`/analysis/run/${run.id}`}><BarChart3 size={16} />View analysis</Link>}
        {running
          ? <button className="btn dark" onClick={() => stop(false)}><Square size={15} />Stop block</button>
          : <button className="btn primary" onClick={start} disabled={busy || !athlete || !athlete.consent.data || !hub?.online}><Play size={16} />Start {proto?.name ?? "block"}</button>}
      </div>

      <div className="grid g-dash">
        <div className="span-4 stack">
          <Card title="Athlete">
            {!athletes.data ? <Skeleton h={44} /> : !athletes.data.length ? <Empty>No athletes yet. <Link to="/athletes" style={{ color: "var(--blue)" }}>Add one</Link></Empty> : <>
              <select className="select" value={athleteId ?? ""} onChange={(e) => setAthleteId(Number(e.target.value))} disabled={!!running} aria-label="Athlete">
                {athletes.data.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.code} · {a.sport ?? a.group}</option>)}
              </select>
              {athlete && !athlete.consent.data && (
                <div className="insight mt-12" style={{ background: "var(--amber-2)", color: "#7a4f00" }}>
                  <h4 style={{ color: "#7a4f00" }}><ShieldAlert size={16} />Data consent missing</h4>
                  No session can be recorded until consent is on file. <Link to={`/athletes/${athlete.id}`} style={{ textDecoration: "underline" }}>Record consent</Link>
                </div>
              )}
            </>}
          </Card>
          <Card title="Protocol" sub={proto ? `${proto.kind} · ${proto.n_trials} trials · window ${proto.window_ms} ms` : undefined}>
            <div className="proto-grid">
              {(protocols.data ?? []).map((p) => (
                <button key={p.key} className={`proto ${p.key === protocol ? "on" : ""}`} onClick={() => setProtocol(p.key)} disabled={!!running}
                  aria-label={`${p.name}: ${p.description}`} aria-pressed={p.key === protocol}>
                  <b>{p.name}</b><span>{p.description}</span>
                </button>
              ))}
            </div>
            <label className="field mt-16">Trials (blank = protocol default)
              <input className="input" type="number" min={1} max={64} placeholder={String(proto?.n_trials ?? "")} value={nTrials ?? ""}
                onChange={(e) => setNTrials(e.target.value ? Math.min(64, Math.max(1, Number(e.target.value))) : null)} disabled={!!running} />
            </label>
          </Card>
        </div>

        <div className="span-8 stack">
          <Card title="Targets" sub={run ? `${run.protocol_name} · ${run.block_id}` : "Target layout (lit target shown live)"}
            action={run ? <StatusChip status={blockDone ?? run.status} /> : undefined}>
            <TargetArc targets={arc} height={260} />
            <div className="row between mt-8" style={{ fontSize: 13 }}>
              <span className="muted">Trial {Math.min(scored.length + (lit ? 1 : 0), total || 0)} / {total || "–"}</span>
              <div className="legend">
                {["hit", "wrong_target", "false_alarm", "false_start", "miss"].map((k) => <span key={k}><i style={{ background: RESULT_COLOUR[k] }} />{RESULT_LABEL[k]}</span>)}
              </div>
            </div>
            <div className="mt-8"><Progress value={total ? scored.length / total : 0} tone="blue" /></div>
          </Card>

          <div className="kpis" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
            <Kpi label="Last response" value={ms(lastRt)} unit="ms" />
            <Kpi label="Median (hits)" value={ms(median)} unit="ms" />
            <Kpi label="Accuracy" value={goTrials.length ? `${Math.round((hits.length / goTrials.length) * 100)}` : "–"} unit="%" />
            <Kpi label="Errors" value={scored.filter((t) => !["hit", "correct_rejection"].includes(t.result!)).length} note="wrong, miss, no-go, early" />
          </div>
        </div>

        <Card className="span-4" title="Response feed" sub="Newest first">
          {trials.length ? [...trials].reverse().slice(0, 9).map((t) => (
            <div key={t.key} className="feed-row">
              <span className="chip" style={{ justifyContent: "center", padding: 0 }}>{t.target}</span>
              <span style={{ color: t.result ? RESULT_COLOUR[t.result] === "#cff25c" ? "#5a7000" : RESULT_COLOUR[t.result] : "var(--muted)" }}>
                {t.result ? RESULT_LABEL[t.result] : "lit…"}{t.pressed && t.pressed !== t.target ? ` (pressed ${t.pressed})` : ""}
              </span>
              <b>{t.rt != null ? `${t.rt.toFixed(0)} ms` : ""}</b>
            </div>
          )) : <Empty>Responses appear here as the athlete hits targets.</Empty>}
        </Card>

        <Card className="span-4" title="Balance" sub="Live centre of pressure (mm)">
          <div style={{ display: "grid", placeItems: "center" }}><CopPlot path={copTrail} live={cop} size={230} /></div>
          <div className="row between mt-8" style={{ fontSize: 13 }}>
            <span className="muted">ML {cop ? cop.x.toFixed(1) : "–"} · AP {cop ? cop.y.toFixed(1) : "–"}</span>
            <span className="muted">{copTrail.length ? "board loaded" : "no load"}</span>
          </div>
        </Card>

        <Card className="span-4" title="Wrist motion" sub="|acceleration − g| (m/s²), throttled live view">
          <Sparkline values={imu.length > 1 ? imu : [0, 0]} height={150} colour="#1f5eff" />
          <p className="muted mt-12" style={{ fontSize: 13 }}>Bursts mark movement onset. Analysis splits each response into decision and movement time from the full-rate stream.</p>
        </Card>
      </div>

      <button className="estop" onClick={() => stop(true)} aria-label="Emergency stop"><OctagonX size={20} />E-STOP</button>
    </>
  );
}
