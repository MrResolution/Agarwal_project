import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity, ArrowUpRight, BatteryMedium, CalendarDays, ChevronLeft, ChevronRight, Clock3, Gauge as GaugeIcon, History,
  Play, Radar as RadarIcon, Search, Sparkles, Target, Timer, Trophy, Wifi,
} from "lucide-react";
import { api, type Analysis, type Overview, type Run } from "../api";
import { useMe } from "../App";
import { PodsArt } from "../art";
import { BarChart, DotMatrix, Gauge, Lollipops, Radar, Sparkline, TargetArc } from "../charts";
import { athleteLabel, axisLabels, initials, insights, ms, pct, skillProfile, useAsync, useStationFeed, when, type FeedMessage } from "../lib";
import { Card, CountUp, Empty, ErrorBoundary, Progress, Skeleton, StatusChip } from "../ui";

const PROTO_NAMES: Record<string, string> = {
  simple_rt: "Simple", choice_rt: "Choice", go_nogo: "Go / No-Go", peripheral: "Peripheral", speed_drill: "Speed drill",
};
const localDay = (d: string) => new Date(`${d}T00:00`);

export default function Dashboard() {
  const me = useMe();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const ov = useAsync(() => api.overview(), [], 10000);
  const o = ov.data;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <>
      <div className="headline">
        <div className="title">
          <h1>{greet}, {me.full_name.split(" ")[0]}</h1>
          <div className="sub">{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
            {o && <><span>·</span><span>{o.athletes} athletes · {o.devices_online}/{o.devices_total} hubs online</span></>}</div>
        </div>
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); nav(`/athletes?q=${encodeURIComponent(q)}`); }}>
          <Search size={17} className="muted" />
          <input placeholder="Search athletes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search athletes" />
        </form>
        <Link className="btn primary" to="/live"><Play size={16} />Start session</Link>
      </div>

      {ov.error && !o && <div className="err-card mt-8" style={{ marginBottom: 16 }}>Couldn't load the overview: {ov.error}</div>}

      <div className="grid g-dash">
        <section className="card hero span-5 reveal" style={{ ["--i" as string]: 0 }}>
          <h2>Sharpen every reaction</h2>
          <p className="lede">Reaction, inhibition and balance, measured on every block.</p>
          <Link className="round-link" to="/live" aria-label="Open live session"><ArrowUpRight size={20} /></Link>
          <PodsArt className="hero-art" />
          <div className="glass">
            <div><div className="lbl">Median reaction</div><div className="val"><span className="ico"><Timer size={15} /></span><CountUp value={o?.median_rt_recent} /><small>ms</small></div></div>
            <div><div className="lbl">Accuracy</div><div className="val"><span className="ico"><Target size={15} /></span>
              {o?.accuracy_recent != null ? <><CountUp value={o.accuracy_recent * 100} /><small>%</small></> : "–"}</div></div>
            <div><div className="lbl">Runs this week</div><div className="val"><span className="ico"><GaugeIcon size={15} /></span><CountUp value={o?.runs_this_week} /></div></div>
          </div>
        </section>

        <ErrorBoundary label="Skill overview"><SkillOverview leaderboard={o?.leaderboard ?? []} className="span-7" /></ErrorBoundary>

        <Card className="span-4 t-6" i={2} icon={<Activity size={18} />} iconTone="lime" title="Training activity" sub="Protocol runs per day, last 14 days" to="/analysis">
          {o ? <>
            <div className="row" style={{ alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <span className="big"><CountUp value={o.runs_per_day.slice(-14).reduce((s, d) => s + d.runs, 0)} /></span>
              <span className="muted" style={{ fontSize: 13 }}>runs · {o.completed_this_week} completed this week</span>
            </div>
            <BarChart height={236} items={o.runs_per_day.slice(-14).map((d, i, all) => ({
              label: localDay(d.date).toLocaleDateString(undefined, { day: "2-digit" }), value: d.runs, highlight: i === all.length - 1,
              tip: <><b>{d.runs} run{d.runs === 1 ? "" : "s"}</b> <span className="muted">{localDay(d.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span></>,
            }))} />
            <ProtocolMix mix={o.protocol_mix} />
          </> : <Skeleton h={250} />}
        </Card>

        <ErrorBoundary label="Live station"><LiveStationCard className="span-4 t-6" overview={o} /></ErrorBoundary>

        <Card className="span-4 t-6" i={4} icon={<Target size={18} />} title="Progress & goals" sub="Training load, consent and hardware">
          {o ? <>
            <div className="row between"><span className="muted" style={{ fontSize: 13 }}>Activity, last 3 weeks</span>
              <span className="big" style={{ fontSize: 30 }}><CountUp value={o.runs_per_day.slice(-21).reduce((s, d) => s + d.runs, 0)} /></span></div>
            <DotMatrix height={92} rows={5} columns={o.runs_per_day.slice(-21).map((d, i) => ({ label: d.date, value: d.runs, tone: i }))} />
            <div className="insight mt-8" style={{ padding: "4px 16px" }}>
              <Goal label="Weekly sessions" value={o.completed_this_week} target={10} />
              <Goal label="Recent accuracy" value={o.accuracy_recent} target={1} percent />
              <Goal label="Athletes with data consent" value={o.athletes - o.athletes_without_consent} target={Math.max(1, o.athletes)} />
              <Goal label="Hubs online" value={o.devices_online} target={Math.max(1, o.devices_total)} />
            </div>
          </> : <Skeleton h={300} />}
        </Card>

        <Card className="span-5 t-6" i={5} icon={<History size={18} />} title="Recent runs" sub="Latest protocol blocks across all athletes" to="/analysis">
          {o?.recent_runs.length ? o.recent_runs.slice(0, 6).map((r) => (
            <Link key={r.id} to={`/analysis/run/${r.id}`} className="list-item">
              <span className="initials sm blue">{initials(r.athlete_name, r.athlete_code?.slice(-2))}</span>
              <div className="grow">
                <div className="ellipsis">{r.athlete_name || r.athlete_code}</div>
                <div className="muted ellipsis" style={{ fontSize: 12.5 }}>{r.protocol_name} · {when(r.created_at)}</div>
              </div>
              <div style={{ textAlign: "right", minWidth: 70 }}>
                <div>{r.summary?.median_rt != null ? `${r.summary.median_rt.toFixed(0)} ms` : "–"}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{pct(r.summary?.accuracy)}</div>
              </div>
              <StatusChip status={r.status} />
            </Link>
          )) : o ? <Empty icon={<History size={20} />}>No runs yet. Start one from <Link to="/live" style={{ color: "var(--blue)" }}>Live session</Link>.</Empty> : <Skeleton h={300} />}
        </Card>

        <Leaderboard className="span-3 t-6" o={o} />

        <Card className="span-4 t-6" i={7} icon={<CalendarDays size={18} />} title="Schedule" sub="Days with sessions">
          <Calendar days={o?.runs_per_day ?? []} />
        </Card>
      </div>
    </>
  );
}

function ProtocolMix({ mix }: { mix: Record<string, number> }) {
  const total = Object.values(mix).reduce((s, v) => s + v, 0);
  if (!total) return null;
  const colours = ["#1f5eff", "#cff25c", "#8fb4ff", "#0f1420", "#ffb020"];
  const items = Object.entries(mix).filter(([, n]) => n > 0);
  return (
    <div className="card-foot">
      <div style={{ display: "flex", height: 8, borderRadius: 999, overflow: "hidden", gap: 2 }}>
        {items.map(([k, n], i) => <span key={k} title={`${PROTO_NAMES[k] ?? k}: ${n}`} style={{ width: `${(n / total) * 100}%`, background: colours[i % colours.length], transformOrigin: "left", animation: `grow-x .8s var(--ease) ${0.1 * i}s both` }} />)}
      </div>
      <div className="legend mt-8">{items.map(([k, n], i) => <span key={k}><i style={{ background: colours[i % colours.length] }} />{PROTO_NAMES[k] ?? k} {n}</span>)}</div>
    </div>
  );
}

function Goal({ label, value, target, percent }: { label: string; value: number | null; target: number; percent?: boolean }) {
  const frac = value == null ? 0 : value / target;
  return (
    <div className="goal">
      <div className="row"><span>{label}</span><span className="muted">{percent ? pct(value) : `${value ?? 0}/${target}`}</span></div>
      <Progress value={frac} />
    </div>
  );
}

function Leaderboard({ o, className }: { o: Overview | null; className?: string }) {
  const boards = o?.leaderboards ?? {};
  const keys = Object.keys(boards).sort((a, b) => (boards[b]!.length - boards[a]!.length));
  const [proto, setProto] = useState<string | null>(null);
  const current = proto && boards[proto] ? proto : keys[0];
  const rows = current ? boards[current]! : [];
  return (
    <Card className={className} i={6} icon={<Trophy size={18} />} iconTone="lime" title="Fastest reactions" sub="Ranked within one protocol">
      {!o ? <Skeleton h={300} /> : !keys.length ? <Empty icon={<Trophy size={20} />}>Complete a run to see rankings.</Empty> : <>
        <select className="select pill" value={current} onChange={(e) => setProto(e.target.value)} aria-label="Protocol" style={{ marginBottom: 8, width: "100%" }}>
          {keys.map((k) => <option key={k} value={k}>{PROTO_NAMES[k] ?? k} ({boards[k]!.length})</option>)}
        </select>
        {rows.map((l, i) => (
          <Link key={l.athlete_id} to={`/analysis/run/${l.run_id}`} className="list-item" style={{ animation: `slide-in .35s var(--ease) ${i * 50}ms both` }}>
            <span className={`initials sm ${i ? "blue" : ""}`}>{i === 0 ? <Trophy size={14} /> : i + 1}</span>
            <div className="grow">
              <div className="row between"><span className="ellipsis">{athleteLabel(l)}</span>
                <b style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{ms(l.median_rt)}<span className="muted" style={{ fontSize: 12, fontWeight: 400 }}> ms</span></b></div>
              <div className="muted ellipsis" style={{ fontSize: 12.5, marginBottom: 6 }}>{l.sport ?? "–"} · {pct(l.accuracy)} accuracy</div>
              <Progress value={rows[0]!.median_rt / l.median_rt} tone={i === 0 ? "lime" : "blue"} />
            </div>
          </Link>
        ))}
        <Link to="/analysis" className="hint card-foot" style={{ justifyContent: "center" }}>Compare runs in Analysis <ArrowUpRight size={13} /></Link>
      </>}
    </Card>
  );
}

function Calendar({ days }: { days: { date: string; runs: number }[] }) {
  const now = new Date();
  const [offset, setOffset] = useState(0);
  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const counts = new Map(days.map((d) => [d.date, d.runs]));
  const start = (month.getDay() + 6) % 7; // Monday first
  const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((start + daysIn) / 7) * 7 }, (_, i) => i - start + 1);
  const iso = (d: number) => {
    const dt = new Date(month.getFullYear(), month.getMonth(), d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };
  return (
    <>
      <div className="row between" style={{ marginTop: -4, marginBottom: 10 }}>
        <button className="round-link" onClick={() => setOffset(offset - 1)} aria-label="Previous month" style={{ transform: "none" }}><ChevronLeft size={16} /></button>
        <span style={{ fontSize: 14.5 }}>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        <button className="round-link" onClick={() => setOffset(Math.min(0, offset + 1))} disabled={offset === 0} aria-label="Next month" style={{ transform: "none", opacity: offset === 0 ? .4 : 1 }}><ChevronRight size={16} /></button>
      </div>
      <div className="cal" key={offset} style={{ animation: "fade .3s both" }}>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div key={i} className="dow">{d}</div>)}
        {cells.map((d, i) => {
          const inMonth = d >= 1 && d <= daysIn;
          const n = inMonth ? counts.get(iso(d)) ?? 0 : 0;
          const today = inMonth && offset === 0 && d === now.getDate();
          return (
            <div key={i} className={`d ${!inMonth ? "out" : ""} ${n >= 3 ? "many" : n > 0 ? "has" : ""} ${today ? "today" : ""}`}
              title={inMonth ? `${n} run${n === 1 ? "" : "s"}` : undefined}>
              {inMonth ? d : ""}
            </div>
          );
        })}
      </div>
      <div className="legend card-foot"><span><i style={{ background: "var(--lime)" }} />1–2 runs</span><span><i style={{ background: "var(--blue)" }} />3+ runs</span><span><i style={{ background: "transparent", boxShadow: "0 0 0 2px var(--ink)" }} />today</span></div>
    </>
  );
}

