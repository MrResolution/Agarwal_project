import { Check, Cpu, Radio, Wifi } from "lucide-react";
import { api } from "../api";
import { Gauge } from "../charts";
import { useAsync, when } from "../lib";
import { Card, Empty, Kpi, Skeleton, useToast } from "../ui";

const SEV: Record<string, string> = { critical: "red", warning: "amber", info: "" };

export default function Devices() {
  const toast = useToast();
  const devices = useAsync(() => api.devices(), [], 5000);
  const net = useAsync(() => api.network(), [], 10000);
  const alerts = useAsync(() => api.alerts(), [], 6000);
  const gw = useAsync(() => api.gateway(), [], 5000);
  const g = gw.data;
  const clocks = Object.entries((g?.clocks ?? {}) as Record<string, any>);

  async function resolve(id: number) {
    try { await api.resolveAlert(id); alerts.reload(); } catch (e) { toast((e as Error).message, true); }
  }
  async function ping(station: string) {
    try { await api.command(station, "ping"); toast(`${station} acknowledged`); } catch (e) { toast((e as Error).message, true); }
  }

  return (
    <>
      <div className="headline">
        <div style={{ marginRight: "auto" }}>
          <h1>Devices</h1>
          <div className="sub">Hubs, network setup, data quality and alerts</div>
        </div>
      </div>
      <div className="grid g-dash">
        <div className="span-12 kpis">
          <Kpi label="Gateway" value={g ? (g.connected ? "Connected" : "Down") : "–"} note={g ? `${g.stats?.messages ?? 0} messages` : undefined} icon={<Radio size={14} />} />
          <Kpi label="Events stored" value={g?.stats?.events ?? 0} note={`${g?.stats?.duplicates ?? 0} duplicates dropped`} />
          <Kpi label="Samples streamed" value={(g?.stats?.stream_samples ?? 0).toLocaleString()} note={`${g?.parquet?.files_written ?? 0} Parquet files`} />
          <Kpi label="Lost messages" value={g?.stats?.gaps ?? 0} note="gap reports" />
          <Kpi label="Rejected" value={g?.stats?.invalid ?? 0} note="malformed messages" />
        </div>

        <Card className="span-8" title="Hubs">
          {!devices.data ? <Skeleton h={160} /> : !devices.data.length ? <Empty icon={<Cpu />}>No hub has connected yet. Power one on, or run the simulator.</Empty> :
            devices.data.map((d) => {
              const s = d.last_status ?? {};
              return (
                <div key={d.id} className="list-item" style={{ alignItems: "center", flexWrap: "wrap" }}>
                  <Gauge value={d.battery_pct != null ? d.battery_pct / 100 : null} size={78} />
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div className="row" style={{ gap: 8 }}><span className={`pulse ${d.online ? "" : "off"}`} /><b style={{ fontWeight: 500 }}>{d.id}</b><span className="chip">{d.station}</span></div>
                    <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                      {d.firmware ?? "firmware ?"} · boot {d.boot_id} · seen {when(d.last_seen)}
                    </div>
                    <div className="muted" style={{ fontSize: 13 }}><Wifi size={12} /> {s.ip ?? "ip ?"} {s.ssid ? `on ${s.ssid}` : ""} · {d.rssi != null ? `${Math.round(d.rssi)} dBm` : ""}</div>
                    <div className="row wrap mt-8" style={{ gap: 6 }}>
                      {(s.targets ?? []).map((t: { id: string; online: boolean }) => <span key={t.id} className={`chip ${t.online ? "blue" : "red"}`} style={{ height: 24 }}>{t.id}</span>)}
                      {(s.sensors ?? []).map((x: string) => <span key={x} className="chip lime" style={{ height: 24 }}>{x}</span>)}
                    </div>
                  </div>
                  <button className="btn sm" onClick={() => ping(d.station)} disabled={!d.online}>Ping</button>
                </div>
              );
            })}
        </Card>

        <Card className="span-4" title="Connect a hub" sub="Router or phone hotspot">
          {!net.data ? <Skeleton h={160} /> : <>
            <div className="muted" style={{ fontSize: 13 }}>Hubs on the same Wi-Fi connect to</div>
            {net.data.hub_should_connect_to.map((a) => <div key={a} className="big mono" style={{ fontSize: 22, marginTop: 6 }}>{a}</div>)}
            <div className="insight mt-16">
              <div>mDNS: <span className="mono">{net.data.mdns.hostname}</span> · <span className="mono">{net.data.mdns.service}</span></div>
              <div className="mt-8">Start the broker with <span className="mono">python -m svs.broker --lan</span> and allow TCP {net.data.broker.port} in the firewall.</div>
            </div>
            {clocks.length > 0 && <div className="mt-16">
              <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>Clock sync</div>
              {clocks.map(([k, c]) => (
                <div key={k} className="row between" style={{ fontSize: 13, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                  <span className="mono">{k}</span>
                  <span>{c.synced ? `±${Math.round(c.uncertainty_us / 1000 * 10) / 10} ms · ${c.drift_ppm} ppm` : "not synced"}</span>
                </div>
              ))}
            </div>}
          </>}
        </Card>

        <Card className="span-12" title="Alerts" sub="Newest first">
          {!alerts.data ? <Skeleton h={140} /> : !alerts.data.length ? <Empty>No alerts.</Empty> : (
            <div className="scroll-x" style={{ maxHeight: 380, overflowY: "auto" }}><table className="table">
              <thead><tr><th>When</th><th>Severity</th><th>Kind</th><th>Message</th><th>Device</th><th></th></tr></thead>
              <tbody>{alerts.data.map((a) => (
                <tr key={a.id} style={{ opacity: a.resolved_at ? 0.5 : 1 }}>
                  <td className="muted">{when(a.at)}</td>
                  <td><span className={`chip ${SEV[a.severity] ?? ""}`}>{a.severity}</span></td>
                  <td className="mono">{a.kind}</td><td style={{ whiteSpace: "normal" }}>{a.message}</td><td>{a.device_id ?? "–"}</td>
                  <td>{!a.resolved_at && a.severity !== "info" && <button className="btn sm ghost" onClick={() => resolve(a.id)}><Check size={14} />Resolve</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
