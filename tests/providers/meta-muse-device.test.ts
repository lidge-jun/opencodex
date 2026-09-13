/**
 * Muse Code device-authorization login.
 *
 * Every test injects fetchImpl, sleep and now, so no test touches the network, a real
 * timer or a real clock. That is the difference from tests/oauth/chatgpt-device-auth.test.ts,
 * which pays real seconds to prove the poll interval is honoured (its own comment at
 * :102-113 explains why): here the interval is asserted from the recorded sleep arguments.
 */
import { describe, expect, test } from "bun:test";
import {
  MuseDeviceLoginError,
  loginMetaMuseDevice,
  mintMuseApiKey,
  museApiKeyFromPayload,
  pollMuseDeviceToken,
  requestMuseDeviceAuthorization,
  type MuseDeviceDeps,
} from "../../src/oauth/meta-muse-device";
import { getCredential, saveCredential } from "../../src/oauth/store";

const DEVICE_AUTH = "https://auth.meta.com/oidc/device/authorization/";
const DEVICE_TOKEN = "https://auth.meta.com/oidc/device/token/";
const MINT = "https://api.meta.ai/muse-code/key";

/** Synthetic, matches the LLM| grammar the import path enforces. */
const KEY = `LLM|${"1".repeat(16)}|${"c".repeat(27)}`;
const ACCOUNT_TOKEN = "meta-account-" + "z".repeat(48);
/** If this string ever reaches an error message, a response body leaked into one. */
const BODY_CANARY = "canary-body-must-never-appear-in-an-error";

interface Reply { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }
interface Scenario {
  auth?: Reply;
  tokens?: Reply[];
  mint?: Reply;
}

const AUTH_OK = {
  device_code: "device-code-opaque",
  user_code: "ABCD-EFGH",
  verification_uri: "https://auth.meta.com/oauth/device/",
  verification_uri_complete: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
  interval: 5,
  expires_in: 900,
};
const MINT_OK = { api_key: KEY, user_id: "meta-user-1", user_email: "Someone@Example.COM", is_subs_active: true };

function reply(r: Reply | undefined, fallbackBody: unknown): Response {
  const status = r?.status ?? 200;
  const body = r?.text !== undefined ? r.text : JSON.stringify(r?.body ?? fallbackBody);
  return new Response(body, { status, headers: { "content-type": "application/json", ...(r?.headers ?? {}) } });
}

