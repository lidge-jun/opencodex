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

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
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
  return { access: accessToken, refresh: refreshToken, expires: getTokenExpiry(accessToken) };
}

/** Exchange a refresh token for fresh credentials. Keeps the old refresh if the server omits one. */
export async function refreshCursorToken(refresh: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  const response = await fetch(CURSOR_REFRESH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${refresh}`, "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Cursor token refresh failed: ${response.status}`);
  }
  const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
  if (!data.accessToken) {
    throw new Error("Cursor refresh response missing access token");
  }
  return { access: data.accessToken, refresh: data.refreshToken || refresh, expires: getTokenExpiry(data.accessToken) };
}

/** Resolve a token's expiry (epoch ms) from its JWT `exp`, minus a 5-minute skew; ~1h fallback. */
export function getTokenExpiry(token: string): number {
  try {
    const parts = token.split(".");
    const payload = parts.length === 3 ? parts[1] : undefined;
    if (payload) {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { exp?: number };
      if (typeof decoded.exp === "number") return decoded.exp * 1000 - EXPIRY_SKEW_MS;
    }
  } catch {
    // fall through to the fixed fallback below
  }
  return Date.now() + FALLBACK_TTL_MS;
}
