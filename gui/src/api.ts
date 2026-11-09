import { promptForAdminToken, type AdminTokenVerifier } from "./admin-token-dialog";
import { createBoundedFetch, withFetchDeadline } from "./bounded-fetch";
import { adminTokenPromptAllowed, apiTargetIdentity, standaloneApiTargets, type ApiPlane, type ApiTarget, type ApiTargets } from "./api-targets";

const EXPECTED_TARGET_HEADER = "x-opencodex-expected-target";
export const TARGET_CHANGED_EVENT = "opencodex:target-changed";
export const TARGET_PREFLIGHT_LEGACY_EVENT = "opencodex:target-preflight-legacy";
let apiTargetGeneration = 0;
let lastTargetIdentity: string | null = null;

export interface ApiTargetCapture {
  apiBase: string;
  targetKey: string;
  origin: string;
  requestGeneration: number;
  transport: ApiTarget["transport"];
  relayTargetCheck?: "expected-target-v1";
  /**
   * An embedded component supplied its own base while this dashboard had no discovered
   * topology. Such a capture is authoritative only until discovery configures a machine
   * or shared plane; after that the live target wins and the capture is stale.
   */
  standalone?: true;
}

/** Non-secret generation fencing every Usage report and inventory. */
export const USAGE_SESSION_CHANGED = "opencodex:usage-session-changed";
type UsageSessionSnapshot = { generation: number; blocked: boolean };
let usageSession: UsageSessionSnapshot = { generation: 0, blocked: false };
export function usageSessionSnapshot(): UsageSessionSnapshot { return usageSession; }
export function purgeLegacyUsageCache(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith("ocx.usage.v2:")) sessionStorage.removeItem(key);
    }
  } catch { /* Storage may be unavailable. */ }
}
function changeUsageSession(blocked: boolean): void {
  usageSession = { generation: usageSession.generation + 1, blocked };
  purgeLegacyUsageCache();
  if (typeof window !== "undefined") {
    try { window.dispatchEvent(new window.Event(USAGE_SESSION_CHANGED)); } catch { /* Non-browser event environments. */ }
  }
}
/** An old request cannot revoke a newer session. */
export function denyUsageSession(generation: number): void {
  if (usageSession.generation === generation && !usageSession.blocked) changeUsageSession(true);
}

/** A successful management mutation may change the source-facet inventory. */
export const USAGE_SOURCE_INVENTORY_CHANGED = "opencodex:usage-source-inventory-changed";

function sourceInventoryMutation(path: string | null, method: string): boolean {
  if (!path) return false;
  if (path === "/api/keys") return ["POST", "PATCH", "DELETE"].includes(method);
  if (path === "/api/keys/rotate") return method === "POST" || method === "DELETE";
  if (path === "/api/keys/rotate/commit") return method === "POST";
  if (["/api/link/apply", "/api/link/issue", "/api/link/join"].includes(path)) return method === "POST";
  if (/^\/api\/link\/[^/]+$/.test(path)) return method === "DELETE";
  return /^\/api\/link\/[^/]+\/reconnect$/.test(path) && method === "POST";
}

export function sourceInventoryEventMatches(event: Event, apiBase: string): boolean {
  const detail = (event as CustomEvent<{ apiBase?: string }>).detail;
  try { return typeof detail?.apiBase === "string" && new URL(detail.apiBase || "/", window.location.href).href.replace(/\/+$/, "") === new URL(apiBase || "/", window.location.href).href.replace(/\/+$/, ""); }
  catch { return false; }
}

/**
 * Fired after an unauthorized request cannot recover a session. The shell synchronizes
 * its existing readiness state; cancelled callers and newer valid sessions emit no notice.
 */
export const SESSION_UNAVAILABLE_EVENT = "opencodex:session-unavailable";
/** Token identity changed; contains only the plane, never credential material. */
export const SESSION_CHANGED_EVENT = "opencodex:session-changed";
/** The remembered-device proof was stored or cleared; contains only the plane. */
export const DEVICE_PROOF_CHANGED_EVENT = "opencodex:device-proof-changed";

const LEGACY_TOKEN_KEY = "opencodex-api-token";
const DEVICE_PROOF_KEY = "opencodex.dashboard-device-proof";
const DEVICE_PROOF_PATTERN = /^ocx_proof_[A-Za-z0-9_-]{43}$/;
// Any guarded route answers 401 for a bad token; this one is a cheap config read. /api/settings
// also resolves the Codex runtime and startup health, which made the token prompt hang.
const ADMIN_TOKEN_VALIDATION_PATH = "/api/combos";
const SESSION_REBOOTSTRAP_TIMEOUT_MS = 10_000;
const RESOLUTION_WATCHDOG_MS = 15_000;
const MACHINE_SESSION_HEADER = "X-OpenCodex-Machine-Session";
const MACHINE_GUI_ORIGIN_HEADER = "X-OpenCodex-Machine-GUI-Origin";
const MACHINE_CSRF_HEADER = "X-OpenCodex-Machine-CSRF-Token";