function harness(s: Scenario = {}) {
  const calls = { auth: 0, token: 0, mint: 0 };
  const bodies: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const sleeps: number[] = [];
  let clock = 1_700_000_000_000;
  let tokenIndex = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (typeof init?.body === "string") bodies.push(init.body);
    headers.push({ ...(init?.headers as Record<string, string> | undefined) });
    if (url === DEVICE_AUTH) { calls.auth += 1; return reply(s.auth, AUTH_OK); }
    if (url === DEVICE_TOKEN) {
      calls.token += 1;
      const list = s.tokens ?? [{ body: { access_token: ACCOUNT_TOKEN } }];
      const r = list[Math.min(tokenIndex, list.length - 1)];
      tokenIndex += 1;
      return reply(r, { access_token: ACCOUNT_TOKEN });
    }
    if (url === MINT) { calls.mint += 1; return reply(s.mint, MINT_OK); }
    throw new Error("unexpected fetch: " + url);
  }) as unknown as typeof fetch;
  const deps: MuseDeviceDeps = {
    fetchImpl,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  };
  return { deps, calls, bodies, headers, sleeps, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

async function caught(fn: () => Promise<unknown>): Promise<MuseDeviceLoginError> {
  try { await fn(); } catch (error) {
    if (error instanceof MuseDeviceLoginError) return error;
    throw error;
  }
  throw new Error("expected a MuseDeviceLoginError, got success");
}

describe("muse device authorization", () => {
  test("sends the Meta client id and the api version header", async () => {
    const h = harness();
    const auth = await requestMuseDeviceAuthorization(h.deps);
    expect(h.bodies[0]).toContain("client_id=1031625952748946");
    expect(h.headers[0]?.["x-api-version"]).toBe("1.0.0");
    expect(auth.userCode).toBe("ABCD-EFGH");
    expect(auth.deviceCode).toBe("device-code-opaque");
    expect(auth.intervalMs).toBe(5_000);
    expect(auth.expiresAtMs).toBe(h.now() + 900_000);
  });

  test("falls back to the observed verification url when the response omits one", async () => {
    const h = harness({ auth: { body: { device_code: "d", user_code: "U" } } });
    const auth = await requestMuseDeviceAuthorization(h.deps);
    expect(auth.verificationUri).toBe("https://auth.meta.com/oauth/device/");
    expect(auth.intervalMs).toBe(5_000);
  });

  test("a string interval is coerced and floored, never left to hot-loop", async () => {
    const h = harness({ auth: { body: { ...AUTH_OK, interval: "0.001" } } });
    expect((await requestMuseDeviceAuthorization(h.deps)).intervalMs).toBe(1_000);
  });

  test("a hostile expires_in is capped at thirty minutes", async () => {
    const h = harness({ auth: { body: { ...AUTH_OK, expires_in: 999_999 } } });
    const auth = await requestMuseDeviceAuthorization(h.deps);
    expect(auth.expiresAtMs).toBe(h.now() + 30 * 60_000);
  });

  test("a missing device code is a named failure", async () => {
    const h = harness({ auth: { body: { user_code: "U" } } });
    const error = await caught(() => requestMuseDeviceAuthorization(h.deps));
    expect(error.kind).toBe("device-authorization");
  });

  test("a failed authorization reports the status and never the body", async () => {
    const h = harness({ auth: { status: 500, text: BODY_CANARY } });
    const error = await caught(() => requestMuseDeviceAuthorization(h.deps));
    expect(error.kind).toBe("device-authorization");
    expect(error.message).toContain("500");
    expect(error.message).not.toContain(BODY_CANARY);
  });
});

describe("muse device poll", () => {
  async function poll(s: Scenario, opts: { signal?: AbortSignal } = {}) {
    const h = harness(s);
    const auth = await requestMuseDeviceAuthorization(h.deps);
    const token = await pollMuseDeviceToken(auth, h.deps, opts.signal);
    return { h, token };
  }

  test("keeps polling through authorization_pending and honours the interval", async () => {
    const { h, token } = await poll({ tokens: [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      { body: { access_token: ACCOUNT_TOKEN } },
    ] });
    expect(token).toBe(ACCOUNT_TOKEN);
    expect(h.calls.token).toBe(3);
    expect(h.sleeps).toEqual([5_000, 5_000]);
  });

  test("slow_down grows the interval monotonically", async () => {
    const { h } = await poll({ tokens: [
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "slow_down" } },
      { body: { access_token: ACCOUNT_TOKEN } },
    ] });
    expect(h.sleeps).toEqual([10_000, 15_000]);
  });

  test("a 429 is treated as slow_down and honours Retry-After", async () => {
    const { h } = await poll({ tokens: [
      { status: 429, body: {}, headers: { "retry-after": "12" } },
      { body: { access_token: ACCOUNT_TOKEN } },
    ] });
    expect(h.sleeps).toEqual([12_000]);
  });

  test("an absurd Retry-After is clamped to the poll ceiling", async () => {
    const { h } = await poll({ tokens: [
      { status: 429, body: {}, headers: { "retry-after": "99999" } },
      { body: { access_token: ACCOUNT_TOKEN } },
    ] });
    expect(h.sleeps).toEqual([60_000]);
  });

  test("a small Retry-After cannot shrink the interval below the increment", async () => {
    const { h } = await poll({ tokens: [
      { status: 429, body: {}, headers: { "retry-after": "1" } },
      { body: { access_token: ACCOUNT_TOKEN } },
    ] });
    expect(h.sleeps).toEqual([10_000]);
  });

  test("access_denied and expired_token are distinct terminal failures", async () => {
    const denied = await caught(() => poll({ tokens: [{ status: 400, body: { error: "access_denied" } }] }));
    expect(denied.kind).toBe("device-denied");
    const expired = await caught(() => poll({ tokens: [{ status: 400, body: { error: "expired_token" } }] }));
    expect(expired.kind).toBe("device-expired");
  });

  test("an unrecognised error code stops instead of hammering the endpoint", async () => {
    const h = harness({ tokens: [{ status: 400, body: { error: "invalid_client" } }] });
    const auth = await requestMuseDeviceAuthorization(h.deps);
    const error = await caught(() => pollMuseDeviceToken(auth, h.deps));
    expect(error.kind).toBe("device-token");
    expect(h.calls.token).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  test("a non-2xx with no readable body is terminal, not pending", async () => {
    const h = harness({ tokens: [{ status: 503, text: BODY_CANARY }] });
    const auth = await requestMuseDeviceAuthorization(h.deps);
    const error = await caught(() => pollMuseDeviceToken(auth, h.deps));
    expect(error.kind).toBe("device-token");
    expect(h.calls.token).toBe(1);
    expect(error.message).toContain("503");
    expect(error.message).not.toContain(BODY_CANARY);
  });

  test("a 200 without an access token is a protocol failure", async () => {
    const error = await caught(() => poll({ tokens: [{ body: { token_type: "bearer" } }] }));
    expect(error.kind).toBe("device-token");
  });

  // W4 and W3 together: the last seconds of a grant must still be polled, and a token
  // the server issued in that window must not be thrown away by a local clock.
  test("polls once more inside the final seconds and accepts a late token", async () => {
    const h = harness({
      auth: { body: { ...AUTH_OK, expires_in: 3 } },
      tokens: [{ status: 400, body: { error: "authorization_pending" } }, { body: { access_token: ACCOUNT_TOKEN } }],
    });
    const auth = await requestMuseDeviceAuthorization(h.deps);
    const token = await pollMuseDeviceToken(auth, h.deps);
    expect(h.sleeps).toEqual([3_000]);
    expect(h.calls.token).toBe(2);
    expect(token).toBe(ACCOUNT_TOKEN);
  });

  test("expires only after a poll that still says pending with no time left", async () => {
    const h = harness({
      auth: { body: { ...AUTH_OK, expires_in: 3 } },
      tokens: [{ status: 400, body: { error: "authorization_pending" } }],
    });
    const auth = await requestMuseDeviceAuthorization(h.deps);
    const error = await caught(() => pollMuseDeviceToken(auth, h.deps));
    expect(error.kind).toBe("device-expired");
    expect(h.calls.token).toBe(2);
  });

  test("an aborted controller cancels instead of polling", async () => {
    const h = harness();
    const auth = await requestMuseDeviceAuthorization(h.deps);
    const ac = new AbortController();
    ac.abort();
    const error = await caught(() => pollMuseDeviceToken(auth, h.deps, ac.signal));
    expect(error.kind).toBe("cancelled");
    expect(h.calls.token).toBe(0);
  });
});

describe("muse key mint", () => {
  test("asks Meta to onboard during a login and sends the account bearer", async () => {
    const h = harness();
    await mintMuseApiKey(ACCOUNT_TOKEN, { onboard: true }, h.deps);
    expect(h.bodies[0]).toBe(JSON.stringify({ onboard: true }));
    expect(h.headers[0]?.Authorization).toBe("Bearer " + ACCOUNT_TOKEN);
    expect(h.headers[0]?.["x-api-version"]).toBe("1.0.0");
  });

  test("omits onboard when it is only reading", async () => {
    const h = harness();
    await mintMuseApiKey(ACCOUNT_TOKEN, {}, h.deps);
    expect(h.bodies[0]).toBe("{}");
  });

  test("a rate limit names the wait and carries it structurally", async () => {
    const h = harness({ mint: { status: 429, body: {}, headers: { "retry-after": "30" } } });
    const error = await caught(() => mintMuseApiKey(ACCOUNT_TOKEN, {}, h.deps));
    expect(error.kind).toBe("mint-rate-limited");
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.message).toContain("30s");
  });

  test("a failed mint reports the status and never the body", async () => {
    const h = harness({ mint: { status: 502, text: BODY_CANARY } });
    const error = await caught(() => mintMuseApiKey(ACCOUNT_TOKEN, {}, h.deps));
    expect(error.kind).toBe("mint-http");
    expect(error.message).toContain("502");
    expect(error.message).not.toContain(BODY_CANARY);
  });

  test("lowercases the email and keeps the usage object", async () => {
    const h = harness({ mint: { body: { ...MINT_OK, subs_usage: { weekly: { used_percent: 4 } } } } });
    const payload = await mintMuseApiKey(ACCOUNT_TOKEN, {}, h.deps);
    expect(payload.userEmail).toBe("someone@example.com");
    expect(payload.subsUsage).toEqual({ weekly: { used_percent: 4 } });
  });
});

