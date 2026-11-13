import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { classifyLoginCodeError } from "../../../src/oauth/login-flow-state";
import { loginXaiDevice, XaiRedirectRefusedError, XaiTokenRequestError } from "../../../src/oauth/xai";

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
  test("discovery 503 is reported as provider unreachable before a code is issued", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const error = await loginXaiDevice({}).catch(e => e);
    expect(calls).toEqual([DISCOVERY]);
    expect(classifyLoginCodeError(error)).toBe("provider_unreachable");
  });

  test("discovery throttling and network failure report provider unreachable", async () => {
    for (const result of [new Response("rate limited", { status: 429 }), new TypeError("network failed")]) {
      globalThis.fetch = (async () => { if (result instanceof Error) throw result; return result; }) as typeof fetch;
      const error = await loginXaiDevice({}).catch(e => e);
      expect(classifyLoginCodeError(error)).toBe("provider_unreachable");
    }
  });

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

  for (const [label, responses, expected] of [
    ["outage", [503, 503], "provider_unreachable"],
    ["pending", [400, 400], "invalid_or_expired_code"],
  ] as const) test(`deadline after ${label} classifies the last poll`, async () => {
    const f = clockFixture();
    try {
      const calls = mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device", expires_in: 3, interval: 1 },
        responses.map(status => Response.json(status === 400 ? { error: "authorization_pending" } : {}, { status })));
      const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
      expect(calls.filter(c => c.url === TOKEN)).toHaveLength(2);
      expect(classifyLoginCodeError(error)).toBe(expected);
    } finally { f.clock.mockRestore(); }
  });

  for (const status of [503, 429] as const) test(`deadline after a ${status} carrying authorization_pending keeps the outage cause`, async () => {
    const f = clockFixture();
    try {
      mockXai({ device_code: "d", user_code: "u", verification_uri: "https://accounts.x.ai/oauth2/device", expires_in: 3, interval: 1 },
        [status, status].map(code => Response.json({ error: "authorization_pending" }, { status: code })));
      const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
      expect(classifyLoginCodeError(error)).toBe("provider_unreachable");
    } finally { f.clock.mockRestore(); }
  });

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
    // A poll that never answers must still end on the grant deadline. The per-poll signal carries
    // the time left in the grant, so the deadline is a budget handed to `AbortSignal.timeout`, not
    // a wall-clock wait: this case stubs the timer and aborts the poll's own signal, so it proves
    // the deadline arithmetic and the abort path without spending real time.
    //
    // The interval is floored at 1s, so the grant must outlive that floor for a poll to be issued
    // at all; a sub-second `expires_in` ends the loop before the first request and would let this
    // pass without ever exercising the abort.
    const f = clockFixture();
    const pollDeadline = new AbortController();
    const budgets: number[] = [];
    // Every timeout is a controlled signal: a real one would make this case wait for the 30s
    // request budget that nothing here is testing.
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      budgets.push(ms);
      return pollDeadline.signal;
    });
    try {
      mockXai(boundedDevice({ expires_in: 1.5, interval: 1 }), []);
      const mocked = globalThis.fetch;
      let tokens = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== TOKEN) return mocked(input, init);
        tokens++;
        // Never answers: only the per-poll abort can settle it. The controller fires as soon as the
        // request is in flight, so the rejection is the deadline's, not a fetch timeout's.
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          pollDeadline.abort(new DOMException("fixture grant deadline", "TimeoutError"));
        });
      }) as typeof fetch;
      const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
      expect(classifyLoginCodeError(error)).toBe("provider_unreachable");
      // One request, then the grant ran out: no retry after the deadline.
      expect(tokens).toBe(1);
      // The settled interval, then the 500ms the grant had left — never a full second past the
      // deadline, and never a retry on the leftover.
      expect(f.waits).toEqual([1_000, 500]);
      // The poll's own budget is what is left in the grant, not the 30s request budget.
      expect(budgets).toContain(500);
    } finally {
      timeout.mockRestore();
      f.clock.mockRestore();
    }
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

  // ---- a refused redirect must end the login, not expire it ---------------------------------
  //
  // `postXaiToken` asks for `redirect: "error"`, so `fetch` throws instead of returning a
  // response. That throw used to land in the generic network branch: the poll was retried every
  // interval until the grant ran out, then reported `expired_token` — a wrong cause, a delayed
  // failure, and extra requests carrying the `device_code`. The fix classifies the runtime's own
  // redirect error as a deterministic refusal.

  /**
   * The error the running JavaScript runtime really throws for `redirect: "error"`.
   *
   * Built from a live loopback server rather than a hand-written object, so the detector is
   * tested against the shape this runtime produces instead of the shape this file assumes.
   */
  async function realRedirectRefusal(): Promise<Error> {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(null, { status: 307, headers: { location: "https://auth.x.ai/oauth2/token" } }),
    });
    try {
      await fetch(`http://127.0.0.1:${server.port}/redirect`, { method: "POST", redirect: "error", body: "x=1" });
      throw new Error("fixture server did not redirect");
    } catch (error) {
      return error as Error;
    } finally {
      await server.stop(true);
    }
  }

  /** A stubbed fetch that rejects the token poll with `failure` instead of answering it. */
  function mockRefusingPoll(failure: () => Error): Call[] {
    const calls = mockXai(boundedDevice({ expires_in: 900, interval: 5 }), []);
    const mocked = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === TOKEN) {
        calls.push({ url, body: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
        throw failure();
      }
      return mocked(input, init);
    }) as typeof fetch;
    return calls;
  }

  test("a redirect on the token poll ends the login after one request, with no wait and no secret text", async () => {
    const refusal = await realRedirectRefusal();
    const f = clockFixture();
    try {
      const calls = mockRefusingPoll(() => refusal);
      const error = await loginXaiDevice({ onAuth: () => {} }, { sleep: f.sleep }).catch(e => e);
      expect(error).toBeInstanceOf(XaiRedirectRefusedError);
      // One poll, then the failure. The old branch slept one interval and polled again per tick
      // until `expires_in` elapsed, which is what made this look like a broken network.
      expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);
      expect(f.waits).toEqual([5_000]);
      const text = [
        String(error?.message ?? ""),
        String(error?.cause ?? ""),
        JSON.stringify(error),
        (error as Error).stack ?? "",
      ].join("\n");
      for (const secret of [TOKEN, "dev-1", "ABCD", refusal.message]) expect(text).not.toContain(secret);
    } finally {
      f.clock.mockRestore();
    }
  });

  test("the Node/undici redirect shape is refused, and a real connection failure still retries", async () => {
    // Shape observed from a real Node fetch with `redirect: "error"` (node v26): the top error is
    // `TypeError("fetch failed")` and undici puts `Error("unexpected redirect")` on its cause. Bun
    // reports the same condition as `TypeError` with `code: "UnexpectedRedirect"` (captured above).
    const undiciRefusal = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    const calls = mockRefusingPoll(() => undiciRefusal);
    await expect(loginXaiDevice({}, { sleep: async () => {} })).rejects.toBeInstanceOf(XaiRedirectRefusedError);
    expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);

    // A connection failure is also a TypeError, sometimes with `fetch failed` on top. It must stay
    // retriable: this is the branch the fix must not swallow.
    const refusedConnection = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") });
    const retryCalls = mockXai(boundedDevice({ expires_in: 900, interval: 5 }), []);
    const mocked = globalThis.fetch;
    let polls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== TOKEN) return mocked(input, init);
      polls++;
      if (polls === 1) throw refusedConnection;
      return granted();
    }) as typeof fetch;
    const f = clockFixture();
    try {
      expect(await loginXaiDevice({}, { sleep: f.sleep })).toMatchObject({ access: "access" });
    } finally {
      f.clock.mockRestore();
    }
    // Two polls, one interval apart: the first failure was retried, not classified.
    expect(polls).toBe(2);
    expect(f.waits).toEqual([5_000, 5_000]);
    expect(retryCalls.some(c => c.url === DEVICE)).toBe(true);
  });

  test("a redirect on the device authorization request is refused before the first poll", async () => {
    const refusal = await realRedirectRefusal();
    const calls = mockXai(boundedDevice({ expires_in: 900, interval: 5 }), [granted()]);
    const mocked = globalThis.fetch;
    const deviceRequests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === DEVICE) {
        deviceRequests.push(String(input));
        throw refusal;
      }
      return mocked(input, init);
    }) as typeof fetch;
    await expect(loginXaiDevice({})).rejects.toBeInstanceOf(XaiRedirectRefusedError);
    expect(deviceRequests).toEqual([DEVICE]);
    // The failure precedes authorization, so no token poll was ever issued.
    expect(calls.filter(c => c.url === TOKEN)).toHaveLength(0);
  });

  // ---- 429 Retry-After on a device poll ------------------------------------------------------
  // `postXaiToken` is called with `maxAttempts: 1` here, so its own Retry-After path never runs.
  // The outer loop owns the schedule, and it must honour the server's throttle rather than
  // re-polling on the client interval; it is still bounded by the grant deadline.
  const throttled = (retryAfter: string) => new Response("", { status: 429, headers: { "retry-after": retryAfter } });

  test("slow_down with 429 respects Retry-After and retains the increased interval", async () => {
    const f = clockFixture();
    try {
      mockXai(boundedDevice({ expires_in: 900, interval: 1 }), [
        Response.json({ error: "slow_down" }, { status: 429, headers: { "retry-after": "60" } }),
        pending(), granted(),
      ]);
      await loginXaiDevice({}, { sleep: f.sleep });
      expect(f.waits).toEqual([1_000, 60_000, 6_000]);
    } finally { f.clock.mockRestore(); }
  });

  test("400 slow_down honors Retry-After for one poll and retains its interval", async () => {
    const f = clockFixture();
    try {
      mockXai(boundedDevice({ expires_in: 900, interval: 1 }), [
        Response.json({ error: "slow_down" }, { status: 400, headers: { "retry-after": "60" } }),
        pending(), granted(),
      ]);
      await loginXaiDevice({}, { sleep: f.sleep });
      expect(f.waits).toEqual([1_000, 60_000, 6_000]);
    } finally { f.clock.mockRestore(); }
  });

  test("400 slow_down throttle remains cancellable", async () => {
    const cancel = new AbortController();
    const calls = mockXai(boundedDevice({ expires_in: 900, interval: 1 }), [
      Response.json({ error: "slow_down" }, { status: 400, headers: { "retry-after": "60" } }), granted(),
    ]);
    const waits: number[] = [];
    await expect(loginXaiDevice({ signal: cancel.signal }, { sleep: async ms => {
      waits.push(ms); if (waits.length === 2) { cancel.abort(); throw cancel.signal.reason; }
    } })).rejects.toBeDefined();
    expect(waits).toEqual([1_000, 60_000]);
    expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);
  });

  test("slow_down with malformed throttle uses its persistent interval", async () => {
    const f = clockFixture();
    try {
      mockXai(boundedDevice({ expires_in: 900, interval: 1 }), [
        Response.json({ error: "slow_down" }, { status: 429, headers: { "retry-after": "soon" } }), granted(),
      ]);
      await loginXaiDevice({}, { sleep: f.sleep });
      expect(f.waits).toEqual([1_000, 6_000]);
    } finally { f.clock.mockRestore(); }
  });

  test("slow_down throttle cannot poll after the grant deadline", async () => {
    const f = clockFixture();
    try {
      const calls = mockXai(boundedDevice({ expires_in: 10, interval: 1 }), [
        Response.json({ error: "slow_down" }, { status: 429, headers: { "retry-after": "60" } }),
      ]);
      await expect(loginXaiDevice({}, { sleep: f.sleep })).rejects.toMatchObject({ oauthError: "slow_down", status: 429 });
      expect(f.waits).toEqual([1_000, 9_000]);
      expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);
    } finally { f.clock.mockRestore(); }
  });

  test("cancellation during a slow_down throttle does not issue another poll", async () => {
    const cancel = new AbortController();
    const calls = mockXai(boundedDevice({ expires_in: 900, interval: 1 }), [
      Response.json({ error: "slow_down" }, { status: 429, headers: { "retry-after": "60" } }),
    ]);
    const waits: number[] = [];
    await expect(loginXaiDevice({ signal: cancel.signal }, { sleep: async ms => {
      waits.push(ms); if (waits.length === 2) { cancel.abort(); throw cancel.signal.reason; }
    } })).rejects.toBeDefined();
    expect(waits).toEqual([1_000, 60_000]);
    expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);
  });

  test("a 429 Retry-After delay beyond the poll interval is honored", async () => {
    const f = clockFixture();
    try {
      mockXai(boundedDevice({ expires_in: 900, interval: 5 }), [throttled("30"), granted()]);
      expect(await loginXaiDevice({}, { sleep: f.sleep })).toMatchObject({ access: "access" });
      // 30s from the header, not the 5s interval: earlier would re-poll inside the throttle.
      expect(f.waits).toEqual([5_000, 30_000]);
    } finally {
      f.clock.mockRestore();
    }
  });

  test("a 5xx Retry-After shares the throttle path rather than only the interval", async () => {
    const f = clockFixture();
    try {
      // A 503 is retried too; the server's throttle on it must not be dropped just because the
      // status is not 429. Both share one branch, and this case pins that.
      mockXai(boundedDevice({ expires_in: 900, interval: 5 }), [
        new Response("", { status: 503, headers: { "retry-after": "20" } }), granted(),
      ]);
      expect(await loginXaiDevice({}, { sleep: f.sleep })).toMatchObject({ access: "access" });
      expect(f.waits).toEqual([5_000, 20_000]);
    } finally {
      f.clock.mockRestore();
    }
  });

  test("a 429 Retry-After HTTP-date is honored", async () => {
    const f = clockFixture();
    try {
      // Relative to the loop's own clock, which the fixture advances.
      const date = () => new Date(f.now.peek() + 45_000).toUTCString();
      const calls = mockXai(boundedDevice({ expires_in: 900, interval: 5 }), []);
      const mocked = globalThis.fetch;
      let polls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== TOKEN) return mocked(input, init);
        polls++;
        return polls === 1 ? new Response("", { status: 429, headers: { "retry-after": date() } }) : granted();
      }) as typeof fetch;
      expect(await loginXaiDevice({}, { sleep: f.sleep })).toMatchObject({ access: "access" });
      expect(calls.length).toBeGreaterThan(0);
      expect(f.waits).toEqual([5_000, 45_000]);
    } finally {
      f.clock.mockRestore();
    }
  });

  test("a malformed or oversized Retry-After cannot shrink the wait, overflow a timer, or hot-loop", async () => {
    // Malformed: the header is ignored and the client interval still applies.
    const malformed = clockFixture();
    try {
      mockXai(boundedDevice({ expires_in: 12, interval: 5 }), [throttled("soon"), granted()]);
      await loginXaiDevice({}, { sleep: malformed.sleep });
      expect(malformed.waits).toEqual([5_000, 5_000]);
    } finally {
      malformed.clock.mockRestore();
    }
    // Oversized: 100,000s would overflow `setTimeout` into a next-tick fire. It is bounded by the
    // grant lifetime, so the login waits out the grant and expires instead of polling hot.
    const oversized = clockFixture();
    try {
      mockXai(boundedDevice({ expires_in: 60, interval: 5 }), [throttled("100000")]);
      const error = await loginXaiDevice({}, { sleep: oversized.sleep }).catch(e => e);
      expect(classifyLoginCodeError(error)).toBe("provider_unreachable");
      expect(oversized.waits).toEqual([5_000, 55_000]);
      expect(oversized.waits.every(ms => ms <= 2 ** 31 - 1)).toBe(true);
    } finally {
      oversized.clock.mockRestore();
    }
  });

  test("numeric Retry-After overflow waits for expiry across retriable poll responses", async () => {
    for (const [status, body] of [[400, { error: "slow_down" }], [429, { error: "slow_down" }], [429, {}], [503, {}]] as const) {
      const f = clockFixture();
      try {
        const calls = mockXai(boundedDevice({ expires_in: 10, interval: 1 }), [
          Response.json(body, { status, headers: { "retry-after": "9".repeat(310) } }), granted(),
        ]);
        const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
        expect(classifyLoginCodeError(error)).toBe(status === 400 ? "invalid_or_expired_code" : "provider_unreachable");
        expect(f.waits).toEqual([1_000, 9_000]);
        expect(f.waits.every(ms => Number.isFinite(ms) && ms <= 2 ** 31 - 1)).toBe(true);
        expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);
      } finally { f.clock.mockRestore(); }
    }
  });

  test("cancellation during an overflow throttle prevents another poll", async () => {
    const cancel = new AbortController();
    const calls = mockXai(boundedDevice({ expires_in: 10, interval: 1 }), [throttled("9".repeat(310)), granted()]);
    const waits: number[] = [];
    await expect(loginXaiDevice({ signal: cancel.signal }, { sleep: async ms => {
      waits.push(ms); if (waits.length === 2) { cancel.abort(); throw cancel.signal.reason; }
    } })).rejects.toBeDefined();
    expect(waits).toEqual([1_000, 10_000]);
    expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);
  });

  test("a Retry-After past the grant deadline ends the login instead of polling after it", async () => {
    const f = clockFixture();
    try {
      const calls = mockXai(boundedDevice({ expires_in: 60, interval: 5 }), [throttled("120")]);
      const error = await loginXaiDevice({}, { sleep: f.sleep }).catch(e => e);
      expect(classifyLoginCodeError(error)).toBe("provider_unreachable");
      // One poll; the throttle outlives the grant, so there is nothing left to wait for.
      expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);
      expect(f.waits).toEqual([5_000, 55_000]);
    } finally {
      f.clock.mockRestore();
    }
  });

  test("cancellation during a Retry-After wait rejects without another poll", async () => {
    const cancel = new AbortController();
    const calls = mockXai(boundedDevice({ expires_in: 900, interval: 5 }), [throttled("120")]);
    const sleeps: number[] = [];
    const error = await loginXaiDevice({ signal: cancel.signal }, {
      sleep: async ms => { sleeps.push(ms); if (sleeps.length > 1) { cancel.abort(); throw cancel.signal.reason; } },
    }).catch(e => e);
    expect(error).toBeDefined();
    expect(calls.filter(c => c.url === TOKEN)).toHaveLength(1);
    expect(sleeps).toEqual([5_000, 120_000]);
  });

  test("an issuer without device authorization, or a verification URL off x.ai, is refused", async () => {
    mockXai({}, [], { authorization_endpoint: "https://auth.x.ai/oauth2/authorize", token_endpoint: TOKEN });
    await expect(loginXaiDevice({})).rejects.toThrow(/does not advertise device authorization/);
    mockXai({ device_code: "d", user_code: "u", verification_uri: "https://evil.example/device" }, []);
    await expect(loginXaiDevice({})).rejects.toThrow(/unexpected endpoint/);
  });
});
