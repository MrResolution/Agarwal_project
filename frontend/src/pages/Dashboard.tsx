import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Gauge as GaugeIcon, Play, Search, Sparkles, Target, Timer, Wifi } from "lucide-react";
import { api, type Analysis, type Run } from "../api";
import { useMe } from "../App";
import { PodsArt } from "../art";
import { DotMatrix, Gauge, LineChart, Lollipops, Radar, Sparkline } from "../charts";
import { athleteLabel, insights, ms, pct, skillProfile, useAsync, useStationFeed, when, type FeedMessage } from "../lib";
import { Card, Empty, Progress, Skeleton, StatusChip } from "../ui";

export default function Dashboard() {
  const me = useMe();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const ov = useAsync(() => api.overview(), [], 10000);
  const o = ov.data;

  return (
    <>
      <div className="headline">
        <div style={{ marginRight: "auto" }}>
          <h1>Welcome, {me.full_name.split(" ")[0]}</h1>
          <div className="sub">{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</div>
        </div>
        <form className="search" onSubmit={(e) => { e.preventDefault(); nav(`/athletes?q=${encodeURIComponent(q)}`); }}>
          <input placeholder="Search athletes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search athletes" />
          <Search size={17} className="muted" />
        </form>
        <Link className="btn primary" to="/live"><Play size={16} />Start session</Link>
      </div>

      <div className="grid g-dash">
        <section className="card hero span-5">
          <h2>Sharpen every reaction</h2>
          <Link className="round-link" to="/live" aria-label="Open live session"><ArrowUpRight size={20} /></Link>
          <PodsArt className="hero-art" />
          <div className="glass">
            <div><div className="lbl">Median reaction</div><div className="val"><span className="ico"><Timer size={15} /></span>{ms(o?.median_rt_recent)}<small style={{ fontSize: 13 }}>ms</small></div></div>
            <div><div className="lbl">Accuracy</div><div className="val"><span className="ico"><Target size={15} /></span>{pct(o?.accuracy_recent)}</div></div>
            <div><div className="lbl">Runs this week</div><div className="val"><span className="ico"><GaugeIcon size={15} /></span>{o?.runs_this_week ?? "–"}</div></div>
          </div>
        </section>

        <SkillOverview leaderboard={o?.leaderboard ?? []} className="span-7" />

        <div className="span-4 stack">
          <Card title="Training activity" sub="Protocol runs per day, last 14 days" to="/analysis">
            {o ? <>
              <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
                <span className="big">{o.runs_per_day.slice(-14).reduce((s, d) => s + d.runs, 0)}</span>
                <span className="muted" style={{ fontSize: 13 }}>runs · {o.completed_this_week} completed this week</span>
              </div>
              <LineChart height={150} points={o.runs_per_day.slice(-14).map((d) => ({
                label: new Date(`${d.date}T00:00`).toLocaleDateString(undefined, { day: "2-digit" }), value: d.runs,
                tip: <><b>{d.runs} runs</b> <span className="muted">{new Date(`${d.date}T00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span></>,
              }))} yMin={0} />
            </> : <Skeleton h={190} />}
          </Card>
          <Card title="Schedule" sub="Days with completed sessions">
            <Calendar days={o?.runs_per_day ?? []} />
          </Card>
        </div>

        <LiveStationCard className="span-4" />

        <Card className="span-4" title="Progress & goals" sub="Training load, consent and quality">
          {o ? <>
            <div className="row between"><span className="muted" style={{ fontSize: 13 }}>Activity index (6 weeks)</span>
              <span className="big" style={{ fontSize: 32 }}>{o.runs_total}</span></div>
            <DotMatrix height={140} rows={6} columns={o.runs_per_day.slice(-21).map((d, i) => ({ label: d.date, value: d.runs, tone: i }))} />
            <div className="insight mt-12" style={{ padding: "6px 16px" }}>
              <Goal label="Weekly sessions" value={o.completed_this_week} target={10} />
              <Goal label="Recent accuracy" value={o.accuracy_recent} target={1} percent />
              <Goal label="Athletes with data consent" value={o.athletes - o.athletes_without_consent} target={Math.max(1, o.athletes)} />
              <Goal label="Hubs online" value={o.devices_online} target={Math.max(1, o.devices_total)} />
            </div>
          </> : <Skeleton h={340} />}
        </Card>

        <Card className="span-7" title="Recent runs" sub="Latest protocol blocks across all athletes" to="/analysis">
          {o?.recent_runs.length ? (
            <div className="scroll-x">
              <table className="table">
                <thead><tr><th>Athlete</th><th>Protocol</th><th>Status</th><th>Median RT</th><th>Accuracy</th><th>When</th></tr></thead>
                <tbody>
                  {o.recent_runs.map((r) => (
                    <tr key={r.id} className="click" onClick={() => nav(`/analysis/run/${r.id}`)}>
                      <td>{r.athlete_name || r.athlete_code}</td>
                      <td>{r.protocol_name}</td>
                      <td><StatusChip status={r.status} /></td>
                      <td>{r.summary?.median_rt != null ? `${r.summary.median_rt.toFixed(0)} ms` : "–"}</td>
                      <td>{pct(r.summary?.accuracy)}</td>
                      <td className="muted">{when(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : o ? <Empty>No runs yet. Start a session from <Link to="/live" style={{ color: "var(--blue)" }}>Live session</Link>.</Empty> : <Skeleton h={220} />}
        </Card>

        <Card className="span-5" title="Fastest reactions" sub="Latest completed run per athlete">
          {o?.leaderboard.length ? o.leaderboard.map((l, i) => (
            <Link key={l.athlete_id} to={`/athletes/${l.athlete_id}`} className="list-item">
              <span className={`initials ${i ? "blue" : ""}`} style={{ width: 38, height: 38, fontSize: 13 }}>{i + 1}</span>
              <div style={{ flex: 1 }}>
                <div>{athleteLabel(l)}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{l.sport ?? "–"} · {l.protocol.replace("_", " ")}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div>{ms(l.median_rt)} ms</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{pct(l.accuracy)}</div>
              </div>
            </Link>
          )) : o ? <Empty>Complete a run to see rankings</Empty> : <Skeleton h={220} />}
        </Card>
      </div>
    </>
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
      <div className="row between" style={{ marginTop: -6, marginBottom: 10 }}>
        <button className="chip" onClick={() => setOffset(offset - 1)} aria-label="Previous month">‹</button>
        <span className="chip">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        <button className="chip" onClick={() => setOffset(Math.min(0, offset + 1))} aria-label="Next month">›</button>
      </div>
      <div className="cal">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="dow">{d}</div>)}
        {cells.map((d, i) => {
          const inMonth = d >= 1 && d <= daysIn;
          const n = inMonth ? counts.get(iso(d)) ?? 0 : 0;
          const today = inMonth && offset === 0 && d === now.getDate();
          return (
            <div key={i} className={`d ${!inMonth ? "out" : ""} ${n >= 3 ? "many" : n > 0 ? "has" : ""} ${today ? "today" : ""}`}
              title={inMonth && n ? `${n} run${n > 1 ? "s" : ""}` : undefined}>
              {inMonth ? d : ""}
            </div>
          );
        })}
      </div>
    </>
  );
}

function SkillOverview({ leaderboard, className }: { leaderboard: { athlete_id: number }[]; className?: string }) {
  const athletes = useAsync(() => api.athletes(), []);
  const [athleteId, setAthleteId] = useState<number | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [latest, setLatest] = useState<Analysis | null>(null);
  useEffect(() => {
    if (athleteId == null && athletes.data?.length) setAthleteId(leaderboard[0]?.athlete_id ?? athletes.data[0]!.id);
  }, [athletes.data, leaderboard, athleteId]);
  useEffect(() => {
    if (athleteId == null) return;
    let live = true;
    api.runs(athleteId).then(async (rs) => {
      if (!live) return;
      setRuns(rs);
      const done = rs.find((r) => r.status === "done");
      setLatest(done ? (await api.run(done.id)).analysis : null);
    }).catch(() => {});
    return () => { live = false; };
  }, [athleteId]);

  // A just-finished run has no cached summary yet; use its live analysis so chart and headline agree.
  const rtOf = (r: Run) => r.summary?.median_rt ?? (latest && r.block_id === latest.block_id ? latest.summary.rt.median : null);
  const done = runs.filter((r) => r.status === "done" && rtOf(r) != null).slice(0, 6).reverse();
  const baseline = done.length >= 2 ? (rtOf(done[0]!)! + rtOf(done[1]!)!) / 2 : null;
  const s = latest?.summary;
  const periphDelta = s?.by_band.peripheral != null && s?.by_band.central != null ? s.by_band.peripheral - s.by_band.central : null;
  const skills = skillProfile(s, periphDelta);
  const tips = insights(latest);

  return (
    <Card className={className} title="Skill overview" sub={latest ? `Latest run · ${latest.block_id}` : "Select an athlete"}
      action={<>
        <select className="select" style={{ height: 36, width: 180, borderRadius: 999 }} value={athleteId ?? ""} onChange={(e) => setAthleteId(Number(e.target.value))} aria-label="Athlete">
          {(athletes.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.display_name || a.code}</option>)}
        </select>
        <span className="chip dark"><Sparkles size={13} />Coach insight</span>
      </>}>
      {!athletes.data ? <Skeleton h={240} /> : !athletes.data.length ? <Empty>Add an athlete to see their skill profile.</Empty> : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(200px,230px) minmax(0,1fr) minmax(0,230px)", gap: 16, alignItems: "center" }} className="skill-grid">
          <div title={skills.map((k) => `${k.label}: ${k.detail}`).join("\n")}>
            {skills.length ? <Radar axes={skills.map((k) => ({ label: k.label, value: k.value }))} /> : <Empty>No completed run yet</Empty>}
          </div>
          <div>
            <div className="row between"><span style={{ fontSize: 14 }}>Median reaction time, last runs</span><span className="big" style={{ fontSize: 30 }}>{ms(s?.rt.median)}<small>ms</small></span></div>
            <Lollipops height={170} goal={baseline} items={done.map((r, i) => ({ label: `0${i + 1}`, value: rtOf(r), highlight: i === done.length - 1 }))} />
          </div>
          <div className="insight" style={{ alignSelf: "stretch" }}>
            <h4>Coach insight</h4>
            {tips.length ? <ul>{tips.slice(0, 3).map((t, i) => <li key={i}>{t}</li>)}</ul> : <p>Insights appear after the athlete's first completed run.</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

function LiveStationCard({ className }: { className?: string }) {
  const station = "station-1";
  const [rts, setRts] = useState<number[]>([]);
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const stim = useRef(new Map<string, number>());
  const connected = useStationFeed(station, (m: FeedMessage) => {
    if (m.type === "device_status") setStatus(m.status);
    if (m.type !== "event") return;
    const e = m.event;
    setLastEvent(e.type);
    const key = `${e.block_id}:${e.trial_no}`;
    if (e.type === "stimulus_on") stim.current.set(key, e.t_us);
    if (e.type === "response" && stim.current.has(key)) {
      setRts((r) => [...r.slice(-29), (e.t_us - stim.current.get(key)!) / 1000]);
    }
  });
  const latest = rts[rts.length - 1];
  const online = status?.online;
  return (
    <Card className={className} title="Live station" sub={station} to="/live"
      action={<span className={`chip ${online ? "lime" : ""}`}><span className={`pulse ${online && connected ? "" : "off"}`} />{online ? "Hub online" : "Hub offline"}</span>}>
      <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
        <span className="big">{latest ? latest.toFixed(0) : "–"}</span><span className="muted">ms latest response</span>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{lastEvent ? `Last event: ${lastEvent.replace("_", " ")}` : "Waiting for hub events…"}</div>
      <div className="mt-12"><Sparkline values={rts.length ? rts : [0, 0]} height={110} /></div>
      <div className="grid mt-16" style={{ gridTemplateColumns: "1fr 1fr", gap: 0, borderTop: "1px solid var(--line)" }}>
        <div style={{ padding: "16px 12px 0 0", borderRight: "1px solid var(--line)" }}>
          <div className="big" style={{ fontSize: 30 }}>{status?.rssi != null ? Math.round(status.rssi) : "–"}<small>dBm</small></div>
          <div className="muted" style={{ fontSize: 12.5 }}><Wifi size={12} /> Wi-Fi signal {status?.ssid ? `· ${status.ssid}` : ""}</div>
          <div className="row mt-12 wrap" style={{ gap: 6 }}>
            {(status?.targets ?? []).map((t: { id: string; online: boolean }) => (
              <span key={t.id} className={`chip ${t.online ? "blue" : "red"}`} style={{ height: 24, padding: "0 9px" }}>{t.id}</span>
            ))}
          </div>
        </div>
        <div style={{ padding: "12px 0 0 12px", display: "grid", placeItems: "center" }}>
          <Gauge value={status?.battery_pct != null ? status.battery_pct / 100 : null} label="battery" size={124} />
          <div className="muted" style={{ fontSize: 12 }}>{status?.firmware ?? ""}</div>
        </div>
      </div>
    </Card>
  );
}