function SkillOverview({ leaderboard, className }: { leaderboard: { athlete_id: number }[]; className?: string }) {
  const athletes = useAsync(() => api.athletes(), []);
  const [athleteId, setAthleteId] = useState<number | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [latest, setLatest] = useState<Analysis | null>(null);
  useEffect(() => {
    if (athleteId == null && athletes.data?.length) setAthleteId(leaderboard[0]?.athlete_id ?? athletes.data[0]!.id);
  }, [athletes.data, leaderboard, athleteId]);
  useEffect(() => {
    if (athleteId == null) return;
    let live = true;
    setRuns(null);
    api.runs(athleteId).then(async (rs) => {
      if (!live) return;
      const done = rs.find((r) => r.status === "done");
      const a = done ? (await api.run(done.id)).analysis : null;
      if (!live) return;
      setLatest(a);
      setRuns(rs);
    }).catch(() => live && setRuns([]));
    return () => { live = false; };
  }, [athleteId]);

  const rtOf = (r: Run) => r.summary?.median_rt ?? (latest && r.block_id === latest.block_id ? latest.summary.rt.median : null);
  const done = (runs ?? []).filter((r) => r.status === "done" && rtOf(r) != null).slice(0, 6).reverse();
  const baseline = done.length >= 2 ? (rtOf(done[0]!)! + rtOf(done[1]!)!) / 2 : null;
  const s = latest?.summary;
  const periphDelta = s?.by_band.peripheral != null && s?.by_band.central != null ? s.by_band.peripheral - s.by_band.central : null;
  const skills = skillProfile(s, periphDelta);
  const tips = insights(latest);
  const latestRun = (runs ?? []).find((r) => r.block_id === latest?.block_id);

  return (
    <Card className={className} i={1} icon={<RadarIcon size={18} />} iconTone="blue" title="Skill overview"
      sub={latestRun ? `${latestRun.protocol_name} · ${when(latestRun.created_at)}` : "Latest completed run"}
      action={<>
        <select className="select pill" value={athleteId ?? ""} onChange={(e) => setAthleteId(Number(e.target.value))} aria-label="Athlete">
          {(athletes.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.display_name || a.code}</option>)}
        </select>
        {latestRun && <Link to={`/analysis/run/${latestRun.id}`} className="round-link hide-sm" aria-label="Open this run"><ArrowUpRight size={16} /></Link>}
      </>}>
      {!athletes.data || runs == null ? <Skeleton h={250} /> : !athletes.data.length ? <Empty>Add an athlete to see their skill profile.</Empty> : !latest ? (
        <Empty icon={<RadarIcon size={20} />}>No completed run for this athlete yet.</Empty>
      ) : (
        <div key={athleteId} style={{ display: "grid", gridTemplateColumns: "minmax(200px,230px) minmax(0,1fr) minmax(0,250px)", gap: 18, alignItems: "center", flex: 1 }} className="skill-grid">
          <div title={skills.map((k) => `${k.label}: ${k.detail}`).join("\n")} style={{ display: "grid", placeItems: "center" }}>
            <Radar axes={skills.map((k) => ({ label: k.label, value: k.value }))} />
          </div>
          <div>
            <div className="row between"><span style={{ fontSize: 14 }}>Median reaction, last runs</span>
              <span className="big" style={{ fontSize: 30 }}><CountUp value={s?.rt.median} /><small>ms</small></span></div>
            <Lollipops height={176} goal={baseline} items={done.map((r, i) => ({ label: axisLabels(done.map((x) => x.created_at))[i]!, value: rtOf(r), highlight: i === done.length - 1 }))} />
            {baseline != null && <div className="hint"><span style={{ width: 14, borderTop: "2px dashed var(--blue)", display: "inline-block" }} />baseline {baseline.toFixed(0)} ms (first two runs)</div>}
          </div>
          <div className="insight" style={{ alignSelf: "stretch" }}>
            <h4><Sparkles size={15} color="#1f5eff" />Coach insight</h4>
            <ul>{tips.slice(0, 3).map((t, i) => <li key={i} style={{ ["--i" as string]: i }}>{t}</li>)}</ul>
          </div>
        </div>
      )}
    </Card>
  );
}

