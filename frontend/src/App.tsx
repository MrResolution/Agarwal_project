import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Activity, BarChart3, Bell, Cpu, LayoutGrid, LogOut, PersonStanding, Users } from "lucide-react";
import { api, getToken, onAuthLost, setToken, STAFF, type Me } from "./api";
import { initials, useAsync } from "./lib";
import { PoseProvider, usePose } from "./pose/PoseContext";
import { ErrorBoundary, useDismiss } from "./ui";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Live from "./pages/Live";
import AnalysisPage from "./pages/Analysis";
import Athletes from "./pages/Athletes";
import AthleteDetail from "./pages/AthleteDetail";
import Devices from "./pages/Devices";
import Tracking from "./pages/Tracking";

const STATION = "station-1";

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
  { to: "/tracking", label: "Body tracking", icon: PersonStanding },
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

/** Shown while the camera (or the simulated athlete) is running, on every page. */
function TrackingChip() {
  const [, snap] = usePose();
  const nav = useNavigate();
  if (snap.status !== "running") return null;
  const cam = snap.source === "camera";
  return (
    <button className="track-chip" onClick={() => nav("/tracking")} title={cam ? "The camera is on (not recorded). Open body tracking" : "Simulated athlete running. Open body tracking"}>
      <span className={`rec-dot ${cam ? "" : "sim"}`} /><span className="t">{cam ? "Camera on" : "Simulation"}</span>
    </button>
  );
}

function TopBar({ me, onLogout, openAccess }: { me: Me; onLogout: () => void; openAccess: boolean }) {
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
        <TrackingChip />
        <button className="icon-btn" onClick={() => nav("/devices")} aria-label={urgent ? `${urgent} open alerts` : "Alerts"} title="Alerts">
          <Bell size={18} />{urgent > 0 && <span className="dot-badge">{urgent > 9 ? "9+" : urgent}</span>}
        </button>
        <button className="avatar" onClick={() => setOpen((o) => !o)} aria-label="Account menu" aria-expanded={open}>{initials(me.full_name)}</button>
        {open && (
          <div className="menu" role="menu">
            <div className="who"><div>{me.full_name}</div><div className="muted" style={{ fontSize: 13 }}>{me.email}</div>
              <div className="row mt-8" style={{ gap: 6 }}>
                <span className="chip blue" style={{ height: 24, textTransform: "capitalize" }}>{me.role}</span>
                {openAccess && <span className="chip amber" style={{ height: 24 }}>Open access</span>}
              </div></div>
            {openAccess
              ? <div className="hint" style={{ padding: "8px 12px", lineHeight: 1.45 }}>Sign-in is turned off on this computer. Remove <span className="mono">SVS_OPEN_ACCESS</span> from <span className="mono">backend/.env</span> to require it again.</div>
              : <button role="menuitem" onClick={onLogout}><LogOut size={16} />Sign out</button>}
          </div>
        )}
      </div>
    </header>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [openAccess, setOpenAccess] = useState(false);
  const loc = useLocation();

  /** Signed-in token first; otherwise use open access if the API allows it for this machine. */
  const boot = useCallback(async () => {
    setChecking(true);
    try {
      if (getToken()) {
        try { setMe(await api.me()); return; } catch { setToken(null); }
      }
      const mode = await api.authMode().catch(() => ({ open_access: false }));
      setOpenAccess(mode.open_access);
      setMe(mode.open_access ? await api.me() : null);
    } catch {
      setMe(null);
    } finally {
      setChecking(false);
    }
  }, []);
  const logout = useCallback(() => { setToken(null); setMe(null); void boot(); }, [boot]);

  useEffect(() => {
    onAuthLost(logout);
    void boot();
  }, [boot, logout]);
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
      <PoseProvider station={STATION}>
      <div className="app">
        <TopBar me={me} onLogout={logout} openAccess={openAccess && !getToken()} />
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
                <Route path="/tracking" element={<Tracking />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </div>
          </ErrorBoundary>
        </main>
      </div>
      </PoseProvider>
    </MeCtx.Provider>
  );
}