interface ApiSessionState {
  token: string | null;
  csrfToken: string | null;
  browserOrigin: string | null;
  serverOrigin: string | null;
}

interface TargetRuntime {
  target: ApiTarget;
  session: ApiSessionState;
  generation: object;
  // Pending/successful explicit logout blocks renewal until an explicit login replaces it.
  logoutBarrier: { pending: number; completed: boolean } | null;
  resolutionInFlight: Promise<SessionSnapshot | null> | null;
  promptCancelled: boolean;
}

interface SessionRevision { state: TargetRuntime; generation: object }
interface SessionSnapshot extends SessionRevision { token: string | null }
interface RecoveryAttempt extends SessionRevision { plane: ApiPlane; active: boolean }

type AdminTokenPrompt = (verifyToken: AdminTokenVerifier, rememberAllowed?: boolean) => Promise<string | null>;
const defaultAdminTokenPrompt: AdminTokenPrompt = (verify, allowed) => promptForAdminToken(verify, undefined, allowed);
type RebootstrapResult = { kind: "minted"; token: string } | { kind: "unavailable" } | { kind: "failed" };

let installed = false;
let rawFetch: typeof fetch | null = null;
let configuredTargets: ApiTargets | null = null;
let requestAdminToken: AdminTokenPrompt = defaultAdminTokenPrompt;
let rebootstrapTimeoutMs = SESSION_REBOOTSTRAP_TIMEOUT_MS;
let resolutionWatchdogMs = RESOLUTION_WATCHDOG_MS;
const runtimes = new Map<ApiPlane, TargetRuntime>();
const sessionHandoffOwners = new WeakMap<ApiSessionState, object>();

function reportSessionEvent(plane: ApiPlane, event: string): void {
  if (typeof window === "undefined") return;
  if (plane === "shared" && event === SESSION_UNAVAILABLE_EVENT && !usageSession.blocked) changeUsageSession(true);
  // Take the constructor off the same window we dispatch on: a test harness (and a
  // sandboxed embed) can supply a document without installing CustomEvent globally.
  const Ctor = (window as unknown as { CustomEvent?: typeof CustomEvent }).CustomEvent
    ?? (typeof CustomEvent === "function" ? CustomEvent : null);
  if (!Ctor) return;
  try {
    window.dispatchEvent(new Ctor(event, { detail: { plane } }));
  } catch { /* a shell that cannot receive the notice must not break the fetch path */ }
}

function advanceSessionGeneration(state: TargetRuntime, notifyUsage = true): void {
  state.generation = {};
  state.resolutionInFlight = null;
  if (notifyUsage && state.target.id === "shared") changeUsageSession(!!state.logoutBarrier || !state.session.token);
}

function sessionSnapshot(state: TargetRuntime): SessionSnapshot {
  return { state, generation: state.generation, token: state.session.token };
}

function isCurrentRevision(plane: ApiPlane, revision: SessionRevision): boolean {
  return runtimes.get(plane) === revision.state && revision.state.generation === revision.generation;
}

function isCurrentRecovery(recovery: RecoveryAttempt): boolean {
  return recovery.active && !recovery.state.logoutBarrier && isCurrentRevision(recovery.plane, recovery);
}

function updateSession(state: TargetRuntime, session: ApiSessionState, recovery?: RecoveryAttempt): void {
  if (recovery && !isCurrentRecovery(recovery)) return;
  const changed = state.session.token !== session.token;
  advanceSessionGeneration(state, false);
  state.session = session;
  // Advance our own recovery before synchronous session-event listeners can supersede it.
  if (recovery) recovery.generation = state.generation;
  if (state.target.id === "shared") changeUsageSession(!session.token);
  if (changed) reportSessionEvent(state.target.id, SESSION_CHANGED_EVENT);
}

function blankSession(): ApiSessionState {
  return { token: null, csrfToken: null, browserOrigin: null, serverOrigin: null };
}

/** Automatic invalidation retains rollback authority; login, logout and target changes do not. */
function invalidateSession(state: TargetRuntime, recovery?: RecoveryAttempt, handoffOwner?: object): void {
  const cleared = blankSession();
  const owner = handoffOwner ?? sessionHandoffOwners.get(state.session);
  if (owner) sessionHandoffOwners.set(cleared, owner);
  updateSession(state, cleared, recovery);
}

function ensureTargets(): ApiTargets {
  if (!configuredTargets) configureApiTargets(standaloneApiTargets(""));
  return configuredTargets!;
}

function sameTarget(left: ApiTarget, right: ApiTarget): boolean {
  return left.baseUrl === right.baseUrl && left.serverOrigin === right.serverOrigin && left.transport === right.transport;
}

