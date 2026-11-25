import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Activity, CalendarCheck, Plus, Search, ShieldAlert, ShieldCheck, Timer, Users } from "lucide-react";
import { api, type Athlete } from "../api";
import { Sparkline } from "../charts";
import { initials, ms, pct, useAsync, when } from "../lib";
import { Card, CountUp, Empty, Kpi, Modal, Skeleton, useToast } from "../ui";

const GROUPS = ["athlete", "patient", "elderly", "child"];
const PROTO: Record<string, string> = { simple_rt: "Simple", choice_rt: "Choice", go_nogo: "Go / No-Go", peripheral: "Peripheral", speed_drill: "Speed drill" };

export default function Athletes() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => { const id = setTimeout(() => setParams(text ? { q: text } : {}, { replace: true }), 250); return () => clearTimeout(id); }, [text, setParams]);
  const list = useAsync(() => api.athletes(q), [q]);
  const stats = useAsync(() => api.athleteStats(), [], 15000);
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const st = stats.data ?? {};
  const all = list.data ?? [];
  const withConsent = all.filter((a) => a.consent.data).length;
  const activeWeek = all.filter((a) => (st[a.id]?.this_week ?? 0) > 0).length;
  const rts = all.map((a) => st[a.id]?.latest?.median_rt).filter((v): v is number => v != null).sort((x, y) => x - y);
  const medianRt = rts.length ? rts[Math.floor(rts.length / 2)] : null;

  return (
    <>
      <div className="headline">
        <div className="title">
          <h1>Athletes</h1>
          <div className="sub">{list.data ? `${all.length} profile${all.length === 1 ? "" : "s"}${q ? ` matching “${q}”` : ""}` : "Loading…"}</div>
        </div>
        <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
          <Search size={17} className="muted" />
          <input placeholder="Name or code…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search athletes" />
        </form>
        <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} />Add athlete</button>
      </div>

      <div className="kpis" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", marginBottom: 18 }}>
        <Kpi i={0} icon={<Users size={14} />} label="Athletes" value={list.data ? <CountUp value={all.length} /> : "–"} />
        <Kpi i={1} icon={<ShieldCheck size={14} />} label="Data consent on file" value={list.data ? <CountUp value={withConsent} /> : "–"} unit={list.data ? `/ ${all.length}` : undefined} />
        <Kpi i={2} icon={<CalendarCheck size={14} />} label="Active this week" value={list.data ? <CountUp value={activeWeek} /> : "–"} unit={list.data ? `/ ${all.length}` : undefined} />
        <Kpi i={3} icon={<Timer size={14} />} label="Median of latest RTs" value={<CountUp value={medianRt} />} unit="ms" note="across athletes, any protocol" />
      </div>

      {!list.data ? (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>{[0, 1, 2].map((k) => <Skeleton key={k} h={210} />)}</div>
      ) : !all.length ? (
        <Card><Empty icon={<Users size={20} />}>No athletes{q ? ` match “${q}”` : " yet"}.<div className="mt-12"><button className="btn sm primary" onClick={() => setAdding(true)}><Plus size={14} />Add athlete</button></div></Empty></Card>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          {all.map((a, i) => {
            const s = st[a.id];
            return (
              <section key={a.id} style={{ ["--i" as string]: Math.min(i, 12) + 4 }} className="card click reveal" onClick={() => nav(`/athletes/${a.id}`)}
                role="link" tabIndex={0} aria-label={`Open ${a.display_name || a.code}`} onKeyDown={(e) => e.key === "Enter" && nav(`/athletes/${a.id}`)}>
                <div className="row" style={{ gap: 14 }}>
                  <span className="initials">{initials(a.display_name, a.code.slice(-2))}</span>
                  <div className="grow">
                    <div className="ellipsis" style={{ fontSize: 16.5 }}>{a.display_name || a.code}</div>
                    <div className="muted ellipsis" style={{ fontSize: 13 }}>{a.code} · {a.sport ?? a.group}{a.position ? ` · ${a.position}` : ""}</div>
                  </div>
                  {a.consent.data
                    ? <span className="chip green" title="Data consent on file"><ShieldCheck size={13} />Consent</span>
                    : <span className="chip amber" title="No data consent"><ShieldAlert size={13} />No consent</span>}
                </div>
                <div className="stat-row" style={{ marginTop: 16 }}>
                  <div><div className="v">{ms(s?.latest?.median_rt)}<small>ms</small></div><div className="l"><Timer size={12} />latest RT</div></div>
                  <div><div className="v">{pct(s?.latest?.accuracy)}</div><div className="l"><Activity size={12} />accuracy</div></div>
                  <div><div className="v">{s?.completed ?? 0}<small>/{s?.runs ?? 0}</small></div><div className="l"><CalendarCheck size={12} />runs</div></div>
                </div>
                <div className="mt-12" style={{ minHeight: 56 }}>
                  {s && s.trend.length > 1
                    ? <Sparkline values={s.trend} height={56} colour="#1f5eff" />
                    : <div className="hint" style={{ height: 56, alignItems: "center" }}>Trend appears after two completed runs</div>}
                </div>
                <div className="row between hint mt-8">
                  <span>{s?.latest ? `Latest: ${PROTO[s.latest.protocol] ?? s.latest.protocol}` : "No completed runs"}</span>
                  <span>{s?.last_run_at ? when(s.last_run_at) : ""}</span>
                </div>
              </section>
            );
          })}
        </div>
      )}
      {adding && <AthleteForm onClose={() => setAdding(false)} onSaved={(a) => { setAdding(false); nav(`/athletes/${a.id}`); }} />}
    </>
  );
}

