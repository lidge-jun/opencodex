export const LINK_ERROR_CODES = [
  "admission_timeout",
  "admission_failed",
  "compensation_failed",
  "fingerprint_failed",
  "forbidden",
  "host_confirmation_expired",
  "host_fingerprint_mismatch",
  "host_not_confirmed",
  "invalid_alias",
  "invalid_body",
  "invalid_link_id",
  "join_connect_failed",
  "join_in_progress",
  "join_issue_failed",
  "join_port_failed",
  "join_port_mismatch",
  "join_restart_failed",
  "join_rollback_failed",
  "join_tunnel_failed",
  "key_issue_failed",
  "key_revoke_failed",
  "link_apply_failed",
  "link_exists",
  "link_not_found",
  "link_remove_failed",
  "link_unavailable",
  "listener_unavailable",
  "probe_failed",
  "remote_connect_failed",
  "remote_disconnect_failed",
  "remote_ocx_missing",
  "remote_ocx_outdated",
  "remote_ocx_unrecognized",
  "remote_port_failed",
  "standalone_required",
  "tailscale_session_refused",
  "version_probe_failed",
] as const;

export type LinkErrorCode = typeof LINK_ERROR_CODES[number];

export type LinkWireDirection = "hub-initiated" | "client-initiated";
export type LinkWireState = "connecting" | "connected" | "reconnecting" | "failed" | "idle";
export type LinkListenerState = "off" | "listening" | "failed";

export interface LinkCandidateView { alias: string; source: string }
export interface LinkProbeView { alias: string; fingerprint: string; keyType: string }
export interface LinkConfirmHostView { alias: string; fingerprint: string; ocxVersion: string }
export interface LinkRowWire { id: string; alias: string; direction: LinkWireDirection; state: LinkWireState; since: string; reason: string | null; tunnelPort: number }
export interface RemoteLinkStatusWire {
  role: "standalone" | "home" | "child";
  listener: { state: LinkListenerState; port: number | null };
  links: LinkRowWire[];
  child: null | { alias: string; state: LinkWireState; since: string; reason: string | null };
  /**
   * Whether this dashboard session may join a Home as a Child: a dashboard session on a
   * standalone runtime that listens on its configured port. The server omits the field for
   * non-dashboard callers, read as false.
   */
  joinAvailable: boolean;
}

const LINK_STATES: readonly LinkWireState[] = ["connecting", "connected", "reconnecting", "failed", "idle"];
const LINK_ROLES = ["standalone", "home", "child"] as const;

export class LinkApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** The server's bounded hint line (ssh stderr, the ssh runner's own failure, or the parsed remote version), shown under the translated message. */
  readonly hint: string | null;

  constructor(code: string, status: number, hint: string | null = null) {
    super(code);
    this.name = "LinkApiError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

const HINT_MAX_CHARS = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** C0/C1 controls plus the invisible and bidi formatting ranges, compared by code point. */
function isHintControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff;
}

/**
 * The server already bounds hints; the dashboard re-bounds them so no response can grow the UI.
 * The cap counts and cuts code points, so an astral character is never split into a lone surrogate.
 */
export function boundLinkHint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = Array.from(value, char => isHintControl(char.codePointAt(0) ?? 0) ? " " : char).join("").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const points = Array.from(clean);
  return points.length > HINT_MAX_CHARS ? `${points.slice(0, HINT_MAX_CHARS - 1).join("")}\u2026` : clean;
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isLinkState(value: unknown): value is LinkWireState { return typeof value === "string" && LINK_STATES.includes(value as LinkWireState); }

