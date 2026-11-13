/** xAI OAuth flow (Grok account login). Ported from jawcode oauth/xai.ts. */
import { abortError, sleepWithAbort } from "../lib/upstream-retry";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { LocalTokenImportMode, OAuthController, OAuthCredentials } from "./types";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_CALLBACK_PORT = 56121;
const XAI_OAUTH_CALLBACK_PATH = "/callback";
const XAI_OAUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const RETRY_AFTER_MAX_DELAY_MS = 60_000;
const JITTER_DELAY_CAP_MS = 2_000;
const XAI_TRUSTED_AUTH_HOSTS = new Set(["auth.x.ai", "accounts.x.ai"]);

export const XAI_LOCAL_CLI_DETACH_WARNING =
  "[oauth:xai] Grok CLI credential was stale; refreshed into OpenCodex ownership. Grok CLI may require login again.";

interface XaiDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** RFC 8628 endpoint, when the issuer advertises one. */
  deviceAuthorizationEndpoint?: string;
}

interface XaiDiscoveryPayload {
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  device_authorization_endpoint?: unknown;
}

export interface XaiTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  token_type?: unknown;
}

interface XaiJwtPayload {
  sub?: unknown;
  email?: unknown;
  [key: string]: unknown;
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function validateXaiEndpoint(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("xAI OAuth discovery returned an unparseable endpoint URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.port !== ""
    || !XAI_TRUSTED_AUTH_HOSTS.has(host)
  ) {
    throw new Error(`xAI OAuth discovery returned an unexpected endpoint (host: ${host || "none"})`);
  }
  return parsed.toString();
}

export async function discoverXaiOAuthEndpoints(signal?: AbortSignal): Promise<XaiDiscovery> {
  let response: Response;
  try {
    response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
      headers: { Accept: "application/json" },
      signal: requestSignal(signal),
    });
  } catch (error) {
    throw new XaiTokenRequestError(undefined, undefined, "xAI OAuth discovery failed: network error", { cause: error });
  }
  if (!response.ok) {
    throw new XaiTokenRequestError(response.status, undefined, `xAI OAuth discovery failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as XaiDiscoveryPayload;
  if (typeof payload.authorization_endpoint !== "string" || typeof payload.token_endpoint !== "string") {
    throw new Error("xAI OAuth discovery response missing authorization/token endpoints");
  }

  return {
    authorizationEndpoint: validateXaiEndpoint(payload.authorization_endpoint),
    tokenEndpoint: validateXaiEndpoint(payload.token_endpoint),
    ...(typeof payload.device_authorization_endpoint === "string"
      ? { deviceAuthorizationEndpoint: validateXaiEndpoint(payload.device_authorization_endpoint) }
      : {}),
  };
}

function decodeJwtPayload(token: string): XaiJwtPayload | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as XaiJwtPayload;
  } catch {
    return undefined;
  }
}

function getTokenIdentity(accessToken: string, idToken: string | undefined): { accountId?: string; email?: string } {
  const payload = (idToken ? decodeJwtPayload(idToken) : undefined) ?? decodeJwtPayload(accessToken);
  const accountId = typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
  const email =
    typeof payload?.email === "string" && payload.email.length > 0 ? payload.email.toLowerCase() : undefined;
  return { accountId, email };
}

export class XaiTokenRequestError extends Error {
  constructor(
    public readonly status?: number,
    public readonly oauthError?: string,
    message = "xAI token request failed",
    options?: { cause?: unknown },
    /** Server-requested throttle from a retryable response, already floored and finite. */
    public readonly retryAfterMs?: number,
  ) {
    super(message, options);
    this.name = "XaiTokenRequestError";
  }
}

/**
 * The endpoint answered with a redirect while the caller asked `redirect: "error"`.
 *
 * Non-retriable by construction: replaying the request would send the same body to a host
 * `validateXaiEndpoint` never approved. The message is fixed on purpose. Bun's redirect
 * `TypeError` embeds the target URL in its text, and the poll body carries the
 * bearer-equivalent `device_code`, so neither may reach a log, an error `cause`, a login
 * status payload, or the terminal.
 */
export class XaiRedirectRefusedError extends XaiTokenRequestError {
  constructor() {
    super(undefined, undefined, "xAI token request refused a redirect");
    this.name = "XaiRedirectRefusedError";
  }
}

/**
 * True when `fetch` refused a redirect because this caller passed `redirect: "error"`.
 *
 * The two runtimes signal it differently and both were checked against a real local server:
 * Bun throws `TypeError` with `code: "UnexpectedRedirect"`; Node/undici throws
 * `TypeError("fetch failed")` whose `cause` is `Error("unexpected redirect")`. Matching exactly
 * keeps a programming `TypeError` (no marker) and a real connection failure (Bun
 * `ECONNREFUSED`/`ENOTFOUND`, undici's own cause text) retriable.
 */
function isRedirectRefusal(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  if ((error as { code?: unknown }).code === "UnexpectedRedirect") return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && cause.message === "unexpected redirect";
}
export interface XaiTokenRetryDeps { sleep?:(ms:number)=>Promise<void>; random?:()=>number; /** Default 3; the device poll sends one request per interval. */ maxAttempts?:number; /**
 * Fetch redirect policy. Inherited callers keep the runtime default (follow); the device poll sets
 * `error` because its body carries the RFC 8628 `device_code`, a bearer-equivalent secret that must
 * not be re-POSTed to a redirect target. A 307/308 preserves the method and body.
 */ redirect?:RequestRedirect }
const IMF_FIXDATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
const RFC850_DATE_RE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
const ASCTIME_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i;
const HTTP_MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseUtcDateParts(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const month = HTTP_MONTH_INDEX[monthName.toLowerCase()];
  if (month === undefined) return undefined;
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month
    && parsed.getUTCDate() === day
    && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute
    && parsed.getUTCSeconds() === second
    ? timestamp
    : undefined;
}

function parseHttpDateMs(value: string, now: number): number | undefined {
  const match = IMF_FIXDATE_RE.exec(value);
  if (match) {
    return parseUtcDateParts(
      Number(match[3]), match[2]!, Number(match[1]),
      Number(match[4]), Number(match[5]), Number(match[6]),
    );
  }
  const rfc850 = RFC850_DATE_RE.exec(value);
  if (rfc850) {
    // Two-digit years more than 50 years in the future are in the past (RFC 9110).
    const currentYear = new Date(now).getUTCFullYear();
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850[3]);
    const candidateTimeOfYear = Date.UTC(
      2000, HTTP_MONTH_INDEX[rfc850[2]!.toLowerCase()]!, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]),
    );
    const current = new Date(now);
    const currentTimeOfYear = Date.UTC(
      2000, current.getUTCMonth(), current.getUTCDate(),
      current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(),
      current.getUTCMilliseconds(),
    );
    const yearDelta = year - currentYear;
    if (yearDelta < -50 || (yearDelta === -50 && candidateTimeOfYear < currentTimeOfYear)) {
      year += 100;
    } else if (yearDelta > 50 || (yearDelta === 50 && candidateTimeOfYear > currentTimeOfYear)) {
      year -= 100;
    }
    return parseUtcDateParts(
      year, rfc850[2]!, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]),
    );
  }
  const asctime = ASCTIME_DATE_RE.exec(value);
  if (!asctime) return undefined;
  return parseUtcDateParts(
    Number(asctime[6]), asctime[1]!, Number(asctime[2]),
    Number(asctime[3]), Number(asctime[4]), Number(asctime[5]),
  );
}

function parseRetryAfterMs(retryAfter: string | null): number | undefined {
  const text = retryAfter?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(Number(text) * 1000));
    return ms > 0 ? ms : undefined;
  }
  const now = Date.now();
  const timestamp = parseHttpDateMs(text, now);
  if (timestamp === undefined) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? delay : undefined;
}

function jitterDelay(attempt: number, random: () => number): number {
  const base = attempt === 1 ? 100 : 250;
  return Math.min(JITTER_DELAY_CAP_MS, Math.round(base * (0.75 + random() * 0.5)));
}

/**
 * Delay before the next attempt, or undefined when the server asked for a wait
 * beyond the retry budget — retrying earlier than Retry-After would hammer the
 * token endpoint, so the caller fails the request instead of clamping.
 */
function retryDelay(attempt: number, retryAfter: string | null, random: () => number): number | undefined {
  const serverMs = parseRetryAfterMs(retryAfter);
  if (serverMs === undefined) return jitterDelay(attempt, random);
  return serverMs <= RETRY_AFTER_MAX_DELAY_MS ? serverMs : undefined;
}

async function sleepAbortable(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw abortError(signal);
  let onAbort!: () => void;
  try {
    await Promise.race([
      sleep(ms),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function readTokenError(response:Response):Promise<XaiTokenRequestError>{let oauthError:string|undefined,detail="";try{const body=await response.json() as {error?:unknown;error_description?:unknown};if(typeof body.error==="string")oauthError=body.error;if(typeof body.error_description==="string")detail=body.error_description;}catch{/* non-JSON error body: fall through to the generic message */}const suffix=detail?`: ${detail}`:oauthError?`: ${oauthError}`:"";const retryAfterMs=response.status===429||response.status>=500||(response.status===400&&oauthError==="slow_down")?parseRetryAfterMs(response.headers.get("retry-after")):undefined;return new XaiTokenRequestError(response.status,oauthError,`xAI token request failed: ${response.status}${suffix}`,undefined,retryAfterMs!==undefined&&Number.isFinite(retryAfterMs)?retryAfterMs:undefined);}
export async function postXaiToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  signal?: AbortSignal, deps:XaiTokenRetryDeps={},
): Promise<XaiTokenPayload> {
 const sleep=deps.sleep??((ms:number)=>sleepWithAbort(ms,signal)),random=deps.random??Math.random,max=deps.maxAttempts??3,redirect=deps.redirect;let last:unknown;
 for(let attempt=1;attempt<=max;attempt++){let response:Response;try{response=await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    ...(redirect === undefined ? {} : { redirect }),
    signal: requestSignal(signal),
  });}catch(error){
  if(signal?.aborted)throw error;
  const name=(error as {name?:string}|undefined)?.name;
  if(name==="AbortError"||name==="TimeoutError")throw error;
  // A refused redirect is deterministic: the same body replayed reaches the same answer, and
  // the caller asked for `error` precisely so the request never leaves the approved endpoint.
  if(redirect==="error"&&isRedirectRefusal(error))throw new XaiRedirectRefusedError();
  last=error;
  if(attempt===max)throw new XaiTokenRequestError(undefined,undefined,"xAI token request failed: network error",{cause:error});
  await sleepAbortable(jitterDelay(attempt,random),sleep,signal);
  continue;
  }if(response.ok)return await response.json() as XaiTokenPayload;const error=await readTokenError(response);last=error;if(!(response.status===429||response.status>=500)||attempt===max)throw error;if(signal?.aborted)throw error;const delay=retryDelay(attempt,response.headers.get("retry-after"),random);if(delay===undefined)throw error;await sleepAbortable(delay,sleep,signal);}throw last;
}

function credentialsFromTokenPayload(payload: XaiTokenPayload, refreshFallback = ""): OAuthCredentials {
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("xAI token response did not include an access token");
  }
  const refresh =
    typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
      ? payload.refresh_token
      : refreshFallback;
  if (!refresh) {
    throw new Error("xAI token response did not include a refresh token");
  }
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  const { accountId, email } = getTokenIdentity(payload.access_token, idToken);
  return {
    refresh,
    access: payload.access_token,
    expires: Date.now() + expiresIn * 1000 - XAI_OAUTH_REFRESH_SKEW_MS,
    accountId,
    email,
  };
}

export class XaiOAuthFlow extends OAuthCallbackFlow {
  #verifier = "";
  #discovery: XaiDiscovery | undefined;

  constructor(ctrl: OAuthController) {
    super(ctrl, {
      preferredPort: XAI_OAUTH_CALLBACK_PORT,
      callbackPath: XAI_OAUTH_CALLBACK_PATH,
      callbackHostname: "127.0.0.1",
      callbackBindHostname: "127.0.0.1",
      redirectUri: `http://127.0.0.1:${XAI_OAUTH_CALLBACK_PORT}${XAI_OAUTH_CALLBACK_PATH}`,
    } satisfies OAuthCallbackFlowOptions);
  }

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    this.#discovery = await discoverXaiOAuthEndpoints(this.ctrl.signal);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: XAI_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: XAI_OAUTH_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      nonce: crypto.randomUUID(),
    });
    return {
      url: `${this.#discovery.authorizationEndpoint}?${params.toString()}`,
      instructions:
        "Complete xAI/Grok login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
    };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    if (!this.#verifier) {
      throw new Error("xAI OAuth PKCE verifier was not initialized");
    }
    const discovery = this.#discovery ?? (await discoverXaiOAuthEndpoints(this.ctrl.signal));
    const tokenPayload = await postXaiToken(
      discovery.tokenEndpoint,
      {
        grant_type: "authorization_code",
        client_id: XAI_OAUTH_CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: this.#verifier,
      },
      this.ctrl.signal,
    );
    return credentialsFromTokenPayload(tokenPayload);
  }
}