describe("muse mint payload classification", () => {
  test("an inactive subscription is not reported as a missing key", () => {
    const error = (() => { try { museApiKeyFromPayload({ isSubsActive: false, apiKey: KEY }); } catch (e) { return e as MuseDeviceLoginError; } throw new Error("expected throw"); })();
    expect(error.kind).toBe("subscription-inactive");
  });

  test("a payment requirement carries Metas own action url", () => {
    const error = (() => { try { museApiKeyFromPayload({ requirePayment: true, actionUrl: "https://dev.meta.ai/billing" }); } catch (e) { return e as MuseDeviceLoginError; } throw new Error("expected throw"); })();
    expect(error.kind).toBe("entitlement-required");
    expect(error.actionUrl).toBe("https://dev.meta.ai/billing");
    expect(error.message).toContain("https://dev.meta.ai/billing");
  });

  test("a missing key with no payment signal is its own failure", () => {
    const error = (() => { try { museApiKeyFromPayload({}); } catch (e) { return e as MuseDeviceLoginError; } throw new Error("expected throw"); })();
    expect(error.kind).toBe("missing-api-key");
  });

  test("a key in the wrong format is rejected before it is stored", () => {
    const error = (() => { try { museApiKeyFromPayload({ apiKey: "not-a-meta-key" }); } catch (e) { return e as MuseDeviceLoginError; } throw new Error("expected throw"); })();
    expect(error.kind).toBe("mint-invalid");
  });

  test("a valid key passes through unchanged", () => {
    expect(museApiKeyFromPayload({ apiKey: KEY, isSubsActive: true })).toBe(KEY);
  });
});

