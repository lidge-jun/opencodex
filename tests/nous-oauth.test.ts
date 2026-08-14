import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearNousRefreshIntent, identityFromNousTokens, loginNous, nousRefreshIntentBlocksReplay, refreshNousToken, RefreshIntentIOError } from "../src/oauth/nous";
import { getCredential, listAccounts, saveCredential } from "../src/oauth/store";
import type { OAuthController } from "../src/oauth/types";
import * as configModule from "../src/config";
import { BOUNDED_BODY_MAX_BYTES } from "../src/lib/bounded-body";

const TEST_DIR = join(import.meta.dir, ".tmp-nous-oauth-test");
const TEST_PORTAL = "https://portal.test";
let previousOpencodexHome: string | undefined;
let previousPortalBase: string | undefined;

function jwtWithClaims(claims: Record<string, unknown>): string {
  // A real Nous inference JWT carries the inference:invoke scope; callers that
  // need to exercise the missing-scope path pass an explicit `scope` override.
  const payloadClaims = { scope: "inference:invoke", ...claims };
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(payloadClaims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

function jwtPayloadOf(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error(`token is not a JWT: ${token}`);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function refreshIntentPathFor(refreshToken: string): string {
  const hash = createHash("sha256").update(refreshToken).digest("hex");
  return join(TEST_DIR, ".nous-refresh-intent", `${hash}.json`);
}

function writeRawIntent(refreshToken: string, raw: string): void {
  const path = refreshIntentPathFor(refreshToken);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, raw, "utf8");
}

describe("Nous OAuth JWT identity", () => {
  test("sub becomes accountId", () => {
    const access = jwtWithClaims({ sub: "nous-user-aaa", exp: 9_999_999_999 });
    expect(identityFromNousTokens(access)).toEqual({ accountId: "nous-user-aaa" });
  });

  test("email is lowercased when present", () => {
    const mixed = ["Alice", String.fromCharCode(64), "Nous.Example"].join("");
    const access = jwtWithClaims({ sub: "u1", email: mixed });
    expect(identityFromNousTokens(access).email).toBe(mixed.toLowerCase());
  });

  test("opaque tokens yield no identity", () => {
    expect(identityFromNousTokens("not-a-jwt")).toEqual({});
  });
});

describe("Nous token-response wiring", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    previousPortalBase = process.env.NOUS_PORTAL_BASE_URL;
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    process.env.NOUS_PORTAL_BASE_URL = TEST_PORTAL;
    // Isolate durable refresh-intent state so this block never leaves intent
    // files in the developer/runner config tree (review: 1st wiring test must
    // isolate OPENCODEX_HOME).
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousPortalBase === undefined) delete process.env.NOUS_PORTAL_BASE_URL;
    else process.env.NOUS_PORTAL_BASE_URL = previousPortalBase;
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("refreshNousToken posts the refresh token in the x-nous-refresh-token header and keeps the rotated token", async () => {
    const access = jwtWithClaims({ sub: "wired-user", exp: Math.floor(Date.now() / 1000) + 3600 });
    let observedHeader: string | undefined;
    let observedGrant: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      observedHeader = (init?.headers as Record<string, string> | undefined)?.["x-nous-refresh-token"];
      observedGrant = new URLSearchParams(init?.body as string).get("grant_type") ?? undefined;
      return new Response(JSON.stringify({
        access_token: access,
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }), { status: 200 });
    }) as typeof fetch;

    const cred = await refreshNousToken("old-refresh");

    expect(observedHeader).toBe("old-refresh");
    expect(observedGrant).toBe("refresh_token");
    expect(cred.access).toBe(access);
    expect(cred.refresh).toBe("rotated-refresh");
    expect(cred.accountId).toBe("wired-user");
  });

  test("loginNous runs the device grant and returns credentials with the verification code surfaced", async () => {
    let pollCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const grant = new URLSearchParams(init?.body as string).get("grant_type");
      if (url.endsWith("/api/oauth/device/code")) {
        return new Response(JSON.stringify({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://portal.nousresearch.com/activate",
          verification_uri_complete: "https://portal.nousresearch.com/activate?code=ABCD-EFGH",
          expires_in: 600,
          interval: 1,
        }), { status: 200 });
      }
      if (url.endsWith("/api/oauth/token") && grant === "urn:ietf:params:oauth:grant-type:device_code") {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
        }
        return new Response(JSON.stringify({
          access_token: jwtWithClaims({ sub: "device-user", exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: "device-refresh",
          expires_in: 3600,
        }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const authUrls: Array<{ url?: string; instructions?: string; deviceCode?: string }> = [];
    const ctrl: OAuthController = {
      onAuth(info) {
        authUrls.push(info);
      },
    };
    const cred = await loginNous(ctrl);

    expect(authUrls).toEqual([{
      url: "https://portal.nousresearch.com/activate?code=ABCD-EFGH",
      instructions: "Sign in to Nous Portal and enter the code: ABCD-EFGH",
      deviceCode: "ABCD-EFGH",
    }]);
    expect(jwtPayloadOf(cred.access).sub).toBe("device-user");
    expect(cred.refresh).toBe("device-refresh");
    expect(cred.accountId).toBe("device-user");
  });

  test.each([200, 400])("rejects oversized device-authorization responses with HTTP %i", async (status) => {
    globalThis.fetch = (async () =>
      new Response("x".repeat(BOUNDED_BODY_MAX_BYTES + 1), { status })) as typeof fetch;

    await expect(loginNous({ onAuth() {} })).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "response_too_large",
    });
  });

  test("normalizes a null device-authorization response before required-field validation", async () => {
    globalThis.fetch = (async () =>
      new Response("null", { status: 200 })) as typeof fetch;

    await expect(loginNous({ onAuth() {} })).rejects.toThrow(
      "Nous Portal device authorization response missing required fields",
    );
  });

  test("propagates caller abort while the device-authorization body is pending", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("caller stopped", "AbortError");
    let bodyReadStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyReadStarted = resolve; });
    let cancelReason: unknown;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        bodyReadStarted();
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        cancelReason = reason;
      },
    }), { status: 200 })) as typeof fetch;

    const pending = loginNous({ onAuth() {}, signal: controller.signal });
    await started;
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    await Bun.sleep(0);
    expect(cancelReason).toBe(abortReason);
  });

  test("rejects oversized device-token responses at the bounded OAuth reader", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/oauth/device/code")) {
        return new Response(JSON.stringify({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://portal.nousresearch.com/activate",
          expires_in: 60,
          interval: 1,
        }), { status: 200 });
      }
      return new Response("x".repeat(BOUNDED_BODY_MAX_BYTES + 1), { status: 200 });
    }) as typeof fetch;

    await expect(loginNous({ onAuth() {} })).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "response_too_large",
    });
  });

  test.each([200, 400])("rejects oversized refresh responses with HTTP %i", async (status) => {
    globalThis.fetch = (async () =>
      new Response("x".repeat(BOUNDED_BODY_MAX_BYTES + 1), { status })) as typeof fetch;

    await expect(refreshNousToken(`old-refresh-${status}`)).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "response_too_large",
    });
    expect(nousRefreshIntentBlocksReplay(`old-refresh-${status}`)).toBe(true);
  });

  test("normalizes a null refresh response to a terminal token error and blocks replay", async () => {
    globalThis.fetch = (async () =>
      new Response("null", { status: 200 })) as typeof fetch;

    await expect(refreshNousToken("old-refresh-null")).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "invalid_token",
      terminal: true,
    });
    expect(nousRefreshIntentBlocksReplay("old-refresh-null")).toBe(true);
  });

  test("an implausible JWT exp falls back to expires_in instead of pinning a never-expiring credential", async () => {
    // A too-large `exp` (e.g. milliseconds instead of seconds, or clock skew)
    // must not produce an expiry so far in the future that the credential is
    // never refreshed. The caller falls back to `expires_in`.
    const access = jwtWithClaims({ sub: "wired-user", exp: 9_999_999_999 });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: access,
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    const cred = await refreshNousToken("old-refresh");
    const expected = Date.now() + 3600_000 - 2 * 60 * 1000;
    // The expiry is derived from expires_in (≈ now + 3600s - skew), not from the
    // absurd exp claim.
    expect(Math.abs(cred.expires - expected)).toBeLessThan(5000);
  });
});

