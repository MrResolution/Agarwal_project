import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Pencil, Play, ShieldCheck, ShieldOff } from "lucide-react";
import { api, getToken } from "../api";
import { LineChart } from "../charts";
import { axisLabels, initials, ms, pct, useAsync, when } from "../lib";
import { Card, Empty, Kpi, Modal, Skeleton, StatusChip, useToast } from "../ui";
import { AthleteForm } from "./Athletes";

export default function AthleteDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const toast = useToast();
  const athlete = useAsync(() => api.athlete(id), [id]);
  const consents = useAsync(() => api.consents(id), [id]);
  const runs = useAsync(() => api.runs(id), [id], 8000);
  const trends = useAsync(() => api.trends(id), [id]);
  const [editing, setEditing] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [proto, setProto] = useState<string | null>(null);

  const a = athlete.data;
  if (athlete.error) return <Card className="mt-24"><Empty>{athlete.error}</Empty></Card>;
  if (!a) return <div className="mt-24"><Skeleton h={300} /></div>;

  const protos = Object.entries(trends.data?.protocols ?? {});
  const current = protos.find(([k]) => k === proto) ?? protos[0];
  const done = (runs.data ?? []).filter((r) => r.status === "done" && r.summary);
  const last = done[0]?.summary;

  async function withdraw(cid: number) {
    try { await api.withdrawConsent(id, cid); consents.reload(); athlete.reload(); toast("Consent withdrawn"); }
    catch (e) { toast((e as Error).message, true); }
  }

  return (
    <>
      <div className="headline">
        <span className="initials" style={{ width: 60, height: 60, fontSize: 20 }}>{initials(a.display_name, a.code.slice(-2))}</span>
        <div style={{ marginRight: "auto" }}>
          <h1>{a.display_name || a.code}</h1>
          <div className="sub">{a.code} · {a.group}{a.sport ? ` · ${a.sport}` : ""}{a.position ? ` · ${a.position}` : ""}{a.is_minor ? " · minor" : ""}</div>
        </div>
        <button className="btn" onClick={() => setEditing(true)} disabled={!!a.anonymised_at}><Pencil size={15} />Edit</button>
        <button className="btn primary" onClick={() => nav(`/live?athlete=${a.id}`)} disabled={!a.consent.data}><Play size={16} />Start session</button>
      </div>

      <div className="grid g-dash">
        <div className="span-12 kpis">
          <Kpi label="Latest median RT" value={ms(last?.median_rt)} unit="ms" note={done[0] ? done[0].protocol_name : "no completed run"} />
          <Kpi label="Latest accuracy" value={last?.accuracy != null ? (last.accuracy * 100).toFixed(0) : "–"} unit="%" />
          <Kpi label="Decision time" value={ms(last?.premotor_median)} unit="ms" note="stimulus → movement onset" />
          <Kpi label="Completed runs" value={done.length} note={`${(runs.data ?? []).length} total`} />
          <Kpi label="Data consent" value={a.consent.data ? "On file" : "Missing"} note={`video ${a.consent.video ? "yes" : "no"} · research ${a.consent.research ? "yes" : "no"}`} />
        </div>

        <Card className="span-8" title="Progress vs baseline" sub="Median reaction time per completed run. Changes stay unverified until test-retest reliability is measured.">
          {!trends.data ? <Skeleton h={220} /> : !current ? <Empty>Complete a run to start tracking progress.</Empty> : (
            <>
              {protos.length > 1 && (
                <div className="seg" style={{ marginBottom: 10 }}>
                  {protos.map(([k, v]) => <button key={k} className={current[0] === k ? "on" : ""} onClick={() => setProto(k)}>{v.protocol_name}</button>)}
                </div>
              )}
              <LineChart height={220} unit=" ms" goal={current[1].baseline.median_rt}
                points={current[1].points.map((p, i, all) => ({
                  label: axisLabels(all.map((x) => x.at))[i]!, value: p.median_rt,
                  tip: <><b>{ms(p.median_rt)} ms</b> · {pct(p.accuracy)}{p.rt_change_pct != null && <> · <span style={{ color: p.rt_change_pct <= 0 ? "#18a957" : "#b3261e" }}>{p.rt_change_pct > 0 ? "+" : ""}{p.rt_change_pct.toFixed(1)} %</span></>}</>,
                }))} />
              <div className="row wrap mt-8" style={{ gap: 8 }}>
                <span className="chip blue">Baseline {ms(current[1].baseline.median_rt)} ms ({current[1].baseline.runs.length} run{current[1].baseline.runs.length === 1 ? "" : "s"})</span>
                <span className="chip">{current[1].points.length} completed</span>
                <span className="chip amber">change {current[1].change_status}</span>
              </div>
            </>
          )}
        </Card>

        <Card className="span-4" title="Consent" action={<button className="btn sm primary" onClick={() => setConsentOpen(true)} disabled={!!a.anonymised_at}>Record</button>}>
          {!consents.data ? <Skeleton h={120} /> : !consents.data.length ? <Empty>No consent recorded. Sessions cannot start without data consent.</Empty> :
            consents.data.slice().reverse().map((c) => (
              <div key={c.id} className="list-item">
                {c.active ? <ShieldCheck size={18} color="#18a957" /> : <ShieldOff size={18} color="#9aa0aa" />}
                <div style={{ flex: 1 }}>
                  <div style={{ textTransform: "capitalize" }}>{c.type} <span className="muted" style={{ fontSize: 12.5 }}>· form {c.text_version}</span></div>
                  <div className="muted" style={{ fontSize: 12.5 }}>{c.signed_by}{c.guardian_name ? ` (guardian ${c.guardian_name})` : ""} · {when(c.signed_at)}{c.withdrawn_at ? ` · withdrawn ${when(c.withdrawn_at)}` : ""}</div>
                </div>
                {c.active && <button className="btn sm ghost" onClick={() => withdraw(c.id)}>Withdraw</button>}
              </div>
            ))}
        </Card>

        <Card className="span-8" title="Runs" sub="Click a run for the full analysis">
          {!runs.data ? <Skeleton h={160} /> : !runs.data.length ? <Empty>No runs yet.</Empty> : (
            <div className="scroll-x"><table className="table">
              <thead><tr><th>Protocol</th><th>Status</th><th>Trials</th><th>Median RT</th><th>Accuracy</th><th>d′</th><th>Decision</th><th>When</th></tr></thead>
              <tbody>{runs.data.map((r) => (
                <tr key={r.id} className="click" onClick={() => nav(`/analysis/run/${r.id}`)}>
                  <td>{r.protocol_name}</td><td><StatusChip status={r.status} /></td><td>{r.n_trials}</td>
                  <td>{r.summary?.median_rt != null ? `${r.summary.median_rt.toFixed(0)} ms` : "–"}</td>
                  <td>{pct(r.summary?.accuracy)}</td><td>{r.summary?.dprime ?? "–"}</td>
                  <td>{r.summary?.premotor_median != null ? `${r.summary.premotor_median.toFixed(0)} ms` : "–"}</td>
                  <td className="muted">{when(r.created_at)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>

        <Card className="span-4" title="Profile">
          {[["Dominant hand", a.dominant_hand], ["Dominant foot", a.dominant_foot], ["Birth year", a.birth_year], ["Visual correction", a.visual_correction], ["Goals", a.goals]].map(([k, v]) => (
            <div key={String(k)} className="row between" style={{ padding: "9px 0", borderBottom: "1px solid var(--line)", fontSize: 14, alignItems: "flex-start" }}>
              <span className="muted">{k}</span><span style={{ textAlign: "right", maxWidth: "60%" }}>{v ?? "–"}</span>
            </div>
          ))}
          <div className="row mt-16" style={{ gap: 8 }}>
            <a className="btn sm ghost" href={`/api/athletes/${a.id}/export`} onClick={async (e) => {
              e.preventDefault();
              const res = await fetch(`/api/athletes/${a.id}/export`, { headers: { Authorization: `Bearer ${getToken()}` } });
              if (!res.ok) { toast("Export failed", true); return; }
              const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              Object.assign(document.createElement("a"), { href: url, download: `${a.code}-export.json` }).click();
              URL.revokeObjectURL(url);
            }}>Export data</a>
            <Link className="btn sm ghost" to="/analysis">All analyses</Link>
          </div>
        </Card>
      </div>

      {editing && <AthleteForm initial={a} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); athlete.reload(); }} />}
      {consentOpen && <ConsentForm minor={a.is_minor} onClose={() => setConsentOpen(false)}
        onSubmit={async (body) => {
          try { await api.addConsent(id, body); setConsentOpen(false); consents.reload(); athlete.reload(); toast("Consent recorded"); }
          catch (e) { toast((e as Error).message, true); }
        }} />}
    </>
  );
}

function ConsentForm({ minor, onClose, onSubmit }: { minor: boolean; onClose: () => void; onSubmit: (b: { type: string; text_version: string; signed_by: string; guardian_name?: string }) => void }) {
  const [type, setType] = useState("data");
  const [version, setVersion] = useState("v1.0");
  const [signedBy, setSignedBy] = useState("");
  const [guardian, setGuardian] = useState("");
  return (
    <Modal title="Record consent" onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); onSubmit({ type, text_version: version, signed_by: signedBy, ...(guardian ? { guardian_name: guardian } : {}) }); }}>
        <label className="field">Type<select className="select" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="data">Data (required for sessions)</option><option value="video">Video</option><option value="research">Research use</option></select></label>
        <label className="field">Form version<input className="input" value={version} onChange={(e) => setVersion(e.target.value)} required /></label>
        <label className="field full">Signed by<input className="input" value={signedBy} onChange={(e) => setSignedBy(e.target.value)} required /></label>
        <label className="field full">Parent / guardian {minor ? "(required: minor)" : "(if applicable)"}
          <input className="input" value={guardian} onChange={(e) => setGuardian(e.target.value)} required={minor} /></label>
        <div className="full row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary">Record consent</button>
        </div>
      </form>
    </Modal>
  );
}
