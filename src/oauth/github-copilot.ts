/**
 * GitHub Copilot OAuth (device authorization grant + copilot_internal token exchange).
 *
 * Uses the public VS Code GitHub OAuth app client id (community-proven for Copilot Pro).
 * This is an unofficial bridge — GitHub may tighten or revoke access. See registry note.
 */
import type { OAuthController, OAuthCredentials } from "./types";
import { redactSecretString } from "../lib/redact";

/** VS Code's public GitHub OAuth app — required for copilot_internal/v2/token to succeed. */
export const GITHUB_COPILOT_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_COPILOT_DEFAULT_API_BASE = "https://api.githubcopilot.com";
export const GITHUB_DEVICE_VERIFY_ORIGIN = "https://github.com";
export const GITHUB_DEVICE_VERIFY_PATH = "/login/device";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_USER_URL = "https://api.github.com/user";

const OAUTH_SCOPE = "read:user";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const OAUTH_EXPIRY_SKEW_MS = 2 * 60 * 1000;
const MIN_POLL_MS = 1000;

/** Honest OpenCodex client fingerprint; VS Code-shaped values only if API requires them later. */
export const GITHUB_COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "Editor-Version": "opencodex/0.1.0",
  "Editor-Plugin-Version": "opencodex/0.1.0",
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": "opencodex",
  Accept: "application/json",
};

interface DeviceAuthorizationResponse {
  user_code?: string;
  device_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface GithubTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
}

interface CopilotTokenResponse {
  token?: string;
  expires_at?: number;
  refresh_in?: number;
  endpoints?: { api?: string };
}

interface GithubUserResponse {
  login?: string;
  id?: number;
  email?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("Login cancelled"));
    }, { once: true });
  });
}

/** Status-only errors — never echo response bodies (may contain tokens). */
export function githubCopilotHttpError(action: string, status: number): Error {
  return new Error(`GitHub Copilot ${action} failed (${status})`);
}

export function buildGithubDeviceVerifyUrl(userCode: string): string {
  const code = userCode.trim();
  if (!code || !/^[A-Z0-9-]+$/i.test(code)) {
    throw new Error("GitHub Copilot device flow returned an invalid user code");
  }
  return `${GITHUB_DEVICE_VERIFY_ORIGIN}${GITHUB_DEVICE_VERIFY_PATH}?user_code=${encodeURIComponent(code)}`;
}

/**
 * Allowlist for browser-open URLs. Prefer {@link buildGithubDeviceVerifyUrl}; this rejects
 * phishing redirects if a caller still passes a server-supplied verification URI.
 */
export function isAllowedGithubDeviceVerifyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.hostname.toLowerCase() !== "github.com") return false;
    if (parsed.port && parsed.port !== "443") return false;
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return path === GITHUB_DEVICE_VERIFY_PATH;
  } catch {
    return false;
  }
}

/**
 * Tight allowlist for Copilot API hosts from token `endpoints.api`.
 * Rejects IPs, localhost, non-HTTPS, userinfo, and non-default ports.
 */
export function validateCopilotApiBaseUrl(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.port && parsed.port !== "443") return undefined;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) {
    return undefined;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return undefined;
  if (host !== "api.githubcopilot.com" && !host.endsWith(".githubcopilot.com")) return undefined;
  // Normalize to origin only (no path/query from the network).
  return `https://${host}`;
}

export function resolveCopilotApiBaseUrl(raw: string | undefined | null): string {
  return validateCopilotApiBaseUrl(raw) ?? GITHUB_COPILOT_DEFAULT_API_BASE;
}

async function requestDeviceAuthorization(signal?: AbortSignal): Promise<{
  userCode: string;
  deviceCode: string;
  verifyUrl: string;
  expiresInMs: number;
  intervalMs: number;
}> {
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "opencodex",
    },
    body: new URLSearchParams({
      client_id: GITHUB_COPILOT_OAUTH_CLIENT_ID,
      scope: OAUTH_SCOPE,
    }),
    signal,
  });
  if (!response.ok) throw githubCopilotHttpError("device authorization", response.status);
  const payload = (await response.json()) as DeviceAuthorizationResponse;
  if (!payload.user_code || !payload.device_code) {
    throw new Error("GitHub Copilot device authorization response missing required fields");
  }
  // Construct verify URL ourselves — never trust verification_uri_complete for openUrl.
  const verifyUrl = buildGithubDeviceVerifyUrl(payload.user_code);
  return {
    userCode: payload.user_code,
    deviceCode: payload.device_code,
    verifyUrl,
    expiresInMs: typeof payload.expires_in === "number" ? payload.expires_in * 1000 : DEFAULT_DEVICE_FLOW_TTL_MS,
    intervalMs: typeof payload.interval === "number" && payload.interval > 0
      ? payload.interval * 1000
      : DEFAULT_POLL_INTERVAL_MS,
  };
}

