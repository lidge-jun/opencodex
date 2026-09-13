# wp2 — device-authorization core

One new module plus the one type it needs. Nothing user-visible moves yet — `020` wires the
module into a login. Written to be executable as-is; deviations found while building are
amended here at wp3's P rather than left implicit.

**NEW** `src/oauth/meta-muse-device.ts`
**MODIFY** `src/oauth/types.ts` — the `muse` credential field
**MODIFY** `src/oauth/store.ts` — teach `normalizeCredential` about that field
**NEW** `tests/providers/meta-muse-device.test.ts` (specified in `040`)

> **Audit fold (A-phase, reviewer B1):** the type was originally scheduled for wp3, which
> does not compile. `loginMetaMuseDevice` returns an object literal typed as
> `OAuthCredentials`, so TypeScript's excess-property check rejects `muse` with TS2353
> until `src/oauth/types.ts` declares it. The field therefore lands in the same commit as
> the module, and `020` no longer owns it.

## `src/oauth/types.ts`

Add beside `KiroOAuthMetadata`, whose role this mirrors (`002` §A):

```ts
/**
 * Account-scoped Muse Code data that is NOT the request bearer.
 *
 * The Model API is authenticated by the `LLM|` key in `access`; this token authenticates
 * the Meta ACCOUNT and exists only to mint that key and to read subscription usage
 * (devlog/_plan/260912_muse_device_oauth/002 A). Keeping it out of `access` is what lets
 * every request path stay unchanged.
 *
 * It must never be added to `OAuthAccountSummary` (src/oauth/index.ts:1803) or to
 * `OAuthAccessSnapshot` (src/oauth/index.ts:85-100). Both are hand-built allowlists, and
 * that construction — not a redactor — is what keeps a secret out of a response.
 */
export interface MuseOAuthMetadata {
  /** Meta account access token from the device grant. Never sent to api.meta.ai/v1. */
  oauthAccessToken: string;
  /**
   * The stable Meta account id. Kept HERE rather than in `accountId` on purpose (wp2
   * audit fold W2): the store keys a slot on `accountId ?? email`, and this provider
   * import path has always supplied email only. Promoting `user_id` to `accountId` would
   * make a device login fail to match the row an imported login already created, giving
   * one human two accounts.
   */
  userId?: string;
  /** Epoch ms of the mint that produced the stored key. */
  mintedAt?: number;
  /** Subscription tier label as Meta reported it. Display only. */
  tierName?: string;
}
```

and on `OAuthCredentials`, directly after the `kiro` field:

```ts
  /** Never returned by management APIs; persisted only inside the protected auth-store boundary. */
  muse?: MuseOAuthMetadata;
```

## `src/oauth/store.ts`

> **wp2 audit fold W1 (blocker).** Declaring the type is not enough. `normalizeCredential`
> (`src/oauth/store.ts:447-500`) does not copy a credential, it REBUILDS one field by
> field, so any field it does not know about is silently dropped on persist. Without this
> change the device login would appear to succeed, the account token would never reach
> disk, and the whole on-demand quota capability in `030` would be dead with no error
> anywhere. Found by reading the function rather than by a type error, which is exactly
> why it matters: this failure has no compile-time signal.

Add after the `kiro` block, using the same cleaning discipline it established:

```ts
  if (candidate.muse && typeof candidate.muse === "object") {
    const muse = candidate.muse;
    const cleanMuse = (value: unknown, max: number): string | undefined => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed && trimmed.length <= max && !/[\x00-\x1f\x7f]/.test(trimmed) ? trimmed : undefined;
    };
    const oauthAccessToken = cleanMuse(muse.oauthAccessToken, 4096);
    const userId = cleanMuse(muse.userId, 128);
    const tierName = cleanMuse(muse.tierName, 128);
    const mintedAt = typeof muse.mintedAt === "number" && Number.isFinite(muse.mintedAt)
      ? muse.mintedAt
      : undefined;
    // oauthAccessToken is the only load-bearing member: without it there is nothing to
    // mint or probe with, and a row carrying only a tier label would be noise.
    if (oauthAccessToken) {
      normalized.muse = {
        oauthAccessToken,
        ...(userId ? { userId } : {}),
        ...(tierName ? { tierName } : {}),
        ...(mintedAt !== undefined ? { mintedAt } : {}),
      };
    }
  }
```

## Contract

```ts
loginMetaMuseDevice(ctrl: OAuthController, deps?: MuseDeviceDeps): Promise<OAuthCredentials>
```

Three network steps, each with its own error kind: device authorization, poll, mint. The
returned credential carries the `LLM|` key in `access`/`refresh` (unchanged bearer
contract, `002` §A) and the account token in `muse.oauthAccessToken`.

