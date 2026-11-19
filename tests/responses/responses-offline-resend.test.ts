import { afterEach, expect, spyOn, test } from "bun:test";
import {
  createOfflineResendWait, offlineResendProbeUrl, resolveOfflineResendWaitMs, setOfflineResendDependenciesForTests,
} from "../../src/lib/offline-resend";
import { markEgressTransparentExecutor } from "../../src/lib/provider-egress";
import { classifyTransportFailureKind } from "../../src/lib/upstream-reachability";
import { causeForRecoveryKind } from "../../src/lib/request-failure-model";
import {
  applyUpstreamRecoveryInit, fetchWithResetRetry, fetchWithTransientRetry, type UpstreamSendRecovery,
} from "../../src/lib/upstream-retry";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// #7958: an opt-in wait (default off) for reachability after a pre-connect DNS/connect failure,
// then one resend under the existing send budget.
const originalFetch = globalThis.fetch;
let release: (() => void) | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setOfflineResendDependenciesForTests(undefined);
  release?.();
  release = undefined;
});

const offline = () => Object.assign(new TypeError("getaddrinfo ENOTFOUND gateway.example"), { code: "ENOTFOUND" });

/** An expiry that never fires on its own and rejects only when its signal aborts. */
const neverExpires = (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
  signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
});

/** A DNS probe that fails `failures` times, and a clock that advances only by the waited delays. */
function probes(failures: number) {
  let clock = 0;
  const lookups: string[] = [];
  const delays: number[] = [];
  setOfflineResendDependenciesForTests({
    resolveHost: async host => { lookups.push(host); if (lookups.length <= failures) throw offline(); },
    delay: async ms => { delays.push(ms); clock += ms; },
    expire: neverExpires,
    now: () => clock,
  });
  return { lookups, delays };
}

test("the wait is off unless a positive number of seconds is configured, and is capped at 300 s", () => {
  for (const value of [undefined, 0, -1, Number.NaN, "30"]) expect(resolveOfflineResendWaitMs(value)).toBe(0);
  expect(resolveOfflineResendWaitMs(1.5)).toBe(1_500);
  expect(resolveOfflineResendWaitMs(9_999)).toBe(300_000);
  expect(createOfflineResendWait("https://gateway.example/v1/responses", 0)).toBeUndefined();
});

test("a pre-connect failure waits for DNS, resends once, and the resend counts against the budget", async () => {
  const { lookups, delays } = probes(2);
  let sends = 0;
  const consumed: number[] = [];
  const response = await fetchWithResetRetry(async () => {
    sends += 1;
    if (sends === 1) throw offline();
    return new Response("ok");
  }, { attempts: 3, onSendsConsumed: count => consumed.push(count),
    offlineWait: createOfflineResendWait("https://gateway.example/v1/responses", 30_000) });
  expect(await response.text()).toBe("ok");
  expect(sends).toBe(2);
  expect(consumed).toEqual([1, 1]);
  expect(lookups).toEqual(["gateway.example", "gateway.example", "gateway.example"]);
  expect(delays).toEqual([1_000, 1_000]);
});

test("the wait ends at its limit and keeps the original failure", async () => {
  const { delays } = probes(Number.POSITIVE_INFINITY);
  let sends = 0;
  const failure = fetchWithResetRetry(async () => { sends += 1; throw offline(); },
    { attempts: 3, offlineWait: createOfflineResendWait("https://gateway.example/v1/responses", 2_500) });
  await expect(failure).rejects.toMatchObject({ code: "ENOTFOUND" });
  expect(sends).toBe(1);
  expect(delays).toEqual([1_000, 1_000, 500]);
});

for (const retry of [fetchWithResetRetry, fetchWithTransientRetry]) {
  for (const exhaustedAt of ["send", "wait", "admission"] as const) {
    test(`${retry.name}: offline resend keeps the original error when allowance ends at ${exhaustedAt}`, async () => {
      const original = offline();
      let remaining = 2;
      let sends = 0;
      let waits = 0;
      let claims = 0;
      await expect(retry(async () => {
        sends++;
        if (exhaustedAt === "send") remaining = 0;
        throw original;
      }, {
        attempts: 2,
        remainingSends: () => remaining,
        onSendsConsumed: Object.assign(() => {}, { beforeSend: () => ++claims === 1 }),
        offlineWait: async () => {
          waits++;
          if (exhaustedAt === "wait") remaining = 0;
          return true;
        },
      })).rejects.toBe(original);
      expect(sends).toBe(1);
      expect(waits).toBe(exhaustedAt === "send" ? 0 : 1);
      expect(claims).toBe(exhaustedAt === "admission" ? 2 : 1);
    });
  }
}

