import type { OAuthController, OAuthCredentials } from "./types";
import { CHATGPT_CLIENT_ID, CHATGPT_TOKEN_URL, credsFromToken } from "./chatgpt";

/**
 * OpenAI deviceauth (device-code) grant for the ChatGPT/Codex provider.
 *
 * The callback flow in `./chatgpt` needs a browser and a listener on
 * localhost:1455. A hub running headless in a container or over SSH has
 * neither, which left "copy the long redirect URL out of the browser error
 * page" as the only way to add an account there (#3366).
 *
 * This is the same grant Codex CLI uses. Three steps, and the middle one is
 * where it differs from RFC 8628: the poll returns an authorization code plus
 * a SERVER-generated PKCE verifier, which is then spent at the ordinary token
 * endpoint. We never generate the verifier ourselves here.
 */
const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";

/** Where the user types the short code. Fixed, and safe to show anywhere. */
export const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";

/** The grant's own lifetime. Polling past this only produces a worse error message. */
const DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 1_000;
/**
 * Above ~2^31 ms a timer overflows and fires immediately, which would turn a
 * hostile or corrupt `interval` into a hot loop against an auth endpoint. The
 * grant only lives 15 minutes, so anything longer is meaningless anyway.
 */
const MAX_POLL_INTERVAL_MS = DEVICE_FLOW_TTL_MS;

/**
 * Upstream sends `interval` as a number in some responses and a string in
 * others. A string would make `setTimeout` treat it as 0 and turn the poll
 * into a hot loop against an auth endpoint, so coerce and floor it.
 */
function normalizeIntervalMs(raw: unknown): number {
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_POLL_INTERVAL_MS;
  const ms = Math.round(seconds * 1000);
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, ms));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Login cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Device-flow errors carry the HTTP status and nothing else.
 *
 * The callback flow's `safeErrorDescription` reflects the upstream body into
 * the message, which is fine for an OAuth error envelope but not here: these
 * endpoints can echo request material, and this message reaches CLI output,
 * the GUI, and issue reports.
 */
function deviceError(stage: string, status: number): Error {
  return new Error(`ChatGPT device authorization ${stage} failed: HTTP ${status}`);
}

interface DeviceUserCode {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}

async function requestUserCode(signal?: AbortSignal): Promise<DeviceUserCode> {
  const response = await fetch(USERCODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
    signal,
  });
  if (!response.ok) throw deviceError("request", response.status);
  const payload = (await response.json()) as Record<string, unknown>;
  const deviceAuthId = nonEmptyString(payload.device_auth_id);
  // Upstream accepts both spellings, so a response using the alias must not be
  // rejected as malformed.
  const userCode = nonEmptyString(payload.user_code) ?? nonEmptyString(payload.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("ChatGPT device authorization response missing required fields");
  }
  return { deviceAuthId, userCode, intervalMs: normalizeIntervalMs(payload.interval) };
}

interface DeviceGrant {
  authorizationCode: string;
  codeVerifier: string;
}

/**
 * Poll until the user finishes at the verification page.
 *
 * Pending is signalled by 403/404 rather than an `authorization_pending` body,
 * so status is the whole protocol here: any other non-2xx is terminal, and
 * treating it as pending would keep hammering a permanently failing endpoint.
 */
async function pollForGrant(
  device: DeviceUserCode,
  signal?: AbortSignal,
): Promise<DeviceGrant> {
  const deadline = Date.now() + DEVICE_FLOW_TTL_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    const response = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      signal,
    });
    if (response.status === 403 || response.status === 404) {
      // Cap the wait at the time actually left. Sleeping a full interval past
      // the deadline is how a 15-minute grant turns into a 20-minute wait.
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(device.intervalMs, remaining), signal);
      continue;
    }
    if (!response.ok) throw deviceError("poll", response.status);
    // The deadline is checked again here, not only at the top of the loop: a
    // single poll can itself outlive the grant, and accepting a code that
    // expired mid-flight just moves the failure to the token exchange.
    if (Date.now() >= deadline) break;
    const payload = (await response.json()) as Record<string, unknown>;
    const authorizationCode = nonEmptyString(payload.authorization_code);
    const codeVerifier = nonEmptyString(payload.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      throw new Error("ChatGPT device authorization response missing required fields");
    }
    return { authorizationCode, codeVerifier };
  }
  throw new Error("ChatGPT device authorization expired");
}

async function exchangeGrant(grant: DeviceGrant, signal?: AbortSignal): Promise<OAuthCredentials> {
  const response = await fetch(CHATGPT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CHATGPT_CLIENT_ID,
      code: grant.authorizationCode,
      code_verifier: grant.codeVerifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }).toString(),
    signal,
  });
  if (!response.ok) throw deviceError("token exchange", response.status);
  return credsFromToken((await response.json()) as Record<string, unknown>);
}

/**
 * Run the device flow to completion.
 *
 * `deviceCode` in the `onAuth` payload is the HUMAN code, matching kimi, nous,
 * and github-copilot. The opaque `device_auth_id` never leaves this module:
 * every device-code surface renders `deviceCode` verbatim, and the management
 * login route also uses its presence to decide a flow must not be handed to a
 * local browser spawn.
 */
export async function loginChatGPTDevice(ctrl: OAuthController): Promise<OAuthCredentials> {
  const device = await requestUserCode(ctrl.signal);
  ctrl.onAuth?.({
    url: DEVICE_VERIFICATION_URL,
    instructions: `Enter code: ${device.userCode}`,
    deviceCode: device.userCode,
  });
  const grant = await pollForGrant(device, ctrl.signal);
  return exchangeGrant(grant, ctrl.signal);
}
