import { afterEach, expect, test } from "bun:test";
import {
  createOfflineResendWait, resolveOfflineResendWaitMs, setOfflineResendDependenciesForTests,
} from "../../src/lib/offline-resend";
import { fetchWithResetRetry } from "../../src/lib/upstream-retry";
import { handleResponses } from "../../src/server/responses";
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

/** A DNS probe that fails `failures` times, and a clock that advances only by the waited delays. */
function probes(failures: number) {
  let clock = 0;
  const lookups: string[] = [];
  const delays: number[] = [];
  setOfflineResendDependenciesForTests({
    resolveHost: async host => { lookups.push(host); if (lookups.length <= failures) throw offline(); },
    delay: async ms => { delays.push(ms); clock += ms; },
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

test("only one resend per request: a second offline failure is returned", async () => {
  probes(0);
  let sends = 0;
  const failure = fetchWithResetRetry(async () => { sends += 1; throw offline(); },
    { attempts: 3, offlineWait: createOfflineResendWait("https://gateway.example/v1/responses", 30_000) });
  await expect(failure).rejects.toMatchObject({ code: "ENOTFOUND" });
  expect(sends).toBe(2);
});

test("no resend without send budget, for a failure after connect, or after a client abort", async () => {
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
    delay: async () => {}, now: () => 0,
  });
  sends = 0;
  await expect(fetchWithResetRetry(async () => { sends += 1; throw offline(); },
    { attempts: 3, abortSignal: abort.signal, offlineWait: createOfflineResendWait(url, 30_000) }))
    .rejects.toMatchObject({ name: "AbortError" });
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
  ["off by default", undefined, { status: 502, sends: 1 }],
  ["opted in", 30, { status: 200, sends: 2 }],
] as const) {
  test(`native Responses passthrough after an offline DNS failure: ${label}`, async () => {
    release = acquireOwnedSpendHome();
    probes(1);
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      if (sends === 1) throw offline();
      return Response.json(completed);
    }) as unknown as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/probe", input: "hello", stream: false, store: false }),
    }), nativeConfig(offlineResendWaitSec), { model: "", provider: "" });
    expect(response.status).toBe(expected.status);
    expect(sends).toBe(expected.sends);
    if (expected.status === 200) expect(await response.text()).toContain("BACK_ONLINE");
  });
}
test("a translated Chat route waits and resends once when opted in", async () => {
  release = acquireOwnedSpendHome();
  probes(1);
  let sends = 0;
  globalThis.fetch = (async () => {
    sends += 1;
    if (sends === 1) throw offline();
    return Response.json({ id: "chat_1", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: "BACK_ONLINE" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }) as unknown as typeof fetch;
  const cfg = nativeConfig(30);
  (cfg.providers.fixture as { adapter: string }).adapter = "openai-chat";
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/probe", input: "hello", stream: false }),
  }), cfg, { model: "", provider: "" });
  expect(response.status).toBe(200);
  expect(sends).toBe(2);
  expect(await response.text()).toContain("BACK_ONLINE");
});
