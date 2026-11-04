import { createContext, useContext, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { Activity, BarChart3, Bell, Cpu, LayoutGrid, LogOut, Users } from "lucide-react";
import { api, getToken, onAuthLost, setToken, STAFF, type Me } from "./api";
import { initials, useAsync } from "./lib";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Live from "./pages/Live";
import AnalysisPage from "./pages/Analysis";
import Athletes from "./pages/Athletes";
import AthleteDetail from "./pages/AthleteDetail";
import Devices from "./pages/Devices";

const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;

export function BrandMark({ size = 42 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }}>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="7" stroke="#0f1420" strokeWidth="2.2" />
        <circle cx="12" cy="12" r="2.6" fill="#1f5eff" />
        <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="#0f1420" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function TopBar({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const alerts = useAsync(() => api.alerts(true), [], 15000);
  const urgent = (alerts.data ?? []).filter((a) => a.severity !== "info").length;
  const links = [
    { to: "/", label: "Dashboard", icon: LayoutGrid, end: true },
    { to: "/live", label: "Live session", icon: Activity },
    { to: "/analysis", label: "Analysis", icon: BarChart3 },
    { to: "/athletes", label: "Athletes", icon: Users },
    { to: "/devices", label: "Devices", icon: Cpu },
  ];
  return (
    <header className="topbar">
      <div className="brand"><BrandMark /><span className="name">VisionReflex</span></div>
      <nav className="nav" aria-label="Main">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon size={16} /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="top-actions" style={{ position: "relative" }}>
        <button className="icon-btn" onClick={() => nav("/devices")} aria-label={`${urgent} open alerts`}>
          <Bell size={18} />{urgent > 0 && <span className="dot-badge">{urgent > 9 ? "9+" : urgent}</span>}
        </button>
        <button className="avatar" onClick={() => setOpen((o) => !o)} aria-label="Account">{initials(me.full_name)}</button>
        {open && (
          <div className="menu" onMouseLeave={() => setOpen(false)}>
            <div className="who"><div>{me.full_name}</div><div className="muted" style={{ fontSize: 13 }}>{me.email} · {me.role}</div></div>
            <button onClick={onLogout}><LogOut size={16} />Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const logout = () => { setToken(null); setMe(null); };

  useEffect(() => {
    onAuthLost(logout);
    if (!getToken()) return;
    api.me().then(setMe).catch(logout).finally(() => setChecking(false));
  }, []);

  if (checking) return null;
  if (!me) return <Login onLogin={setMe} />;
  if (!STAFF.includes(me.role)) {
    return (
      <div className="login-wrap"><div className="card" style={{ maxWidth: 480 }}>
        <h3>Coach dashboard</h3>
        <p className="muted mt-8">This dashboard is for coaches, therapists and admins. An athlete or parent view is planned.</p>
        <button className="btn mt-16" onClick={logout}>Sign out</button>
      </div></div>
    );
  }
  return (
    <MeCtx.Provider value={me}>
      <div className="page">
        <div className="shell">
          <TopBar me={me} onLogout={logout} />
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/live" element={<Live />} />
            <Route path="/analysis" element={<AnalysisPage />} />
            <Route path="/analysis/run/:runId" element={<AnalysisPage />} />
            <Route path="/analysis/block/:blockId" element={<AnalysisPage />} />
            <Route path="/athletes" element={<Athletes />} />
            <Route path="/athletes/:id" element={<AthleteDetail />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </MeCtx.Provider>
  );
}
