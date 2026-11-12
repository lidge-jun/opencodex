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
  /**
   * A fake clock whose `sleep` reproduces the runtime's timer arithmetic: a delay above 2^31-1 ms
   * does not wait, it fires on the next tick. Without that, an injected `sleep` that simply adds
   * the requested delay would hide the overflow the clamp exists to prevent. `now.peek()` reads the
   * fake clock so a case can assert the loop stopped where the deadline is rather than merely that
   * it stopped.
   *
   * `interval` is floored at 1s, so every timing case needs a grant that outlives that floor; a
   * sub-second grant now ends before the first poll and would make a case vacuous.
   *
   * `maxPolls` is a tripwire, not a behaviour: a hot loop on the unfixed code runs billions of
   * iterations, so the case has to end on a count rather than on wall time.
   */
  const clockFixture = (maxPolls = 500) => {
    const waits: number[] = [];
    let now = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const sleep = async (ms: number) => {
      waits.push(ms);
      if (waits.length > maxPolls) throw new Error(`polled ${waits.length} times inside the grant`);
      now += ms > 2 ** 31 - 1 ? 1 : ms;
    };
    return { waits, sleep, clock, now: { peek: () => now } };
  };

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

  test("slow_down adds five seconds to the interval", async () => {
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
    // `AbortSignal.timeout` is a real timer, so this case spends real time on purpose: the per-poll
    // abort is the thing under test, and faking it would test the fake. 1.5 seconds total.
    //
    // The interval is floored at 1s, so the grant must outlive that floor for a poll to be issued
    // at all; a sub-second `expires_in` ends the loop before the first request and would let this
    // pass without ever exercising the abort.
    mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device", expires_in: 1.5, interval: 1 }, []);
    const mocked = globalThis.fetch;
    let tokens = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== TOKEN) return mocked(input, init);
      tokens++;
      // Never answers: only the per-poll abort can settle it, and that signal carries the time
      // left in the grant, so the promise rejects at the deadline, not at the 30s fetch timeout.
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as typeof fetch;
    const started = Date.now();
    const error = await loginXaiDevice({}).catch(e => e);
    const elapsed = Date.now() - started;
    expect(error.oauthError).toBe("expired_token");
    expect(tokens).toBe(1);
    // One 1s interval, then the poll is aborted with the 500ms the grant had left.
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("an unapproved code expires at the provider's deadline", async () => {
    // 90 polls at the 1s floor, then the deadline. `interval: 0.01` is below the floor, which is
    // what the clamp exists for; the count proves the loop used the floor, not 10ms.
    const f = clockFixture();
    try {
      mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device", expires_in: 90, interval: 0.01 }, []);
      const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
      expect(error).toBeInstanceOf(XaiTokenRequestError);
      expect(error.oauthError).toBe("expired_token");
      expect(f.waits).toHaveLength(90);
      expect(f.waits.every(ms => ms === 1_000)).toBe(true);
    } finally {
      f.clock.mockRestore();
    }
  });

  // ---- provider-supplied poll timing and grant lifetime -------------------------------------
  // `interval` and `expires_in` arrive in the device-authorization response, i.e. from the issuer.
  // A timer delay above 2^31-1 ms overflows to 1 ms, and a sub-second delay is a hot loop against
  // the auth endpoint, so both are clamped before they reach `sleep`/`AbortSignal.timeout`.
  const boundedDevice = (timing: Record<string, unknown>) => ({
    device_code: "d", user_code: "ABCD", verification_uri: "https://accounts.x.ai/oauth2/device", ...timing,
  });
  test("an oversized provider interval and lifetime cannot overflow a timer into a hot loop", async () => {
    const f = clockFixture();
    try {
      // Both values are needed to reach the overflow. `sleep` already takes the smaller of the
      // interval and the remaining lifetime, so a huge interval alone stays bounded by
      // `expires_in`; a huge `expires_in` alone stays bounded by a sane interval. Original head
      // asked for min(1e15, 3.15e13) ms, which the runtime clamps to 1 ms: a hot loop.
      mockXai(boundedDevice({ expires_in: 3.15e10, interval: 1e12 }), []);
      const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
      expect(error.oauthError).toBe("expired_token");
      expect(f.waits).toEqual([30 * 60 * 1000]);
    } finally {
      f.clock.mockRestore();
    }
  });

  test("a fractional or sub-second provider interval cannot flood the auth endpoint", async () => {
    const f = clockFixture();
    try {
      mockXai(boundedDevice({ expires_in: 60, interval: 0.0001 }), []);
      const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
      expect(error.oauthError).toBe("expired_token");
      // Original head waited 0.1 ms per poll: 235 polls in 300 ms measured, and ~600k here.
      expect(f.waits).toHaveLength(60);
      expect(f.waits.every(ms => ms >= 1_000)).toBe(true);
    } finally {
      f.clock.mockRestore();
    }
  });

  test("a provider grant lifetime is capped so a login cannot outlive a plausible approval", async () => {
    const f = clockFixture();
    try {
      // ~1000 years. The poll must still end on the bounded ceiling, not run for the grant's life.
      mockXai(boundedDevice({ expires_in: 3.15e10, interval: 60 }), []);
      const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
      expect(error).toBeInstanceOf(XaiTokenRequestError);
      expect(error.oauthError).toBe("expired_token");
      // Exactly the 30-minute ceiling: 30 one-minute waits, then the deadline, not 5e8 polls.
      expect(f.waits).toEqual(Array(30).fill(60_000));
    } finally {
      f.clock.mockRestore();
    }
  });

  test("slow_down adds exactly five seconds per poll, inside the bounded lifetime", async () => {
    const f = clockFixture();
    try {
      // Five slow_downs: the interval must grow 60 -> 65 -> 70 -> 75 -> 80 -> 85 seconds rather
      // than reset, shrink, or jump by a provider-controlled amount. RFC 8628 §3.5 asks for the
      // +5s, and dropping it is a hot loop with extra steps.
      mockXai(boundedDevice({ expires_in: 1800, interval: 60 }),
        [...Array(5)].map(() => Response.json({ error: "slow_down" }, { status: 400 })).concat(granted()));
      const creds = await loginXaiDevice({}, { sleep: f.sleep });
      expect(creds).toMatchObject({ access: "access" });
      expect(f.waits).toEqual([60_000, 65_000, 70_000, 75_000, 80_000, 85_000]);
    } finally {
      f.clock.mockRestore();
    }
  });

  test("a slow_down near the deadline is cut to what is left, never past the lifetime", async () => {
    const f = clockFixture();
    try {
      // 1790s interval inside a 30-minute grant. The +5s would ask for 1795s; the remaining 10s
      // wins, so the login still ends at the deadline rather than 1795s past the first poll.
      mockXai(boundedDevice({ expires_in: 3600, interval: 1790 }),
        [Response.json({ error: "slow_down" }, { status: 400 })]);
      const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
      expect(error.oauthError).toBe("expired_token");
      expect(f.waits).toEqual([1_790_000, 10_000]);
    } finally {
      f.clock.mockRestore();
    }
  });

  // ---- redirect handling on the newly introduced path --------------------------------------
  test("the device authorization request refuses a redirect instead of following it", async () => {
    const f = clockFixture();
    try {
      const calls = mockXai(boundedDevice({ expires_in: 900, interval: 5 }), []);
      const redirects: Array<{ url: string; redirect?: RequestRedirect }> = [];
      const mocked = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === DEVICE) redirects.push({ url: String(input), redirect: init?.redirect });
        return mocked(input, init);
      }) as typeof fetch;
      await loginXaiDevice({}, { sleep: f.sleep }).catch(() => {});
      expect(calls.some(c => c.url === DEVICE)).toBe(true);
      // A 307/308 preserves method and body, so the follow policy is the only place the request
      // body can be stopped from reaching a host `validateXaiEndpoint` never approved.
      expect(redirects).toEqual([{ url: DEVICE, redirect: "error" }]);
    } finally {
      f.clock.mockRestore();
    }
  });

  test("the device token poll refuses a redirect so the device code cannot ride one", async () => {
    mockXai(boundedDevice({ expires_in: 900, interval: 5 }), [granted()]);
    const redirects: Array<RequestRedirect | undefined> = [];
    const mocked = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === TOKEN) redirects.push(init?.redirect);
      return mocked(input, init);
    }) as typeof fetch;
    await loginXaiDevice({}, { sleep: async () => {} });
    expect(redirects).toEqual(["error"]);
  });

  test("an issuer without device authorization, or a verification URL off x.ai, is refused", async () => {
    mockXai({}, [], { authorization_endpoint: "https://auth.x.ai/oauth2/authorize", token_endpoint: TOKEN });
    await expect(loginXaiDevice({})).rejects.toThrow(/does not advertise device authorization/);
    mockXai({ device_code: "d", user_code: "u", verification_uri: "https://evil.example/device" }, []);
    await expect(loginXaiDevice({})).rejects.toThrow(/unexpected endpoint/);
  });
});