export function parseRemoteLinkStatus(value: unknown): RemoteLinkStatusWire {
  if (!isRecord(value) || !LINK_ROLES.includes(value.role as typeof LINK_ROLES[number])) throw new Error("invalid status");
  const listener = value.listener;
  if (!isRecord(listener) || !["off", "listening", "failed"].includes(String(listener.state)) || (listener.port !== null && typeof listener.port !== "number")) throw new Error("invalid listener");
  if (!Array.isArray(value.links)) throw new Error("invalid links");
  const links = value.links.map(item => {
    if (!isRecord(item) || !nonEmpty(item.id) || !nonEmpty(item.alias) || !["hub-initiated", "client-initiated"].includes(String(item.direction)) || !isLinkState(item.state) || !nonEmpty(item.since) || (item.reason !== null && typeof item.reason !== "string") || typeof item.tunnelPort !== "number") throw new Error("invalid link");
    return { id: item.id, alias: item.alias, direction: item.direction as LinkWireDirection, state: item.state, since: item.since, reason: item.reason as string | null, tunnelPort: item.tunnelPort };
  });
  let child: RemoteLinkStatusWire["child"] = null;
  if (value.child !== null) {
    if (!isRecord(value.child) || !nonEmpty(value.child.alias) || !isLinkState(value.child.state) || !nonEmpty(value.child.since) || (value.child.reason !== null && typeof value.child.reason !== "string")) throw new Error("invalid child");
    child = { alias: value.child.alias, state: value.child.state, since: value.child.since, reason: value.child.reason as string | null };
  }
  return { role: value.role as RemoteLinkStatusWire["role"], listener: { state: listener.state as LinkListenerState, port: listener.port as number | null }, links, child, joinAvailable: value.joinAvailable === true };
}

/** Read link-route JSON and preserve the server's machine-readable error code. */
export async function readLinkJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch { /* malformed response is handled by the success-body guard below */ }

  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    const code = error && typeof error.code === "string" ? error.code : "unknown";
    throw new LinkApiError(code, response.status, boundLinkHint(error?.hint));
  }
  if (body === null || body === undefined) throw new LinkApiError("invalid_body", response.status);
  return body as T;
}

export async function requestLinkJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, cache: "no-store" });
  return readLinkJson<T>(response);
}

/** The identity `/healthz` reports without a session: the runtime role and process id. */
export interface RuntimeHealthView { role: string | null; pid: number | null }

/** Read the serving runtime's `/healthz`. Never throws: no answer, or not OpenCodex, is null. */
export async function readRuntimeHealth(apiBase: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<RuntimeHealthView | null> {
  try {
    const response = await fetchImpl(`${apiBase}/healthz`, { cache: "no-store", signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || body.service !== "opencodex") return null;
    return { role: typeof body.role === "string" ? body.role : null, pid: typeof body.pid === "number" ? body.pid : null };
  } catch {
    return null;
  }
}

export const CHILD_RESTART_POLL_MS = 1_000;
/** The poll interval once the restart is slower than the server's own handoff budget. */
export const CHILD_RESTART_SLOW_POLL_MS = 5_000;
/**
 * The server's handoff budget plus a margin, the window `ocx restart` also observes: up to 60 s of
 * drain (`MEMORY_DRAIN_RESTART_MS`), then up to 70 s for the replacement to answer
 * (`REPLACEMENT_READY_TIMEOUT_MS`), plus 15 s. Past it the page says the restart is slow and keeps
 * checking, so a Child that comes up late still reloads the page.
 */
export const CHILD_RESTART_NOTICE_MS = 145_000;
const CHILD_RESTART_PROBE_TIMEOUT_MS = 2_000;

export interface ChildRestartWaitDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called once when the wait passes `CHILD_RESTART_NOTICE_MS`; the wait goes on. */
  onSlow?: () => void;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Wait for the Child runtime that replaces this standalone after a join. It is ready when
 * `/healthz` reports `role: "client"` under a pid other than the one read before the join; only
 * then is reloading safe, because the draining parent keeps answering as standalone until it
 * exits. One small unauthenticated read per second until `CHILD_RESTART_NOTICE_MS`, then one
 * every 5 seconds, until the Child answers or the caller aborts. The wait never gives up by
 * itself: a Child that is late, or restarted by its supervisor, still brings the page back.
 */
export async function waitForChildRuntime(
  apiBase: string,
  previousPid: number | null,
  signal: AbortSignal,
  deps: ChildRestartWaitDeps = {},
): Promise<"ready" | "aborted"> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepUnlessAborted;
  const noticeAt = now() + CHILD_RESTART_NOTICE_MS;
  let slow = false;
  for (;;) {
    if (signal.aborted) return "aborted";
    const health = await readRuntimeHealth(apiBase, AbortSignal.any([signal, AbortSignal.timeout(CHILD_RESTART_PROBE_TIMEOUT_MS)]), deps.fetchImpl);
    if (signal.aborted) return "aborted";
    if (health?.role === "client" && (previousPid === null || health.pid !== previousPid)) return "ready";
    if (!slow && now() >= noticeAt) {
      slow = true;
      deps.onSlow?.();
    }
    await sleep(slow ? CHILD_RESTART_SLOW_POLL_MS : CHILD_RESTART_POLL_MS, signal);
  }
}