export function configureApiTargets(targets: ApiTargets): void {
  const identity = apiTargetIdentity(targets);
  if (lastTargetIdentity !== identity.key) {
    lastTargetIdentity = identity.key;
    apiTargetGeneration += 1;
  }
  configuredTargets = targets;
  for (const plane of ["machine", "shared"] as const) {
    const current = runtimes.get(plane);
    if (current && !sameTarget(current.target, targets[plane])) updateSession(current, blankSession());
    if (current && sameTarget(current.target, targets[plane])) {
      if (current.target.bootstrapPath !== targets[plane].bootstrapPath) {
        advanceSessionGeneration(current);
        current.logoutBarrier = null;
        sessionHandoffOwners.delete(current.session);
      }
      current.target = targets[plane];
    } else runtimes.set(plane, {
      target: targets[plane], session: blankSession(), generation: {}, logoutBarrier: null, resolutionInFlight: null, promptCancelled: false,
    });
  }
}

function runtime(plane: ApiPlane): TargetRuntime {
  ensureTargets();
  return runtimes.get(plane)!;
}

/**
 * Capture the logical target at the user action boundary, before any await.
 *
 * A component may be mounted with its own `apiBase` (the dashboard's public embedding
 * contract). While this page has no discovered topology that base is the target: the
 * dashboard is standalone and the prop names the server the component manages. Once
 * discovery configures a machine/shared plane the live target is authoritative, so a
 * caller cannot retarget a configured dashboard by passing a different base.
 */
export function captureApiTarget(plane: ApiPlane = "shared", explicitBase?: string): ApiTargetCapture {
  const targets = ensureTargets();
  const state = runtime(plane);
  const supplied = typeof explicitBase === "string" ? explicitBase.replace(/\/+$/, "") : "";
  if (!targets.connected && supplied !== "") {
    const resolved = new URL(supplied || "/", window.location.href);
    return {
      apiBase: supplied,
      targetKey: resolved.origin,
      origin: resolved.origin,
      requestGeneration: apiTargetGeneration,
      transport: "same-origin",
      standalone: true,
    };
  }
  return {
    apiBase: state.target.baseUrl,
    targetKey: apiTargetIdentity(targets).key,
    origin: plane === "shared" ? targets.shared.serverOrigin : state.target.serverOrigin,
    requestGeneration: apiTargetGeneration,
    transport: state.target.transport,
    ...(targets.relayTargetCheck === "expected-target-v1" ? { relayTargetCheck: "expected-target-v1" as const } : {}),
  };
}

function targetChangedResponse(): Response {
  return Response.json({ error: "target_changed" }, { status: 409, headers: { "Cache-Control": "no-store" } });
}

function targetCaptureMatches(capture: ApiTargetCapture): boolean {
  const targets = ensureTargets();
  if (capture.standalone) {
    // Discovery invalidates an embedded base: the connected plane, not the prop, owns
    // the target from then on.
    return !targets.connected && apiTargetGeneration === capture.requestGeneration;
  }
  const state = runtime("shared");
  return apiTargetGeneration === capture.requestGeneration
    && apiTargetIdentity(targets).key === capture.targetKey
    && state.target.baseUrl === capture.apiBase
    && targets.shared.serverOrigin === capture.origin
    && state.target.transport === capture.transport;
}

/** A completion may apply only while the action's captured target is still current. */
export function isApiTargetCaptureCurrent(capture: ApiTargetCapture): boolean {
  return targetCaptureMatches(capture);
}

async function legacyRelayPreflight(capture: ApiTargetCapture): Promise<Response | null> {
  try {
    const machineBase = runtime("machine").target.baseUrl;
    const response = await globalThis.fetch(`${machineBase}/api/machine/status`, { cache: "no-store" });
    if (!response.ok) return Response.json({ error: "target_check_unavailable" }, { status: 503 });
    const status = await response.json().catch(() => null) as { sharedServerOrigin?: unknown } | null;
    if (typeof status?.sharedServerOrigin !== "string" || status.sharedServerOrigin !== capture.origin) {
      try { window.dispatchEvent(new window.Event(TARGET_CHANGED_EVENT)); } catch { /* non-browser */ }
      return targetChangedResponse();
    }
    try {
      window.dispatchEvent(new window.CustomEvent(TARGET_PREFLIGHT_LEGACY_EVENT, { detail: { targetKey: capture.targetKey } }));
    } catch { /* non-browser */ }
    return null;
  } catch {
    return Response.json({ error: "target_check_unavailable" }, { status: 503 });
  }
}

/**
 * Send a mutation through the target captured when the user acted. Authentication is read
 * only after the captured target is verified. The expected-target header carries the
 * capture's origin; whether that header is negotiated comes from the live target, so a
 * same-identity downgrade uses the fresh legacy preflight.
 */
