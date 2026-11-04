import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, setToken, type Me } from "../api";
import { BrandMark } from "../App";
import { PodsArt } from "../art";

export default function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    <div className="login-wrap">
      <div className="login">
        <div className="art hero card" style={{ borderRadius: 0, boxShadow: "none" }}>
          <div className="row" style={{ position: "relative", zIndex: 1 }}>
            <BrandMark size={38} /><span style={{ fontSize: 20 }}>VisionReflex</span>
          </div>
          <h2 style={{ marginTop: 28 }}>Train the eyes.<br />Measure the reflex.</h2>
          <p style={{ position: "relative", zIndex: 1, opacity: .8, marginTop: 12, maxWidth: 300, fontSize: 14.5 }}>
            Reaction, peripheral vision and balance assessment with LED targets, wearables and a balance board.
          </p>
          <PodsArt className="hero-art" style={{ top: "auto", bottom: -40, right: -30, width: 360, height: 360 }} />
        </div>
        <form onSubmit={submit}>
          <div>
            <h1 style={{ fontSize: 30, fontWeight: 400 }}>Welcome back</h1>
            <p className="muted mt-8">Sign in with your coach or therapist account.</p>
          </div>
          <label className="field">Email
            <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label className="field">Password
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <div className="err">{error}</div>}
          <button className="btn primary" disabled={busy} style={{ marginTop: 6 }}>
            {busy ? "Signing in…" : <>Sign in <ArrowRight size={16} /></>}
          </button>
          <p className="muted" style={{ fontSize: 12.5 }}>Accounts are created by your organisation's admin.</p>
        </form>
      </div>
    </div>
  );
}
