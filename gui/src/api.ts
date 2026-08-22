import { promptForAdminToken, type AdminTokenVerifier } from "./admin-token-dialog";
import { createBoundedFetch } from "./bounded-fetch";

let installed = false;
/** Shared 401 refresh gate — concurrent waiters join one prompt / token resolution. */
let resolutionInFlight: Promise<string | null> | null = null;
/** Unwrapped fetch captured at install time — used for session re-bootstrap so the
 *  bootstrap document request itself never enters the 401 handling path. */
let rawFetch: typeof fetch | null = null;
/**
 * After the user cancels (or submits blank) once, suppress further prompts for this page
 * lifetime so a staggered 401 fan-out does not reopen the dialog N times (#647 / Codex).
 * A full reload clears module state and allows prompting again.
 */
let promptCancelled = false;

type AdminTokenPrompt = (verifyToken: AdminTokenVerifier) => Promise<string | null>;
let requestAdminToken: AdminTokenPrompt = promptForAdminToken;

/**
 * Document path re-fetched to mint a fresh loopback GUI session (server injects meta tags).
 * Deliberately NOT "/": the Vite dev server owns that route for the app shell, so the dev
 * proxy forwards this dedicated extensionless path to the backend with the original host.
 */
const SESSION_REBOOTSTRAP_PATH = "/opencodex-session";
/** Safe authenticated read used to validate a raw admin token before closing the sign-in form. */
const ADMIN_TOKEN_VALIDATION_PATH = "/api/settings";

/**
 * The silent re-bootstrap must fail fast: every /api/* request queues behind the
 * shared resolution, so an unbounded bootstrap hangs the whole dashboard (H2).
 */
const SESSION_REBOOTSTRAP_TIMEOUT_MS = 10_000;
let rebootstrapTimeoutMs = SESSION_REBOOTSTRAP_TIMEOUT_MS;

/**
 * Whole-resolution watchdog. The bootstrap bound covers a well-behaved fetch; this
 * covers everything else — a fetch that never honors the abort, a prompt path that
 * pends without settling, any surprise inside the shared body. Without it one stuck
 * resolution pins every /api/* waiter for the page lifetime, which is the exact
 * failure this module exists to kill.
 *
 * Scope note: the watchdog races the BOOTSTRAP CALL ONLY, never the admin-token
 * prompt. The prompt is user-controlled and unbounded by design; while its body
 * pends, later waves join the same resolution, which is what keeps a single dialog
 * on screen (promptForAdminToken has no singleton guard — a watchdog that fired
 * during the prompt would stack a fresh modal every cycle).
 */
const RESOLUTION_WATCHDOG_MS = 15_000;
let resolutionWatchdogMs = RESOLUTION_WATCHDOG_MS;

function needsApiAuth(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.href);
    // Absolute cross-origin URLs must never get the local API token or 401 prompt.
    if (url.origin !== window.location.origin) return false;
    return url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Legacy sessionStorage key from pre-memory auth — wiped once on install, never read. */
const LEGACY_TOKEN_KEY = "opencodex-api-token";

/** In-memory only — never write tokens to web storage (XSS can read sessionStorage/localStorage). */
let memoryToken: string | null = null;
let memoryCsrfToken: string | null = null;
let memorySessionOrigin: string | null = null;

function readToken(): string | null {
  return memoryToken;
}

function storeToken(token: string): void {
  memoryToken = token;
}

function clearToken(): void {
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
}

function takeMetaContent(name: string): string | null {
  const element = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
  const content = element?.content.trim() || null;
  element?.remove();
  return content;
}

function loadInjectedSession(): void {
  const token = takeMetaContent("opencodex-session-token");
  const csrfToken = takeMetaContent("opencodex-session-csrf");
  const origin = takeMetaContent("opencodex-session-origin");
  storeSession(token, csrfToken, origin);
}

/** Clear memory only when it still holds `expected` (avoid wiping a newer concurrent store). */
function clearTokenIfCurrent(expected: string | null): void {
  if (expected != null && readToken() === expected) clearToken();
}

