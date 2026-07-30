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

/** Document path re-fetched to mint a fresh loopback GUI session (server injects meta tags). */
const SESSION_REBOOTSTRAP_PATH = "/";

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
 * a token. Returns null when the server refuses to mint sessions (non-loopback operator
 * dashboards), where the manual admin-token prompt remains the fallback.
 */
async function reBootstrapSessionToken(): Promise<string | null> {
  if (!rawFetch) return null;
  try {
    const response = await rawFetch(SESSION_REBOOTSTRAP_PATH, { cache: "no-store" });
    if (!response.ok) return null;
    const html = await response.text();
    const stored = storeSession(
      metaContentFromHtml(html, "opencodex-session-token"),
      metaContentFromHtml(html, "opencodex-session-csrf"),
      metaContentFromHtml(html, "opencodex-session-origin"),
    );
    return stored ? readToken() : null;
  } catch {
    return null;
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
 * fan-out does not open one window.prompt per /api request (#647). Re-reads memoryToken before
 * prompting so waiters that wake after another request already stored a token do not re-prompt.
 */
async function resolveTokenAfter401(failedToken: string | null): Promise<string | null> {
  if (promptCancelled) return null;
  if (resolutionInFlight) return resolutionInFlight;

  resolutionInFlight = (async () => {
    if (promptCancelled) return null;
    const current = readToken();
    if (current && current !== failedToken) return current;

    const renewed = await reBootstrapSessionToken();
    if (renewed) return renewed;

    const prompted = window.prompt("OpenCodex admin token (OPENCODEX_ADMIN_AUTH_TOKEN)")?.trim() || null;
    if (prompted) {
      storeToken(prompted);
      return prompted;
    }
    promptCancelled = true;
    return null;
  })().finally(() => {
    resolutionInFlight = null;
  });

  return resolutionInFlight;
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

    const nextToken = await resolveTokenAfter401(token);
    if (!nextToken) return response;

    const [retryInput, retryInit] = withToken(input, init, nextToken);
    const retry = await originalFetch(retryInput, retryInit);
    if (retry.status === 401) clearTokenIfCurrent(nextToken);
    return retry;
  };
}

/** Test-only: allow a fresh `installApiAuthFetch()` in the same module instance. */
export function resetApiAuthFetchForTests(): void {
  installed = false;
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
  resolutionInFlight = null;
  rawFetch = null;
  promptCancelled = false;
}