`sleep` and `now` are injected. That is the difference between testing eight poll
branches in milliseconds and paying real seconds per branch the way
`tests/oauth/chatgpt-device-auth.test.ts:102-113` currently must.

## File body

```ts
/**
 * Meta Muse Code device-authorization login.
 *
 * `./meta-muse` imports the credential the vendor's CLI already minted. This module
 * produces one: Meta's OIDC device grant, then the subscription key mint that turns the
 * resulting account token into the `LLM|` Model API key our request path sends as a
 * bearer.
 *
 * Protocol source: devlog/_plan/260912_muse_device_oauth/001_reference_measurements.md.
 * It is second-party, not vendor documentation, so every response is parsed defensively
 * and every failure names a kind instead of throwing a bare string.
 *
 * Two properties are load-bearing and easy to lose in a later edit:
 *
 * 1. NO RESPONSE BODY REACHES AN ERROR MESSAGE. These endpoints can echo request
 *    material, the mint response literally contains the API key, and these messages reach
 *    CLI output, the dashboard and issue reports. Status codes only — the same discipline
 *    as `deviceError` in ./chatgpt-device.
 * 2. THE ACCOUNT TOKEN IS NOT A BEARER FOR THE MODEL API. Measured 2026-09-03: it 401s
 *    with `invalid_api_key` while the sibling key returns 200
 *    (devlog/_fin/260903_muse_spark_plan_oauth/003 §B). It exists here only to mint and
 *    to read subscription usage.
 */
import type { OAuthController, OAuthCredentials } from "./types";
import { sanitizeApiKeyValue } from "../providers/api-keys";

/** Meta's own Muse Code client. Public in its device-approval URL; not a secret. */
const CLIENT_ID = "1031625952748946";
const DEVICE_AUTHORIZATION_URL = "https://auth.meta.com/oidc/device/authorization/";
const DEVICE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const API_VERSION = "1.0.0";

/** Shown when the response omits a verification URI. Observed 2026-09-03 from `muse login`. */
const VERIFICATION_FALLBACK_URL = "https://auth.meta.com/oauth/device/";

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_FLOW_TTL_MS = 15 * 60_000;
/** A hostile or corrupt `expires_in` must not park a login for hours. */
const MAX_FLOW_TTL_MS = 30 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Floor: a zero or string interval would otherwise hot-loop an auth endpoint. */
const MIN_POLL_INTERVAL_MS = 1_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;

export type MuseDeviceErrorKind =
  | "device-authorization"
  | "device-token"
  | "device-denied"
  | "device-expired"
  | "cancelled"
  | "mint-http"
  | "mint-rate-limited"
  | "mint-invalid"
  | "subscription-inactive"
  | "entitlement-required"
  | "missing-api-key"
  | "missing-identity";

export class MuseDeviceLoginError extends Error {
  readonly kind: MuseDeviceErrorKind;
  readonly status?: number;
  /** Where the user resolves an entitlement problem. Vendor-supplied, never a local path. */
  readonly actionUrl?: string;
  readonly retryAfterMs?: number;
  constructor(
    kind: MuseDeviceErrorKind,
    message: string,
    extra: { status?: number; actionUrl?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    // Set here rather than as a class field, matching src/oauth/nous.ts:160 and :383.
    this.name = "MuseDeviceLoginError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.actionUrl !== undefined) this.actionUrl = extra.actionUrl;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

/** Injected so tests never touch the network or a real clock. */
export interface MuseDeviceDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface MuseDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalMs: number;
  expiresAtMs: number;
}

export interface MuseKeyPayload {
  apiKey?: string;
  requirePayment?: boolean;
  actionUrl?: string;
  userEmail?: string;
  userId?: string;
  isSubsActive?: boolean;
  subsTierName?: string;
  /** Raw `subs_usage` object, api_key-free by construction. Parsed by muse-key-quota. */
  subsUsage?: Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Upstream may send `interval` as a number or a string. A string reaches `setTimeout` as
 * 0 and turns the poll into a hot loop, so coerce, floor and cap it.
 */
function normalizeIntervalMs(raw: unknown): number {
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.round(seconds * 1000)));
}

function normalizeTtlMs(raw: unknown): number {
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_FLOW_TTL_MS;
  return Math.min(MAX_FLOW_TTL_MS, Math.round(seconds * 1000));
}

/** RFC 7231 `Retry-After`: delta-seconds or an HTTP date. Clamped to the poll ceiling. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  const raw = text(header ?? undefined);
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_POLL_INTERVAL_MS, Math.round(seconds * 1000));
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(0, at - now));
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelled();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelled(): MuseDeviceLoginError {
  return new MuseDeviceLoginError("cancelled", "Muse Code login cancelled");
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Step 1: ask Meta for a user code. */
export async function requestMuseDeviceAuthorization(
  deps: MuseDeviceDeps = {},
  signal?: AbortSignal,
): Promise<MuseDeviceAuthorization> {
  const now = deps.now ?? Date.now;
  const response = await (deps.fetchImpl ?? fetch)(DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-api-version": API_VERSION,
    },
    body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    throw new MuseDeviceLoginError(
      "device-authorization",
      `Muse Code device authorization request failed: HTTP ${response.status}`,
      { status: response.status },
    );
  }
  const payload = record(await response.json().catch(() => undefined));
  const deviceCode = text(payload?.device_code);
  const userCode = text(payload?.user_code);
  if (!deviceCode || !userCode) {
    throw new MuseDeviceLoginError(
      "device-authorization",
      "Muse Code device authorization response is missing the device or user code",
      { status: response.status },
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUri: text(payload?.verification_uri) ?? VERIFICATION_FALLBACK_URL,
    ...(text(payload?.verification_uri_complete)
      ? { verificationUriComplete: text(payload?.verification_uri_complete) as string }
      : {}),
    intervalMs: normalizeIntervalMs(payload?.interval),
    expiresAtMs: now() + normalizeTtlMs(payload?.expires_in),
  };
}

/**
 * Step 2: poll until approval.
 *
 * RFC 8628 signals state with an `error` code in a non-2xx body, so the CODE decides, not
 * the status. An unrecognized code is terminal: retrying a permanent failure just hammers
 * an auth endpoint until the grant expires. A 429 is treated as `slow_down` with
 * `Retry-After` honoured, because that is what it means here.
 */
export async function pollMuseDeviceToken(
  authorization: MuseDeviceAuthorization,
  deps: MuseDeviceDeps = {},
  signal?: AbortSignal,
): Promise<string> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  let intervalMs = authorization.intervalMs;
  while (true) {
    if (signal?.aborted) throw cancelled();
    // [W4] Poll FIRST, then decide whether there is time to sleep again. The previous
    // shape checked the deadline at the top, so a sleep ending exactly at the deadline
    // skipped the final poll and discarded an approval the user had already completed
    // inside that window.
    const response = await (deps.fetchImpl ?? fetch)(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "x-api-version": API_VERSION,
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: authorization.deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }).toString(),
      redirect: "error",
      signal: requestSignal(signal),
    });
    const payload = record(await response.json().catch(() => undefined));
    if (response.ok) {
      // [W3] No deadline re-check here. If Meta answered 200 with a token, Meta accepted
      // the device code; its clock is authoritative and ours is not. Discarding an issued
      // token because a local deadline just passed would force the user to redo an
      // approval that already succeeded.
      const accessToken = text(payload?.access_token);
      if (!accessToken) {
        throw new MuseDeviceLoginError(
          "device-token",
          "Muse Code device token response is missing an access token",
          { status: response.status },
        );
      }
      return accessToken;
    }
    const code = text(payload?.error)?.toLowerCase();
    if (code === "access_denied") {
      throw new MuseDeviceLoginError("device-denied", "Muse Code login was denied in the browser", {
        status: response.status,
      });
    }
    if (code === "expired_token") {
      throw new MuseDeviceLoginError("device-expired", "Muse Code device code expired; start the login again", {
        status: response.status,
      });
    }
    if (code === "slow_down" || response.status === 429) {
      const advised = retryAfterMs(response.headers.get("retry-after"), now());
      intervalMs = Math.min(
        MAX_POLL_INTERVAL_MS,
        Math.max(advised ?? 0, intervalMs + SLOW_DOWN_INCREMENT_MS),
      );
    } else if (code !== "authorization_pending") {
      throw new MuseDeviceLoginError(
        "device-token",
        `Muse Code device token poll failed: HTTP ${response.status}`,
        { status: response.status },
      );
    }
    // [W4] The deadline is checked ONLY here, before sleeping. Reaching it means the
    // grant is spent: the loop has just polled and been told to wait longer than the
    // grant has left. Never sleep past it, which is how a 15-minute grant becomes a
    // 20-minute wait.
    const remaining = authorization.expiresAtMs - now();
    if (remaining <= 0) {
      throw new MuseDeviceLoginError("device-expired", "Muse Code device authorization expired before approval");
    }
    await sleep(Math.min(intervalMs, remaining), signal);
  }
}

/**
 * Step 3: mint the subscription key.
 *
 * `onboard` is sent only during an interactive login. Meta's key endpoint is rate-limited
 * and returns the SAME key for an account, so any caller that already holds one must not
 * come back here (`020` enforces that on refresh; `030` reuses this function read-only).
 */
export async function mintMuseApiKey(
  accountAccessToken: string,
  options: { onboard?: boolean } = {},
  deps: MuseDeviceDeps = {},
  signal?: AbortSignal,
): Promise<MuseKeyPayload> {
  const now = deps.now ?? Date.now;
  const response = await (deps.fetchImpl ?? fetch)(MUSE_KEY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accountAccessToken}`,
      "Content-Type": "application/json",
      "x-api-version": API_VERSION,
    },
    body: JSON.stringify(options.onboard ? { onboard: true } : {}),
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (response.status === 429) {
    const wait = retryAfterMs(response.headers.get("retry-after"), now());
    throw new MuseDeviceLoginError(
      "mint-rate-limited",
      wait === undefined
        ? "Meta rate-limited the Muse Code key request; wait a minute and retry"
        : `Meta rate-limited the Muse Code key request; retry in about ${Math.ceil(wait / 1000)}s`,
      { status: 429, ...(wait === undefined ? {} : { retryAfterMs: wait }) },
    );
  }
  if (!response.ok) {
    // Status only. The body of this endpoint can carry the key itself.
    throw new MuseDeviceLoginError(
      "mint-http",
      `Muse Code key exchange failed: HTTP ${response.status}`,
      { status: response.status },
    );
  }
  const payload = record(await response.json().catch(() => undefined));
  if (!payload) {
    throw new MuseDeviceLoginError("mint-invalid", "Muse Code key exchange returned an unreadable response", {
      status: response.status,
    });
  }
  return {
    ...(text(payload.api_key) ? { apiKey: text(payload.api_key) as string } : {}),
    ...(typeof payload.require_payment === "boolean" ? { requirePayment: payload.require_payment } : {}),
    ...(text(payload.action_url) ?? text(payload.require_payment_action_url)
      ? { actionUrl: (text(payload.action_url) ?? text(payload.require_payment_action_url)) as string }
      : {}),
    ...(text(payload.user_email) ? { userEmail: (text(payload.user_email) as string).toLowerCase() } : {}),
    ...(text(payload.user_id) ? { userId: text(payload.user_id) as string } : {}),
    ...(typeof payload.is_subs_active === "boolean" ? { isSubsActive: payload.is_subs_active } : {}),
    ...(text(payload.subs_tier_name) ? { subsTierName: text(payload.subs_tier_name) as string } : {}),
    ...(record(payload.subs_usage) ? { subsUsage: record(payload.subs_usage) as Record<string, unknown> } : {}),
  };
}