describe("Nous device-flow error handling", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    previousPortalBase = process.env.NOUS_PORTAL_BASE_URL;
    process.env.NOUS_PORTAL_BASE_URL = TEST_PORTAL;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousPortalBase === undefined) delete process.env.NOUS_PORTAL_BASE_URL;
    else process.env.NOUS_PORTAL_BASE_URL = previousPortalBase;
  });

  function deviceFlowFetch(respond: (grant: string | null) => Response): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/oauth/device/code")) {
        return new Response(JSON.stringify({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "https://portal.nousresearch.com/activate?code=ABCD-EFGH",
          expires_in: 600,
          interval: 1,
        }), { status: 200 });
      }
      return respond(new URLSearchParams(init?.body as string).get("grant_type"));
    }) as typeof fetch;
  }

  test("access_denied surfaces as a terminal NousTokenError", async () => {
    globalThis.fetch = deviceFlowFetch(() =>
      new Response(JSON.stringify({ error: "access_denied", error_description: "User denied the request" }), { status: 400 }),
    );
    const ctrl: OAuthController = { onAuth() {} };
    let err: unknown;
    try {
      await loginNous(ctrl);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Nous Portal device authorization denied");
    expect((err as { name?: string }).name).toBe("NousTokenError");
    expect((err as { oauthError?: string }).oauthError).toBe("access_denied");
    expect((err as { terminal?: boolean }).terminal).toBe(true);
  });

  test("expired_token surfaces as a terminal NousTokenError", async () => {
    globalThis.fetch = deviceFlowFetch(() =>
      new Response(JSON.stringify({ error: "expired_token", error_description: "Code expired" }), { status: 400 }),
    );
    const ctrl: OAuthController = { onAuth() {} };
    let err: unknown;
    try {
      await loginNous(ctrl);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Nous Portal device authorization expired");
    expect((err as { name?: string }).name).toBe("NousTokenError");
    expect((err as { oauthError?: string }).oauthError).toBe("expired_token");
    expect((err as { terminal?: boolean }).terminal).toBe(true);
  });

  test("slow_down backs off and resumes polling until success", async () => {
    let pollCount = 0;
    const access = jwtWithClaims({ sub: "device-user", exp: Math.floor(Date.now() / 1000) + 3600 });
    globalThis.fetch = deviceFlowFetch(() => {
      pollCount += 1;
      if (pollCount === 1) {
        return new Response(JSON.stringify({ error: "slow_down", interval: 1 }), { status: 400 });
      }
      return new Response(JSON.stringify({
        access_token: access,
        refresh_token: "device-refresh",
        expires_in: 3600,
      }), { status: 200 });
    });
    const ctrl: OAuthController = { onAuth() {} };
    const cred = await loginNous(ctrl);
    expect(pollCount).toBe(2);
    expect(cred.access).toBe(access);
    expect(cred.refresh).toBe("device-refresh");
    expect(cred.accountId).toBe("device-user");
  }, 15_000);

  test("device flow times out when the server never authorizes before the deadline", async () => {
    // The deadline comes from the device-code response: keep it tiny so the
    // polling loop exits quickly instead of running for the full server TTL.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/oauth/device/code")) {
        return new Response(JSON.stringify({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "https://portal.nousresearch.com/activate?code=ABCD-EFGH",
          expires_in: 1,
          interval: 1,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
    }) as typeof fetch;
    const ctrl: OAuthController = { onAuth() {} };
    await expect(loginNous(ctrl)).rejects.toThrow("Nous Portal device flow timed out");
  }, 15_000);

  test("a successful device-code response with empty/non-JSON body yields the clear validation error, not a JSON parse leak", async () => {
    // Server returns 200 but the body is HTML/empty — not JSON. The required-field
    // validation must surface the clear "missing required fields" error instead of
    // leaking a raw JSON parser exception.
    globalThis.fetch = (async () => new Response("<html>not json</html>", { status: 200 })) as typeof fetch;
    const ctrl: OAuthController = { onAuth() {} };
    await expect(loginNous(ctrl)).rejects.toThrow("Nous Portal device authorization response missing required fields");
  });

  test("a device-login response missing refresh_token is an unusable-response error, not refresh_token_reused", async () => {
    // In the device flow no refresh token was submitted, so a missing
    // refresh_token must not be mislabeled as single-use reuse.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/oauth/device/code")) {
        return new Response(JSON.stringify({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "https://portal.nousresearch.com/activate?code=ABCD-EFGH",
          expires_in: 600,
          interval: 1,
        }), { status: 200 });
      }
      // Token endpoint: unusable device-login response (no refresh_token).
      return new Response(JSON.stringify({
        access_token: jwtWithClaims({ sub: "device-user", exp: Math.floor(Date.now() / 1000) + 3600 }),
      }), { status: 200 });
    }) as typeof fetch;
    const ctrl: OAuthController = { onAuth() {} };
    let err: unknown;
    try {
      await loginNous(ctrl);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { oauthError?: string }).oauthError).toBe("invalid_token");
    expect((err as { oauthError?: string }).oauthError).not.toBe("refresh_token_reused");
  });

  test("a successful device-flow response missing access_token is a terminal invalid_token error", async () => {
    // A 200 token response that omits access_token must be routed through
    // parseTokenPayload so it is classified as terminal invalid_token, not
    // silently treated as a transient/unknown error that retries the login.
    globalThis.fetch = deviceFlowFetch(() =>
      new Response(JSON.stringify({ refresh_token: "device-refresh" }), { status: 200 }),
    );
    const ctrl: OAuthController = { onAuth() {} };
    let err: unknown;
    try {
      await loginNous(ctrl);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("did not include an access token");
    expect((err as { name?: string }).name).toBe("NousTokenError");
    expect((err as { oauthError?: string }).oauthError).toBe("invalid_token");
    expect((err as { terminal?: boolean }).terminal).toBe(true);
  });

  test("a successful device-flow response with a null body is a terminal invalid_token error, not a TypeError", async () => {
    // A 200 response whose body is valid JSON `null` must be normalized to an
    // empty object so parseTokenPayload raises the intended terminal
    // invalid_token error instead of dereferencing null into a raw TypeError.
    globalThis.fetch = deviceFlowFetch(() =>
      new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const ctrl: OAuthController = { onAuth() {} };
    let err: unknown;
    try {
      await loginNous(ctrl);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toContain("did not include an access token");
    expect((err as { name?: string }).name).toBe("NousTokenError");
    expect((err as { oauthError?: string }).oauthError).toBe("invalid_token");
    expect((err as { terminal?: boolean }).terminal).toBe(true);
  });
});

describe("Nous Portal base URL hardening", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("an HTTP override fails before fetch is invoked", async () => {
    process.env.NOUS_PORTAL_BASE_URL = "http://portal.test";
    let fetchCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const ctrl: OAuthController = { onAuth() {} };
      await expect(loginNous(ctrl)).rejects.toThrow(/must use HTTPS/);
      await expect(refreshNousToken("hardening-refresh")).rejects.toThrow(/must use HTTPS/);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.NOUS_PORTAL_BASE_URL;
    }
  });

  test("a non-URL override fails before fetch is invoked", async () => {
    process.env.NOUS_PORTAL_BASE_URL = "not a url";
    let fetchCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(refreshNousToken("hardening-refresh")).rejects.toThrow(/not a valid URL/);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.NOUS_PORTAL_BASE_URL;
    }
  });

  test("embedded credentials / query / fragment in the override are rejected", async () => {
    for (const bad of [
      "https://user:pass@portal.test",
      "https://portal.test?x=1",
      "https://portal.test#frag",
    ]) {
      process.env.NOUS_PORTAL_BASE_URL = bad;
      const realFetch = globalThis.fetch;
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      try {
        await expect(refreshNousToken("hardening-refresh")).rejects.toThrow(/base URL/);
        expect(fetchCalled).toBe(false);
      } finally {
        globalThis.fetch = realFetch;
        delete process.env.NOUS_PORTAL_BASE_URL;
      }
    }
  });

  test("a malformed URL override never echoes a secret-bearing value in the error", async () => {
    // Deliberately sensitive-looking malformed input. The error must identify
    // the configuration problem without reflecting the secret.
    // Build the secret dynamically so no static token-looking literal appears
    // in the source (keeps privacy:scan clean while still proving redaction).
    const secret = ["super", "secret", "value", "123456"].join("-");
    // No scheme separator -> new URL() throws SyntaxError, hitting the
    // malformed-URL branch (not a parseable https/user: URL).
    process.env.NOUS_PORTAL_BASE_URL = `not a real url containing ${secret}`;
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      let message = "";
      try {
        await refreshNousToken("hardening-refresh");
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("not a valid URL");
      expect(message).not.toContain(secret);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.NOUS_PORTAL_BASE_URL;
    }
  });

  test("a path in the override is discarded; requests still target the canonical endpoint", async () => {
    // resolvePortalBaseUrl returns url.origin only, so a smuggled path/prefix in
    // the override must not redirect the OAuth request to a non-canonical path.
    process.env.NOUS_PORTAL_BASE_URL = "https://portal.test/evil/prefix";
    const realFetch = globalThis.fetch;
    let observedUrl: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      observedUrl = String(input);
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as typeof fetch;
    try {
      await expect(refreshNousToken("origin-only-token")).rejects.toThrow();
      expect(observedUrl).toBe("https://portal.test/api/oauth/token");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.NOUS_PORTAL_BASE_URL;
    }
  });
});

