import { describe, expect, test } from "bun:test";
import {
  accountIdFromMuseCodeApiKey,
  buildMuseCodeDeviceVerifyUrl,
  isAllowedMuseCodeDeviceVerifyUrl,
  loginMuseCode,
  museCodeHttpError,
  refreshMuseCodeToken,
} from "../src/oauth/muse-code";
import { museCodeUserAgent } from "../src/adapters/client-fingerprint";

const META_ACCESS = "fixture-meta-access-DO-NOT-LEAK";
const MUSE_KEY = "LLM|123456789|fixture-muse-key-DO-NOT-LEAK";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("Meta Muse Code device login", () => {
  test("constructs only the fixed auth.meta.com verification URL", () => {
    const url = buildMuseCodeDeviceVerifyUrl("ABCD-EFGH");
    expect(url).toBe("https://auth.meta.com/oauth/device/?code=ABCD-EFGH");
    expect(isAllowedMuseCodeDeviceVerifyUrl(url)).toBe(true);
    expect(isAllowedMuseCodeDeviceVerifyUrl("http://auth.meta.com/oauth/device/?code=ABCD")).toBe(false);
    expect(isAllowedMuseCodeDeviceVerifyUrl("https://auth.meta.com.evil.example/oauth/device/?code=ABCD")).toBe(false);
    expect(isAllowedMuseCodeDeviceVerifyUrl("https://auth.meta.com/other/?code=ABCD")).toBe(false);
  });

  test("polls the device grant, mints a key, and discards the Meta access token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let polls = 0;
    const opened: Array<{ url: string; deviceCode?: string }> = [];
    const credential = await loginMuseCode({
      onAuth: ({ url, deviceCode }) => opened.push({ url, deviceCode }),
    }, {
      sleep: async () => {},
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, init });
        if (url.endsWith("/oidc/device/authorization/")) {
          return response({
            device_code: "device-code-secret",
            user_code: "ABCD-EFGH",
            verification_uri_complete: "https://evil.example/phish",
            expires_in: 600,
            interval: 1,
          });
        }
        if (url.endsWith("/oidc/device/token/")) {
          polls += 1;
          return polls === 1
            ? response({ error: "authorization_pending" }, 400)
            : response({ access_token: META_ACCESS, refresh_token: "unused-refresh" });
        }
        if (url.endsWith("/muse-code/key")) {
          return response({
            api_key: MUSE_KEY,
            base_url: "https://api.meta.ai/v1",
            require_payment: false,
            user_email: "not-an-email-fixture",
          });
        }
        return response({}, 404);
      },
    });

    expect(opened).toEqual([{ url: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH", deviceCode: "ABCD-EFGH" }]);
    expect(credential).toMatchObject({
      access: MUSE_KEY,
      refresh: MUSE_KEY,
      accountId: "123456789",
      expires: Number.MAX_SAFE_INTEGER,
      source: "oauth",
    });
    expect(credential.email).toBeUndefined();
    expect(JSON.stringify(credential)).not.toContain(META_ACCESS);
    const mint = calls.find(call => call.url.endsWith("/muse-code/key"));
    expect(new Headers(mint?.init?.headers).get("authorization")).toBe(`Bearer ${META_ACCESS}`);
    expect(new Headers(mint?.init?.headers).get("x-api-version")).toBe("1.0.0");
    expect(mint?.init?.redirect).toBe("error");
    // Every OAuth call mirrors the official Muse Code client fingerprint, never a bare runtime UA.
    expect(museCodeUserAgent()).toMatch(/^muse-build\/1\.0\.1 \(non-interactive; [\w-]+-[\w-]+; build [0-9a-f]{40}\)$/);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("user-agent")).toBe(museCodeUserAgent());
    }
    // The captured Muse Code device/mint requests carry no Accept header; don't invent one.
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("accept")).toBeNull();
    }
  });

  test("honors slow_down and rejects an account that still requires billing", async () => {
    const waits: number[] = [];
    let polls = 0;
    await expect(loginMuseCode({}, {
      sleep: async ms => { waits.push(ms); },
      fetch: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/oidc/device/authorization/")) {
          return response({ device_code: "device", user_code: "SLOW-DOWN", expires_in: 600, interval: 1 });
        }
        if (url.endsWith("/oidc/device/token/")) {
          polls += 1;
          return polls === 1
            ? response({ error: "slow_down" }, 400)
            : response({ access_token: META_ACCESS });
        }
        return response({
          api_key: MUSE_KEY,
          base_url: "https://api.meta.ai/v1",
          require_payment: true,
        });
      },
    })).rejects.toThrow("subscription or billing is not ready");
    expect(waits).toEqual([1_000, 6_000]);
  });

  test("does not leak response bodies or credentials in errors", async () => {
    expect(museCodeHttpError("API key mint", 401).message).toBe("Meta Muse Code API key mint failed (401)");
    await expect(loginMuseCode({}, {
      sleep: async () => {},
      fetch: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/oidc/device/authorization/")) {
          return response({ device_code: "device", user_code: "FAIL-CODE", expires_in: 600, interval: 1 });
        }
        if (url.endsWith("/oidc/device/token/")) return response({ access_token: META_ACCESS });
        return new Response(`denied ${META_ACCESS} ${MUSE_KEY}`, { status: 401 });
      },
    })).rejects.toThrow("Meta Muse Code API key mint failed (401)");
  });
});

describe("Meta Muse Code durable API key", () => {
  test("extracts only the stable numeric account id", () => {
    expect(accountIdFromMuseCodeApiKey(MUSE_KEY)).toBe("123456789");
    expect(accountIdFromMuseCodeApiKey("LLM|not-numeric|secret")).toBeUndefined();
    expect(accountIdFromMuseCodeApiKey("OTHER|123|secret")).toBeUndefined();
    expect(accountIdFromMuseCodeApiKey("LLM|123|bad\nvalue")).toBeUndefined();
    expect(accountIdFromMuseCodeApiKey("not-a-key")).toBeUndefined();
  });

  test("refresh is a no-network durable-key operation", async () => {
    expect(await refreshMuseCodeToken(MUSE_KEY)).toMatchObject({
      access: MUSE_KEY,
      refresh: MUSE_KEY,
      accountId: "123456789",
      expires: Number.MAX_SAFE_INTEGER,
    });
    await expect(refreshMuseCodeToken("not-a-key")).rejects.toThrow("API key is invalid");
  });
});