const XAI_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 §3.2 `expires_in` default when the issuer omits it; also the fallback `interval`. */
const XAI_DEVICE_DEFAULT_TTL_S = 900;
const XAI_DEVICE_DEFAULT_INTERVAL_S = 5;
/**
 * Hard ceilings on values the issuer supplies, so a hostile or corrupt response cannot turn the
 * poll into a hot loop or an unbounded login.
 *
 * `setTimeout` stores its delay in a 32-bit signed int. A larger value overflows and fires on the
 * next tick, which is exactly a hot loop against the auth endpoint; a `0`/negative/fractional
 * `interval` floors to ~1 ms for the same effect. So the interval is clamped into
 * [MIN, TTL] and the grant lifetime into (0, MAX_TTL]. RFC 8628 §3.2 says the issuer supplies
 * `interval` and `expires_in`, but sets no ceiling on either, so the values below are this client's
 * policy rather than an RFC rule: a grant that outlives a plausible human approval at another
 * machine is not worth holding a login open for. A grant the issuer would still honour past the
 * ceiling ends here: pending approval reports `expired_token`, while a final transport or server
 * failure retains its cause.
 */
const XAI_DEVICE_MIN_INTERVAL_MS = 1_000;
const XAI_DEVICE_MAX_TTL_S = 30 * 60;

