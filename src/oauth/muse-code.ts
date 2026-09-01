/**
 * Meta Muse Code browser login.
 *
 * Meta does not document this device grant for third-party clients. The fixed
 * client id and key-mint exchange below mirror Muse Code 1.0.1 observations
 * supplied with the implementation. The resulting subscription credential is
 * subject to Meta's current Muse Code terms; the dashboard gates this provider
 * behind the high-risk OAuth acknowledgement.
 */
import type { OAuthController, OAuthCredentials } from "./types";
import { readBoundedResponseBytes } from "../lib/bounded-body";

export const MUSE_CODE_OAUTH_CLIENT_ID = "1031625952748946";
export const MUSE_CODE_API_BASE_URL = "https://api.meta.ai/v1";
export const MUSE_CODE_DEVICE_VERIFY_ORIGIN = "https://auth.meta.com";

const DEVICE_AUTHORIZATION_URL = "https://auth.meta.com/oidc/device/authorization/";
const DEVICE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
const DEVICE_VERIFY_PATH = "/oauth/device/";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MUSE_CODE_API_VERSION = "1.0.0";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 10 * 60 * 1_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1_024;

type Fetch = typeof globalThis.fetch;

export interface MuseCodeOAuthDependencies {
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function credentialString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  return /[\x00-\x1f\x7f]/.test(value) ? undefined : value;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Login cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const { bytes, oversized } = await readBoundedResponseBytes(response, {
    maxBytes: MAX_OAUTH_RESPONSE_BYTES,
    signal,
  });
  if (oversized) throw new Error("Meta Muse Code authentication response was too large");
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
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
      && (url.pathname.replace(/\/+$/, "/") === DEVICE_VERIFY_PATH);
  } catch {
    return false;
  }
}

export function accountIdFromMuseCodeApiKey(apiKey: string): string | undefined {
  if (apiKey.length > 4_096 || /[\x00-\x20\x7f]/.test(apiKey)) return undefined;
  const segments = apiKey.split("|");
  const accountId = segments.length === 3 && segments[0] === "LLM" && segments[2]
    ? segments[1]
    : undefined;
  return accountId && /^\d{1,32}$/.test(accountId) ? accountId : undefined;
}

async function requestDeviceAuthorization(
  fetchImpl: Fetch,
  signal?: AbortSignal,
): Promise<{ deviceCode: string; userCode: string; verifyUrl: string; expiresInMs: number; intervalMs: number }> {
  const boundedSignal = requestSignal(signal);
  const response = await fetchImpl(DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "opencodex",
    },
    body: new URLSearchParams({ client_id: MUSE_CODE_OAUTH_CLIENT_ID }),
    redirect: "error",
    signal: boundedSignal,
  });
  const payload = await readJson(response, boundedSignal);
  if (!response.ok) throw museCodeHttpError("device authorization", response.status);
  const deviceCode = credentialString(payload.device_code, 4_096);
  const userCode = nonEmptyString(payload.user_code);
  if (!deviceCode || !userCode) {
    throw new Error("Meta Muse Code device authorization response missing required fields");
  }
  const verifyUrl = buildMuseCodeDeviceVerifyUrl(userCode);
  if (!isAllowedMuseCodeDeviceVerifyUrl(verifyUrl)) {
    throw new Error("Meta Muse Code refused to open a non-allowlisted verification URL");
  }
  return {
    deviceCode,
    userCode,
    verifyUrl,
    expiresInMs: (positiveNumber(payload.expires_in) ?? DEFAULT_DEVICE_FLOW_TTL_MS / 1_000) * 1_000,
    intervalMs: (positiveNumber(payload.interval) ?? DEFAULT_POLL_INTERVAL_MS / 1_000) * 1_000,
  };
}

async function pollDeviceToken(
  device: { deviceCode: string; expiresInMs: number; intervalMs: number },
  deps: Required<Pick<MuseCodeOAuthDependencies, "fetch" | "now" | "sleep">>,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = deps.now() + device.expiresInMs;
  let waitMs = Math.max(MIN_POLL_INTERVAL_MS, device.intervalMs);
  while (deps.now() < deadline) {
    await deps.sleep(waitMs, signal);
    if (deps.now() >= deadline) break;
    const boundedSignal = requestSignal(signal);
    const response = await deps.fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "opencodex",
      },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: device.deviceCode,
        client_id: MUSE_CODE_OAUTH_CLIENT_ID,
      }),
      redirect: "error",
      signal: boundedSignal,
    });
    const payload = await readJson(response, boundedSignal);
    const accessToken = credentialString(payload.access_token, 8_192);
    if (response.ok && accessToken) return accessToken;
    const error = nonEmptyString(payload.error);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      const requestedWait = (positiveNumber(payload.interval) ?? 0) * 1_000;
      waitMs = Math.max(waitMs + 5_000, requestedWait);
      continue;
    }
    if (error === "access_denied") throw new Error("Meta Muse Code device authorization denied");
    if (error === "expired_token") throw new Error("Meta Muse Code device authorization expired");
    if (!response.ok) throw museCodeHttpError("device token poll", response.status);
    throw new Error("Meta Muse Code device flow failed (unknown)");
  }
  throw new Error("Meta Muse Code device flow timed out");
}

async function mintMuseCodeKey(
  metaAccessToken: string,
  fetchImpl: Fetch,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const boundedSignal = requestSignal(signal);
  const response = await fetchImpl(KEY_MINT_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${metaAccessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "opencodex",
      "x-api-version": MUSE_CODE_API_VERSION,
    },
    body: "{}",
    redirect: "error",
    signal: boundedSignal,
  });
  const payload = await readJson(response, boundedSignal);
  if (!response.ok) throw museCodeHttpError("API key mint", response.status);
  const apiKey = credentialString(payload.api_key, 4_096);
  if (!apiKey) throw new Error("Meta Muse Code API key mint response missing API key");
  const baseUrl = nonEmptyString(payload.base_url);
  if (baseUrl !== MUSE_CODE_API_BASE_URL) {
    throw new Error("Meta Muse Code API key mint returned an unexpected API endpoint");
  }
  if (payload.require_payment === true) {
    throw new Error("Meta Muse Code subscription or billing is not ready; update it in Meta Accounts Center and log in again");
  }
  const accountId = accountIdFromMuseCodeApiKey(apiKey);
  if (!accountId) throw new Error("Meta Muse Code API key mint returned an invalid API key");
  return {
    access: apiKey,
    // The Meta account access token is needed only for the mint exchange. Do not
    // retain it after login; the minted key is durable and can reauthenticate
    // only through a fresh, user-approved device flow.
    refresh: apiKey,
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
    sleep: dependencies.sleep ?? defaultSleep,
  };
  const device = await requestDeviceAuthorization(deps.fetch, ctrl.signal);
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
