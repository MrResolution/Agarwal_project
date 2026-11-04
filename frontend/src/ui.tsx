import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { Link } from "react-router-dom";

export function Card({ title, sub, action, to, children, className = "", style }: {
  title?: ReactNode; sub?: ReactNode; action?: ReactNode; to?: string; children?: ReactNode; className?: string; style?: React.CSSProperties;
}) {
  return (
    <section className={`card ${className}`} style={style}>
      {(title || action || to) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {sub && <div className="card-sub" style={{ marginTop: 2 }}>{sub}</div>}
          </div>
          <div className="spacer" />
          {action}
          {to && <Link className="round-link" to={to} aria-label="Open"><ArrowUpRight size={16} /></Link>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, unit, note, icon }: { label: string; value: ReactNode; unit?: string; note?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="lbl">{icon}{label}</div>
      <div className="val">{value}{unit && <small>{unit}</small>}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export function Progress({ value, tone = "lime" }: { value: number | null; tone?: "lime" | "blue" }) {
  return <div className={`progress ${tone === "blue" ? "blue" : ""}`}><span style={{ width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%` }} /></div>;
}

export function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return <div className="empty">{icon}{children}</div>;
}

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} />;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="row between" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 20 }}>{title}</h3>
          <button className="round-link" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone: Record<string, string> = { done: "green", running: "blue", sent: "blue", aborted: "amber", incomplete: "amber", failed: "red", pending: "" };
  return <span className={`chip ${tone[status] ?? ""}`}>{status === "sent" ? "starting" : status}</span>;
}

// ---------------------------------------------------------------- toasts
const ToastCtx = createContext<(msg: string, error?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; error: boolean } | null>(null);
  const show = useCallback((msg: string, error = false) => {
    setT({ msg, error });
    setTimeout(() => setT(null), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div className={`toast ${t.error ? "error" : ""}`} role="status">{t.msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