async function pollGithubDeviceToken(
  deviceCode: string,
  intervalMs: number,
  expiresInMs: number,
  signal?: AbortSignal,
): Promise<{ access: string; refresh: string }> {
  const deadline = Date.now() + expiresInMs;
  let waitMs = Math.max(MIN_POLL_MS, intervalMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "opencodex",
      },
      body: new URLSearchParams({
        client_id: GITHUB_COPILOT_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal,
    });
    const payload = (await response.json().catch(() => ({}))) as GithubTokenResponse;
    if (response.ok && payload.access_token && payload.refresh_token) {
      return { access: payload.access_token, refresh: payload.refresh_token };
    }
    const error = payload.error;
    if (error === "authorization_pending") {
      await sleep(waitMs, signal);
      continue;
    }
    if (error === "slow_down") {
      // RFC 8628: increase the interval. Prefer server-provided `interval` when present;
      // otherwise add one second (not five) so CI under load still completes.
      const retryAfter = typeof payload.interval === "number" && payload.interval > 0
        ? payload.interval * 1000
        : waitMs + 1000;
      waitMs = Math.max(waitMs + 1000, retryAfter);
      await sleep(waitMs, signal);
      continue;
    }
    if (error === "expired_token") throw new Error("GitHub Copilot device authorization expired");
    if (error === "access_denied") throw new Error("GitHub Copilot device authorization denied");
    if (error === "unsupported_grant_type" || error === "incorrect_device_code") {
      throw new Error(`GitHub Copilot device flow failed (${error})`);
    }
    if (!response.ok) throw githubCopilotHttpError("device token poll", response.status);
    throw new Error(`GitHub Copilot device flow failed (${error ?? "unknown"})`);
  }
  throw new Error("GitHub Copilot device flow timed out");
}

async function refreshGithubAccessToken(refreshToken: string, signal?: AbortSignal): Promise<{ access: string; refresh: string }> {
  const response = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "opencodex",
    },
    body: new URLSearchParams({
      client_id: GITHUB_COPILOT_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal,
  });
  if (!response.ok) throw githubCopilotHttpError("token refresh", response.status);
  const payload = (await response.json().catch(() => ({}))) as GithubTokenResponse;
  if (!payload.access_token) throw new Error("GitHub Copilot token refresh missing access token");
  return {
    access: payload.access_token,
    refresh: payload.refresh_token ?? refreshToken,
  };
}

async function exchangeCopilotToken(githubAccessToken: string, signal?: AbortSignal): Promise<{
  access: string;
  expires: number;
  apiBaseUrl: string;
}> {
  const response = await fetch(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      ...GITHUB_COPILOT_EDITOR_HEADERS,
      Authorization: `token ${githubAccessToken}`,
    },
    signal,
  });
  if (!response.ok) throw githubCopilotHttpError("token exchange", response.status);
  const payload = (await response.json().catch(() => ({}))) as CopilotTokenResponse;
  if (!payload.token || typeof payload.token !== "string") {
    throw new Error("GitHub Copilot token exchange missing token");
  }
  let expires: number;
  if (typeof payload.expires_at === "number" && Number.isFinite(payload.expires_at)) {
    // expires_at is unix seconds from GitHub.
    expires = payload.expires_at * 1000 - OAUTH_EXPIRY_SKEW_MS;
  } else if (typeof payload.refresh_in === "number" && payload.refresh_in > 0) {
    expires = Date.now() + payload.refresh_in * 1000 - OAUTH_EXPIRY_SKEW_MS;
  } else {
    expires = Date.now() + 25 * 60 * 1000 - OAUTH_EXPIRY_SKEW_MS;
  }
  return {
    access: payload.token,
    expires,
    apiBaseUrl: resolveCopilotApiBaseUrl(payload.endpoints?.api),
  };
}

async function fetchGithubIdentity(githubAccessToken: string, signal?: AbortSignal): Promise<{
  email?: string;
  accountId?: string;
}> {
  try {
    const response = await fetch(GITHUB_USER_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubAccessToken}`,
        "User-Agent": "opencodex",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal,
    });
    if (!response.ok) return {};
    const user = (await response.json()) as GithubUserResponse;
    const accountId = typeof user.id === "number" ? String(user.id) : undefined;
    const email = typeof user.login === "string" && user.login
      ? `${user.login}@users.noreply.github.com`
      : undefined;
    return { email, accountId };
  } catch {
    return {};
  }
}

async function credentialsFromGithubAccess(
  githubAccess: string,
  githubRefresh: string,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const [copilot, identity] = await Promise.all([
    exchangeCopilotToken(githubAccess, signal),
    fetchGithubIdentity(githubAccess, signal),
  ]);
  return {
    access: copilot.access,
    refresh: githubRefresh,
    expires: copilot.expires,
    apiBaseUrl: copilot.apiBaseUrl,
    source: "oauth",
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
  };
}

export async function loginGithubCopilot(ctrl: OAuthController): Promise<OAuthCredentials> {
  const device = await requestDeviceAuthorization(ctrl.signal);
  if (!isAllowedGithubDeviceVerifyUrl(device.verifyUrl)) {
    throw new Error("GitHub Copilot refused to open a non-allowlisted verification URL");
  }
  ctrl.onAuth?.({
    url: device.verifyUrl,
    instructions: `Enter code: ${device.userCode}`,
  });
  ctrl.onProgress?.("Waiting for GitHub device authorization…");
  const github = await pollGithubDeviceToken(
    device.deviceCode,
    device.intervalMs,
    device.expiresInMs,
    ctrl.signal,
  );
  ctrl.onProgress?.("Exchanging GitHub token for Copilot access…");
  return credentialsFromGithubAccess(github.access, github.refresh, ctrl.signal);
}

/**
 * Refresh = GitHub OAuth refresh (using stored GitHub refresh token) + Copilot re-exchange.
 * `refreshToken` is the GitHub refresh token stored in credentials.refresh.
 */
export async function refreshGithubCopilotToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const github = await refreshGithubAccessToken(refreshToken, signal);
  return credentialsFromGithubAccess(github.access, github.refresh, signal);
}

/** Test helper: ensure a string does not contain obvious secret material from fixtures. */
export function assertNoSecretLeak(message: string, secrets: string[]): void {
  const lower = message.toLowerCase();
  for (const secret of secrets) {
    if (!secret) continue;
    if (message.includes(secret) || lower.includes(secret.toLowerCase())) {
      throw new Error(`secret leaked into error message: ${redactSecretString(secret)}`);
    }
  }
}