/** Validate and store a server-minted GUI session; rejects anything bound to another origin. */
function storeSession(token: string | null, csrfToken: string | null, origin: string | null): boolean {
  if (!token?.startsWith("ocx_session_") || !csrfToken || origin !== window.location.origin) return false;
  memoryToken = token;
  memoryCsrfToken = csrfToken;
  memorySessionOrigin = origin;
  return true;
}

/** Read one named meta tag out of a served HTML document (attribute order varies). */
function metaContentFromHtml(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const nameMatch = tag.match(/\bname="([^"]+)"/i);
    if (nameMatch?.[1] !== name) continue;
    const contentMatch = tag.match(/\bcontent="([^"]*)"/i);
    return contentMatch?.[1]?.trim() || null;
  }
  return null;
}

/**
 * Silently renew the GUI session from a freshly served document. Loopback servers mint
 * short-lived sessions into the HTML on every page load, so an expired session (5-minute
 * TTL) or one invalidated by a proxy restart is replaced without ever asking the user for
 * a token.
 *
 * Tri-state by design: only a definitive refusal ("unavailable": 4xx, or an OK
 * document without valid session meta — the non-loopback shape) may fall through to
 * the admin-token prompt. Anything transient — timeout, abort, network error, 5xx
 * from an intermediate proxy — is "failed", which settles this wave as an ordinary
 * request failure and lets the next poll retry. Mapping a transient failure to the
 * prompt would pop a credential modal on a loopback dashboard that needs no token.
 */
type RebootstrapResult =
  | { kind: "minted"; token: string }
  | { kind: "unavailable" }
  | { kind: "failed" };

async function reBootstrapSessionToken(): Promise<RebootstrapResult> {
  if (!rawFetch) return { kind: "failed" };
  const bounded = createBoundedFetch(rebootstrapTimeoutMs);
  try {
    const response = await rawFetch(SESSION_REBOOTSTRAP_PATH, { cache: "no-store", signal: bounded.signal });
    if (!response.ok) {
      // Only a definitive refusal is "unavailable"; 5xx and everything else is transient.
      return response.status >= 400 && response.status < 500 ? { kind: "unavailable" } : { kind: "failed" };
    }
    const html = await response.text();
    const stored = storeSession(
      metaContentFromHtml(html, "opencodex-session-token"),
      metaContentFromHtml(html, "opencodex-session-csrf"),
      metaContentFromHtml(html, "opencodex-session-origin"),
    );
    const token = readToken();
    if (stored && token) return { kind: "minted", token };
    return { kind: "unavailable" };
  } catch {
    return { kind: "failed" };
  } finally {
    bounded.clear();
  }
}

