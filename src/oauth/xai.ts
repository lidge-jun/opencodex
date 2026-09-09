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
}

interface XaiDiscoveryPayload {
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
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
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json" },
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    throw new Error(`xAI OAuth discovery failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as XaiDiscoveryPayload;
  if (typeof payload.authorization_endpoint !== "string" || typeof payload.token_endpoint !== "string") {
    throw new Error("xAI OAuth discovery response missing authorization/token endpoints");
  }

  return {
    authorizationEndpoint: validateXaiEndpoint(payload.authorization_endpoint),
    tokenEndpoint: validateXaiEndpoint(payload.token_endpoint),
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

export class XaiTokenRequestError extends Error { constructor(public readonly status?:number,public readonly oauthError?:string,message="xAI token request failed",options?:{cause?:unknown}){super(message,options);this.name="XaiTokenRequestError";} }
export interface XaiTokenRetryDeps { sleep?:(ms:number)=>Promise<void>; random?:()=>number }
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
    const ms = Math.ceil(Number(text) * 1000);
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
async function readTokenError(response:Response):Promise<XaiTokenRequestError>{let oauthError:string|undefined,detail="";try{const body=await response.json() as {error?:unknown;error_description?:unknown};if(typeof body.error==="string")oauthError=body.error;if(typeof body.error_description==="string")detail=body.error_description;}catch{/* non-JSON error body: fall through to the generic message */}const suffix=detail?`: ${detail}`:oauthError?`: ${oauthError}`:"";return new XaiTokenRequestError(response.status,oauthError,`xAI token request failed: ${response.status}${suffix}`);}
export async function postXaiToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  signal?: AbortSignal, deps:XaiTokenRetryDeps={},
): Promise<XaiTokenPayload> {
 const sleep=deps.sleep??((ms:number)=>sleepWithAbort(ms,signal)),random=deps.random??Math.random;let last:unknown;
 for(let attempt=1;attempt<=3;attempt++){let response:Response;try{response=await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    signal: requestSignal(signal),
  });}catch(error){
  if(signal?.aborted)throw error;
  const name=(error as {name?:string}|undefined)?.name;
  if(name==="AbortError"||name==="TimeoutError")throw error;
  last=error;
  if(attempt===3)throw new XaiTokenRequestError(undefined,undefined,"xAI token request failed: network error",{cause:error});
  await sleepAbortable(jitterDelay(attempt,random),sleep,signal);
  continue;
  }if(response.ok)return await response.json() as XaiTokenPayload;const error=await readTokenError(response);last=error;if(!(response.status===429||response.status>=500)||attempt===3)throw error;if(signal?.aborted)throw error;const delay=retryDelay(attempt,response.headers.get("retry-after"),random);if(delay===undefined)throw error;await sleepAbortable(delay,sleep,signal);}throw last;
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

export async function loginXai(
  ctrl: OAuthController,
  opts?: { importLocal?: LocalTokenImportMode },
): Promise<OAuthCredentials> {
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