/**
 * Turn a mint payload into the error it deserves, or return the validated key.
 *
 * Four distinct outcomes the reference collapses into fewer: an inactive subscription is
 * not a missing key, a payment requirement is not an auth failure, and a key that fails
 * the `LLM|` grammar is not a server error.
 */
export function museApiKeyFromPayload(payload: MuseKeyPayload): string {
  if (payload.isSubsActive === false) {
    throw new MuseDeviceLoginError(
      "subscription-inactive",
      "This Meta account has no active Muse Code subscription. Subscribe at https://dev.meta.ai, then log in again.",
      { status: 403 },
    );
  }
  const apiKey = sanitizeApiKeyValue(payload.apiKey);
  if (!apiKey) {
    if (payload.requirePayment === true || payload.actionUrl) {
      throw new MuseDeviceLoginError(
        "entitlement-required",
        payload.actionUrl
          ? `Meta requires a subscription or payment method before it will issue a Muse Code key: ${payload.actionUrl}`
          : "Meta requires a subscription or payment method before it will issue a Muse Code key.",
        { ...(payload.actionUrl ? { actionUrl: payload.actionUrl } : {}) },
      );
    }
    throw new MuseDeviceLoginError("missing-api-key", "Meta returned no Muse Code API key for this account");
  }
  if (!/^LLM\|\d+\|[A-Za-z0-9_-]{10,}$/.test(apiKey)) {
    throw new MuseDeviceLoginError(
      "mint-invalid",
      "Meta returned a Muse Code key in an unexpected format; log in again",
    );
  }
  return apiKey;
}