async function verifyAdminToken(token: string): ReturnType<AdminTokenVerifier> {
  if (!rawFetch) return "unavailable";
  try {
    const [input, init] = withToken(ADMIN_TOKEN_VALIDATION_PATH, { cache: "no-store" }, token);
    const response = await rawFetch(input, init);
    if (response.status === 401) return "rejected";
    return response.ok ? "accepted" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function clearLegacySessionToken(): void {
  try {
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* session storage may be disabled */
  }
}

function withToken(input: RequestInfo | URL, init: RequestInit | undefined, token: string): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("X-OpenCodex-API-Key", token);
  if (memorySessionOrigin && memoryCsrfToken && token.startsWith("ocx_session_")) {
    headers.set("X-OpenCodex-GUI-Origin", memorySessionOrigin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      headers.set("X-OpenCodex-CSRF-Token", memoryCsrfToken);
    }
  }
  if (input instanceof Request) return [new Request(input, { headers }), init ? { ...init, headers } : undefined];
  return [input, { ...init, headers }];
}

/**
 * Resolve a token after a 401. Concurrent callers share one in-flight resolution so a dashboard
 * fan-out opens at most one credential dialog per /api request wave (#647). Re-reads
 * memoryToken before prompting so waiters that wake after another request already stored a token
 * do not re-prompt.
 */
async function resolveTokenAfter401(failedToken: string | null, callerSignal?: AbortSignal): Promise<string | null> {
  if (promptCancelled) return null;
  if (callerSignal?.aborted) return null;
  if (!resolutionInFlight) {
    const body = (async () => {
      if (promptCancelled) return null;
      const current = readToken();
      if (current && current !== failedToken) return current;

      // The watchdog races the bootstrap call only — never the prompt below. When
      // it wins, the wave fails and the conditional clear lets the NEXT 401 start
      // a fresh resolution instead of joining the zombie.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const renewed = await Promise.race([
        reBootstrapSessionToken(),
        new Promise<RebootstrapResult>((resolve) => {
          watchdog = setTimeout(() => resolve({ kind: "failed" }), resolutionWatchdogMs);
        }),
      ]).finally(() => clearTimeout(watchdog));
      if (renewed.kind === "minted") return renewed.token;
      // Transient bootstrap failure: this wave fails and the next 401 re-arms a
      // fresh resolution (the finally clears resolutionInFlight). No prompt.
      if (renewed.kind === "failed") return null;

      // User-controlled and unbounded: later waves join this pending body, which
      // is what keeps exactly one prompt dialog on screen.
      const prompted = await requestAdminToken(verifyAdminToken);
      if (prompted) {
        storeToken(prompted);
        return prompted;
      }
      promptCancelled = true;
      return null;
    })();
    const tracked = body.finally(() => {
      // Only clear if nobody replaced us — a late settle must not wipe a newer
      // in-flight resolution. (Async callback: tracked is assigned long before
      // this can run.)
      if (resolutionInFlight === tracked) resolutionInFlight = null;
    });
    resolutionInFlight = tracked;
  }

  if (!callerSignal) return resolutionInFlight;
  // Per-caller race: an abort unwinds THIS caller only — a dead caller must not
  // cancel the shared resolution other waiters still need. The listener is removed
  // whether the race resolves by token or by abort, so waiters never accumulate.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    callerSignal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([resolutionInFlight, aborted]).finally(() => {
    if (onAbort) callerSignal.removeEventListener("abort", onAbort);
  });
}

export function installApiAuthFetch(): void {
  if (installed) return;
  installed = true;
  // Drop any leftover XSS-readable token; new tokens stay memory-only (no read/migrate).
  clearLegacySessionToken();
  loadInjectedSession();
  const originalFetch = window.fetch.bind(window);
  rawFetch = originalFetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!needsApiAuth(input)) return originalFetch(input, init);

    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const token = readToken();
    const [firstInput, firstInit] = token ? withToken(input, init, token) : [input, init];
    const response = await originalFetch(firstInput, firstInit);
    if (response.status !== 401) return response;

    // Another request may have stored a token while this one was in flight (or while prompt blocked).
    const refreshed = readToken();
    if (refreshed && refreshed !== token) {
      const [retryInput, retryInit] = withToken(input, init, refreshed);
      const retry = await originalFetch(retryInput, retryInit);
      if (retry.status !== 401) return retry;
      clearTokenIfCurrent(refreshed);
    } else {
      clearTokenIfCurrent(token);
    }

    const nextToken = await resolveTokenAfter401(token, callerSignal ?? undefined);
    if (!nextToken) return response;

    const [retryInput, retryInit] = withToken(input, init, nextToken);
    const retry = await originalFetch(retryInput, retryInit);
    if (retry.status === 401) clearTokenIfCurrent(nextToken);
    return retry;
  };
}

/** Test-only: allow a fresh `installApiAuthFetch()` in the same module instance. */
export function resetApiAuthFetchForTests(adminTokenPrompt: AdminTokenPrompt = promptForAdminToken): void {
  installed = false;
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
  resolutionInFlight = null;
  rawFetch = null;
  promptCancelled = false;
  requestAdminToken = adminTokenPrompt;
  rebootstrapTimeoutMs = SESSION_REBOOTSTRAP_TIMEOUT_MS;
  resolutionWatchdogMs = RESOLUTION_WATCHDOG_MS;
}

/** Test-only: shrink the re-bootstrap deadline so timeout paths run in milliseconds. */
export function setRebootstrapTimeoutForTests(ms: number): void {
  rebootstrapTimeoutMs = ms;
}

/** Test-only: shrink the whole-resolution watchdog so zombie paths run in milliseconds. */
export function setResolutionWatchdogForTests(ms: number): void {
  resolutionWatchdogMs = ms;
}
