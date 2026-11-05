import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, RotateCcw, X } from "lucide-react";
import { Link } from "react-router-dom";

export function Card({ title, sub, icon, iconTone, action, to, children, className = "", style, i = 0, onClick }: {
  title?: ReactNode; sub?: ReactNode; icon?: ReactNode; iconTone?: "lime" | "blue"; action?: ReactNode; to?: string;
  children?: ReactNode; className?: string; style?: React.CSSProperties; i?: number; onClick?: () => void;
}) {
  return (
    <section className={`card reveal ${onClick ? "click" : ""} ${className}`} style={{ ...style, ["--i" as string]: i }} onClick={onClick}>
      {(title || action || to) && (
        <div className="card-head">
          {icon && <span className={`card-icon ${iconTone ?? ""}`}>{icon}</span>}
          <div className="ttl">
            {title && <h3>{title}</h3>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          <div className="spacer" />
          {action}
          {to && <Link className="round-link" to={to} aria-label={`Open ${typeof title === "string" ? title : ""}`}><ArrowUpRight size={16} /></Link>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

/** Animated number: counts from the previous value to the new one. */
export function CountUp({ value, decimals = 0, duration = 900 }: { value: number | null | undefined; decimals?: number; duration?: number }) {
  const [shown, setShown] = useState<number | null>(value ?? null);
  const from = useRef(0);
  useEffect(() => {
    if (value == null) { setShown(null); return; }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setShown(value); from.current = value; return; }
    const start = performance.now(), a = from.current, b = value;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(a + (b - a) * e);
      if (p < 1) raf = requestAnimationFrame(tick); else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{shown == null ? "–" : shown.toFixed(decimals)}</>;
}

export function Kpi({ label, value, unit, note, icon, i = 0 }: { label: string; value: ReactNode; unit?: string; note?: ReactNode; icon?: ReactNode; i?: number }) {
  return (
    <div className="kpi reveal" style={{ ["--i" as string]: i }}>
      <div className="lbl">{icon}{label}</div>
      <div className="val">{value}{unit && <small>{unit}</small>}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export function Progress({ value, tone = "lime" }: { value: number | null; tone?: "lime" | "blue" }) {
  return <div className={`progress ${tone === "blue" ? "blue" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)}>
    <span style={{ width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%` }} />
  </div>;
}

export function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return <div className="empty">{icon && <span className="empty-ico">{icon}</span>}<div>{children}</div></div>;
}

export function Skeleton({ h = 120, style }: { h?: number; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, ...style }} aria-hidden />;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 20 }}>{title}</h3>
          <button className="round-link" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const STATUS: Record<string, { tone: string; label: string }> = {
  done: { tone: "green", label: "Done" }, running: { tone: "blue", label: "Running" }, sent: { tone: "blue", label: "Starting" },
  aborted: { tone: "amber", label: "Aborted" }, incomplete: { tone: "amber", label: "Incomplete" }, failed: { tone: "red", label: "Failed" },
  pending: { tone: "", label: "Pending" },
};
export function StatusChip({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: "", label: status };
  return <span className={`chip ${s.tone}`}>{(status === "running" || status === "sent") && <span className="pulse" style={{ background: "var(--blue)" }} />}{s.label}</span>;
}

/** Closes when clicking outside or pressing Escape. */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open, onClose]);
  return ref;
}

// ---------------------------------------------------------------- error boundary
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string; resetKey?: unknown }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(this.props.label ?? "UI error", error, info.componentStack); }
  componentDidUpdate(prev: { resetKey?: unknown }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="err-card row" style={{ gap: 12 }}>
        <AlertTriangle size={18} />
        <div className="grow"><b style={{ fontWeight: 500 }}>{this.props.label ?? "This section"} couldn't be displayed.</b>
          <div style={{ fontSize: 13, opacity: .8 }}>{this.state.error.message}</div></div>
        <button className="btn sm" onClick={() => this.setState({ error: null })}><RotateCcw size={14} />Retry</button>
      </div>
    );
  }
}

// ---------------------------------------------------------------- toasts
const ToastCtx = createContext<(msg: string, error?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; error: boolean; id: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const show = useCallback((msg: string, error = false) => {
    clearTimeout(timer.current);
    setT({ msg, error, id: Date.now() });
    timer.current = setTimeout(() => setT(null), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div key={t.id} className={`toast ${t.error ? "error" : ""}`} role="status">
        {t.error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} color="#cff25c" />}{t.msg}
      </div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