describe("Nous refresh token safety", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    previousPortalBase = process.env.NOUS_PORTAL_BASE_URL;
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.NOUS_PORTAL_BASE_URL = TEST_PORTAL;
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousPortalBase === undefined) delete process.env.NOUS_PORTAL_BASE_URL;
    else process.env.NOUS_PORTAL_BASE_URL = previousPortalBase;
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("rejecting a missing replacement refresh token does not reuse the consumed one", async () => {
    const access = jwtWithClaims({ sub: "wired-user", exp: Math.floor(Date.now() / 1000) + 3600 });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const observedHeader = (init?.headers as Record<string, string> | undefined)?.["x-nous-refresh-token"];
      expect(observedHeader).toBe("old-refresh");
      return new Response(JSON.stringify({
        access_token: access,
        expires_in: 3600,
        // no refresh_token field on purpose
      }), { status: 200 });
    }) as typeof fetch;

    await expect(refreshNousToken("old-refresh")).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "refresh_token_reused",
    });
  });

  test("rejecting a replacement equal to the submitted token (consumed-credential reuse)", async () => {
    const access = jwtWithClaims({ sub: "wired-user", exp: Math.floor(Date.now() / 1000) + 3600 });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: access,
      refresh_token: "old-refresh", // identical to what was submitted
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    await expect(refreshNousToken("old-refresh")).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "refresh_token_reused",
    });
  });

  test("a rotated replacement refresh token is kept", async () => {
    const access = jwtWithClaims({ sub: "wired-user", exp: Math.floor(Date.now() / 1000) + 3600 });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const observedHeader = (init?.headers as Record<string, string> | undefined)?.["x-nous-refresh-token"];
      expect(observedHeader).toBe("old-refresh");
      return new Response(JSON.stringify({
        access_token: access,
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }), { status: 200 });
    }) as typeof fetch;

    const cred = await refreshNousToken("old-refresh");
    expect(cred.access).toBe(access);
    expect(cred.refresh).toBe("rotated-refresh");
    expect(cred.accountId).toBe("wired-user");
  });
});

