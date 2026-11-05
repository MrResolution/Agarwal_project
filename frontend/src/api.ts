// Typed client for the FastAPI backend (proxied at /api by Vite).

export type Role = "admin" | "coach" | "therapist" | "athlete" | "patient" | "parent";
export const STAFF: Role[] = ["admin", "coach", "therapist"];

export interface Me { id: number; email: string; full_name: string; role: Role; org_id: number }
export interface Consent { data: boolean; video: boolean; research: boolean }
export interface Athlete {
  id: number; code: string; display_name: string | null; birth_year: number | null; group: string;
  sport: string | null; position: string | null; dominant_hand: string | null; dominant_foot: string | null;
  visual_correction: string | null; history_notes: string | null; goals: string | null;
  is_minor: boolean; anonymised_at: string | null; created_at: string; consent: Consent;
}
export interface AthleteStats {
  runs: number; completed: number; this_week: number; last_run_at: string | null; trend: number[];
  latest: { protocol: string; median_rt: number | null; accuracy: number | null; run_id: number } | null;
}
export interface ConsentRecord {
  id: number; type: "data" | "video" | "research"; text_version: string; signed_by: string;
  guardian_name: string | null; signed_at: string; withdrawn_at: string | null; active: boolean;
}
export interface Protocol {
  key: string; name: string; kind: string; description: string; n_trials: number;
  foreperiod_ms: [number, number]; window_ms: number; iti_ms: number; nogo_ratio: number; targets: string; skills: string[];
}
export interface CompactSummary {
  median_rt: number | null; mean_rt: number | null; sd_rt: number | null; cv: number | null; accuracy: number | null;
  overall_accuracy: number | null; dprime: number | null; valid_hits: number | null; trials: number | null;
  false_start_rate: number | null; omission_rate: number | null; commission_rate: number | null;
  premotor_median: number | null; movement_median: number | null; asymmetry_index_pct: number | null;
  quality: string | null; sway_velocity: number | null;
}
export interface Run {
  id: number; block_id: string; athlete_id: number; station: string; protocol: string; protocol_name: string;
  kind: string; params: Record<string, unknown>; seed: number; status: string; error: string | null; notes: string | null;
  created_at: string; finished_at: string | null; n_trials: number; summary: CompactSummary | null;
  plan?: TrialSpec[]; athlete_code?: string | null; athlete_name?: string | null;
}
export interface TrialSpec { trial_no: number; target_id: string; colour: string; foreperiod_ms: number; window_ms: number; is_nogo: boolean; iti_ms: number }
export interface Stats { n: number; median: number | null; mean: number | null; sd: number | null; iqr: number | null; mad: number | null; cv: number | null; min: number | null; max: number | null; p10: number | null; p90: number | null }
export interface TargetSummary { target_id: string; trials: number; hits: number; accuracy: number | null; median_rt: number | null; angle_deg?: number; side?: string; band?: string; row?: string }
export interface Summary {
  trials: number; counts: Record<string, number>; go_trials: number; nogo_trials: number; valid_hits: number;
  excluded_outliers: number; rt: Stats; premotor: Stats; movement: Stats; accuracy: number | null; overall_accuracy: number | null;
  omission_rate: number | null; commission_rate: number | null; false_start_rate: number | null; dprime: number | null;
  criterion: number | null; per_target: TargetSummary[]; by_band: Record<string, number | null>;
  by_side: { left: number | null; right: number | null; asymmetry_index_pct: number | null };
  histogram: { from: number; to: number; count: number }[]; quality: string;
}
export interface TrialResult {
  trial_no: number; target_id: string | null; colour: string | null; is_nogo: boolean; t_stimulus_us: number | null;
  response_target_id: string | null; t_response_us: number | null; rt_ms: number | null; premotor_ms: number | null;
  movement_ms: number | null; force: number | null; false_starts: number; result: string; excluded: string | null;
}
export interface Balance {
  status: string; samples?: number; duration_s?: number; mean_load_kg?: number; mean_cop_mm?: [number, number];
  path_length_mm?: number; mean_velocity_mm_s?: number; rms_ml_mm?: number; rms_ap_mm?: number; range_ml_mm?: number;
  range_ap_mm?: number; ellipse_area_mm2?: number; path?: [number, number][];
}
export interface LayoutPos { target_id: string; angle_deg: number; row: string; side: string; band: string; eccentricity_deg: number }
export interface Analysis {
  block_id: string; station: string; device_id: string; status: string; duration_s: number; started_at_us: number | null;
  summary: Summary; trials: TrialResult[]; balance: Balance | null; imu_sensor: string | null; layout: LayoutPos[];
}
export interface TrendPoint extends CompactSummary { run_id: number; block_id: string; at: string; rt_change_pct?: number }
export interface Trends { athlete_id: number; protocols: Record<string, { protocol_name: string; baseline: { median_rt: number | null; accuracy: number | null; runs: number[] }; points: TrendPoint[]; change_status: string }> }
export interface Overview {
  athletes: number; runs_total: number; runs_this_week: number; completed_this_week: number;
  median_rt_recent: number | null; accuracy_recent: number | null; runs_per_day: { date: string; runs: number }[];
  protocol_mix: Record<string, number>; devices_online: number; devices_total: number; open_alerts: number;
  recent_runs: Run[]; leaderboard: { athlete_id: number; code: string; name: string | null; sport: string | null; protocol: string; median_rt: number | null; accuracy: number | null }[];
  athletes_without_consent: number;
  leaderboards: Record<string, { athlete_id: number; code: string; name: string | null; sport: string | null; protocol: string; run_id: number; median_rt: number; accuracy: number | null; at: string }[]>;
}
export interface Device { id: string; station: string; kind: string; firmware: string | null; boot_id: string | null; online: boolean; battery_pct: number | null; rssi: number | null; last_seen: string | null; last_status: Record<string, any> }
export interface Alert { id: number; at: string; station: string; device_id: string | null; kind: string; severity: string; message: string; detail: Record<string, any>; resolved_at: string | null }
export interface BlockRow { block_id: string; first_event_at: string; last_event_at: string; events: number; stimuli: number; status: string; run_id: number | null; athlete_id: number | null; protocol: string | null }
export interface NetworkInfo { laptop_ips: string[]; broker: { port: number }; mdns: { hostname: string; service: string }; hub_should_connect_to: string[]; hubs: { device_id: string; online: boolean; ip: string | null; ssid: string | null; rssi: number | null; firmware: string | null }[] }