interface XaiDeviceAuthorization {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
}

/** Coerce a provider-supplied seconds value to a finite, positive number, or undefined. */
function secondsToPositive(value: unknown): number | undefined {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Poll wait in ms: floored at 1s and capped at the grant lifetime.
 *
 * The lifetime cap is also the overflow guard. `setTimeout` stores its delay in a 32-bit signed
 * int, so anything above 2^31-1 ms fires on the next tick instead of waiting; a 30-minute ceiling
 * is 1.8e6 ms, three orders of magnitude below that, and the floor keeps a `0`, negative or
 * fractional `interval` from becoming a tight loop.
 */
function deviceIntervalMs(raw: unknown, ttlMs: number): number {
  const seconds = secondsToPositive(raw) ?? XAI_DEVICE_DEFAULT_INTERVAL_S;
  return Math.min(ttlMs, Math.max(XAI_DEVICE_MIN_INTERVAL_MS, Math.round(seconds * 1000)));
}

/** Grant lifetime in ms: defaulted when absent, capped so a login cannot run unbounded. */
function deviceGrantTtlMs(raw: unknown): number {
  const seconds = Math.min(secondsToPositive(raw) ?? XAI_DEVICE_DEFAULT_TTL_S, XAI_DEVICE_MAX_TTL_S);
  return Math.round(seconds * 1000);
}

/**
 * RFC 8628 device login, for a host whose browser cannot reach the 127.0.0.1:56121 callback:
 * the user opens the URL in any browser, confirms the short code, and this polls for the token.
 */
export async function loginXaiDevice(
  ctrl: OAuthController,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<OAuthCredentials> {
  const signal = ctrl.signal;
  const sleep = deps.sleep ?? ((ms: number) => sleepWithAbort(ms, signal));
  const discovery = await discoverXaiOAuthEndpoints(signal);
  if (!discovery.deviceAuthorizationEndpoint) {
    throw new Error("xAI OAuth discovery does not advertise device authorization");
  }
  let response: Response;
  try {
    response = await fetch(discovery.deviceAuthorizationEndpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }).toString(),
      // The request carries the client id in its body and lands on a vetted issuer; a redirect would
      // replay it somewhere `validateXaiEndpoint` never saw. Discovery already refused to produce a
      // non-x.ai endpoint, so a redirect here can only be a downgrade, never a legitimate hop.
      redirect: "error",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (isRedirectRefusal(error)) throw new XaiRedirectRefusedError();
    throw error;
  }
  if (!response.ok) throw await readTokenError(response);
  const device = (await response.json()) as XaiDeviceAuthorization;
  const verificationUri = typeof device.verification_uri_complete === "string"
    ? device.verification_uri_complete
    : device.verification_uri;
  if (
    typeof device.device_code !== "string" || !device.device_code
    || typeof device.user_code !== "string" || !device.user_code
    || typeof verificationUri !== "string"
  ) {
    throw new Error("xAI device authorization response is incomplete");
  }
  // Validate before the optional call: `onAuth?.(…)` skips evaluating its argument when unset.
  // `validateXaiEndpoint` parses the URL, which percent-encodes control characters out of the
  // path/query. The user code is kept exact here: `deviceCode` is structured data that every login
  // surface renders, and escaping belongs at the terminal boundary that prints it.
  const url = validateXaiEndpoint(verificationUri);
  ctrl.onAuth?.({
    url,
    instructions: `Open this URL in any browser and confirm the code ${device.user_code}.`,
    deviceCode: device.user_code,
  });
  // Both bounds come from the issuer, so both are clamped before they reach a timer: an oversized
  // `expires_in` would make `AbortSignal.timeout` and the deadline meaningless, and a tiny
  // `interval` would poll the auth endpoint in a tight loop.
  const ttlMs = deviceGrantTtlMs(device.expires_in);
  const deadline = Date.now() + ttlMs;
  let waitMs = deviceIntervalMs(device.interval, ttlMs);
  // Wait for the next iteration. `slow_down` raises the grant interval itself; a 429/5xx
  // `Retry-After` applies to the response that carried it, so it is held for one poll.
  let nextWaitMs = waitMs;
  let lastFailure: unknown;
  for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
    await sleep(Math.min(nextWaitMs, remaining));
    nextWaitMs = waitMs;
    const left = deadline - Date.now();
    if (left <= 0) break;
    // One request per interval, cut off at the grant deadline; the loop owns every retry.
    const pollSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left);
    try {
      const payload = await postXaiToken(
        discovery.tokenEndpoint,
        { grant_type: XAI_DEVICE_GRANT, client_id: XAI_OAUTH_CLIENT_ID, device_code: device.device_code },
        pollSignal,
        // The device code is a bearer-equivalent secret; it must not survive a redirect hop.
        { maxAttempts: 1, redirect: "error" },
      );
      return credentialsFromTokenPayload(payload);
    } catch (error) {
      if (signal?.aborted) throw error;
      // Checked before the retriable branches: it subclasses `XaiTokenRequestError` with no
      // status, which they would otherwise read as a transient network failure and poll on
      // until the grant expires.
      if (error instanceof XaiRedirectRefusedError) throw error;
      if (error instanceof XaiTokenRequestError) {
        if (error.oauthError === "slow_down") {
          lastFailure = error.status === 400 ? undefined : error;
          // RFC 8628 §3.5: lengthen the interval by 5s and never poll faster than before. Kept
          // under the same ceiling so the sleep cannot overflow into an immediate retry.
          waitMs = Math.min(ttlMs, waitMs + 5_000);
          nextWaitMs = Math.min(ttlMs, Math.max(waitMs, error.retryAfterMs ?? 0));
          continue;
        }
        // Still waiting for approval, or a network or server failure the grant can outlast.
        const status = error.status;
        if (error.oauthError === "authorization_pending" || status === undefined || status === 429 || status >= 500) {
          // Only an ordinary pending answer clears the cause; a 429/5xx carrying that body is still an outage.
          lastFailure = error.oauthError === "authorization_pending" && status === 400 ? undefined : error;
          // The server's own throttle wins over this client's interval, but never over the
          // grant deadline: the loop still sleeps at most what the grant has left.
          if (error.retryAfterMs !== undefined) nextWaitMs = Math.min(ttlMs, Math.max(waitMs, error.retryAfterMs));
          continue;
        }
        throw error;
      }
      // A timed-out poll (Bun reports it as TimeoutError or AbortError) is retried; the deadline still holds.
      const name = (error as { name?: string } | undefined)?.name;
      if (name === "TimeoutError" || name === "AbortError") { lastFailure = error; continue; }
      throw error;
    }
  }
  if (lastFailure) throw lastFailure;
  throw new XaiTokenRequestError(undefined, "expired_token", "xAI device authorization expired");
}

