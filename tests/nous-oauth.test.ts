import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { identityFromNousTokens, loginNous, refreshNousToken } from "../src/oauth/nous";
import { getCredential, listAccounts, saveCredential } from "../src/oauth/store";
import type { OAuthController } from "../src/oauth/types";

const TEST_DIR = join(import.meta.dir, ".tmp-nous-oauth-test");
const TEST_PORTAL = "http://portal.test";
let previousOpencodexHome: string | undefined;
let previousPortalBase: string | undefined;

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

function jwtPayloadOf(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error(`token is not a JWT: ${token}`);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
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
    process.env.NOUS_PORTAL_BASE_URL = TEST_PORTAL;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousPortalBase === undefined) delete process.env.NOUS_PORTAL_BASE_URL;
    else process.env.NOUS_PORTAL_BASE_URL = previousPortalBase;
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
    await expect(loginNous(ctrl)).rejects.toThrow("Nous Portal device authorization denied");
  });

  test("expired_token surfaces as a terminal NousTokenError", async () => {
    globalThis.fetch = deviceFlowFetch(() =>
      new Response(JSON.stringify({ error: "expired_token", error_description: "Code expired" }), { status: 400 }),
    );
    const ctrl: OAuthController = { onAuth() {} };
    await expect(loginNous(ctrl)).rejects.toThrow("Nous Portal device authorization expired");
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
});

describe("Nous refresh fallback", () => {
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

  test("keeps the previous refresh token when the response omits a new one", async () => {
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

    const cred = await refreshNousToken("old-refresh");

    expect(cred.access).toBe(access);
    expect(cred.refresh).toBe("old-refresh");
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
