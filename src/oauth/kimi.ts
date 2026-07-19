/** Kimi Code OAuth flow (device authorization grant). Ported from jawcode oauth/kimi.ts. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir } from "../config";
import type { OAuthController, OAuthCredentials } from "./types";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_ID_FILENAME = "kimi-device-id";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const KIMI_CLI_VERSION = "0.14.0";

interface DeviceAuthorizationResponse {
  user_code?: string;
  device_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
}

interface KimiJwtPayload {
  user_id?: unknown;
  sub?: unknown;
  email?: unknown;
}

function decodeKimiJwtPayload(token: string): KimiJwtPayload | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as KimiJwtPayload;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Stable multiauth identity from Kimi JWTs (`user_id` preferred; `sub` / `email` fallbacks). */
export function identityFromKimiTokens(accessToken: string, refreshToken?: string): {
  accountId?: string;
  email?: string;
} {
  const fromAccess = identityFromPayload(decodeKimiJwtPayload(accessToken));
  const fromRefresh = refreshToken ? identityFromPayload(decodeKimiJwtPayload(refreshToken)) : {};
  // Prefer access claims; fill gaps from refresh (opaque/partial access JWTs).
  const accountId = fromAccess.accountId ?? fromRefresh.accountId;
  const email = fromAccess.email ?? fromRefresh.email;
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

function identityFromPayload(payload: KimiJwtPayload | undefined): { accountId?: string; email?: string } {
  if (!payload) return {};
  const accountId = nonEmptyString(payload.user_id) ?? nonEmptyString(payload.sub);
  const emailRaw = nonEmptyString(payload.email);
  return {
    ...(accountId ? { accountId } : {}),
    ...(emailRaw ? { email: emailRaw.toLowerCase() } : {}),
  };
}

function resolveOAuthHost(): string {
  return process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Login cancelled")); }, { once: true });
  });
}

function getDeviceModel(): string {
  const platform = os.platform();
  const label = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
  return [label, os.release(), os.arch()].filter(Boolean).join(" ").trim();
}

let deviceIdCache: string | undefined;
function getDeviceId(): string {
  if (deviceIdCache) return deviceIdCache;
  const p = join(getConfigDir(), DEVICE_ID_FILENAME);
  try {
    const existing = readFileSync(p, "utf-8").trim();
    if (existing) { deviceIdCache = existing; return existing; }
  } catch (e) {
    if ((e as { code?: string })?.code !== "ENOENT") throw e;
  }
  const id = randomUUID().replace(/-/g, "");
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(p, id + "\n", { mode: 0o600 });
  deviceIdCache = id;
  return id;
}

function getKimiCommonHeaders(): Record<string, string> {
  return {
    "User-Agent": `KimiCLI/${KIMI_CLI_VERSION}`,
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": KIMI_CLI_VERSION,
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": getDeviceModel(),
    "X-Msh-Os-Version": os.version(),
    "X-Msh-Device-Id": getDeviceId(),
  };
}

async function requestDeviceAuthorization(): Promise<{
  userCode: string; deviceCode: string; verificationUriComplete: string; expiresInMs: number; intervalMs: number;
}> {
  const response = await fetch(`${resolveOAuthHost()}/api/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...getKimiCommonHeaders() },
    body: new URLSearchParams({ client_id: CLIENT_ID }),
  });
  if (!response.ok) {
    throw new Error(`Kimi device authorization failed: ${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as DeviceAuthorizationResponse;
  if (!payload.user_code || !payload.device_code || !payload.verification_uri) {
    throw new Error("Kimi device authorization response missing required fields");
  }
  return {
    userCode: payload.user_code,
    deviceCode: payload.device_code,
    verificationUriComplete: payload.verification_uri_complete || payload.verification_uri,
    expiresInMs: typeof payload.expires_in === "number" ? payload.expires_in * 1000 : DEFAULT_DEVICE_FLOW_TTL_MS,
    intervalMs: typeof payload.interval === "number" && payload.interval > 0 ? payload.interval * 1000 : DEFAULT_POLL_INTERVAL_MS,
  };
}

function parseTokenPayload(payload: TokenResponse, refreshFallback?: string): OAuthCredentials {
  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new Error("Kimi token response missing required fields");
  }
  const refresh = payload.refresh_token ?? refreshFallback;
  if (!refresh) throw new Error("Kimi token response missing refresh token");
  const identity = identityFromKimiTokens(payload.access_token, refresh);
  return {
    access: payload.access_token,
    refresh,
    expires: Date.now() + payload.expires_in * 1000 - OAUTH_EXPIRY_SKEW_MS,
    ...identity,
  };
}

async function pollForToken(deviceCode: string, intervalMs: number, expiresInMs: number, signal?: AbortSignal): Promise<OAuthCredentials> {
  const deadline = Date.now() + expiresInMs;
  let waitMs = Math.max(1000, intervalMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...getKimiCommonHeaders() },
      body: new URLSearchParams({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const payload = (await response.json()) as TokenResponse;
    if (response.ok && payload.access_token) return parseTokenPayload(payload);
    const error = payload.error;
    if (error === "authorization_pending") { await sleep(waitMs, signal); continue; }
    if (error === "slow_down") {
      waitMs += 5000;
      const retryAfter = typeof payload.interval === "number" ? payload.interval * 1000 : undefined;
      if (retryAfter && retryAfter > waitMs) waitMs = retryAfter;
      await sleep(waitMs, signal);
      continue;
    }
    if (error === "expired_token") throw new Error("Kimi device authorization expired");
    if (error === "access_denied") throw new Error("Kimi device authorization denied");
    throw new Error(`Kimi device flow failed: ${error ?? response.status}${payload.error_description ? `: ${payload.error_description}` : ""}`);
  }
  throw new Error("Kimi device flow timed out");
}

export async function loginKimi(ctrl: OAuthController): Promise<OAuthCredentials> {
  const device = await requestDeviceAuthorization();
  ctrl.onAuth?.({ url: device.verificationUriComplete, instructions: `Enter code: ${device.userCode}` });
  return pollForToken(device.deviceCode, device.intervalMs, device.expiresInMs, ctrl.signal);
}

export async function refreshKimiToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...getKimiCommonHeaders() },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
    throw new Error(`Kimi token refresh failed: ${response.status}${payload?.error_description ? `: ${payload.error_description}` : ""}`);
  }
  return parseTokenPayload((await response.json()) as TokenResponse, refreshToken);
}
