/**
 * Meta Muse Code browser login.
 *
 * Meta does not document this device grant for third-party clients. The fixed
 * client id and key-mint exchange below mirror Muse Code 1.0.1 observations
 * supplied with the implementation. The resulting subscription credential is
 * subject to Meta's current Muse Code terms; the dashboard gates this provider
 * behind the high-risk OAuth acknowledgement.
 */
import { museCodeUserAgent } from "../adapters/client-fingerprint";
import type { OAuthController, OAuthCredentials } from "./types";

export const MUSE_CODE_OAUTH_CLIENT_ID = "1031625952748946";
export const MUSE_CODE_API_BASE_URL = "https://api.meta.ai/v1";
export const MUSE_CODE_DEVICE_VERIFY_ORIGIN = "https://auth.meta.com";

const DEVICE_AUTHORIZATION_URL = "https://auth.meta.com/oidc/device/authorization/";
const DEVICE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
const DEVICE_VERIFY_PATH = "/oauth/device/";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MUSE_CODE_API_VERSION = "1.0.0";
/** RFC 8628 §3.2: default polling interval when the response omits `interval`. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MIN_POLL_INTERVAL_MS = 1000;
/** RFC 8628 §3.5: a slow_down response increases the polling interval by 5 seconds. */
const SLOW_DOWN_STEP_MS = 5000;

type Fetch = typeof globalThis.fetch;

export interface MuseCodeOAuthDependencies {
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * RFC 8628 §3.2 device authorization response. `interval` is the only OPTIONAL
 * field (live 2026-09-01 probe returns it as 5); the upstream verification_uri
 * fields are deliberately absent here because the verify URL is rebuilt from
 * user_code so it can never leave the auth.meta.com allowlist.
 */
interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval?: number;
}

/** RFC 8628 §3.5 token success arm. The refresh token is observed but discarded (see mintMuseCodeKey). */
interface DeviceTokenSuccess {
  access_token: string;
  refresh_token?: string;
}

/**
 * RFC 8628 §3.5 error arm (live probe returns HTTP 400 with error_description).
 * error_description is deliberately not surfaced in thrown errors so upstream
 * response bodies cannot leak into logs.
 */
interface DeviceTokenError {
  error: string;
  error_description?: string;
}

type DeviceTokenResponse = DeviceTokenSuccess | DeviceTokenError;

/** Muse Code 1.0.1 key-mint response fields this flow consumes (live probe: all always present). */
interface KeyMintResponse {
  api_key: string;
  base_url: string;
  require_payment: boolean;
}

/** Parse a JSON body once at the trust boundary; null means "not JSON". */
async function readJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    }, { once: true });
  });
}

export function museCodeHttpError(action: string, status: number): Error {
  return new Error(`Meta Muse Code ${action} failed (${status})`);
}

export function buildMuseCodeDeviceVerifyUrl(userCode: string): string {
  const code = userCode.trim();
  if (!/^[A-Z0-9-]{4,64}$/i.test(code)) {
    throw new Error("Meta Muse Code device flow returned an invalid user code");
  }
  return `${MUSE_CODE_DEVICE_VERIFY_ORIGIN}${DEVICE_VERIFY_PATH}?code=${encodeURIComponent(code)}`;
}

export function isAllowedMuseCodeDeviceVerifyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && url.hostname.toLowerCase() === "auth.meta.com"
      && (!url.port || url.port === "443")
      && url.pathname.replace(/\/+$/, "/") === DEVICE_VERIFY_PATH;
  } catch {
    return false;
  }
}

export function accountIdFromMuseCodeApiKey(apiKey: string): string | undefined {
  if (apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(apiKey)) return undefined;
  const segments = apiKey.split("|");
  const accountId = segments.length === 3 && segments[0] === "LLM" && segments[2] ? segments[1] : undefined;
  return accountId && /^\d{1,32}$/.test(accountId) ? accountId : undefined;
}

async function requestDeviceAuthorization(
  fetchImpl: Fetch,
  signal?: AbortSignal,
): Promise<{ deviceCode: string; userCode: string; verifyUrl: string; expiresInMs: number; intervalMs: number }> {
  const response = await fetchImpl(DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": museCodeUserAgent(),
    },
    body: new URLSearchParams({ client_id: MUSE_CODE_OAUTH_CLIENT_ID }),
    redirect: "error",
    signal,
  });
  if (!response.ok) throw museCodeHttpError("device authorization", response.status);
  const payload = await readJson<DeviceAuthorizationResponse>(response);
  if (payload === null) throw new Error("Meta Muse Code device authorization response was not JSON");
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verifyUrl: buildMuseCodeDeviceVerifyUrl(payload.user_code),
    expiresInMs: payload.expires_in * 1000,
    intervalMs: (payload.interval ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
  };
}

