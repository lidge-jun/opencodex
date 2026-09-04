import { promptForAdminToken, type AdminTokenVerifier } from "./admin-token-dialog";
import { createBoundedFetch } from "./bounded-fetch";
import { adminTokenPromptAllowed, standaloneApiTargets, type ApiPlane, type ApiTarget, type ApiTargets } from "./api-targets";

/**
 * Fired instead of the admin-token prompt when the dashboard cannot start a session on a
 * deployment that has no admin token to type. The shell renders it as a notice; nothing
 * blocks on it.
 */
export const SESSION_UNAVAILABLE_EVENT = "opencodex:session-unavailable";

const LEGACY_TOKEN_KEY = "opencodex-api-token";
const ADMIN_TOKEN_VALIDATION_PATH = "/api/settings";
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
  resolutionInFlight: Promise<string | null> | null;
  promptCancelled: boolean;
}

type AdminTokenPrompt = (verifyToken: AdminTokenVerifier) => Promise<string | null>;
type RebootstrapResult = { kind: "minted"; token: string } | { kind: "unavailable" } | { kind: "failed" };

let installed = false;
let rawFetch: typeof fetch | null = null;
let configuredTargets: ApiTargets | null = null;
let requestAdminToken: AdminTokenPrompt = promptForAdminToken;
let rebootstrapTimeoutMs = SESSION_REBOOTSTRAP_TIMEOUT_MS;
let resolutionWatchdogMs = RESOLUTION_WATCHDOG_MS;
const runtimes = new Map<ApiPlane, TargetRuntime>();

function reportSessionUnavailable(plane: ApiPlane): void {
  if (typeof window === "undefined") return;
  // Take the constructor off the same window we dispatch on: a test harness (and a
  // sandboxed embed) can supply a document without installing CustomEvent globally.
  const Ctor = (window as unknown as { CustomEvent?: typeof CustomEvent }).CustomEvent
    ?? (typeof CustomEvent === "function" ? CustomEvent : null);
  if (!Ctor) return;
  try {
    window.dispatchEvent(new Ctor(SESSION_UNAVAILABLE_EVENT, { detail: { plane } }));
  } catch { /* a shell that cannot receive the notice must not break the fetch path */ }
}

function blankSession(): ApiSessionState {
  return { token: null, csrfToken: null, browserOrigin: null, serverOrigin: null };
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
    runtimes.set(plane, current && sameTarget(current.target, targets[plane])
      ? { ...current, target: targets[plane] }
      : { target: targets[plane], session: blankSession(), resolutionInFlight: null, promptCancelled: false });
  }
}

function runtime(plane: ApiPlane): TargetRuntime {
  ensureTargets();
  return runtimes.get(plane)!;
}

function clearSessionIfCurrent(plane: ApiPlane, expected: string | null): void {
  const state = runtime(plane);
  if (expected !== null && state.session.token === expected) state.session = blankSession();
}

function storeSession(
  plane: ApiPlane,
  token: string | null,
  csrfToken: string | null,
  browserOrigin: string | null,
  serverOrigin: string | null,
): boolean {
  const state = runtime(plane);
  if (!token?.startsWith("ocx_session_") || !csrfToken
    || browserOrigin !== window.location.origin || serverOrigin !== state.target.serverOrigin) {
    state.session = blankSession();
    return false;
  }
  state.session = { token, csrfToken, browserOrigin, serverOrigin };
  state.promptCancelled = false;
  return true;
}

export function hasApiSession(plane: ApiPlane): boolean {
  return Boolean(runtime(plane).session.token?.startsWith("ocx_session_"));
}

