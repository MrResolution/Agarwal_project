import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity, ChevronLeft, ChevronRight, Crosshair, Download, Footprints, Layers, Lightbulb, ListOrdered, RefreshCw, SplitSquareHorizontal,
  Target, Timer, BarChart3, ShieldAlert, Sigma,
} from "lucide-react";

const PROTO_LABEL: Record<string, string> = {
  simple_rt: "Simple reaction", choice_rt: "Choice reaction", go_nogo: "Go / No-Go", peripheral: "Peripheral response", speed_drill: "Speed drill",
};
import { api, type Analysis, type Run } from "../api";
import { CopPlot, Histogram, SplitBar, TargetArc, TrialStrip } from "../charts";
import { insights, ms, num, RESULT_COLOUR, RESULT_LABEL, rtColour, useAsync, when } from "../lib";
import { Card, CountUp, Empty, Kpi, Skeleton, StatusChip } from "../ui";

export default function AnalysisPage() {
  const { runId, blockId } = useParams();
  const nav = useNavigate();
  const blocks = useAsync(() => api.blocks(), [], 8000);
  const athletes = useAsync(() => api.athletes(), []);
  const names = new Map((athletes.data ?? []).map((a) => [a.id, a.display_name || a.code]));
  const selected = runId ? `run:${runId}` : blockId ? `block:${blockId}` : null;
  const [filter, setFilter] = useState<"athlete" | "all">("athlete");
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected || !blocks.data?.length) return;
    const first = blocks.data.find((b) => b.run_id) ?? blocks.data[0]!;
    nav(first.run_id ? `/analysis/run/${first.run_id}` : `/analysis/block/${first.block_id}`, { replace: true });
  }, [blocks.data, selected, nav]);
  useEffect(() => {
    railRef.current?.querySelector(".rail-item.on")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected, blocks.data]);

  const shown = (blocks.data ?? []).filter((b) => filter === "all" || b.run_id);
  const scroll = (dx: number) => railRef.current?.scrollBy({ left: dx, behavior: "smooth" });

  return (
    <>
      <div className="headline">
        <div className="title">
          <h1>Analysis</h1>
          <div className="sub">Reaction scoring, decision vs movement split, target heatmap and balance, per block</div>
        </div>
      </div>
      <div className="grid g-dash">
        <Card className="span-12" i={0} icon={<Layers size={18} />} iconTone="blue" title="Blocks" sub="Most recent first"
          action={<>
            <div className="seg hide-sm">
              <button className={filter === "athlete" ? "on" : ""} onClick={() => setFilter("athlete")}>Athlete runs</button>
              <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>Include demo</button>
            </div>
            <button className="round-link" onClick={() => scroll(-480)} aria-label="Scroll left" style={{ transform: "none" }}><ChevronLeft size={16} /></button>
            <button className="round-link" onClick={() => scroll(480)} aria-label="Scroll right" style={{ transform: "none" }}><ChevronRight size={16} /></button>
          </>}>
          {!blocks.data ? <Skeleton h={92} /> : !shown.length ? <Empty icon={<Layers size={20} />}>No blocks recorded yet.</Empty> : (
            <div className="rail" ref={railRef}>
              {shown.slice(0, 40).map((b, i) => {
                const key = b.run_id ? `run:${b.run_id}` : `block:${b.block_id}`;
                return (
                  <button key={b.block_id} className={`rail-item ${key === selected ? "on" : ""}`} style={{ animation: `rise .4s var(--ease) ${Math.min(i, 10) * 30}ms both` }}
                    onClick={() => nav(b.run_id ? `/analysis/run/${b.run_id}` : `/analysis/block/${b.block_id}`)}>
                    <div className="t"><span className="ellipsis">{b.athlete_id ? names.get(b.athlete_id) ?? "Athlete" : "Demo block"}</span><StatusChip status={b.status} /></div>
                    <div className="s ellipsis">{PROTO_LABEL[b.protocol ?? ""] ?? "Self-run block"} · {when(b.last_event_at)}</div>
                    <div className="m">{b.stimuli}<small>trials</small></div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
        {selected && <Detail key={selected} runId={runId ? Number(runId) : null} blockId={blockId ?? null} athleteName={(id) => names.get(id)} />}
      </div>
    </>
  );
}

function Detail({ runId, blockId, athleteName }: { runId: number | null; blockId: string | null; athleteName: (id: number) => string | undefined }) {
  const [run, setRun] = useState<Run | null>(null);
  const [a, setA] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      if (runId) { const r = await api.run(runId); setRun(r.run); setA(r.analysis); }
      else if (blockId) setA(await api.blockAnalysis(blockId));
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    load();
    const id = setInterval(() => { if (a?.status === "running" || run?.status === "sent" || run?.status === "running") load(); }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, blockId, a?.status, run?.status]);

  if (loading && !a) return <><div className="span-12 kpis">{[0, 1, 2, 3, 4].map((k) => <Skeleton key={k} h={104} />)}</div><div className="span-8"><Skeleton h={300} /></div><div className="span-4"><Skeleton h={300} /></div></>;
  if (error) return <Card className="span-12"><Empty>{error}</Empty></Card>;
  if (!a) return <Card className="span-12"><Empty>{run?.status === "failed" ? `The hub rejected this run: ${run.error}` : "Waiting for the first events…"}</Empty></Card>;

  const s = a.summary;
  const tips = insights(a);
  const rtVals = s.per_target.map((t) => t.median_rt).filter((v): v is number => v != null);
  const lo = rtVals.length ? Math.min(...rtVals) : 250, hi = rtVals.length ? Math.max(...rtVals) : 650;
  const heat = a.layout.map((p) => {
    const t = s.per_target.find((x) => x.target_id === p.target_id);
    return { id: p.target_id, angle: p.angle_deg, row: p.row, fill: t?.median_rt != null ? rtColour(t.median_rt, lo, hi + 1) : "#f1f2f5",
      sub: t?.median_rt != null ? `${t.median_rt.toFixed(0)} ms` : t?.trials ? "no hits" : "" };
  });
  const title = run ? `${athleteName(run.athlete_id) ?? "Athlete"} · ${run.protocol_name}` : `Block ${a.block_id}`;

  function exportCsv() {
    const cols = ["trial_no", "target_id", "colour", "is_nogo", "result", "excluded", "rt_ms", "premotor_ms", "movement_ms", "response_target_id", "false_starts", "t_stimulus_us", "t_response_us"] as const;
    const rows = a!.trials.map((t) => cols.map((c) => { const v = t[c]; return v == null ? "" : String(v); }).join(","));
    const header = `# block ${a!.block_id}; device ${a!.device_id}; ${run ? `protocol ${run.protocol}; seed ${run.seed}; ` : ""}results are not a diagnosis`;
    const blob = new Blob([[header, cols.join(","), ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `${a!.block_id}.csv` }).click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="span-12 row wrap reveal" style={{ gap: 10, ["--i" as string]: 1 }}>
        <div className="grow" style={{ minWidth: 240 }}>
          <h2 style={{ fontSize: 24 }}>{title}</h2>
          <div className="hint mt-8">{a.started_at_us ? new Date(a.started_at_us / 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""} · {a.trials.length} trials · {a.duration_s}s{run ? ` · seed ${run.seed}` : ""}</div>
        </div>
        <StatusChip status={a.status} />
        {s.quality !== "ok" && <span className="chip amber">Insufficient data</span>}
        {run && <Link className="btn sm ghost" to={`/athletes/${run.athlete_id}`}>Athlete profile</Link>}
        <button className="btn sm ghost" onClick={load} aria-label="Refresh"><RefreshCw size={14} style={{ animation: loading ? "spin 1s linear infinite" : undefined }} />Refresh</button>
        <button className="btn sm primary" onClick={exportCsv}><Download size={14} />Export CSV</button>
      </div>

      <div className="span-12 kpis">
        <Kpi i={2} icon={<Timer size={14} />} label="Median reaction" value={<CountUp value={s.rt.median} />} unit="ms" note={`mean ${ms(s.rt.mean)} · IQR ${ms(s.rt.iqr)}`} />
        <Kpi i={3} icon={<Target size={14} />} label="Accuracy" value={s.accuracy == null ? "–" : <CountUp value={s.accuracy * 100} />} unit="%" note={`${s.counts.hit}/${s.go_trials} go trials hit`} />
        <Kpi i={4} icon={<Sigma size={14} />} label="Sensitivity d′" value={s.dprime == null ? "–" : <CountUp value={s.dprime} decimals={2} />} note={s.nogo_trials ? `${s.counts.false_alarm}/${s.nogo_trials} no-go touches` : "no no-go trials"} />
        <Kpi i={5} icon={<Activity size={14} />} label="Consistency (CV)" value={s.rt.cv == null ? "–" : <CountUp value={s.rt.cv} decimals={2} />} note={`SD ${ms(s.rt.sd)} ms · ${s.excluded_outliers} outlier(s)`} />
        <Kpi i={6} icon={<ShieldAlert size={14} />} label="False starts" value={s.false_start_rate == null ? "–" : <CountUp value={s.false_start_rate * 100} />} unit="%" note={`${s.counts.false_start + s.counts.anticipation} early / anticipatory`} />
      </div>

      <Card className="span-8" i={7} icon={<BarChart3 size={18} />} iconTone="blue" title="Trial by trial" sub="Response time per trial, coloured by result (dashed ring = outlier)">
        <TrialStrip trials={a.trials} height={190} />
        <div className="legend mt-8">
          {Object.entries(s.counts).filter(([, n]) => n > 0).map(([k, n]) => <span key={k}><i style={{ background: RESULT_COLOUR[k] }} />{RESULT_LABEL[k]} {n}</span>)}
        </div>
      </Card>
      <Card className="span-4 t-6" i={8} icon={<Lightbulb size={18} />} iconTone="lime" title="Coach insight" sub="Rule-based, from this block">
        <div className="insight" style={{ flex: 1 }}><ul>{tips.map((t, i) => <li key={i} style={{ ["--i" as string]: i }}>{t}</li>)}</ul></div>
        <p className="hint mt-12">Training guidance only. Results are not a diagnosis.</p>
      </Card>

      <Card className="span-4 t-6" i={9} icon={<BarChart3 size={18} />} title="RT distribution" sub="Valid hits, 50 ms bins">
        <div className="fill-center"><Histogram bins={s.histogram} highlight={s.rt.median} height={190} /></div>
        <div className="row between muted" style={{ fontSize: 12.5 }}><span>p10 {ms(s.rt.p10)} ms</span><span>median {ms(s.rt.median)} ms</span><span>p90 {ms(s.rt.p90)} ms</span></div>
      </Card>
      <Card className="span-4 t-6" i={10} icon={<Crosshair size={18} />} iconTone="lime" title="Target heatmap" sub="Median RT by target position">
        <div className="fill-center"><TargetArc targets={heat} height={220} /></div>
        <div className="row between" style={{ fontSize: 12.5 }}>
          <span className="row" style={{ gap: 6 }}><i style={{ width: 12, height: 12, borderRadius: 6, background: rtColour(lo, lo, hi + 1) }} />faster</span>
          <span className="row" style={{ gap: 6 }}>slower<i style={{ width: 12, height: 12, borderRadius: 6, background: rtColour(hi, lo, hi + 1) }} /></span>
        </div>
      </Card>
      <Card className="span-4 t-6" i={11} icon={<SplitSquareHorizontal size={18} />} iconTone="blue" title="Where the time goes" sub={a.imu_sensor ? `Wrist IMU: ${a.imu_sensor}` : "No IMU stream in this block"}>
        <SplitBar a={s.premotor.median} b={s.movement.median} />
        <div className="row between mt-24" style={{ fontSize: 13 }}>
          <span className="muted">Left vs right</span>
          <span className={`chip ${Math.abs(s.by_side.asymmetry_index_pct ?? 0) >= 6 ? "amber" : "green"}`}>{s.by_side.asymmetry_index_pct == null ? "–" : `${s.by_side.asymmetry_index_pct > 0 ? "+" : ""}${s.by_side.asymmetry_index_pct.toFixed(1)} % asymmetry`}</span>
        </div>
        <CompareBars rows={[["Left", s.by_side.left], ["Right", s.by_side.right]]} />
        <div className="muted mt-16" style={{ fontSize: 13 }}>By eccentricity</div>
        <CompareBars rows={[["Central", s.by_band.central], ["Mid", s.by_band.mid], ["Peripheral", s.by_band.peripheral]]} />
      </Card>

      <Card className="span-5" i={12} icon={<Footprints size={18} />} iconTone="lime" title="Balance during the block" sub="Centre-of-pressure path (mm)">
        {a.balance?.status === "ok" ? (
          <div className="row" style={{ gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
            <CopPlot path={a.balance.path} size={210} half={Math.max(20, (a.balance.range_ml_mm ?? 20), (a.balance.range_ap_mm ?? 20)) * 0.8} />
            <div style={{ flex: 1, minWidth: 160, fontSize: 14 }}>
              {[["Mean velocity", `${num(a.balance.mean_velocity_mm_s, 1)} mm/s`], ["Path length", `${num(a.balance.path_length_mm, 0)} mm`],
                ["95 % ellipse", `${num(a.balance.ellipse_area_mm2, 0)} mm²`], ["RMS ML / AP", `${num(a.balance.rms_ml_mm, 1)} / ${num(a.balance.rms_ap_mm, 1)} mm`],
                ["Mean load", `${num(a.balance.mean_load_kg, 1)} kg`]].map(([k, v]) => (
                <div key={k} className="row between" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}><span className="muted">{k}</span><b>{v}</b></div>
              ))}
            </div>
          </div>
        ) : <Empty icon={<Footprints size={20} />}>{a.balance?.status === "no_load" ? "Nobody was standing on the board." : "No balance-board data for this block."}</Empty>}
      </Card>
      <Card className="span-7" i={13} icon={<ListOrdered size={18} />} title="Trials" sub="Every trial is kept, including invalid ones">
        <div className="scroll-x" style={{ maxHeight: 300, overflowY: "auto" }}>
          <table className="table">
            <thead><tr><th>#</th><th>Target</th><th>Cue</th><th>Result</th><th>RT</th><th>Decision</th><th>Movement</th><th>Touched</th></tr></thead>
            <tbody>{a.trials.map((t) => (
              <tr key={t.trial_no}>
                <td>{t.trial_no + 1}</td><td>{t.target_id}</td>
                <td><span className={`chip ${t.is_nogo ? "red" : "lime"}`} style={{ height: 22 }}>{t.is_nogo ? "no-go" : "go"}</span></td>
                <td><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: 4, background: RESULT_COLOUR[t.result] }} />{RESULT_LABEL[t.result]}{t.excluded ? " · outlier" : ""}</span></td>
                <td>{t.rt_ms != null ? `${t.rt_ms.toFixed(0)} ms` : "–"}</td>
                <td>{t.premotor_ms != null ? `${t.premotor_ms.toFixed(0)}` : "–"}</td>
                <td>{t.movement_ms != null ? `${t.movement_ms.toFixed(0)}` : "–"}</td>
                <td>{t.response_target_id ?? "–"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/** Median RT per group as bars scaled to the slowest group (shorter = faster). */
function CompareBars({ rows }: { rows: [string, number | null][] }) {
  const vals = rows.map(([, v]) => v).filter((v): v is number => v != null);
  const max = vals.length ? Math.max(...vals) : 1, min = vals.length ? Math.min(...vals) : 0;
  return (
    <div className="mt-8" style={{ display: "grid", gap: 8 }}>
      {rows.map(([label, v], i) => (
        <div key={label} style={{ display: "grid", gridTemplateColumns: "78px 1fr 58px", alignItems: "center", gap: 10, fontSize: 13 }}>
          <span className="muted">{label}</span>
          <div className="progress" style={{ height: 8 }}>
            {v != null && <span style={{ width: `${(v / max) * 100}%`, background: v === min && vals.length > 1 ? "var(--lime)" : "var(--blue)", animationDelay: `${i * 80}ms` }} />}
          </div>
          <b style={{ fontWeight: 500, textAlign: "right" }}>{v != null ? `${v.toFixed(0)} ms` : "–"}</b>
        </div>
      ))}
    </div>
  );
}