export async function targetFetch(
  capture: ApiTargetCapture,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Every stale capture is refused before authentication or fetch, regardless of who
  // created it. A render-owned capture changes only the capture point, not the fence.
  if (!targetCaptureMatches(capture)) return targetChangedResponse();
  let requestUrl: URL;
  try {
    requestUrl = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  } catch {
    return targetChangedResponse();
  }
  const capturedBase = new URL(capture.apiBase || "/", window.location.href);
  const capturedPath = capturedBase.pathname.replace(/\/$/, "");
  if (requestUrl.origin !== capturedBase.origin
    || (capturedPath !== "" && requestUrl.pathname !== capturedPath && !requestUrl.pathname.startsWith(`${capturedPath}/`))) {
    return targetChangedResponse();
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const mutation = method !== "GET" && method !== "HEAD";
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (capture.transport === "relay") {
    // The capture names the target; the live target names the negotiated capability. A
    // relay that downgraded on the same identity must not be trusted to check a header
    // it no longer advertises: fall back to the fresh legacy preflight.
    const negotiated = ensureTargets().relayTargetCheck;
    if (negotiated === "expected-target-v1") {
      headers.set(EXPECTED_TARGET_HEADER, capture.origin);
    } else if (mutation) {
      const refusal = await legacyRelayPreflight(capture);
      if (refusal) return refusal;
      if (!targetCaptureMatches(capture)) return targetChangedResponse();
    }
  }
  const response = await globalThis.fetch(input, { ...init, headers });
  if (capture.transport === "relay" && response.status === 409) {
    const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
    if (body?.error === "target_changed") {
      try { window.dispatchEvent(new window.Event(TARGET_CHANGED_EVENT)); } catch { /* non-browser */ }
    }
  }
  return response;
}

function clearSessionIfCurrent(plane: ApiPlane, expected: string | null): void {
  const state = runtime(plane);
  if (!state.logoutBarrier && expected !== null && state.session.token === expected) invalidateSession(state);
}

function storeSession(
  plane: ApiPlane,
  token: string | null,
  csrfToken: string | null,
  browserOrigin: string | null,
  serverOrigin: string | null,
  recovery?: RecoveryAttempt,
  handoffOwner?: object,
): boolean {
  if (recovery && !isCurrentRecovery(recovery)) return false;
  const state = runtime(plane);
  if (!token?.startsWith("ocx_session_") || !csrfToken
    || browserOrigin !== window.location.origin || serverOrigin !== state.target.serverOrigin) {
    invalidateSession(state, recovery, handoffOwner);
    return false;
  }
  const session = { token, csrfToken, browserOrigin, serverOrigin };
  if (handoffOwner) sessionHandoffOwners.set(session, handoffOwner);
  if (!recovery) state.logoutBarrier = null;
  updateSession(state, session, recovery);
  if (recovery && !isCurrentRecovery(recovery)) return false;
  state.promptCancelled = false;
  return true;
}

export function hasApiSession(plane: ApiPlane): boolean {
  return Boolean(runtime(plane).session.token?.startsWith("ocx_session_"));
}

export async function logoutApiSession(plane: ApiPlane): Promise<boolean> {
  const state = runtime(plane);
  const barrier = state.logoutBarrier ?? { pending: 0, completed: false };
  state.logoutBarrier = barrier;
  advanceSessionGeneration(state);
  sessionHandoffOwners.delete(state.session);
  if (!state.session.token?.startsWith("ocx_session_")) {
    // An explicit logout also supersedes recovery of an already-invalidated candidate.
    barrier.completed = true;
    return false;
  }
  barrier.pending++;
  const bounded = createBoundedFetch(SESSION_REBOOTSTRAP_TIMEOUT_MS);
  try {
    const response = await fetchApiSessionValidation(plane, `${state.target.baseUrl}/api/session/logout`, {
      method: "POST",
      signal: bounded.signal,
    });
    if (!response.ok) return false;
    barrier.completed = true;
    if (runtimes.get(plane) === state && state.logoutBarrier === barrier) {
      if (canRememberDashboardDevice(plane)) {
        try { window.localStorage.removeItem(DEVICE_PROOF_KEY); } catch { /* storage may be disabled */ }
        reportSessionEvent(plane, DEVICE_PROOF_CHANGED_EVENT);
      }
      updateSession(state, blankSession());
      state.promptCancelled = false;
    }
    return true;
  } catch {
    return false;
  } finally {
    bounded.clear();
    barrier.pending--;
    if (!barrier.pending && !barrier.completed && state.logoutBarrier === barrier) {
      state.logoutBarrier = null;
      if (plane === "shared") changeUsageSession(!state.session.token);
    }
  }
}

function takeMetaContent(name: string): string | null {
  const element = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
  const content = element?.content.trim() || null;
  element?.remove();
  return content;
}

function loadInjectedSession(): void {
  const values = {
    token: takeMetaContent("opencodex-session-token"),
    csrf: takeMetaContent("opencodex-session-csrf"),
    browser: takeMetaContent("opencodex-session-origin"),
    server: takeMetaContent("opencodex-session-server-origin"),
  };
  for (const plane of ["machine", "shared"] as const) {
    if (runtime(plane).target.serverOrigin === values.server) {
      storeSession(plane, values.token, values.csrf, values.browser, values.server);
    }
  }
}

function metaContentFromHtml(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const nameMatch = tag.match(/\bname=["']([^"']+)["']/i);
    if (nameMatch?.[1] !== name) continue;
    const contentMatch = tag.match(/\bcontent=["']([^"']*)["']/i);
    return contentMatch?.[1]?.trim() || null;
  }
  return null;
}

