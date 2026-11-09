import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { loginXaiDevice, XaiTokenRequestError } from "../../../src/oauth/xai";

const DISCOVERY = "https://auth.x.ai/.well-known/openid-configuration";
const DEVICE = "https://auth.x.ai/oauth2/device/code";
const TOKEN = "https://auth.x.ai/oauth2/token";
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

type Call = { url: string; body: Record<string, string> };
function mockXai(device: Record<string, unknown>, tokens: Response[], discovery: Record<string, unknown> = {
  authorization_endpoint: "https://auth.x.ai/oauth2/authorize", token_endpoint: TOKEN, device_authorization_endpoint: DEVICE,
}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
    if (url === DISCOVERY) return Response.json(discovery);
    if (url === DEVICE) return Response.json(device);
    if (url === TOKEN) return tokens.shift() ?? Response.json({ error: "authorization_pending" }, { status: 400 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return calls;
}
const pending = () => Response.json({ error: "authorization_pending" }, { status: 400 });
const granted = () => Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });

describe("xAI device login", () => {
  test("shows the URL and code, polls at the interval, backs off on slow_down, and returns the token", async () => {
    const calls = mockXai(
      { device_code: "dev-1", user_code: "ABCD-EFGH", verification_uri: "https://accounts.x.ai/oauth2/device",
        verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH", expires_in: 1800, interval: 5 },
      [pending(), Response.json({ error: "slow_down" }, { status: 400 }), granted()],
    );
    const shown: Array<{ url: string; deviceCode?: string }> = [];
    const waits: number[] = [];
    const creds = await loginXaiDevice({ onAuth: info => { shown.push(info); } }, { sleep: async ms => { waits.push(ms); } });
    expect(creds).toMatchObject({ access: "access", refresh: "refresh" });
    expect(shown).toEqual([expect.objectContaining({ url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH", deviceCode: "ABCD-EFGH" })]);
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(calls[1]).toEqual({ url: DEVICE, body: { client_id: "b1a00492-073a-47ea-816f-4c329264a828", scope: "openid profile email offline_access grok-cli:access api:access" } });
    expect(calls.slice(2).map(c => c.body)).toEqual(Array(3).fill({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "b1a00492-073a-47ea-816f-4c329264a828", device_code: "dev-1",
    }));
  });

  test("a denied approval ends the login", async () => {
    mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device" },
      [Response.json({ error: "access_denied" }, { status: 400 })]);
    await expect(loginXaiDevice({}, { sleep: async () => {} })).rejects.toMatchObject({ oauthError: "access_denied" });
  });

  test("a cancelled login stops polling", async () => {
    const calls = mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device" }, []);
    const cancel = new AbortController();
    await expect(loginXaiDevice({ signal: cancel.signal }, { sleep: async () => { cancel.abort(); } })).rejects.toBeDefined();
    expect(calls.filter(c => c.url === TOKEN).length).toBeLessThanOrEqual(1);
  });

  test("slow_down always adds five seconds, past any cap", async () => {
    mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device", interval: 60 },
      [Response.json({ error: "slow_down" }, { status: 400 }), granted()]);
    const waits: number[] = [];
    await loginXaiDevice({}, { sleep: async ms => { waits.push(ms); } });
    expect(waits).toEqual([60000, 65000]);
  });

  test("a timed-out, refused-by-server or unreachable poll is retried once per interval", async () => {
    const calls = mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device" }, []);
    const replies: Array<() => Response> = [
      () => { throw new DOMException("timed out", "TimeoutError"); },
      () => new Response("", { status: 503 }),
      () => { throw new TypeError("network"); },
      granted,
    ];
    const mocked = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== TOKEN) return mocked(input, init);
      calls.push({ url: TOKEN, body: {} });
      return replies.shift()!();
    }) as typeof fetch;
    const waits: number[] = [];
    expect(await loginXaiDevice({}, { sleep: async ms => { waits.push(ms); } })).toMatchObject({ access: "access" });
    // No hidden retry burst: four polls, one per five-second interval.
    expect(calls.filter(c => c.url === TOKEN)).toHaveLength(4);
    expect(waits).toEqual([5000, 5000, 5000, 5000]);
  });

  test("no poll starts at or after the grant deadline", async () => {
    let now = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const calls = mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device", expires_in: 10, interval: 5 }, []);
      const error = await loginXaiDevice({}, { sleep: async ms => { now += ms; } }).catch(e => e);
      expect(error.oauthError).toBe("expired_token");
      expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("a stalled poll is cut off at the grant deadline", async () => {
    mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device", expires_in: 0.2, interval: 0.01 }, []);
    const mocked = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => String(input) !== TOKEN ? mocked(input, init)
      : await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const started = Date.now();
    expect((await loginXaiDevice({}).catch(e => e)).oauthError).toBe("expired_token");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("an unapproved code expires at the provider's deadline", async () => {
    mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device", expires_in: 0.05, interval: 0.01 }, []);
    const error = await loginXaiDevice({}).catch(e => e);
    expect(error).toBeInstanceOf(XaiTokenRequestError);
    expect(error.oauthError).toBe("expired_token");
  });

  test("an issuer without device authorization, or a verification URL off x.ai, is refused", async () => {
    mockXai({}, [], { authorization_endpoint: "https://auth.x.ai/oauth2/authorize", token_endpoint: TOKEN });
    await expect(loginXaiDevice({})).rejects.toThrow(/does not advertise device authorization/);
    mockXai({ device_code: "d", user_code: "u", verification_uri: "https://evil.example/device" }, []);
    await expect(loginXaiDevice({})).rejects.toThrow(/unexpected endpoint/);
  });
});
