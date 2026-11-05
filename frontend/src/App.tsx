import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Activity, BarChart3, Bell, Cpu, LayoutGrid, LogOut, Users } from "lucide-react";
import { api, getToken, onAuthLost, setToken, STAFF, type Me } from "./api";
import { initials, useAsync } from "./lib";
import { ErrorBoundary, useDismiss } from "./ui";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Live from "./pages/Live";
import AnalysisPage from "./pages/Analysis";
import Athletes from "./pages/Athletes";
import AthleteDetail from "./pages/AthleteDetail";
import Devices from "./pages/Devices";

const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;

export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }}>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="7" stroke="#0f1420" strokeWidth="2.2" />
        <circle cx="12" cy="12" r="2.6" fill="#1f5eff" />
        <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="#0f1420" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

const LINKS = [
  { to: "/", label: "Dashboard", icon: LayoutGrid, end: true },
  { to: "/live", label: "Live session", icon: Activity },
  { to: "/analysis", label: "Analysis", icon: BarChart3 },
  { to: "/athletes", label: "Athletes", icon: Users },
  { to: "/devices", label: "Devices", icon: Cpu },
];

/** Pill nav with an indicator that slides to the active item. */
function Nav() {
  const loc = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  const measure = useCallback(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>("a.active");
    if (!nav || !active) { setInd(null); return; }
    setInd({ x: active.offsetLeft, w: active.offsetWidth });
  }, []);
  useLayoutEffect(measure, [loc.pathname, measure]);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (navRef.current) ro.observe(navRef.current);
    return () => ro.disconnect();
  }, [measure]);
  return (
    <nav className="nav" aria-label="Main" ref={navRef}>
      {ind && <span className="nav-indicator" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
      {LINKS.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")} title={label}>
          <Icon size={16} /><span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function TopBar({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const nav = useNavigate();
  const alerts = useAsync(() => api.alerts(true), [], 15000);
  const urgent = (alerts.data ?? []).filter((a) => a.severity !== "info").length;
  const close = useCallback(() => setOpen(false), []);
  const menuRef = useDismiss<HTMLDivElement>(open, close);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`topbar ${scrolled ? "scrolled" : ""}`}>
      <NavLink to="/" className="brand" aria-label="VisionReflex home"><BrandMark /><span className="name">VisionReflex</span></NavLink>
      <Nav />
      <div className="top-actions" ref={menuRef}>
        <button className="icon-btn" onClick={() => nav("/devices")} aria-label={urgent ? `${urgent} open alerts` : "Alerts"} title="Alerts">
          <Bell size={18} />{urgent > 0 && <span className="dot-badge">{urgent > 9 ? "9+" : urgent}</span>}
        </button>
        <button className="avatar" onClick={() => setOpen((o) => !o)} aria-label="Account menu" aria-expanded={open}>{initials(me.full_name)}</button>
        {open && (
          <div className="menu" role="menu">
            <div className="who"><div>{me.full_name}</div><div className="muted" style={{ fontSize: 13 }}>{me.email}</div>
              <span className="chip blue mt-8" style={{ height: 24, textTransform: "capitalize" }}>{me.role}</span></div>
            <button role="menuitem" onClick={onLogout}><LogOut size={16} />Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const loc = useLocation();
  const logout = useCallback(() => { setToken(null); setMe(null); }, []);

  useEffect(() => {
    onAuthLost(logout);
    if (!getToken()) return;
    api.me().then(setMe).catch(logout).finally(() => setChecking(false));
  }, [logout]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [loc.pathname]);

  if (checking) return null;
  if (!me) return <Login onLogin={setMe} />;
  if (!STAFF.includes(me.role)) {
    return (
      <div className="login" style={{ gridTemplateColumns: "1fr", placeItems: "center" }}><div className="card" style={{ maxWidth: 480 }}>
        <h3>Coach dashboard</h3>
        <p className="muted mt-8">This dashboard is for coaches, therapists and admins. An athlete or parent view is planned.</p>
        <button className="btn mt-16" onClick={logout}>Sign out</button>
      </div></div>
    );
  }
  const section = "/" + (loc.pathname.split("/")[1] ?? "");
  return (
    <MeCtx.Provider value={me}>
      <div className="app">
        <TopBar me={me} onLogout={logout} />
        <main className="main">
          <ErrorBoundary label="This page" resetKey={loc.pathname}>
            <div key={section} className="page-enter">
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
          </ErrorBoundary>
        </main>
      </div>
    </MeCtx.Provider>
  );
}