test("only one resend per request: a second offline failure is returned", async () => {
  probes(0);
  let sends = 0;
  const failure = fetchWithResetRetry(async () => { sends += 1; throw offline(); },
    { attempts: 3, offlineWait: createOfflineResendWait("https://gateway.example/v1/responses", 30_000) });
  await expect(failure).rejects.toMatchObject({ code: "ENOTFOUND" });
  expect(sends).toBe(2);
});

test("no resend without send budget, for a failure after connect, or after a client abort (original error kept)", async () => {
  probes(0);
  const url = "https://gateway.example/v1/responses";
  let sends = 0;
  await expect(fetchWithResetRetry(async () => { sends += 1; throw offline(); },
    { attempts: 1, offlineWait: createOfflineResendWait(url, 30_000) })).rejects.toMatchObject({ code: "ENOTFOUND" });
  expect(sends).toBe(1);
  sends = 0;
  const tls = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
  await expect(fetchWithResetRetry(async () => { sends += 1; throw tls; },
    { attempts: 3, offlineWait: createOfflineResendWait(url, 30_000) })).rejects.toBe(tls);
  expect(sends).toBe(1);
  const abort = new AbortController();
  setOfflineResendDependenciesForTests({
    resolveHost: async () => { abort.abort(new DOMException("client gone", "AbortError")); throw offline(); },
    delay: async () => {}, expire: neverExpires, now: () => 0,
  });
  sends = 0;
  const original = offline();
  await expect(fetchWithResetRetry(async () => { sends += 1; throw original; },
    { attempts: 3, abortSignal: abort.signal, offlineWait: createOfflineResendWait(url, 30_000) }))
    .rejects.toBe(original);
  expect(sends).toBe(1);
});

function nativeConfig(offlineResendWaitSec?: number): OcxConfig {
  return {
    port: 0, defaultProvider: "fixture",
    ...(offlineResendWaitSec === undefined ? {} : { offlineResendWaitSec }),
    providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "fixture-key",
      baseUrl: "https://gateway.example/v1", models: ["probe"] } },
  } as unknown as OcxConfig;
}

const completed = { id: "resp_fixture", object: "response", status: "completed", model: "probe",
  output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "BACK_ONLINE", annotations: [] }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };

for (const [label, offlineResendWaitSec, expected] of [
  ["off by default", undefined, { status: 502, sends: 1, recoveryKinds: [] }],
  ["opted in", 30, { status: 200, sends: 2, recoveryKinds: ["offline-resend"] }],
] as const) {
  test(`native Responses passthrough after an offline DNS failure: ${label}`, async () => {
    release = acquireOwnedSpendHome();
    probes(1);
    let sends = 0;
    const keepalive: unknown[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sends += 1;
      keepalive.push(init?.keepalive);
      if (sends === 1) throw offline();
      return Response.json(completed);
    }) as unknown as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/probe", input: "hello", stream: false, store: false }),
    }), nativeConfig(offlineResendWaitSec), logCtx);
    expect(response.status).toBe(expected.status);
    expect(sends).toBe(expected.sends);
    if (expected.status === 200) expect(await response.text()).toContain("BACK_ONLINE");
    // The resend is logged as its own recovery, not a connection reset, and opens a fresh socket.
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([...expected.recoveryKinds]);
    if (expected.sends === 2) expect(keepalive).toEqual([undefined, false]);
  });
}
test("a translated Chat route waits and resends once when opted in", async () => {
  release = acquireOwnedSpendHome();
  probes(1);
  let sends = 0;
  const keepalive: unknown[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sends += 1;
    keepalive.push(init?.keepalive);
    if (sends === 1) throw offline();
    return Response.json({ id: "chat_1", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: "BACK_ONLINE" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }) as unknown as typeof fetch;
  const cfg = nativeConfig(30);
  (cfg.providers.fixture as { adapter: string }).adapter = "openai-chat";
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/probe", input: "hello", stream: false }),
  }), cfg, logCtx);
  expect(response.status).toBe(200);
  expect(sends).toBe(2);
  expect(await response.text()).toContain("BACK_ONLINE");
  expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["offline-resend"]);
  expect(keepalive).toEqual([undefined, false]);
});

