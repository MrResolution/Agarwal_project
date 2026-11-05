import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CameraOff, LoaderCircle, PersonStanding, Video } from "lucide-react";
import { useStationFeed, type FeedMessage } from "../lib";
import { PoseTracker, type Snapshot } from "./tracker";

const Ctx = createContext<PoseTracker | null>(null);

/** One tracker for the whole app; it listens to the station feed while tracking is running. */
export function PoseProvider({ station, children }: { station: string; children: ReactNode }) {
  const [tracker] = useState(() => new PoseTracker());
  const snap = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
  useStationFeed(station, (m: FeedMessage) => {
    if (m.type === "event") tracker.onStationEvent(m.event);
    else if (m.type === "device_status" && Array.isArray(m.status?.targets)) tracker.setTargets(m.status.targets.length);
  }, snap.status === "running");
  useEffect(() => () => tracker.stop(), [tracker]);
  return <Ctx.Provider value={tracker}>{children}</Ctx.Provider>;
}

export function usePose(): [PoseTracker, Snapshot] {
  const t = useContext(Ctx);
  if (!t) throw new Error("usePose needs <PoseProvider>");
  return [t, useSyncExternalStore(t.subscribe, t.getSnapshot)];
}

/** The live view: camera (or simulated studio) with the skeleton, sized to the source's aspect. */
export function PoseCanvas({ compact = false, idle }: { compact?: boolean; idle?: ReactNode }) {
  const [tracker, snap] = usePose();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const aspect = snap.frameSize ? snap.frameSize.w / snap.frameSize.h : 16 / 9;

  useLayoutEffect(() => {
    const el = wrap.current, c = canvas.current;
    if (!el || !c) return;
    const size = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; tracker.redraw(); }
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);
    tracker.attach(c, compact);
    return () => { ro.disconnect(); tracker.detach(c); };
  }, [tracker, compact]);

  const live = snap.status === "running";
  const g = snap.guidance;
  return (
    <div ref={wrap} className={`pose-stage ${compact ? "compact" : ""}`} style={{ aspectRatio: String(aspect) }}>
      <canvas ref={canvas} aria-label={live ? `Body tracking view: ${g.text}` : "Body tracking is off"} role="img" />
      {live && (
        <>
          <div className="pose-badges">
            <span className={`pose-badge ${snap.source === "camera" ? "rec" : "sim"}`}>{snap.source === "camera" ? "LIVE" : "SIMULATED"}</span>
            {snap.fps != null && <span className="pose-badge">{Math.round(snap.fps)} fps</span>}
            {!compact && snap.inferenceMs != null && <span className="pose-badge">{snap.inferenceMs.toFixed(0)} ms model</span>}
            {snap.demo && <span className="pose-badge" title="No block is running, so the simulated athlete reaches for demo targets">Demo motion</span>}
          </div>
          {!compact && <div className="pose-legend"><span><i style={{ background: "#6f95ff" }} />Left</span><span><i style={{ background: "#cff25c" }} />Right</span></div>}
          {g.tone !== "ok" && <div className={`pose-guide ${g.tone}`}>{g.text}</div>}
        </>
      )}
      {!live && (
        <div className="pose-empty">
          {snap.status === "starting" || snap.status === "loading" ? (
            <div className="pose-empty-inner"><LoaderCircle size={compact ? 26 : 34} className="spin" /><div>{snap.message}</div></div>
          ) : snap.status === "error" ? (
            <div className="pose-empty-inner"><CameraOff size={compact ? 26 : 34} /><div className="pose-err">{snap.error}</div>{idle}</div>
          ) : (
            <div className="pose-empty-inner">
              <span className="pose-empty-ico">{compact ? <Video size={22} /> : <PersonStanding size={30} />}</span>
              <div>{compact ? "Body tracking is off" : "Start the camera to track the athlete's posture with a 33-point skeleton."}</div>
              {idle}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