export async function logoutApiSession(plane: ApiPlane): Promise<boolean> {
  const state = runtime(plane);
  if (!state.session.token?.startsWith("ocx_session_")) return false;
  const bounded = createBoundedFetch(SESSION_REBOOTSTRAP_TIMEOUT_MS);
  try {
    const response = await window.fetch(`${state.target.baseUrl}/api/session/logout`, {
      method: "POST",
      signal: bounded.signal,
    });
    if (!response.ok) return false;
    state.session = blankSession();
    state.promptCancelled = false;
    return true;
  } catch {
    return false;
  } finally {
    bounded.clear();
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
  return storeSession(
    plane,
    metaContentFromHtml(html, "opencodex-session-token"),
    metaContentFromHtml(html, "opencodex-session-csrf"),
    metaContentFromHtml(html, "opencodex-session-origin"),
    metaContentFromHtml(html, "opencodex-session-server-origin"),
  );
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

async function reBootstrapSessionToken(plane: ApiPlane): Promise<RebootstrapResult> {
  if (!rawFetch) return { kind: "failed" };
  const state = runtime(plane);
  const bounded = createBoundedFetch(rebootstrapTimeoutMs);
  try {
    const [input, init] = withAuth(plane, state.target.bootstrapPath, { cache: "no-store", signal: bounded.signal }, null);
    const response = await rawFetch(input, init);
    if (!response.ok) return response.status >= 400 && response.status < 500 ? { kind: "unavailable" } : { kind: "failed" };
    const html = await response.text();
    if (!installApiSessionFromHtml(plane, html)) return { kind: "unavailable" };
    return { kind: "minted", token: runtime(plane).session.token! };
  } catch { return { kind: "failed" }; }
  finally { bounded.clear(); }
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

async function resolveTokenAfter401(plane: ApiPlane, failedToken: string | null, callerSignal?: AbortSignal): Promise<string | null> {
  const state = runtime(plane);
  if (state.promptCancelled || callerSignal?.aborted) return null;
  if (!state.resolutionInFlight) {
    const body = (async () => {
      const current = state.session.token;
      if (current && current !== failedToken) return current;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const renewed = await Promise.race([
        reBootstrapSessionToken(plane),
        new Promise<RebootstrapResult>(resolve => { watchdog = setTimeout(() => resolve({ kind: "failed" }), resolutionWatchdogMs); }),
      ]).finally(() => clearTimeout(watchdog));
      if (renewed.kind === "minted") return renewed.token;
      if (renewed.kind === "failed") return null;
      // A non-hub deployment has no admin token the user could supply: the server mints the
      // session itself, so a refusal is a Host/Origin misconfiguration. Surface that instead
      // of a password box the user cannot answer (#3353, #3483).
      if (!adminTokenPromptAllowed()) {
        state.promptCancelled = true;
        reportSessionUnavailable(plane);
        return null;
      }
      const prompted = await requestAdminToken(token => verifyAdminToken(plane, token));
      if (prompted) {
        state.session = { token: prompted, csrfToken: null, browserOrigin: null, serverOrigin: state.target.serverOrigin };
        return prompted;
      }
      state.promptCancelled = true;
      return null;
    })();
    const tracked = body.finally(() => { if (state.resolutionInFlight === tracked) state.resolutionInFlight = null; });
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
    const token = state.session.token;
    const [firstInput, firstInit] = withAuth(classified.plane, input, init);
    const response = await originalFetch(firstInput, firstInit);
    if (classified.bootstrap || response.status !== 401) return response;
    const refreshed = state.session.token;
    if (refreshed && refreshed !== token) {
      const [retryInput, retryInit] = withAuth(classified.plane, input, init);
      const retry = await originalFetch(retryInput, retryInit);
      if (retry.status !== 401) return retry;
      clearSessionIfCurrent(classified.plane, refreshed);
    } else clearSessionIfCurrent(classified.plane, token);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const nextToken = await resolveTokenAfter401(classified.plane, token, callerSignal ?? undefined);
    if (!nextToken) return response;
    const [retryInput, retryInit] = withAuth(classified.plane, input, init, nextToken);
    const retry = await originalFetch(retryInput, retryInit);
    if (retry.status === 401) clearSessionIfCurrent(classified.plane, nextToken);
    return retry;
  };
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