// A proxied send resolves the proxy's name, not the provider's, so that is the name the wait probes.
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;
for (const [label, route, env, expected] of [
  ["a provider proxy", { proxy: "http://proxy.corp.example:3128" }, {}, { probed: "proxy.corp.example", sends: 2 }],
  ["the global HTTPS_PROXY", {}, { HTTPS_PROXY: "http://envproxy.example:8080" }, { probed: "envproxy.example", sends: 2 }],
  ["a provider noProxy exemption", { noProxy: "gateway.example" }, { HTTPS_PROXY: "http://envproxy.example:8080" }, { probed: "gateway.example", sends: 2 }],
  ["a provider pinned direct", { proxy: null }, { HTTPS_PROXY: "http://envproxy.example:8080" }, { probed: "gateway.example", sends: 2 }],
  ["an IP-literal proxy", { proxy: "http://127.0.0.1:7890" }, {}, { probed: undefined, sends: 1 }],
] as const) {
  test(`the wait probes the name the send resolves: ${label}`, async () => {
    const saved = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
    try {
      for (const key of PROXY_ENV_KEYS) delete process.env[key];
      Object.assign(process.env, env);
      release = acquireOwnedSpendHome();
      const { lookups } = probes(0);
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        if (sends === 1) throw offline();
        return Response.json(completed);
      }) as unknown as typeof fetch;
      const cfg = nativeConfig(30);
      Object.assign(cfg.providers.fixture!, route);
      await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/probe", input: "hello", stream: false, store: false }),
      }), cfg, { model: "", provider: "" });
      expect(lookups[0]).toBe(expected.probed);
      expect(sends).toBe(expected.sends);
    } finally {
      for (const key of PROXY_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
}

// OpenCodex installs its own transparent fetch wrappers (xAI, Mistral Chat); only an executor that
// picks its own route leaves the probed name unknown.
test("a built-in transparent fetch wrapper keeps the wait; a caller-supplied executor gets none", () => {
  // Pinned direct, so an ambient HTTPS_PROXY cannot turn the expected probe into the proxy's.
  const provider = { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", models: ["probe"], proxy: null } as const;
  const transparent = markEgressTransparentExecutor((async () => new Response("ok")) as unknown as typeof fetch);
  const own = (async () => new Response("ok")) as unknown as typeof fetch;
  expect(offlineResendProbeUrl("fixture", { ...provider, fetch: transparent } as never, url)).toBe(url);
  expect(offlineResendProbeUrl("fixture", { ...provider, fetch: own } as never, url)).toBeUndefined();
});

test("an xAI route, sent through its built-in transport wrapper, waits and resends once", async () => {
  const saved = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  try {
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
    release = acquireOwnedSpendHome();
    const { lookups } = probes(0);
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) throw offline();
      return Response.json(completed);
    }) as unknown as typeof fetch;
    // The wrapper is installed by provider name, so the route must be the `xai` provider itself.
    const cfg = nativeConfig(30);
    cfg.providers = { xai: { ...cfg.providers.fixture!, baseUrl: "https://api.x.ai/v1" } };
    cfg.defaultProvider = "xai";
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "xai/probe", input: "hello", stream: false, store: false }),
    }), cfg, { model: "", provider: "" });
    expect(lookups[0]).toBe("api.x.ai");
    expect(sends).toBe(2);
    expect(response.status).toBe(200);
  } finally {
    for (const key of PROXY_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
const url = "https://gateway.example/v1/responses";

test("a DNS probe that never settles ends at the wait limit and keeps the original failure", async () => {
  const expiries: number[] = [];
  setOfflineResendDependenciesForTests({
    resolveHost: () => new Promise(() => {}),
    delay: async () => {}, expire: async ms => { expiries.push(ms); }, now: () => 0,
  });
  let sends = 0;
  await expect(fetchWithResetRetry(async () => { sends += 1; throw offline(); },
    { attempts: 3, offlineWait: createOfflineResendWait(url, 5_000) })).rejects.toMatchObject({ code: "ENOTFOUND" });
  expect(sends).toBe(1);
  expect(expiries).toEqual([5_000]);
});

test("cancelling the client during a stalled DNS probe ends the wait at once with the original error", async () => {
  const abort = new AbortController();
  setOfflineResendDependenciesForTests({
    resolveHost: () => { queueMicrotask(() => abort.abort(new DOMException("client gone", "AbortError"))); return new Promise(() => {}); },
    delay: async () => {}, expire: neverExpires, now: () => 0,
  });
  let sends = 0;
  const original = offline();
  await expect(fetchWithResetRetry(async () => { sends += 1; throw original; },
    { attempts: 3, abortSignal: abort.signal, offlineWait: createOfflineResendWait(url, 5_000) }))
    .rejects.toBe(original);
  expect(sends).toBe(1);
});

test("cancelling between probes keeps the DNS error, so a pool send stays host-wide connect_neutral", async () => {
  // The real abortable delay between probes: only the probe and the expiry are faked.
  setOfflineResendDependenciesForTests({ resolveHost: async () => { throw offline(); }, expire: neverExpires });
  const abort = new AbortController();
  const original = offline();
  let sends = 0;
  const failure = fetchWithTransientRetry(async () => { sends += 1; throw original; },
    { attempts: 3, abortSignal: abort.signal, offlineWait: createOfflineResendWait(url, 30_000) });
  setTimeout(() => abort.abort(new DOMException("client gone", "AbortError")), 20);
  const rejection = await failure.then(() => undefined, (error: unknown) => error);
  expect(rejection).toBe(original);
  expect(sends).toBe(1);
  // What passthrough-dispatch charges the failure to: the host, never the account.
  expect(classifyTransportFailureKind(rejection)).toBe("connect_neutral");
  expect(classifyTransportFailureKind(new DOMException("client gone", "AbortError"))).toBe("connect_error");
});

test("a DNS answer that lands after the client left does not resend", async () => {
  const abort = new AbortController();
  setOfflineResendDependenciesForTests({
    resolveHost: async () => { abort.abort(new DOMException("client gone", "AbortError")); },
    delay: async () => {}, expire: neverExpires, now: () => 0,
  });
  const original = offline();
  let sends = 0;
  await expect(fetchWithResetRetry(async () => { sends += 1; throw original; },
    { attempts: 3, abortSignal: abort.signal, offlineWait: createOfflineResendWait(url, 5_000) })).rejects.toBe(original);
  expect(sends).toBe(1);
});

test("the offline resend reports its own recovery kind, and a later reset retry still reports connection-reset", async () => {
  probes(0);
  const recoveries: Array<UpstreamSendRecovery | undefined> = [];
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const response = await fetchWithResetRetry(async recovery => {
    recoveries.push(recovery);
    if (recoveries.length === 1) throw offline();
    if (recoveries.length === 2) throw reset;
    return new Response("ok");
  }, { attempts: 3, replaySafe: true, offlineWait: createOfflineResendWait(url, 30_000) });
  expect(await response.text()).toBe("ok");
  expect(recoveries).toEqual([undefined, "offline-resend", "connection-reset"]);
  // Nothing reached the origin before an offline resend: the cause is unsent, never ambiguous.
  expect(causeForRecoveryKind("offline-resend")).toBe("transport-unsent");
  // A fresh DNS answer means pooled sockets predate the outage, so the resend opts out of keep-alive.
  const init = applyUpstreamRecoveryInit({ method: "POST" }, "offline-resend");
  expect(init.keepalive).toBe(false);
  expect(init.headers.get("connection")).toBe("close");
});

test("a DNS answer that arrives after the wait limit does not authorize a resend", async () => {
  let clock = 0;
  setOfflineResendDependenciesForTests({
    resolveHost: async () => { clock += 5_001; },
    delay: async () => {}, expire: neverExpires, now: () => clock,
  });
  let sends = 0;
  await expect(fetchWithResetRetry(async () => { sends += 1; throw offline(); },
    { attempts: 3, offlineWait: createOfflineResendWait(url, 5_000) })).rejects.toMatchObject({ code: "ENOTFOUND" });
  expect(sends).toBe(1);
});

test("time spent waiting offline does not make the resend count as a slow attempt", async () => {
  let clock = 1_000_000;
  const clockSpy = spyOn(Date, "now").mockImplementation(() => clock);
  setOfflineResendDependenciesForTests({
    resolveHost: (() => { let probes = 0; return async () => { probes += 1; if (probes === 1) throw offline(); }; })(),
    delay: async ms => { clock += ms; }, expire: neverExpires, now: () => clock,
  });
  try {
    const statuses: number[] = [];
    const response = await fetchWithTransientRetry(async () => {
      if (statuses.length === 0) { statuses.push(0); throw offline(); }
      const status = statuses.length === 1 ? 503 : 200;
      statuses.push(status);
      return new Response("x", { status });
    }, { attempts: 3, slowAttemptMs: 500, offlineWait: createOfflineResendWait(url, 30_000) });
    // The 503 after a 1 s offline wait is still retried: the slow clock restarted at the resend.
    expect(response.status).toBe(200);
    expect(statuses).toEqual([0, 503, 200]);
  } finally { clockSpy.mockRestore(); }
});
test("only a DNS resolution failure waits; refused, unreachable and IP-literal failures return at once", async () => {
  const { lookups } = probes(0);
  for (const code of ["ECONNREFUSED", "ConnectionRefused", "ENETUNREACH", "EHOSTUNREACH"]) {
    let sends = 0;
    const error = Object.assign(new TypeError(`connect ${code}`), { code });
    await expect(fetchWithResetRetry(async () => { sends += 1; throw error; },
      { attempts: 3, offlineWait: createOfflineResendWait(url, 30_000) })).rejects.toBe(error);
    expect(sends).toBe(1);
  }
  // An IP literal needs no DNS, so DNS answering proves nothing about it.
  expect(createOfflineResendWait("https://203.0.113.7/v1/responses", 30_000)).toBeUndefined();
  expect(createOfflineResendWait("http://[2001:db8::1]:8080/v1/responses", 30_000)).toBeUndefined();
  expect(lookups).toEqual([]);
  let sends = 0;
  const dnsAgain = Object.assign(new TypeError("getaddrinfo EAI_AGAIN gateway.example"), { code: "EAI_AGAIN" });
  await fetchWithResetRetry(async () => { sends += 1; if (sends === 1) throw dnsAgain; return new Response("ok"); },
    { attempts: 3, offlineWait: createOfflineResendWait(url, 30_000) });
  expect(sends).toBe(2);
});

test("the wait belongs to the first send only; a later transient-5xx leg never waits", async () => {
  const { lookups } = probes(0);
  const sends: Array<number | "offline"> = [];
  const failure = fetchWithTransientRetry(async () => {
    if (sends.length === 0) { sends.push(503); return new Response("x", { status: 503 }); }
    sends.push("offline");
    throw offline();
  }, { attempts: 4, offlineWait: createOfflineResendWait(url, 30_000) });
  await expect(failure).rejects.toBeDefined();
  expect(sends).toEqual([503, "offline"]);
  expect(lookups).toEqual([]);
});

test("a combo fails over instead of waiting once per target", async () => {
  release = acquireOwnedSpendHome();
  const { lookups } = probes(0);
  const hosts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    hosts.push(host);
    if (host === "down.example") throw offline();
    return Response.json(completed);
  }) as unknown as typeof fetch;
  const target = (name: string) => ({ adapter: "openai-responses", authMode: "key", apiKey: "fixture-key",
    baseUrl: `https://${name}.example/v1`, models: ["probe"] });
  const cfg = { port: 0, defaultProvider: "down", offlineResendWaitSec: 30,
    providers: { down: target("down"), up: target("up") },
    combos: { pair: { strategy: "failover", targets: [{ provider: "down", model: "probe" }, { provider: "up", model: "probe" }] } },
  } as unknown as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/pair", input: "hello", stream: false, store: false }),
  }), cfg, { model: "", provider: "" });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("BACK_ONLINE");
  // No DNS wait and no resend to the unreachable member: the combo moved on to the reachable one.
  expect(lookups).toEqual([]);
  expect(hosts).toEqual(["down.example", "up.example"]);
});