describe("Nous multiauth via saveCredential", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("two distinct subs append two nous accounts", async () => {
    const accessA = jwtWithClaims({ sub: "nous-a" });
    const accessB = jwtWithClaims({ sub: "nous-b" });
    await saveCredential("nous", {
      access: accessA,
      refresh: "refresh-a",
      expires: Date.now() + 3600_000,
      ...identityFromNousTokens(accessA),
    });
    await saveCredential("nous", {
      access: accessB,
      refresh: "refresh-b",
      expires: Date.now() + 3600_000,
      ...identityFromNousTokens(accessB),
    });
    expect(listAccounts("nous").length).toBe(2);
    expect(getCredential("nous")?.accountId).toBe("nous-b");
    expect(getCredential("nous")?.access).toBe(accessB);
  });

  test("same sub upserts without duplicating", async () => {
    const access1 = jwtWithClaims({ sub: "nous-same" });
    const access2 = jwtWithClaims({ sub: "nous-same", iat: 2 });
    await saveCredential("nous", {
      access: access1,
      refresh: "refresh-1",
      expires: Date.now() + 3600_000,
      ...identityFromNousTokens(access1),
    });
    await saveCredential("nous", {
      access: access2,
      refresh: "refresh-2",
      expires: Date.now() + 3600_000,
      ...identityFromNousTokens(access2),
    });
    expect(listAccounts("nous").length).toBe(1);
    expect(getCredential("nous")?.access).toBe(access2);
    expect(getCredential("nous")?.refresh).toBe("refresh-2");
  });
});