const TOKEN_KEY = "svs.token";
let token: string | null = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
let onUnauthorized: () => void = () => {};

export function setToken(t: string | null) {
  token = t;
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}
export const getToken = () => token;
export function onAuthLost(fn: () => void) { onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown, form = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body as Record<string, string>).toString();
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  if (res.status === 401 && path !== "/auth/token") onUnauthorized();
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : j.detail?.message ?? JSON.stringify(j.detail ?? j);
    } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  login: (email: string, password: string) =>
    request<{ access_token: string }>("POST", "/auth/token", { username: email, password }, true),
  me: () => request<Me>("GET", "/me"),
  overview: () => request<Overview>("GET", `/overview?days=42&tz_offset_min=${new Date().getTimezoneOffset()}`),
  athletes: (q = "") => request<Athlete[]>("GET", `/athletes${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  athlete: (id: number) => request<Athlete>("GET", `/athletes/${id}`),
  athleteStats: () => request<Record<number, AthleteStats>>("GET", "/athletes-stats"),
  createAthlete: (body: Partial<Athlete>) => request<Athlete>("POST", "/athletes", body),
  updateAthlete: (id: number, body: Partial<Athlete>) => request<Athlete>("PATCH", `/athletes/${id}`, body),
  consents: (id: number) => request<ConsentRecord[]>("GET", `/athletes/${id}/consents`),
  addConsent: (id: number, body: { type: string; text_version: string; signed_by: string; guardian_name?: string }) =>
    request<ConsentRecord>("POST", `/athletes/${id}/consents`, body),
  withdrawConsent: (id: number, cid: number) => request<ConsentRecord>("POST", `/athletes/${id}/consents/${cid}/withdraw`),
  protocols: () => request<Protocol[]>("GET", "/protocols"),
  runs: (athleteId: number) => request<Run[]>("GET", `/athletes/${athleteId}/runs`),
  startRun: (athleteId: number, body: { protocol: string; station: string; params?: Record<string, unknown>; notes?: string }) =>
    request<Run>("POST", `/athletes/${athleteId}/runs`, body),
  stopRun: (runId: number, estop = false) => request<Run>("POST", `/runs/${runId}/stop${estop ? "?estop=true" : ""}`),
  run: (runId: number) => request<{ run: Run; analysis: Analysis | null }>("GET", `/runs/${runId}`),
  trends: (athleteId: number) => request<Trends>("GET", `/athletes/${athleteId}/trends`),
  blocks: (station = "station-1") => request<BlockRow[]>("GET", `/stations/${station}/blocks`),
  blockAnalysis: (blockId: string) => request<Analysis>("GET", `/blocks/${encodeURIComponent(blockId)}/analysis`),
  devices: () => request<Device[]>("GET", "/devices"),
  alerts: (openOnly = false) => request<Alert[]>("GET", `/alerts?limit=60${openOnly ? "&open_only=true" : ""}`),
  resolveAlert: (id: number) => request<Alert>("POST", `/alerts/${id}/resolve`),
  network: () => request<NetworkInfo>("GET", "/network"),
  gateway: () => request<Record<string, any>>("GET", "/gateway"),
  command: (station: string, cmd: string) => request<Record<string, unknown>>("POST", `/stations/${station}/commands`, { cmd }),
};

export function wsUrl(station: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/ws/stations/${encodeURIComponent(station)}?token=${encodeURIComponent(token ?? "")}`;
}
