import { useState } from "react";
import { AlertTriangle, ArrowRight, Eye, EyeOff, Footprints, Timer, Wifi } from "lucide-react";
import { api, setToken, type Me } from "../api";
import { BrandMark } from "../App";
import { PodsArt } from "../art";

export default function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { access_token } = await api.login(email.trim(), password);
      setToken(access_token);
      onLogin(await api.me());
    } catch (err) {
      setError((err as Error).message || "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="art hero">
        <div className="row" style={{ position: "relative", zIndex: 1 }}>
          <BrandMark size={40} /><span style={{ fontSize: 21 }}>VisionReflex</span>
        </div>
        <h2>Train the eyes.<br />Measure the reflex.</h2>
        <p className="lede" style={{ maxWidth: 380, fontSize: 15 }}>
          Reaction, peripheral vision and balance assessment with LED targets, wearables and a balance board.
        </p>
        <div className="foot">
          <span className="row" style={{ gap: 6 }}><Timer size={15} />Hardware-timed reactions</span>
          <span className="row" style={{ gap: 6 }}><Footprints size={15} />Balance & sway</span>
          <span className="row" style={{ gap: 6 }}><Wifi size={15} />Live over Wi-Fi</span>
        </div>
        <PodsArt className="hero-art" />
      </div>
      <form onSubmit={submit} noValidate={false}>
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 400 }}>Welcome back</h1>
          <p className="muted mt-8">Sign in with your coach or therapist account.</p>
        </div>
        <label className="field">Email
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">Password
          <div style={{ position: "relative" }}>
            <input className="input" type={show ? "text" : "password"} autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} required style={{ paddingRight: 46 }} />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}
              style={{ position: "absolute", right: 6, top: 6, width: 32, height: 32, border: 0, background: "none", cursor: "pointer", borderRadius: 8, display: "grid", placeItems: "center", color: "var(--muted)" }}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>
        {error && <div className="err" role="alert"><AlertTriangle size={15} />{error}</div>}
        <button className="btn primary" disabled={busy || !email || !password} style={{ marginTop: 6, height: 48 }}>
          {busy ? <><span className="spinner" />Signing in…</> : <>Sign in <ArrowRight size={16} /></>}
        </button>
        <p className="muted" style={{ fontSize: 12.5 }}>Accounts are created by your organisation's admin.</p>
      </form>
    </div>
  );
}