export function AthleteForm({ initial, onClose, onSaved }: { initial?: Athlete; onClose: () => void; onSaved: (a: Athlete) => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    display_name: initial?.display_name ?? "", group: initial?.group ?? "athlete", sport: initial?.sport ?? "",
    position: initial?.position ?? "", birth_year: initial?.birth_year ? String(initial.birth_year) : "",
    dominant_hand: initial?.dominant_hand ?? "", dominant_foot: initial?.dominant_foot ?? "",
    visual_correction: initial?.visual_correction ?? "", goals: initial?.goals ?? "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const body: Record<string, unknown> = { ...f, birth_year: f.birth_year ? Number(f.birth_year) : null };
    for (const k of ["dominant_hand", "dominant_foot", "sport", "position", "visual_correction", "goals", "display_name"]) if (body[k] === "") body[k] = null;
    try {
      const a = initial ? await api.updateAthlete(initial.id, body) : await api.createAthlete(body);
      toast(initial ? "Profile updated" : `Created ${a.code}`);
      onSaved(a);
    } catch (err) { toast((err as Error).message, true); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={initial ? "Edit profile" : "Add athlete"} onClose={onClose}>
      <form onSubmit={save} className="form-grid">
        <label className="field full">Name (optional; the code is used when blank)<input className="input" value={f.display_name} onChange={set("display_name")} /></label>
        <label className="field">Group<select className="select" value={f.group} onChange={set("group")}>{GROUPS.map((g) => <option key={g}>{g}</option>)}</select></label>
        <label className="field">Birth year<input className="input" type="number" min={1900} max={2100} value={f.birth_year} onChange={set("birth_year")} /></label>
        <label className="field">Sport<input className="input" value={f.sport} onChange={set("sport")} placeholder="Cricket, Football…" /></label>
        <label className="field">Position<input className="input" value={f.position} onChange={set("position")} /></label>
        <label className="field">Dominant hand<select className="select" value={f.dominant_hand} onChange={set("dominant_hand")}><option value="">–</option><option>left</option><option>right</option><option>both</option></select></label>
        <label className="field">Dominant foot<select className="select" value={f.dominant_foot} onChange={set("dominant_foot")}><option value="">–</option><option>left</option><option>right</option><option>both</option></select></label>
        <label className="field full">Visual correction<input className="input" value={f.visual_correction} onChange={set("visual_correction")} placeholder="e.g. contact lenses" /></label>
        <label className="field full">Goals<textarea className="input" rows={2} value={f.goals} onChange={set("goals")} /></label>
        <div className="full row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}