describe("Nous refresh failure-atomicity + terminal errors", () => {
  const realFetch = globalThis.fetch;
  let intentHome: string | undefined;

  beforeEach(() => {
    previousPortalBase = process.env.NOUS_PORTAL_BASE_URL;
    process.env.NOUS_PORTAL_BASE_URL = TEST_PORTAL;
    // Isolate the refresh-intent dir under a temp OPENCODEX_HOME.
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousPortalBase === undefined) delete process.env.NOUS_PORTAL_BASE_URL;
    else process.env.NOUS_PORTAL_BASE_URL = previousPortalBase;
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("a successful rotation leaves the intent submitted until the store persists", async () => {
    const access = jwtWithClaims({ sub: "atomic-user", exp: Math.floor(Date.now() / 1000) + 3600, scope: "inference:invoke" });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: access,
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;
    const cred = await refreshNousToken("old-refresh");
    expect(cred.refresh).toBe("rotated-refresh");
    // After a successful rotation the intent stays "submitted": it is only
    // cleared once the store persists the rotated token (clearNousRefreshIntent).
    expect(nousRefreshIntentBlocksReplay("old-refresh")).toBe(true);
  });

  test("clearNousRefreshIntent unblocks the submitted token after the store persists", async () => {
    const access = jwtWithClaims({ sub: "atomic-user", exp: Math.floor(Date.now() / 1000) + 3600, scope: "inference:invoke" });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: access,
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;
    await refreshNousToken("old-refresh");
    expect(nousRefreshIntentBlocksReplay("old-refresh")).toBe(true);

    // The persistence layer commits the rotated credential and then closes the
    // uncertain-outcome window. Without this step the account would be locked
    // into re-authentication forever.
    clearNousRefreshIntent("old-refresh");
    expect(nousRefreshIntentBlocksReplay("old-refresh")).toBe(false);
  });

  test("an uncertain prior outcome (rotated token obtained but not persisted) blocks replay of the consumed token", async () => {
    const access = jwtWithClaims({ sub: "atomic-user", exp: Math.floor(Date.now() / 1000) + 3600, scope: "inference:invoke" });
    // First refresh rotates successfully (intent left "submitted").
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: access,
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;
    const cred = await refreshNousToken("old-refresh");
    expect(cred.refresh).toBe("rotated-refresh");
    // Simulate a crash that lost the rotated token before the store persisted
    // it: the local store still holds the OLD token. Replaying it must be
    // refused by the guard (not silently reused, not relying on the server).
    await expect(refreshNousToken("old-refresh")).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "refresh_token_reused",
    });
  });

  test("a 200 with an unparseable body marks the intent uncertain and the replay guard refuses before any fetch", async () => {
    // Server returns 200 but the body is not valid JSON -> parseTokenPayload
    // throws, so we mark the intent uncertain rather than clear it.
    let calls = 0;
    globalThis.fetch = ((async () => { calls++; return new Response("not json", { status: 200 }); }) as typeof fetch);
    await expect(refreshNousToken("old-refresh")).rejects.toThrow();
    expect(nousRefreshIntentBlocksReplay("old-refresh")).toBe(true);

    // The next submission of the same (possibly consumed) token is refused by
    // the guard BEFORE any network call — prove fetch is never reached.
    globalThis.fetch = ((async () => { calls++; return new Response(JSON.stringify({ error: "refresh_token_reused" }), { status: 400 }); }) as typeof fetch);
    await expect(refreshNousToken("old-refresh")).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "refresh_token_reused",
    });
    expect(calls).toBe(1); // only the first (unparseable) call ever hit the network
  });

  test("a network failure leaves the intent uncertain (fail-closed, never blindly replayable)", async () => {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    await expect(refreshNousToken("old-refresh")).rejects.toThrow("network down");
    // We cannot prove the server never received/rotated the token on a
    // connection failure, so it must be treated as uncertain: replay refused.
    expect(nousRefreshIntentBlocksReplay("old-refresh")).toBe(true);
  });

  test("invalid_token is a terminal error that forces re-authentication", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: "invalid_token",
      error_description: "token revoked",
    }), { status: 400 })) as typeof fetch;
    let err: unknown;
    try {
      await refreshNousToken("old-refresh");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { name?: string }).name).toBe("NousTokenError");
    expect((err as { oauthError?: string }).oauthError).toBe("invalid_token");
    expect((err as { terminal?: boolean }).terminal).toBe(true);
  });

  test("an access token without the inference:invoke scope is a terminal error but surfaces the rotated refresh", async () => {
    // access token whose JWT scope lacks inference:invoke
    const access = jwtWithClaims({ sub: "scope-user", exp: Math.floor(Date.now() / 1000) + 3600, scope: "billing:manage" });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: access,
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;
    let err: unknown;
    try {
      await refreshNousToken("old-refresh");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { name?: string }).name).toBe("NousTokenError");
    expect((err as { oauthError?: string }).oauthError).toBe("insufficient_scope");
    expect((err as { terminal?: boolean }).terminal).toBe(true);
    // The already-rotated refresh token is preserved (non-enumerable) so the
    // caller can persist it and drive a clean re-auth without discarding the
    // rotation. It must NOT be an enumerable property (no log/serialization leak).
    const e = err as NousTokenError & { getRotatedRefresh(): string | undefined };
    expect(e.getRotatedRefresh()).toBe("rotated-refresh");
    expect(Object.keys(err as object)).not.toContain("rotatedRefresh");
    expect(Object.keys(err as object)).not.toContain("credentials");
  });
});

