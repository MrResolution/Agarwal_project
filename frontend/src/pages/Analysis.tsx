import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Download, Lightbulb, RefreshCw } from "lucide-react";
import { api, type Analysis, type Run } from "../api";
import { CopPlot, Histogram, SplitBar, TargetArc, TrialStrip } from "../charts";
import { insights, ms, num, pct, RESULT_COLOUR, RESULT_LABEL, rtColour, useAsync, when } from "../lib";
import { Card, Empty, Kpi, Skeleton, StatusChip } from "../ui";

export default function AnalysisPage() {
  const { runId, blockId } = useParams();
  const nav = useNavigate();
  const blocks = useAsync(() => api.blocks(), [], 8000);
  const athletes = useAsync(() => api.athletes(), []);
  const names = new Map((athletes.data ?? []).map((a) => [a.id, a.display_name || a.code]));
  const selected = runId ? `run:${runId}` : blockId ? `block:${blockId}` : null;

  useEffect(() => {
    if (selected || !blocks.data?.length) return;
    const first = blocks.data[0]!;
    nav(first.run_id ? `/analysis/run/${first.run_id}` : `/analysis/block/${first.block_id}`, { replace: true });
  }, [blocks.data, selected, nav]);

  return (
    <>
      <div className="headline">
        <div style={{ marginRight: "auto" }}>
          <h1>Analysis</h1>
          <div className="sub">Reaction scoring, decision vs movement split, target heatmap and balance, per block</div>
        </div>
      </div>
      <div className="grid g-dash">
        <Card className="span-12" title="Blocks" sub="Most recent first, including demo blocks run without an athlete">
          {!blocks.data ? <Skeleton h={80} /> : !blocks.data.length ? <Empty>No blocks recorded yet.</Empty> : (
            <div className="row wrap" style={{ gap: 8 }}>
              {blocks.data.slice(0, 18).map((b) => {
                const key = b.run_id ? `run:${b.run_id}` : `block:${b.block_id}`;
                return (
                  <button key={b.block_id} className={`chip ${key === selected ? "dark" : ""}`} style={{ height: 34, cursor: "pointer", border: 0 }}
                    onClick={() => nav(b.run_id ? `/analysis/run/${b.run_id}` : `/analysis/block/${b.block_id}`)}>
                    {b.athlete_id ? names.get(b.athlete_id) ?? "Athlete" : "Demo"} · {(b.protocol ?? "block").replace("_", " ")} · {when(b.last_event_at)}
                    {b.status !== "done" && <span style={{ opacity: .7 }}>({b.status})</span>}
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

  if (loading && !a) return <div className="span-12"><Skeleton h={420} /></div>;
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
      <div className="span-12 row wrap" style={{ gap: 12 }}>
        <h2 style={{ fontSize: 24, marginRight: "auto" }}>{title}</h2>
        <StatusChip status={a.status} />
        {s.quality !== "ok" && <span className="chip amber">insufficient data</span>}
        <span className="chip">{a.trials.length} trials · {a.duration_s}s</span>
        {run && <span className="chip">seed {run.seed}</span>}
        {run && <Link className="chip blue" to={`/athletes/${run.athlete_id}`}>Athlete profile</Link>}
        <button className="btn sm ghost" onClick={load}><RefreshCw size={14} />Refresh</button>
        <button className="btn sm" onClick={exportCsv}><Download size={14} />Export CSV</button>
      </div>

      <div className="span-12 kpis">
        <Kpi label="Median reaction" value={ms(s.rt.median)} unit="ms" note={`mean ${ms(s.rt.mean)} · IQR ${ms(s.rt.iqr)}`} />
        <Kpi label="Accuracy" value={s.accuracy == null ? "–" : (s.accuracy * 100).toFixed(0)} unit="%" note={`${s.counts.hit}/${s.go_trials} go trials hit`} />
        <Kpi label="Sensitivity d′" value={num(s.dprime)} note={s.nogo_trials ? `${s.counts.false_alarm}/${s.nogo_trials} no-go presses` : "no no-go trials"} />
        <Kpi label="Consistency (CV)" value={num(s.rt.cv)} note={`SD ${ms(s.rt.sd)} ms · ${s.excluded_outliers} outlier(s)`} />
        <Kpi label="False starts" value={pct(s.false_start_rate)} note={`${s.counts.false_start + s.counts.anticipation} early / anticipatory`} />
      </div>

      <Card className="span-8" title="Trial by trial" sub="Response time per trial, coloured by result (dashed ring = outlier)">
        <TrialStrip trials={a.trials} height={190} />
        <div className="legend mt-8">
          {Object.entries(s.counts).filter(([, n]) => n > 0).map(([k, n]) => <span key={k}><i style={{ background: RESULT_COLOUR[k] }} />{RESULT_LABEL[k]} {n}</span>)}
        </div>
      </Card>
      <Card className="span-4" title="Coach insight" action={<span className="chip dark"><Lightbulb size={13} />Rule-based</span>}>
        <div className="insight"><ul>{tips.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
        <p className="muted mt-12" style={{ fontSize: 12 }}>Training guidance from this block only. Results are not a diagnosis.</p>
      </Card>

      <Card className="span-4" title="RT distribution" sub="Valid hits, 50 ms bins">
        <Histogram bins={s.histogram} highlight={s.rt.median} height={180} />
        <div className="row between muted" style={{ fontSize: 12.5 }}><span>p10 {ms(s.rt.p10)} ms</span><span>median {ms(s.rt.median)} ms</span><span>p90 {ms(s.rt.p90)} ms</span></div>
      </Card>
      <Card className="span-4" title="Target heatmap" sub="Median RT by target position">
        <TargetArc targets={heat} height={210} />
        <div className="row between" style={{ fontSize: 12.5 }}>
          <span className="row" style={{ gap: 6 }}><i style={{ width: 12, height: 12, borderRadius: 6, background: rtColour(lo, lo, hi + 1) }} />faster</span>
          <span className="row" style={{ gap: 6 }}>slower<i style={{ width: 12, height: 12, borderRadius: 6, background: rtColour(hi, lo, hi + 1) }} /></span>
        </div>
      </Card>
      <Card className="span-4" title="Where the time goes" sub={a.imu_sensor ? `Wrist IMU: ${a.imu_sensor}` : "No IMU stream in this block"}>
        <SplitBar a={s.premotor.median} b={s.movement.median} />
        <div className="mt-24">
          <div className="row between" style={{ fontSize: 14 }}><span>Left side</span><b>{ms(s.by_side.left)} ms</b></div>
          <div className="row between mt-8" style={{ fontSize: 14 }}><span>Right side</span><b>{ms(s.by_side.right)} ms</b></div>
          <div className="row between mt-8" style={{ fontSize: 14 }}><span>Asymmetry</span>
            <span className={`chip ${Math.abs(s.by_side.asymmetry_index_pct ?? 0) >= 6 ? "amber" : "green"}`}>{s.by_side.asymmetry_index_pct == null ? "–" : `${s.by_side.asymmetry_index_pct.toFixed(1)} %`}</span></div>
          <div className="row between mt-16" style={{ fontSize: 14 }}><span>Central / mid / peripheral</span>
            <b>{ms(s.by_band.central)} / {ms(s.by_band.mid)} / {ms(s.by_band.peripheral)}</b></div>
        </div>
      </Card>

      <Card className="span-5" title="Balance during the block" sub="Centre-of-pressure path (mm)">
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
        ) : <Empty>{a.balance?.status === "no_load" ? "Nobody was standing on the board." : "No balance-board data for this block."}</Empty>}
      </Card>
      <Card className="span-7" title="Trials" sub="Every trial is kept, including invalid ones">
        <div className="scroll-x" style={{ maxHeight: 320, overflowY: "auto" }}>
          <table className="table">
            <thead><tr><th>#</th><th>Target</th><th>Cue</th><th>Result</th><th>RT</th><th>Decision</th><th>Movement</th><th>Pressed</th></tr></thead>
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
