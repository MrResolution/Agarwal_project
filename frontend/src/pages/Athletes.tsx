import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { api, type Athlete } from "../api";
import { initials, useAsync } from "../lib";
import { Card, Empty, Modal, Skeleton, useToast } from "../ui";

const GROUPS = ["athlete", "patient", "elderly", "child"];

export default function Athletes() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const list = useAsync(() => api.athletes(q), [q]);
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  return (
    <>
      <div className="headline">
        <div style={{ marginRight: "auto" }}>
          <h1>Athletes</h1>
          <div className="sub">{list.data ? `${list.data.length} profile${list.data.length === 1 ? "" : "s"}` : "Loading…"}</div>
        </div>
        <form className="search" onSubmit={(e) => e.preventDefault()}>
          <input placeholder="Name or code…" value={q} onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {})} aria-label="Search" />
          <Search size={17} className="muted" />
        </form>
        <button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} />Add athlete</button>
      </div>
      {!list.data ? <Skeleton h={200} /> : !list.data.length ? (
        <Card><Empty>No athletes{q ? ` match "${q}"` : " yet"}. <button className="btn sm primary mt-8" onClick={() => setAdding(true)}>Add athlete</button></Empty></Card>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {list.data.map((a) => (
            <section key={a.id} className="card athlete-card" onClick={() => nav(`/athletes/${a.id}`)} role="link" tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && nav(`/athletes/${a.id}`)}>
              <span className="initials">{initials(a.display_name, a.code.slice(-2))}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16 }}>{a.display_name || a.code}</div>
                <div className="muted" style={{ fontSize: 13 }}>{a.code} · {a.sport ?? a.group}{a.position ? ` · ${a.position}` : ""}</div>
              </div>
              {a.consent.data ? <ShieldCheck size={18} color="#18a957" aria-label="Consent on file" /> : <ShieldAlert size={18} color="#ffb020" aria-label="No consent" />}
            </section>
          ))}
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