describe("Nous refresh-intent schema is validated fail-closed", () => {
  const realFetch = globalThis.fetch;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // Each corrupt/unknown shape must block replay (fail-closed): the intent file
  // EXISTS but cannot be validated, so the token must not be replayed.
  const corruptBodies: Array<[string, string]> = [
    ["empty object", "{}"],
    ["null", "null"],
    ["non-object", '"just a string"'],
    ["unknown status", '{"status":"mystery","updatedAt":123}'],
    ["wrong status type", '{"status":42,"updatedAt":123}'],
    ["wrong updatedAt type", '{"status":"submitted","updatedAt":"yesterday"}'],
    ["NaN updatedAt", '{"status":"submitted","updatedAt":null}'],
  ];

  for (const [label, raw] of corruptBodies) {
    test(`an existing intent with ${label} is treated as uncertain (replay refused)`, async () => {
      const token = "schema-corrupt-token";
      writeRawIntent(token, raw);
      // A corrupt-but-existing intent must block the replay guard, never read as absent.
      expect(nousRefreshIntentBlocksReplay(token)).toBe(true);
    });
  }

  test("malformed JSON is treated as uncertain (replay refused)", async () => {
    const token = "schema-malformed-json";
    writeRawIntent(token, "{not valid json");
    expect(nousRefreshIntentBlocksReplay(token)).toBe(true);
  });

  test("a valid submitted intent blocks replay", async () => {
    const token = "schema-valid-submitted";
    writeRawIntent(token, JSON.stringify({ status: "submitted", updatedAt: Date.now() }));
    expect(nousRefreshIntentBlocksReplay(token)).toBe(true);
  });

  test("a valid uncertain intent blocks replay", async () => {
    const token = "schema-valid-uncertain";
    writeRawIntent(token, JSON.stringify({ status: "uncertain", updatedAt: Date.now() }));
    expect(nousRefreshIntentBlocksReplay(token)).toBe(true);
  });

  test("a missing intent file means no intent exists (replay allowed)", () => {
    // The token was never recorded, so replay is not blocked.
    expect(nousRefreshIntentBlocksReplay("never-seen-token")).toBe(false);
  });

  test("a corrupt intent blocks replay before fetch is ever called", async () => {
    const token = "schema-block-before-fetch";
    writeRawIntent(token, "{}");
    let fetchCalled = 0;
    globalThis.fetch = (async () => {
      fetchCalled += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await expect(refreshNousToken(token)).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "refresh_token_reused",
    });
    expect(fetchCalled).toBe(0);
  });
});

