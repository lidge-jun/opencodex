import { promptForAdminToken, type AdminTokenVerifier } from "./admin-token-dialog";
import { createBoundedFetch, withFetchDeadline } from "./bounded-fetch";
import { adminTokenPromptAllowed, standaloneApiTargets, type ApiPlane, type ApiTarget, type ApiTargets } from "./api-targets";

/**
 * Fired after an unauthorized request cannot recover a session. The shell synchronizes
 * its existing readiness state; cancelled callers and newer valid sessions emit no notice.
 */
export const SESSION_UNAVAILABLE_EVENT = "opencodex:session-unavailable";
/** Token identity changed; contains only the plane, never credential material. */
export const SESSION_CHANGED_EVENT = "opencodex:session-changed";

const LEGACY_TOKEN_KEY = "opencodex-api-token";
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

type AdminTokenPrompt = (verifyToken: AdminTokenVerifier) => Promise<string | null>;
type RebootstrapResult = { kind: "minted"; token: string } | { kind: "unavailable" } | { kind: "failed" };

let installed = false;
let rawFetch: typeof fetch | null = null;
let configuredTargets: ApiTargets | null = null;
let requestAdminToken: AdminTokenPrompt = promptForAdminToken;
let rebootstrapTimeoutMs = SESSION_REBOOTSTRAP_TIMEOUT_MS;
let resolutionWatchdogMs = RESOLUTION_WATCHDOG_MS;
const runtimes = new Map<ApiPlane, TargetRuntime>();
const sessionHandoffOwners = new WeakMap<ApiSessionState, object>();

function reportSessionEvent(plane: ApiPlane, event: string): void {
  if (typeof window === "undefined") return;
  // Take the constructor off the same window we dispatch on: a test harness (and a
  // sandboxed embed) can supply a document without installing CustomEvent globally.
  const Ctor = (window as unknown as { CustomEvent?: typeof CustomEvent }).CustomEvent
    ?? (typeof CustomEvent === "function" ? CustomEvent : null);
  if (!Ctor) return;
  try {
    window.dispatchEvent(new Ctor(event, { detail: { plane } }));
  } catch { /* a shell that cannot receive the notice must not break the fetch path */ }
}

function advanceSessionGeneration(state: TargetRuntime): void {
  state.generation = {};
  state.resolutionInFlight = null;
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
  advanceSessionGeneration(state);
  state.session = session;
  // Advance our own recovery before synchronous session-event listeners can supersede it.
  if (recovery) recovery.generation = state.generation;
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
      updateSession(state, blankSession());
      state.promptCancelled = false;
    }
    return true;
  } catch {
    return false;
  } finally {
    bounded.clear();
    barrier.pending--;
    if (!barrier.pending && !barrier.completed && state.logoutBarrier === barrier) state.logoutBarrier = null;
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
  if (machinePath?.startsWith("/api/machine/")) return { plane: "machine", bootstrap: false };
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
      const [input, init] = withAuth(plane, state.target.bootstrapPath, { cache: "no-store", signal }, null);
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

async function verifyAdminToken(plane: ApiPlane, token: string): ReturnType<AdminTokenVerifier> {
  if (!rawFetch) return "unavailable";
  try {
    const state = runtime(plane);
    const [input, init] = withAuth(plane, `${state.target.baseUrl}${ADMIN_TOKEN_VALIDATION_PATH}`, { cache: "no-store" }, token);
    const response = await rawFetch(input, init);
    if (response.status === 401) return "rejected";
    return response.ok ? "accepted" : "unavailable";
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
      const prompted = await requestAdminToken(async token => {
        if (!isCurrentRecovery(recovery)) return "unavailable";
        const result = await verifyAdminToken(plane, token);
        return isCurrentRecovery(recovery) ? result : "unavailable";
      });
      if (!isCurrentRecovery(recovery)) return null;
      if (prompted) {
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
    const token = state.session.token;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    // Pairing exchanges must not carry the old shared-plane credential. The relay's
    // separate machine-session headers are still attached by sessionHeaders().
    const pairingExchange = classified.bootstrap && method === "POST";
    const [firstInput, firstInit] = withAuth(classified.plane, input, init, pairingExchange ? null : undefined);
    const response = await originalFetch(firstInput, firstInit);
    if (classified.bootstrap || response.status !== 401) return response;
    if (runtimes.get(classified.plane) !== state || state.logoutBarrier) return response;
    const refreshed = state.session.token;
    if (refreshed && (refreshed !== token || state.generation !== generation)) {
      const revision = sessionSnapshot(state);
      const [retryInput, retryInit] = withAuth(classified.plane, input, init);
      const retry = await originalFetch(retryInput, retryInit);
      if (!isCurrentRevision(classified.plane, revision)) return retry;
      if (retry.status !== 401) return retry;
      clearSessionIfCurrent(classified.plane, refreshed);
    } else {
      if (state.generation !== generation && !state.resolutionInFlight) return response;
      clearSessionIfCurrent(classified.plane, token);
    }
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const next = await resolveTokenAfter401(classified.plane, token, callerSignal ?? undefined);
    if (!next || !isCurrentRevision(classified.plane, next) || callerSignal?.aborted) return response;
    if (!next.token) {
      if (!callerSignal?.aborted && !hasApiSession(classified.plane)) reportSessionEvent(classified.plane, SESSION_UNAVAILABLE_EVENT);
      return response;
    }
    const [retryInput, retryInit] = withAuth(classified.plane, input, init, next.token);
    const retry = await originalFetch(retryInput, retryInit);
    if (retry.status === 401 && isCurrentRevision(classified.plane, next)) {
      clearSessionIfCurrent(classified.plane, next.token);
      if (!callerSignal?.aborted && !hasApiSession(classified.plane)) reportSessionEvent(classified.plane, SESSION_UNAVAILABLE_EVENT);
    }
    return retry;
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

export function resetApiAuthFetchForTests(adminTokenPrompt: AdminTokenPrompt = promptForAdminToken): void {
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
