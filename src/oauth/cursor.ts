/**
 * Cursor OAuth — PKCE poll flow. Standalone: talks directly to cursor.com / api2.cursor.sh,
 * with no dependency on a local Cursor IDE/CLI install or on jawcode. Ported from jawcode
 * packages/ai/src/utils/oauth/cursor.ts and adapted to opencodex's OAuthController (see kimi.ts).
 *
 * Security: the login URL carries only the PKCE challenge (SHA-256 of the verifier); the verifier
 * is sent only to /auth/poll. Tokens and the verifier are never logged — thrown errors and progress
 * messages are status/string only.
 */
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF = 1.2;
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 60 * 60 * 1000;

const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_ATTEMPTS = 3;
const REFRESH_RETRY_BASE_MS = 300;

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

interface CursorJwtPayload {
  sub?: unknown;
  email?: unknown;
  exp?: unknown;
}

function decodeCursorJwtPayload(token: string): CursorJwtPayload | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as CursorJwtPayload;
  } catch {
    return undefined;
  }
}

/** Build OAuthCredentials from Cursor tokens, extracting stable identity from JWT `sub` for multiauth. */
export function credentialsFromCursorTokens(accessToken: string, refreshToken: string): OAuthCredentials {
  const payload = decodeCursorJwtPayload(accessToken) ?? decodeCursorJwtPayload(refreshToken);
  const accountId = typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
  const email = typeof payload?.email === "string" && payload.email.length > 0 ? payload.email.toLowerCase() : undefined;
  return {
    access: accessToken,
    refresh: refreshToken,
    expires: getTokenExpiry(accessToken),
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

/** Generate PKCE params + the cursor.com deep-link login URL (challenge only — never the verifier). */
export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
  const { verifier, challenge } = await generatePKCE();
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
  return { verifier, challenge, uuid, loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}` };
}

/** Abort-aware delay (mirrors kimi.ts) — rejects if the controller signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cursor login cancelled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Cursor login cancelled"));
      },
      { once: true },
    );
  });
}

/**
 * Poll cursor.com for login completion. 404 = still pending (back off), 200 = tokens.
 * `baseDelayMs` is injectable so tests can avoid the real 1s cadence; production uses the default.
 */
export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  signal?: AbortSignal,
  baseDelayMs: number = POLL_BASE_DELAY_MS,
): Promise<{ accessToken: string; refreshToken: string }> {
  let delay = baseDelayMs;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay, signal);

    try {
      const url = `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
      const response = await fetch(url, { signal });

      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
        if (!data.accessToken || !data.refreshToken) {
          throw new Error("Cursor auth response missing tokens");
        }
        return { accessToken: data.accessToken, refreshToken: data.refreshToken };
      }

      throw new Error(`Cursor auth poll failed: ${response.status}`);
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error("Cursor login cancelled");
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw new Error("Too many consecutive errors during Cursor auth polling");
      }
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
    }
  }

  throw new Error("Cursor authentication polling timeout");
}

/** Run the standalone Cursor login: surface the URL via `onAuth`, then poll until approved. */
export async function loginCursor(
  ctrl: OAuthController,
  pollBaseDelayMs: number = POLL_BASE_DELAY_MS,
): Promise<OAuthCredentials> {
  const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
  ctrl.onAuth?.({ url: loginUrl, instructions: "Approve the Cursor login in your browser, then return here." });
  ctrl.onProgress?.("Waiting for Cursor login approval…");
  const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier, ctrl.signal, pollBaseDelayMs);
  return credentialsFromCursorTokens(accessToken, refreshToken);
}

function isRetryableRefreshStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function refreshRetryDelayMs(attempt: number): number {
  const exp = REFRESH_RETRY_BASE_MS * 2 ** attempt;
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
}

function refreshTimeoutSignal(parent: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/**
 * Exchange a refresh token for fresh credentials. Keeps the old refresh if the server omits one.
 *
 * Hardened with a per-attempt timeout and bounded retry on transient failures (network errors and
 * 429/5xx). Non-retryable statuses (e.g. 401/403 from an expired refresh token) fail fast so the
 * caller can surface a re-auth prompt. Errors never include the token value.
 */
export async function refreshCursorToken(refresh: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("Cursor token refresh aborted");
    let response: Response;
    try {
      response = await fetch(CURSOR_REFRESH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${refresh}`, "Content-Type": "application/json" },
        body: "{}",
        signal: refreshTimeoutSignal(signal),
      });
    } catch (err) {
      // Network/timeout error: retry unless the caller aborted or we are out of attempts.
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt === REFRESH_ATTEMPTS - 1) break;
      await new Promise(resolve => setTimeout(resolve, refreshRetryDelayMs(attempt)));
      continue;
    }
    if (response.ok) {
      const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
      if (!data.accessToken) throw new Error("Cursor refresh response missing access token");
      return credentialsFromCursorTokens(data.accessToken, data.refreshToken || refresh);
    }
    if (!isRetryableRefreshStatus(response.status) || attempt === REFRESH_ATTEMPTS - 1) {
      throw new Error(`Cursor token refresh failed: ${response.status}`);
    }
    lastError = new Error(`Cursor token refresh failed: ${response.status}`);
    await response.body?.cancel().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, refreshRetryDelayMs(attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error("Cursor token refresh failed");
}

/** Resolve a token's expiry (epoch ms) from its JWT `exp`, minus a 5-minute skew; ~1h fallback. */
export function getTokenExpiry(token: string): number {
  const decoded = decodeCursorJwtPayload(token);
  if (typeof decoded?.exp === "number") return decoded.exp * 1000 - EXPIRY_SKEW_MS;
  return Date.now() + FALLBACK_TTL_MS;
}