/** Run the whole grant. */
export async function loginMetaMuseDevice(
  ctrl: OAuthController = {},
  deps: MuseDeviceDeps = {},
): Promise<OAuthCredentials> {
  const authorization = await requestMuseDeviceAuthorization(deps, ctrl.signal);
  ctrl.onAuth?.({
    url: authorization.verificationUriComplete ?? authorization.verificationUri,
    instructions: `Enter code: ${authorization.userCode}`,
    deviceCode: authorization.userCode,
  });
  const accountAccessToken = await pollMuseDeviceToken(authorization, deps, ctrl.signal);
  ctrl.onProgress?.("Approved. Requesting the Muse Code subscription key...");
  const payload = await mintMuseApiKey(accountAccessToken, { onboard: true }, deps, ctrl.signal);
  const apiKey = museApiKeyFromPayload(payload);
  if (payload.requirePayment === true || payload.actionUrl) {
    // [W5] A usable key AND a payment signal. Meta issued a credential but is saying the
    // plan does not cover it. The key is returned, because refusing a working credential
    // would be worse, but the warning is not swallowed: this is the difference between a
    // user who knows calls may be billed per token and one who finds out on an invoice.
    ctrl.onProgress?.(payload.actionUrl
      ? `Meta reports this account needs a subscription or payment method: ${payload.actionUrl}`
      : "Meta reports this account needs a subscription or payment method; treat every call as billable.");
  }
  const email = payload.userEmail;
  // [W2] email FIRST, user_id only as a fallback. The store keys a slot on
  // `accountId ?? email` (src/oauth/store.ts:744,752), and this provider import path has
  // always supplied email alone, so promoting user_id to accountId here would make a
  // device login MISS the row an imported login already created and hand one human two
  // accounts. user_id is still retained, in muse.userId, where it identifies the account
  // for the quota probe without participating in slot identity.
  if (!email && !payload.userId) {
    throw new MuseDeviceLoginError(
      "missing-identity",
      "Meta returned no stable account identity for this Muse Code key",
    );
  }
  return {
    access: apiKey,
    // Static key: there is nothing to exchange, so refresh carries the same value. Meta
    // rejects refresh_token grants on this client (001 §A).
    refresh: apiKey,
    expires: Number.MAX_SAFE_INTEGER,
    ...(email ? { email } : { accountId: payload.userId as string }),
    source: "oauth",
    muse: {
      oauthAccessToken: accountAccessToken,
      ...(payload.userId ? { userId: payload.userId } : {}),
      mintedAt: (deps.now ?? Date.now)(),
      ...(payload.subsTierName ? { tierName: payload.subsTierName } : {}),
    },
  };
}
```

## Why each guard exists

| Guard | Failure it prevents |
|---|---|
| `normalizeIntervalMs` floor and cap | A string or `0` interval hot-looping `auth.meta.com`; a huge value parking the login |
| `normalizeTtlMs` cap at 30 min | A corrupt `expires_in` holding a poll loop open indefinitely |
| Deadline re-check after a successful poll | Accepting a token minted against a code that expired mid-flight |
| `Math.min(intervalMs, remaining)` | Sleeping past the grant's own deadline |
| Unknown error code is terminal | Polling a permanently failing endpoint until expiry |
| Status-only error text | Reflecting a response body that can contain the API key |
| `redirect: "error"` | Forwarding an `Authorization` header to a redirect target |
| `LLM|` grammar check | Persisting a value that will 401 on first use, the same check the import path applies |

## Out of scope for wp2

No registration, no credential persistence, no header change, no quota work. `src/oauth/index.ts`
is untouched until `020`, so this module is unreachable from a user action at the end of
this phase — which is the point: it is testable in isolation first.

## wp2 P re-verification (stale check)

Re-verified against HEAD `7136e45a45` before building. The tree has not moved since the
roadmap was written — wp1 changed no source file — so every insertion point below still
holds. Confirmed individually:

| Claim | State at HEAD |
|---|---|
| `OAuthCredentials` ends with `kiro?: KiroOAuthMetadata;` and that is where `muse` goes | Confirmed, `src/oauth/types.ts:43-45` |
| `sanitizeApiKeyValue(value: unknown): string | undefined` | Confirmed, `src/providers/api-keys.ts:47-51` |
| `"oauth"` is a legal `OAuthCredentialSource` | Confirmed, `src/oauth/types.ts:2` |
| The `LLM|` grammar matches the import path character for character | Confirmed, `src/oauth/meta-muse.ts:270` |
| `AbortSignal.any([signal, timeout])` is the local idiom | Confirmed, `src/oauth/nous.ts:399`, `src/oauth/kiro.ts:546` |
| Test fetch fakes stub `globalThis.fetch` and route by URL | Confirmed, `tests/oauth/chatgpt-device-auth.test.ts:50-87` |

No amendment was needed. One addition to the build order, from the wp1 audit: the type and
the module land in the SAME commit, because the module cannot compile without the type.