describe("Nous HTTP refresh failure-atomicity classification", () => {
  const realFetch = globalThis.fetch;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("an ambiguous 5xx response leaves the old token blocked (never replayable)", async () => {
    const token = "http-5xx-token";
    globalThis.fetch = (async () => new Response("gateway boom", { status: 503 })) as typeof fetch;
    await expect(refreshNousToken(token)).rejects.toThrow();
    // The 5xx is ambiguous: the request may have reached the Portal and rotated
    // the token before the error. The intent must be uncertain -> blocked.
    expect(nousRefreshIntentBlocksReplay(token)).toBe(true);
  });

  test("a second call with a 5xx-blocked token rejects before fetch is called", async () => {
    const token = "http-5xx-token-blocked";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("gateway boom", { status: 502 });
    }) as typeof fetch;

    // First call: ambiguous 5xx -> intent becomes uncertain.
    await expect(refreshNousToken(token)).rejects.toThrow();
    expect(nousRefreshIntentBlocksReplay(token)).toBe(true);

    // Second call: must reject via the replay guard BEFORE any network request.
    await expect(refreshNousToken(token)).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "refresh_token_reused",
    });
    expect(fetchCalls).toBe(1); // only the first (5xx) call ever hit the network
  });

  test("an HTTP 429 response leaves the old token blocked and the next attempt rejects before fetch", async () => {
    const token = "http-429-token";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: "rate_limit", error_description: "slow down" }), { status: 429 });
    }) as typeof fetch;

    // First call: the request reached the token endpoint and got 429. The
    // remote side may already have consumed RT-A, so the intent must remain
    // blocking — the old token must not become locally reusable.
    await expect(refreshNousToken(token)).rejects.toThrow();
    expect(nousRefreshIntentBlocksReplay(token)).toBe(true);

    // Second call: rejected by the replay guard BEFORE any network request.
    await expect(refreshNousToken(token)).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "refresh_token_reused",
    });
    expect(fetchCalls).toBe(1); // only the first (429) call ever hit the network
  });

  test("an unknown/custom 4xx response leaves the old token blocked (no automatic replay)", async () => {
    const token = "http-unknown-4xx-token";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("custom gateway 418 payload", { status: 418 });
    }) as typeof fetch;

    // Request was dispatched; the response provides no definitive proof of
    // non-consumption, so the intent must remain blocking and RT-A cannot be
    // replayed.
    await expect(refreshNousToken(token)).rejects.toThrow();
    expect(nousRefreshIntentBlocksReplay(token)).toBe(true);

    await expect(refreshNousToken(token)).rejects.toMatchObject({
      name: "NousTokenError",
      oauthError: "refresh_token_reused",
    });
    expect(fetchCalls).toBe(1);
  });

  test("a durable-write failure before dispatch throws a non-terminal RefreshIntentIOError (no fetch)", async () => {
    const token = "io-fail-token";
    let fetchCalled = 0;
    globalThis.fetch = (async () => {
      fetchCalled += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    // Force the durable intent write (atomicWriteFile) to fail, deterministically
    // on every platform. The write happens BEFORE dispatch, so this must abort
    // the refresh with a non-terminal operational error and never reach fetch.
    const writeSpy = spyOn(configModule, "atomicWriteFile").mockImplementation(() => {
      throw new Error("forced durable write failure (disk full)");
    });
    try {
      await expect(refreshNousToken(token)).rejects.toBeInstanceOf(RefreshIntentIOError);
      expect(fetchCalled).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
