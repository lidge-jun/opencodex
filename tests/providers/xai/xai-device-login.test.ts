import { afterEach, describe, expect, test } from "bun:test";
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