export async function loginXai(
  ctrl: OAuthController,
  opts?: { importLocal?: LocalTokenImportMode; device?: boolean },
): Promise<OAuthCredentials> {
  if (opts?.device) return loginXaiDevice(ctrl);
  const importLocal = opts?.importLocal ?? "off";
  if (importLocal !== "off") {
    const { detectGrokCliToken } = await import("./local-token-detect");
    const local = detectGrokCliToken();
    if (local) {
      ctrl.onProgress?.("Found Grok CLI token, importing automatically");
      if (local.expires >= Date.now() + 60_000) return local;
      try {
        const fresh = await refreshXaiToken(local.refresh, ctrl.signal);
        ctrl.onProgress?.(XAI_LOCAL_CLI_DETACH_WARNING);
        return { ...fresh, source: "oauth" };
      } catch (error) {
        if (importLocal === "only") {
          throw new Error(
            `Grok CLI token is expired and could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } else if (importLocal === "only") {
      throw new Error("No Grok CLI token found at ~/.grok/auth.json. Run 'ocx login xai' for browser OAuth.");
    }
  }

  return new XaiOAuthFlow(ctrl).login();
}

export async function refreshXaiToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  if (!refreshToken) {
    throw new Error("xAI credentials are expired and do not include a refresh token");
  }
  const discovery = await discoverXaiOAuthEndpoints(signal);
  const tokenPayload = await postXaiToken(
    discovery.tokenEndpoint,
    {
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    },
    signal,
  );
  return credentialsFromTokenPayload(tokenPayload, refreshToken);
}
