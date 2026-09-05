import { afterEach, describe, expect, test } from "bun:test";
import { loginChatGPT } from "../../src/oauth/chatgpt";
import { loginChatGPTDevice } from "../../src/oauth/chatgpt-device";
import type { OAuthController } from "../../src/oauth/types";

/**
 * The OpenAI deviceauth grant (#3366): the login path for a hub with no local
 * browser and no listener on localhost:1455.
 *
 * Every test stubs `globalThis.fetch` and routes by URL, the same style as
 * `tests/oauth/oauth-device-code-contract.test.ts`.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const USERCODE = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN = "https://auth.openai.com/api/accounts/deviceauth/token";
const OAUTH_TOKEN = "https://auth.openai.com/oauth/token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An id_token whose payload carries the identity the Codex pool requires. */
function idToken(): string {
  const payload = {
    email: "Hub.Operator@Example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_device_123" },
  };
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

interface RouteOptions {
  pendingPolls?: number;
  pendingStatus?: number;
  interval?: unknown;
  tokenBody?: unknown;
  grantBody?: unknown;
}

function routeFetch(opts: RouteOptions = {}): { urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  let polls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (typeof init?.body === "string") bodies.push(init.body);
    if (url === USERCODE) {
      return jsonResponse({
        device_auth_id: "auth-id-opaque",
        user_code: "ABCD-EFGH",
        ...(opts.interval === undefined ? {} : { interval: opts.interval }),
      });
    }
    if (url === DEVICE_TOKEN) {
      if (polls < (opts.pendingPolls ?? 0)) {
        polls += 1;
        return jsonResponse({}, opts.pendingStatus ?? 403);
      }
      return jsonResponse(
        opts.grantBody ?? { authorization_code: "auth-code", code_verifier: "server-verifier" },
      );
    }
    if (url === OAUTH_TOKEN) {
      return jsonResponse(
        opts.tokenBody ?? {
          access_token: "access-value",
          refresh_token: "refresh-value",
          id_token: idToken(),
          expires_in: 3600,
        },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { urls, bodies };
}

describe("ChatGPT device auth", () => {
  test("surfaces the fixed verification URL and the human code", async () => {
    routeFetch();
    let seen: { url?: string; instructions?: string; deviceCode?: string } | undefined;
    await loginChatGPTDevice({ onAuth: info => { seen = info; } });

    expect(seen?.url).toBe("https://auth.openai.com/codex/device");
    expect(seen?.deviceCode).toBe("ABCD-EFGH");
    expect(seen?.instructions).toContain("ABCD-EFGH");
    // The opaque polling handle must never reach a rendered surface.
    expect(JSON.stringify(seen)).not.toContain("auth-id-opaque");
  });

  test.each([403, 404])("treats %i as pending and keeps polling", async status => {
    // interval 0.0001s floors to the 1s minimum, so two pending polls would
    // sleep two real seconds. Assert the wait instead of paying for it.
    const calls = routeFetch({ pendingPolls: 2, pendingStatus: status, interval: 0.001 });
    const started = Date.now();
    const creds = await loginChatGPTDevice({});

    expect(calls.urls.filter(url => url === DEVICE_TOKEN)).toHaveLength(3);
    expect(creds.access).toBe("access-value");
    // Two pending polls at the 1s floor: proves the interval is honored rather
    // than collapsed to an immediate retry.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  });

  test("does not accept a grant that arrives after the deadline", async () => {
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === USERCODE) {
          return jsonResponse({ device_auth_id: "auth-id-opaque", user_code: "ABCD-EFGH" });
        }
        if (url === DEVICE_TOKEN) {
          // The poll itself outlives the 15-minute grant.
          clock += 15 * 60 * 1000 + 1;
          return jsonResponse({ authorization_code: "auth-code", code_verifier: "server-verifier" });
        }
        throw new Error("token exchange must not be reached");
      }) as typeof fetch;

      await expect(loginChatGPTDevice({})).rejects.toThrow("expired");
    } finally {
      Date.now = realNow;
    }
  });

  test("accepts the upstream 'usercode' spelling", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === USERCODE) {
        return jsonResponse({ device_auth_id: "auth-id-opaque", usercode: "WXYZ-1234" });
      }
      if (url === DEVICE_TOKEN) {
        return jsonResponse({ authorization_code: "auth-code", code_verifier: "server-verifier" });
      }
      return jsonResponse({ access_token: "access-value", expires_in: 3600 });
    }) as typeof fetch;

    let seen: { deviceCode?: string } | undefined;
    await loginChatGPTDevice({ onAuth: info => { seen = info; } });
    expect(seen?.deviceCode).toBe("WXYZ-1234");
  });

  test("coerces a string interval and clamps an overflowing one", async () => {
    // A raw setTimeout above ~2^31 ms fires immediately, which would turn a
    // corrupt interval into a hot loop against an auth endpoint.
    const calls = routeFetch({ pendingPolls: 3, interval: "999999999" });
    const started = Date.now();
    const abort = new AbortController();
    setTimeout(() => abort.abort("stop"), 60);

    await loginChatGPTDevice({ signal: abort.signal }).catch(() => {});

    expect(Date.now() - started).toBeLessThan(5_000);
    // One poll, then a long clamped wait — not a spin.
    expect(calls.urls.filter(url => url === DEVICE_TOKEN).length).toBeLessThanOrEqual(2);
  });

  test("rejects a token response with no access token", async () => {
    routeFetch({ tokenBody: { refresh_token: "refresh-value", expires_in: 3600 } });

    await expect(loginChatGPTDevice({})).rejects.toThrow(
      "ChatGPT token response missing access token",
    );
  });

  test("exchanges the server-issued grant at the device callback URI", async () => {
    const calls = routeFetch();
    await loginChatGPTDevice({});

    const exchange = calls.bodies.find(body => body.includes("grant_type=authorization_code"));
    expect(exchange).toBeDefined();
    const params = new URLSearchParams(exchange ?? "");
    expect(params.get("code")).toBe("auth-code");
    // The verifier comes from the poll response; we never generate one here.
    expect(params.get("code_verifier")).toBe("server-verifier");
    expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
  });

  test("carries the account identity the Codex pool requires", async () => {
    routeFetch();
    const creds = await loginChatGPTDevice({});

    // A credential with no accountId is rejected at pool admission, so wire
    // success alone would not prove the flow is usable.
    expect(creds.accountId).toBe("acct_device_123");
    expect(creds.email).toBe("hub.operator@example.com");
    expect(creds.refresh).toBe("refresh-value");
  });

  test("rejects a malformed grant without reflecting the response body", async () => {
    routeFetch({ grantBody: { authorization_code: "auth-code" } });

    await expect(loginChatGPTDevice({})).rejects.toThrow(
      "ChatGPT device authorization response missing required fields",
    );
  });

  test("reports a terminal poll failure by status only", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === USERCODE) {
        return jsonResponse({ device_auth_id: "auth-id-opaque", user_code: "ABCD-EFGH" });
      }
      return new Response("upstream said something with a secret in it", { status: 500 });
    }) as typeof fetch;

    const error = await loginChatGPTDevice({}).catch((err: Error) => err);
    expect(String(error)).toContain("HTTP 500");
    expect(String(error)).not.toContain("secret");
  });

  test("stops when the controller aborts", async () => {
    routeFetch({ pendingPolls: 50, interval: 0.001 });
    const abort = new AbortController();
    const ctrl: OAuthController = {
      onAuth: () => abort.abort("observed"),
      signal: abort.signal,
    };

    await expect(loginChatGPTDevice(ctrl)).rejects.toThrow(/cancelled|abort/i);
  });

  test("loginChatGPT routes flow:device to the device grant", async () => {
    const calls = routeFetch();
    // No callback server is started: reaching the usercode endpoint at all
    // proves the browser flow was not selected.
    const creds = await loginChatGPT({}, { flow: "device" });

    expect(calls.urls[0]).toBe(USERCODE);
    expect(creds.accountId).toBe("acct_device_123");
  });
});