function LiveStationCard({ className, overview }: { className?: string; overview: Overview | null }) {
  const station = "station-1";
  const [rts, setRts] = useState<number[]>([]);
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  const [lastEvent, setLastEvent] = useState<{ type: string; at: number } | null>(null);
  const stim = useRef(new Map<string, number>());
  const connected = useStationFeed(station, (m: FeedMessage) => {
    if (m.type === "device_status") setStatus(m.status);
    if (m.type !== "event") return;
    const e = m.event;
    setLastEvent({ type: e.type, at: Date.now() });
    const key = `${e.block_id}:${e.trial_no}`;
    if (e.type === "stimulus_on") stim.current.set(key, e.t_us);
    if (e.type === "response" && stim.current.has(key)) setRts((r) => [...r.slice(-29), (e.t_us - stim.current.get(key)!) / 1000]);
  });
  const online = !!status?.online;
  const active = lastEvent && Date.now() - lastEvent.at < 8000;
  const latest = rts[rts.length - 1];
  const lastRun = overview?.recent_runs.find((r) => r.status === "done");
  const targets: { id: string; online: boolean }[] = status?.targets ?? [];
  return (
    <Card className={className} i={3} icon={<Wifi size={18} />} iconTone="blue" title="Live station" sub={`${station}${status?.firmware ? ` · ${status.firmware}` : ""}`} to="/live"
      action={<span className={`chip ${online ? "lime" : ""}`}><span className={`pulse ${online && connected ? "" : "off"}`} />{online ? (active ? "Running" : "Online") : "Offline"}</span>}>
      {latest != null ? (
        <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
          <span className="big"><CountUp value={latest} duration={400} /></span><span className="muted">ms latest response</span>
        </div>
      ) : (
        <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
          <span className="big">{lastRun?.summary?.median_rt != null ? lastRun.summary.median_rt.toFixed(0) : "–"}</span>
          <span className="muted">ms median, last run{lastRun ? ` (${lastRun.athlete_name || lastRun.athlete_code})` : ""}</span>
        </div>
      )}
      <div className="hint mt-8">
        <Clock3 size={13} />{active ? `Live: ${lastEvent!.type.replace("_", " ")}` : online ? "Idle. Start a block from Live session" : "Waiting for the hub"}
      </div>
      <div className="mt-12" style={{ flex: 1, minHeight: 150, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {rts.length > 1 ? (
          <div style={{ animation: "fade .4s both" }}>
            <div className="hint" style={{ marginBottom: 4 }}>Response time, last {rts.length} responses</div>
            <Sparkline values={rts} height={140} colour="#1f5eff" />
          </div>
        ) : (
          <div style={{ animation: "fade .4s both" }}>
            <TargetArc height={170} athlete targets={(targets.length ? targets : Array.from({ length: 8 }, (_, i) => ({ id: `T${i + 1}`, online: false })))
              .map((t, i, all) => ({ id: t.id, row: "upper", angle: all.length > 1 ? -70 + (140 / (all.length - 1)) * i : 0, fill: t.online ? "#cff25c" : "#f1f2f5" }))} />
            <div className="hint" style={{ justifyContent: "center" }}>{targets.length ? `${targets.filter((t) => t.online).length} of ${targets.length} targets ready` : "No target data yet"}</div>
          </div>
        )}
      </div>
      <div className="stat-row">
        <div><div className="v">{status?.rssi != null ? Math.round(status.rssi) : "–"}<small>dBm</small></div><div className="l"><Wifi size={12} />signal</div></div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Gauge value={status?.battery_pct != null ? status.battery_pct / 100 : null} size={54} />
          <div className="l" style={{ marginTop: 0 }}><BatteryMedium size={12} />battery</div>
        </div>
        <div><div className="v">{targets.filter((t) => t.online).length}<small>/{targets.length || "–"}</small></div><div className="l"><Target size={12} />targets</div></div>
      </div>
    </Card>
  );
}