export function installApiSessionFromHtml(plane: ApiPlane, html: string): boolean {
  return installSessionFromHtml(plane, html);
}

function installSessionFromHtml(plane: ApiPlane, html: string, recovery?: RecoveryAttempt, handoffOwner?: object): boolean {
  return storeSession(
    plane,
    metaContentFromHtml(html, "opencodex-session-token"),
    metaContentFromHtml(html, "opencodex-session-csrf"),
    metaContentFromHtml(html, "opencodex-session-origin"),
    metaContentFromHtml(html, "opencodex-session-server-origin"),
    recovery,
    handoffOwner,
  );
}

/** An opaque, memory-only handoff; callers never receive session credential values. */
export function beginApiSessionHandoff(plane: ApiPlane) {
  const state = runtime(plane);
  const revision = sessionSnapshot(state);
  let previous: ApiSessionState | null = state.session;
  const owner = {};
  const release = () => {
    const current = runtime(plane);
    if (sessionHandoffOwners.get(current.session) === owner) {
      sessionHandoffOwners.delete(current.session);
      advanceSessionGeneration(current);
    }
    previous = null;
  };
  return {
    install(html: string): boolean {
      if (!previous || !isCurrentRevision(plane, revision)) return false;
      const accepted = installSessionFromHtml(plane, html, undefined, owner);
      // Event listeners may synchronously install a newer session or start logout.
      return accepted && runtimes.get(plane) === state && sessionHandoffOwners.get(state.session) === owner;
    },
    commit: release,
    rollback(): void {
      // Background 401 recovery may have cleared the candidate without replacing its owner.
      const current = runtime(plane);
      if (previous && sameTarget(current.target, state.target) && sessionHandoffOwners.get(current.session) === owner) updateSession(current, previous);
      release();
    },
  };
}

/** Inspect this session's response without the normal 401 renewal or admin-token fallback. */
export function fetchApiSessionValidation(plane: ApiPlane, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const [authenticatedInput, authenticatedInit] = withAuth(plane, input, init);
  return (rawFetch ?? window.fetch.bind(window))(authenticatedInput, authenticatedInit);
}

function clearLegacySessionToken(): void {
  try { sessionStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* storage may be disabled */ }
  try {
    const storage = window.localStorage;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key === "opencodex.remembered-admin-token" || key?.startsWith("opencodex.remembered-admin-token:")) storage.removeItem(key);
    }
  } catch { /* do not read or migrate old bearer tokens */ }
}

export function canRememberDashboardDevice(plane: ApiPlane): boolean {
  const target = runtime(plane).target;
  return target.transport !== "relay" && target.serverOrigin === window.location.origin
    && (window.location.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname));
}

/** Enrollment, not capability: the Forget control exists only once a proof is stored. */
export function hasRememberedDashboardDevice(plane: ApiPlane): boolean {
  if (!canRememberDashboardDevice(plane)) return false;
  try { return DEVICE_PROOF_PATTERN.test(window.localStorage.getItem(DEVICE_PROOF_KEY) ?? ""); }
  catch { return false; }
}

function targetAbsoluteBase(target: ApiTarget): URL {
  return new URL(target.baseUrl || "/", window.location.href);
}

function targetMatchesUrl(target: ApiTarget, url: URL): boolean {
  const base = targetAbsoluteBase(target);
  if (url.origin !== base.origin) return false;
  const prefix = base.pathname.replace(/\/$/, "");
  return prefix === "" || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

function relativeTargetPath(target: ApiTarget, url: URL): string | null {
  if (!targetMatchesUrl(target, url)) return null;
  const base = targetAbsoluteBase(target).pathname.replace(/\/$/, "");
  return url.pathname.slice(base.length) || "/";
}

function classify(input: RequestInfo | URL): { plane: ApiPlane; bootstrap: boolean } | null {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  } catch { return null; }
  const targets = ensureTargets();
  if (url.href === new URL(targets.shared.bootstrapPath, window.location.href).href) return { plane: "shared", bootstrap: true };
  if (targets.shared.transport === "relay" && targetMatchesUrl(targets.shared, url)) return { plane: "shared", bootstrap: false };
  const machinePath = relativeTargetPath(targets.machine, url);
  if (machinePath?.startsWith("/api/machine/") || machinePath?.startsWith("/api/codex/desktop-compatibility/")) return { plane: "machine", bootstrap: false };
  const sharedPath = relativeTargetPath(targets.shared, url);
  if (sharedPath?.startsWith("/api/")) return { plane: "shared", bootstrap: false };
  if (url.href === new URL(targets.machine.bootstrapPath, window.location.href).href) return { plane: "machine", bootstrap: true };
  return null;
}