describe("muse device login", () => {
  test("returns the minted key as the bearer and keeps the account token beside it", async () => {
    const h = harness();
    const seen: Array<{ url: string; deviceCode?: string; instructions?: string }> = [];
    const creds = await loginMetaMuseDevice({ onAuth: info => seen.push(info) }, h.deps);
    expect(creds.access).toBe(KEY);
    expect(creds.refresh).toBe(KEY);
    expect(creds.expires).toBe(Number.MAX_SAFE_INTEGER);
    expect(creds.source).toBe("oauth");
    expect(creds.email).toBe("someone@example.com");
    expect(creds.muse?.oauthAccessToken).toBe(ACCOUNT_TOKEN);
    expect(creds.muse?.userId).toBe("meta-user-1");
    expect(creds.muse?.mintedAt).toBe(h.now());
    expect(seen[0]?.deviceCode).toBe("ABCD-EFGH");
    expect(seen[0]?.url).toContain("auth.meta.com/oauth/device/");
  });

  // The separation invariant from 002 A. If a later refactor adopts a packed-JSON bearer,
  // this fails: the request path sends creds.access verbatim as an Authorization header.
  test("the bearer is a plain key, never a container holding the account token", async () => {
    const h = harness();
    const creds = await loginMetaMuseDevice({}, h.deps);
    expect(creds.access).not.toContain(ACCOUNT_TOKEN);
    expect(creds.refresh).not.toContain(ACCOUNT_TOKEN);
    expect(() => JSON.parse(creds.access)).toThrow();
  });

  // W2: slot identity. The store matches accountId ?? email, and the import path stores
  // email alone, so an email-bearing device login must not introduce an accountId.
  test("keys the slot on email when Meta supplies one", async () => {
    const h = harness();
    const creds = await loginMetaMuseDevice({}, h.deps);
    expect(creds.email).toBe("someone@example.com");
    expect(creds.accountId).toBeUndefined();
  });

  test("falls back to the user id only when there is no email", async () => {
    const h = harness({ mint: { body: { api_key: KEY, user_id: "meta-user-2" } } });
    const creds = await loginMetaMuseDevice({}, h.deps);
    expect(creds.accountId).toBe("meta-user-2");
    expect(creds.email).toBeUndefined();
    expect(creds.muse?.userId).toBe("meta-user-2");
  });

  test("refuses a response with no identity at all", async () => {
    const h = harness({ mint: { body: { api_key: KEY } } });
    const error = await caught(() => loginMetaMuseDevice({}, h.deps));
    expect(error.kind).toBe("missing-identity");
  });

  // W5: a usable key plus a payment signal is accepted, but the user is told.
  test("warns about billing when Meta issues a key and still asks for payment", async () => {
    const h = harness({ mint: { body: { ...MINT_OK, require_payment: true, action_url: "https://dev.meta.ai/billing" } } });
    const progress: string[] = [];
    const creds = await loginMetaMuseDevice({ onProgress: m => progress.push(m) }, h.deps);
    expect(creds.access).toBe(KEY);
    expect(progress.join(" ")).toContain("https://dev.meta.ai/billing");
  });
});

// W1: the failure with no compile-time signal. normalizeCredential rebuilds a credential
// field by field, so a field the store does not know about is dropped on persist and the
// login still looks successful. tests/preload.ts sandboxes HOME, so this writes nothing real.
describe("muse credential persistence", () => {
  test("the account token survives a store round trip", async () => {
    await saveCredential("meta-muse", {
      access: KEY,
      refresh: KEY,
      expires: Number.MAX_SAFE_INTEGER,
      email: "someone@example.com",
      source: "oauth",
      muse: { oauthAccessToken: ACCOUNT_TOKEN, userId: "meta-user-1", mintedAt: 1_700_000_000_000, tierName: "Muse Pro" },
    });
    const stored = getCredential("meta-muse");
    expect(stored?.muse?.oauthAccessToken).toBe(ACCOUNT_TOKEN);
    expect(stored?.muse?.userId).toBe("meta-user-1");
    expect(stored?.muse?.tierName).toBe("Muse Pro");
    expect(stored?.muse?.mintedAt).toBe(1_700_000_000_000);
  });

  test("a muse record without an account token is dropped rather than half-stored", async () => {
    await saveCredential("meta-muse", {
      access: KEY,
      refresh: KEY,
      expires: Number.MAX_SAFE_INTEGER,
      email: "other@example.com",
      source: "oauth",
      muse: { oauthAccessToken: "   ", tierName: "Muse Pro" } as never,
    });
    expect(getCredential("meta-muse")?.muse).toBeUndefined();
  });
});