async function pollDeviceToken(
  device: { deviceCode: string; expiresInMs: number; intervalMs: number },
  deps: Required<MuseCodeOAuthDependencies>,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = deps.now() + device.expiresInMs;
  let waitMs = Math.max(MIN_POLL_INTERVAL_MS, device.intervalMs);
  while (deps.now() < deadline) {
    await deps.sleep(waitMs, signal);
    if (deps.now() >= deadline) break;
    // Bound each poll by the remaining lifetime so a hung fetch cannot outlive the flow.
    const remainingMs = Math.max(MIN_POLL_INTERVAL_MS, deadline - deps.now());
    const response = await deps.fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": museCodeUserAgent(),
      },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: device.deviceCode,
        client_id: MUSE_CODE_OAUTH_CLIENT_ID,
      }),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(remainingMs)])
        : AbortSignal.timeout(remainingMs),
    });
    const payload = await readJson<DeviceTokenResponse>(response);
    if (payload === null) {
      throw response.ok
        ? new Error("Meta Muse Code device token response was not JSON")
        : museCodeHttpError("device token poll", response.status);
    }
    if ("error" in payload) {
      if (payload.error === "authorization_pending") continue;
      if (payload.error === "slow_down") {
        waitMs += SLOW_DOWN_STEP_MS;
        continue;
      }
      if (payload.error === "access_denied") throw new Error("Meta Muse Code device authorization denied");
      if (payload.error === "expired_token") throw new Error("Meta Muse Code device authorization expired");
      throw new Error(`Meta Muse Code device flow failed (${payload.error})`);
    }
    if (!response.ok) throw museCodeHttpError("device token poll", response.status);
    return payload.access_token;
  }
  throw new Error("Meta Muse Code device flow timed out");
}

async function mintMuseCodeKey(
  metaAccessToken: string,
  fetchImpl: Fetch,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const response = await fetchImpl(KEY_MINT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${metaAccessToken}`,
      "Content-Type": "application/json",
      "User-Agent": museCodeUserAgent(),
      "x-api-version": MUSE_CODE_API_VERSION,
    },
    body: "{}",
    redirect: "error",
    signal,
  });
  if (!response.ok) throw museCodeHttpError("API key mint", response.status);
  const payload = await readJson<KeyMintResponse>(response);
  if (payload === null) throw new Error("Meta Muse Code API key mint response was not JSON");
  if (payload.base_url !== MUSE_CODE_API_BASE_URL) {
    throw new Error("Meta Muse Code API key mint returned an unexpected API endpoint");
  }
  if (payload.require_payment) {
    throw new Error("Meta Muse Code subscription or billing is not ready; update it in Meta Accounts Center and log in again");
  }
  const accountId = accountIdFromMuseCodeApiKey(payload.api_key);
  if (!accountId) throw new Error("Meta Muse Code API key mint returned an invalid API key");
  return {
    access: payload.api_key,
    // The Meta account access token is needed only for the mint exchange. Do not
    // retain it after login; the minted key is durable and can reauthenticate
    // only through a fresh, user-approved device flow.
    refresh: payload.api_key,
    expires: Number.MAX_SAFE_INTEGER,
    source: "oauth",
    accountId,
  };
}

export async function loginMuseCode(
  ctrl: OAuthController,
  dependencies: MuseCodeOAuthDependencies = {},
): Promise<OAuthCredentials> {
  const deps = {
    fetch: dependencies.fetch ?? globalThis.fetch,
    now: dependencies.now ?? Date.now,
    sleep: dependencies.sleep ?? sleep,
  };
  const device = await requestDeviceAuthorization(deps.fetch, ctrl.signal);
  if (!isAllowedMuseCodeDeviceVerifyUrl(device.verifyUrl)) {
    throw new Error("Meta Muse Code refused to open a non-allowlisted verification URL");
  }
  ctrl.onAuth?.({
    url: device.verifyUrl,
    instructions: `Enter code: ${device.userCode}`,
    deviceCode: device.userCode,
  });
  ctrl.onProgress?.("Waiting for Meta device authorization...");
  const metaAccessToken = await pollDeviceToken(device, deps, ctrl.signal);
  ctrl.onProgress?.("Creating the Muse Code API credential...");
  return mintMuseCodeKey(metaAccessToken, deps.fetch, ctrl.signal);
}

export async function refreshMuseCodeToken(apiKey: string): Promise<OAuthCredentials> {
  const accountId = accountIdFromMuseCodeApiKey(apiKey);
  if (!accountId) throw new Error("Meta Muse Code API key is invalid; run ocx login muse-code");
  return {
    access: apiKey,
    refresh: apiKey,
    expires: Number.MAX_SAFE_INTEGER,
    source: "oauth",
    accountId,
  };
}