function sessionHeaders(plane: ApiPlane, input: RequestInfo | URL, init?: RequestInit, overrideToken?: string | null): Headers {
  const state = runtime(plane);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const token = overrideToken === undefined ? state.session.token : overrideToken;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (token) headers.set("X-OpenCodex-API-Key", token);
  if (token?.startsWith("ocx_session_") && state.session.browserOrigin && state.session.csrfToken) {
    headers.set("X-OpenCodex-GUI-Origin", state.session.browserOrigin);
    if (method !== "GET" && method !== "HEAD") headers.set("X-OpenCodex-CSRF-Token", state.session.csrfToken);
  }
  if (plane === "shared" && state.target.transport === "relay") {
    const machine = runtime("machine").session;
    if (machine.token) headers.set(MACHINE_SESSION_HEADER, machine.token);
    if (machine.browserOrigin) headers.set(MACHINE_GUI_ORIGIN_HEADER, machine.browserOrigin);
    if (method !== "GET" && method !== "HEAD" && machine.csrfToken) headers.set(MACHINE_CSRF_HEADER, machine.csrfToken);
  }
  return headers;
}

function withAuth(
  plane: ApiPlane,
  input: RequestInfo | URL,
  init?: RequestInit,
  overrideToken?: string | null,
): [RequestInfo | URL, RequestInit | undefined] {
  const headers = sessionHeaders(plane, input, init, overrideToken);
  if (input instanceof Request) return [new Request(input, { headers }), init ? { ...init, headers } : undefined];
  return [input, { ...init, headers }];
}

async function reBootstrapSessionToken(recovery: RecoveryAttempt, caller?: AbortSignal, deadlineMs = rebootstrapTimeoutMs): Promise<RebootstrapResult> {
  if (!rawFetch || !isCurrentRecovery(recovery)) return { kind: "failed" };
  const { plane, state } = recovery;
  const send = rawFetch;
  try {
    return await withFetchDeadline<RebootstrapResult>(deadlineMs, caller, async signal => {
      const headers = new Headers();
      if (canRememberDashboardDevice(plane) && new URL(state.target.bootstrapPath, window.location.href).origin === window.location.origin) {
        try {
          const proof = window.localStorage.getItem(DEVICE_PROOF_KEY);
          if (proof && DEVICE_PROOF_PATTERN.test(proof)) headers.set("X-OpenCodex-Device-Proof", proof);
        } catch { /* ordinary session bootstrap still works without browser storage */ }
      }
      const [input, init] = withAuth(plane, state.target.bootstrapPath, { cache: "no-store", redirect: "error", signal, headers }, null);
      const response = await send(input, init);
      if (signal.aborted || !isCurrentRecovery(recovery)) return { kind: "failed" };
      if (!response.ok) return response.status >= 400 && response.status < 500 ? { kind: "unavailable" } : { kind: "failed" };
      const html = await response.text();
      if (signal.aborted || !isCurrentRecovery(recovery)) return { kind: "failed" };
      if (!installSessionFromHtml(plane, html, recovery)) return { kind: "unavailable" };
      return { kind: "minted", token: state.session.token! };
    });
  } catch { return { kind: "failed" }; }
}

/** Discovery is automatic recovery, never an explicit login that can override logout. */
export async function bootstrapApiSession(plane: ApiPlane, signal?: AbortSignal): Promise<boolean> {
  const state = runtime(plane);
  const recovery: RecoveryAttempt = { plane, state, generation: state.generation, active: true };
  try { return (await reBootstrapSessionToken(recovery, signal, 5_000)).kind === "minted"; }
  finally { recovery.active = false; }
}

async function verifyAdminToken(recovery: RecoveryAttempt, token: string, remember = false): ReturnType<AdminTokenVerifier> {
  if (!rawFetch) return "unavailable";
  const { plane, state } = recovery;
  if (remember && !canRememberDashboardDevice(plane)) return "unavailable";
  try {
    return await withFetchDeadline(rebootstrapTimeoutMs, undefined, async signal => {
      const path = remember ? "/api/session/remember" : ADMIN_TOKEN_VALIDATION_PATH;
      const [input, init] = withAuth(plane, state.target.baseUrl + path,
        { method: remember ? "POST" : "GET", cache: "no-store", signal, credentials: remember ? "same-origin" : "omit", redirect: "error" }, token);
      const response = await rawFetch!(input, init);
      if (signal.aborted || !isCurrentRecovery(recovery)) return "unavailable";
      if (response.status === 401) return "rejected";
      // The token was accepted, but this dashboard address cannot hold a remembered device (#8338).
      if (remember && response.status === 403) {
        const body = await response.json().catch(() => null) as { code?: unknown } | null;
        if (signal.aborted || !isCurrentRecovery(recovery)) return "unavailable";
        return body?.code === "remember_requires_direct_origin" ? "remember-unsupported" : "unavailable";
      }
      if (!response.ok) return "unavailable";
      if (remember) {
        const body = await response.json();
        if (signal.aborted || !isCurrentRecovery(recovery) || !storeSession(plane, body?.session?.token,
          body?.session?.csrfToken, body?.session?.browserOrigin, body?.session?.serverOrigin, recovery)) return "unavailable";
        try {
          const proof = body?.device?.proof;
          if (typeof proof !== "string" || !DEVICE_PROOF_PATTERN.test(proof)) throw new Error("Invalid device proof");
          window.localStorage.setItem(DEVICE_PROOF_KEY, proof);
          reportSessionEvent(plane, DEVICE_PROOF_CHANGED_EVENT);
        } catch {
          invalidateSession(state, recovery);
          return "unavailable";
        }
      }
      return "accepted";
    });
  } catch { return "unavailable"; }
}

async function resolveTokenAfter401(plane: ApiPlane, failedToken: string | null, callerSignal?: AbortSignal): Promise<SessionSnapshot | null> {
  const state = runtime(plane);
  if (callerSignal?.aborted || state.logoutBarrier) return null;
  if (state.promptCancelled) return sessionSnapshot(state);
  if (!state.resolutionInFlight) {
    const recovery: RecoveryAttempt = { plane, state, generation: state.generation, active: true };
    const body = (async () => {
      const current = state.session.token;
      if (current && current !== failedToken) return sessionSnapshot(state);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const renewed = await Promise.race([
        reBootstrapSessionToken(recovery),
        new Promise<RebootstrapResult>(resolve => { watchdog = setTimeout(() => {
          recovery.active = false;
          resolve({ kind: "failed" });
        }, resolutionWatchdogMs); }),
      ]).finally(() => clearTimeout(watchdog));
      if (!isCurrentRevision(plane, recovery)) return null;
      // Expiry stops late writes, but a still-current timeout must notify the shell.
      if (renewed.kind === "failed") return sessionSnapshot(state);
      if (!isCurrentRecovery(recovery)) return null;
      if (renewed.kind === "minted") return sessionSnapshot(state);
      // A non-hub deployment has no admin token the user could supply: the server mints the
      // session itself, so a refusal is a Host/Origin misconfiguration. Surface that instead
      // of a password box the user cannot answer (#3353, #3483).
      if (!adminTokenPromptAllowed()) {
        state.promptCancelled = true;
        return sessionSnapshot(state);
      }
      const prompted = await requestAdminToken(async (token, remember) => {
        if (!isCurrentRecovery(recovery)) return "unavailable";
        const result = await verifyAdminToken(recovery, token, remember);
        return isCurrentRecovery(recovery) ? result : "unavailable";
      }, canRememberDashboardDevice(plane));
      if (!isCurrentRecovery(recovery)) return null;
      if (prompted) {
        if (state.session.token?.startsWith("ocx_session_")) return sessionSnapshot(state);
        updateSession(state, { token: prompted, csrfToken: null, browserOrigin: null, serverOrigin: state.target.serverOrigin }, recovery);
        return isCurrentRecovery(recovery) ? sessionSnapshot(state) : null;
      }
      state.promptCancelled = true;
      return sessionSnapshot(state);
    })();
    const tracked = body.finally(() => {
      recovery.active = false;
      if (state.resolutionInFlight === tracked) state.resolutionInFlight = null;
    });
    state.resolutionInFlight = tracked;
  }
  if (!callerSignal) return state.resolutionInFlight;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>(resolve => {
    onAbort = () => resolve(null);
    callerSignal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([state.resolutionInFlight, aborted]).finally(() => {
    if (onAbort) callerSignal.removeEventListener("abort", onAbort);
  });
}

export function installApiAuthFetch(): void {
  if (installed) return;
  installed = true;
  clearLegacySessionToken();
  ensureTargets();
  loadInjectedSession();
  const originalFetch = window.fetch.bind(window);
  rawFetch = originalFetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const classified = classify(input);
    if (!classified) return originalFetch(input, init);
    const state = runtime(classified.plane);
    const generation = state.generation;
    const usageGeneration = usageSession.generation;
    const token = state.session.token;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let mutation = false;
    let usageRequest = false;
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const path = relativeTargetPath(state.target, url);
      mutation = classified.plane === "shared" && sourceInventoryMutation(path, method);
      usageRequest = path === "/api/usage" || path === "/api/usage/devices" || path === "/api/usage/source-facets";
    } catch { /* A malformed URL cannot name an inventory mutation. */ }
    const mutationBase = state.target.baseUrl;
    const finish = (result: Response) => {
      if (mutation && result.ok) {
        try { window.dispatchEvent(new window.CustomEvent(USAGE_SOURCE_INVENTORY_CHANGED, { detail: { apiBase: mutationBase } })); }
        catch { /* A notification failure must not turn a successful mutation into an error. */ }
      }
      return result;
    };
    // Pairing exchanges must not carry the old shared-plane credential. The relay's
    // separate machine-session headers are still attached by sessionHeaders().
    const pairingExchange = classified.bootstrap && method === "POST";
    const [firstInput, firstInit] = withAuth(classified.plane, input, init, pairingExchange ? null : undefined);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const response = await originalFetch(firstInput, firstInit);
    if (callerSignal?.aborted && (response.status === 401 || response.status === 403)) return response;
    const recoverUsage = usageRequest && !callerSignal?.aborted;
    if (!classified.bootstrap && classified.plane === "shared" && state.generation === generation
      && response.status === 401) denyUsageSession(usageGeneration);
    if (classified.bootstrap || response.status !== 401) return finish(response);
    if (runtimes.get(classified.plane) !== state || state.logoutBarrier) return response;
    const refreshed = state.session.token;
    if (refreshed && (refreshed !== token || state.generation !== generation)) {
      const revision = sessionSnapshot(state);
      const [retryInput, retryInit] = withAuth(classified.plane, input, init);
      const retry = await originalFetch(retryInput, retryInit);
      if (!isCurrentRevision(classified.plane, revision)) return finish(retry);
      if (retry.status !== 401) return finish(retry);
      clearSessionIfCurrent(classified.plane, refreshed);
    } else {
      if (state.generation !== generation && !state.resolutionInFlight) return response;
      clearSessionIfCurrent(classified.plane, token);
    }
    // Usage invalidation unsubscribes its loader and aborts its signal. Once an actual 401
    // arrived, let the existing single-flight recovery finish independently; a request
    // already cancelled before the 401 must not start recovery.
    const recoverySignal = recoverUsage ? undefined : callerSignal ?? undefined;
    const recoveryRevision = sessionSnapshot(state);
    let next: SessionSnapshot | null;
    try {
      next = await resolveTokenAfter401(classified.plane, token, recoverySignal);
    } catch (error) {
      if (!recoverUsage) throw error;
      if (isCurrentRevision(classified.plane, recoveryRevision) && !state.logoutBarrier && !state.session.token) {
        reportSessionEvent(classified.plane, SESSION_UNAVAILABLE_EVENT);
      }
      return response;
    }
    if (!next || !isCurrentRevision(classified.plane, next) || state.logoutBarrier) return response;
    if (!next.token) {
      // Usage recovery is deliberately detached after an observed 401: its loader was
      // aborted by session invalidation, but the still-current recovery owns this notice.
      if ((recoverUsage || !callerSignal?.aborted) && !hasApiSession(classified.plane)) reportSessionEvent(classified.plane, SESSION_UNAVAILABLE_EVENT);
      return response;
    }
    if (callerSignal?.aborted) return response;
    const [retryInput, retryInit] = withAuth(classified.plane, input, init, next.token);
    const retry = await originalFetch(retryInput, retryInit);
    if (retry.status === 401 && isCurrentRevision(classified.plane, next)) {
      clearSessionIfCurrent(classified.plane, next.token);
      if (!callerSignal?.aborted && !hasApiSession(classified.plane)) reportSessionEvent(classified.plane, SESSION_UNAVAILABLE_EVENT);
    }
    return finish(retry);
  };
}

/** Audio is data-plane traffic, even when the connected management target is a relay. */
export function fetchAudioUpload(endpoint: string, init: RequestInit): Promise<Response> {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/v1/audio/transcriptions"
    || url.username || url.password || url.search || url.hash || init.method !== "POST") {
    return Promise.reject(new Error("Invalid audio upload destination"));
  }
  return (rawFetch ?? fetch)(url.href, { ...init, credentials: "omit", redirect: "error" });
}

export function resetApiAuthFetchForTests(adminTokenPrompt: AdminTokenPrompt = defaultAdminTokenPrompt): void {
  changeUsageSession(false);
  installed = false;
  rawFetch = null;
  configuredTargets = null;
  runtimes.clear();
  requestAdminToken = adminTokenPrompt;
  rebootstrapTimeoutMs = SESSION_REBOOTSTRAP_TIMEOUT_MS;
  resolutionWatchdogMs = RESOLUTION_WATCHDOG_MS;
}

export function setRebootstrapTimeoutForTests(ms: number): void { rebootstrapTimeoutMs = ms; }
export function setResolutionWatchdogForTests(ms: number): void { resolutionWatchdogMs = ms; }
