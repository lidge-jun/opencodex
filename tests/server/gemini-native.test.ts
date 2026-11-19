import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as oauthStore from "../../src/oauth/store";
import type { OcxConfig } from "../../src/types";
import { handleGeminiNative, type GeminiNativeDeps } from "../../src/server/gemini-native";
import { getActiveTurnCount, tryAdmitTurn } from "../../src/server/lifecycle";
import { rawJsonMember } from "../../src/server/gemini-native-wire";
import type { OAuthAccessSnapshot } from "../../src/oauth";

const config = { providers: { "google-antigravity": { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" } } } as OcxConfig;
const old: OAuthAccessSnapshot = { provider: "google-antigravity", accountId: "fixture-account", generation: "old", accessToken: "fixture-old-token", projectId: "fixture-project" };
const fresh = { ...old, generation: "new", accessToken: "fixture-new-token" };
const fixtureAccount = () => ({
  credential: {
    access: old.accessToken, refresh: "fixture-refresh", expires: Date.now() + 3600_000,
    projectId: old.projectId, accountId: "fixture-google-subject",
  },
  paused: false, needsReauth: false,
});
let accountStatus: ReturnType<typeof oauthStore.getAccountCredentialWithStatus>;
let accountStatusSpy: ReturnType<typeof spyOn<typeof oauthStore, "getAccountCredentialWithStatus">>;
beforeEach(() => { accountStatus = fixtureAccount(); accountStatusSpy = spyOn(oauthStore, "getAccountCredentialWithStatus").mockImplementation(() => accountStatus); });
afterEach(() => accountStatusSpy.mockRestore());

function request(body = '{"contents":[],"future":9007199254740993123}', signal?: AbortSignal) {
  return new Request("http://localhost/v1beta/models/gemini-test:generateContent", { method: "POST", body, signal, headers: { Authorization: "Bearer fixture-client-key" } });
}
function transport(fn: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return Object.assign((url: RequestInfo | URL, init?: RequestInit) => Promise.resolve(fn(String(url), init!)), { preconnect: fetch.preconnect }) as typeof fetch;
}
async function run(req: Request, deps: GeminiNativeDeps, stream: boolean | "array" = false, cfg = config) {
  const lease = tryAdmitTurn(undefined, req.signal)!;
  try { return await handleGeminiNative(req, cfg, "gemini-test", stream === "array" ? stream : stream ? "sse" : undefined, lease, deps); }
  finally { if (!lease.isTransferred()) lease.release(); }
}
test("native generation preserves source JSON, binds project and replaces ingress credentials", async () => {
  const baseline = getActiveTurnCount();
  const raw = '{"contents":[],"future":9007199254740993123}';
  const response = await run(request(raw), {
    access: async () => old, refresh: async () => { throw new Error("unexpected refresh"); },
    fetch: transport((url, init) => {
      expect(url).toEndWith("/v1internal:generateContent");
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-old-token");
      expect(rawJsonMember(String(init.body), "request")).toBe(raw);
      expect(JSON.parse(String(init.body)).project).toBe("fixture-project");
      return new Response('{"response":{"future":9007199254740993123}}');
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"future":9007199254740993123}');
  expect(getActiveTurnCount()).toBe(baseline);
});

const fixtureCredentials = [
  { name: "access token", wire: old.accessToken },
  { name: "project ID", wire: old.projectId! },
  { name: "refresh token", wire: fixtureAccount().credential.refresh },
  { name: "account identity", wire: fixtureAccount().credential.accountId },
  { name: "JSON-escaped project ID", wire: "\\u0066ixture-project" },
];
const finishedPayload = '{ "candidates": [{"finishReason":"STOP"}], "future":9007199254740993123 }';
const safeUpstreamError = { error: { code: 502, message: "Antigravity upstream rejected the request", status: "UNAVAILABLE" } };
const safeInBandUpstreamError = { error: { ...safeUpstreamError.error, status: "INTERNAL" } };
const event = (response: string) => `data: {"response":${response}}\n\n`;
const fixtureChunk = (text: string) => new TextEncoder().encode(text);

for (const { name, wire } of fixtureCredentials) {
  const payload = `{"future":[{"text":"prefix ${wire} suffix","text":"replacement"}]}`;
  test(`buffered native success rejects an echoed ${name}`, async () => {
    const response = await run(request(), {
      access: async () => old, refresh: async () => fresh,
      fetch: transport(() => new Response(`{"response":${payload}}`)),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(safeUpstreamError);
  });

  for (const format of ["sse", "array"] as const) {
    test(`native ${format} rejects an echoed ${name} split across transport chunks`, async () => {
      const frame = event(payload);
      const split = frame.indexOf(wire) + Math.floor(wire.length / 2);
      const response = await run(request(), {
        access: async () => old, refresh: async () => fresh,
        fetch: transport(() => new Response(new ReadableStream({
          start(controller) {
            for (const chunk of [event(finishedPayload), frame.slice(0, split), frame.slice(split)]) {
              controller.enqueue(fixtureChunk(chunk));
            }
            controller.close();
          },
        }))),
      }, format === "array" ? format : true);
      const prefix = format === "sse" ? `data: ${finishedPayload}\n\n` : `[\n${finishedPayload},\n`;
      const error = JSON.stringify(safeInBandUpstreamError);
      expect(await response.text()).toBe(prefix + (format === "sse" ? `data: ${error}\n\n` : `${error}\n]`));
    });
  }
}

for (const format of ["sse", "array"] as const) {
  for (const terminal of ["DONE", "in-band error"] as const) {
    test(`native ${format} stops at ${terminal} and cancels the open upstream`, async () => {
      const baseline = getActiveTurnCount();
      let cancelled = false;
      const terminalEvent = terminal === "DONE" ? "data: [DONE]\n\n" : event('{"error":{"message":"private upstream diagnostic"}}');
      const late = event('{"candidates":[{"finishReason":"STOP"}],"text":"late success"}');
      const response = await run(request(), {
        access: async () => old, refresh: async () => fresh,
        fetch: transport(() => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(fixtureChunk(event(finishedPayload) + terminalEvent + late));
            controller.enqueue(fixtureChunk(late));
          },
          cancel() { cancelled = true; },
        }))),
      }, format === "array" ? format : true);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const read = async () => decoder.decode((await reader.read()).value);
      try {
        expect(await read()).toBe(format === "sse" ? `data: ${finishedPayload}\n\n` : `[\n${finishedPayload}`);
        if (terminal === "in-band error") {
          const error = JSON.stringify(safeInBandUpstreamError);
          expect(await read()).toBe(format === "sse" ? `data: ${error}\n\n` : `,\n${error}`);
        }
        if (format === "array") expect(await read()).toBe("\n]");
        expect((await reader.read()).done).toBe(true);
        await Bun.sleep(0);
        expect(cancelled).toBe(true);
        expect(getActiveTurnCount()).toBe(baseline);
      } finally {
        await reader.cancel();
      }
    });
  }
}

test("401 refreshes the rejected snapshot once and cancels its response", async () => {
  let calls = 0, refreshes = 0, cancelled = false;
  const response = await run(request(), {
    access: async () => old,
    refresh: async rejected => { expect(rejected).toBe(old); refreshes++; return fresh; },
    fetch: transport((_url, init) => {
      calls++;
      if (calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-new-token");
      return new Response('{"response":{}}');
    }),
  });
  expect(response.status).toBe(200);
  expect(calls).toBe(2); expect(refreshes).toBe(1); expect(cancelled).toBe(true);
});

for (const [name, echoed] of [["previous", old.accessToken], ["refreshed", fresh.accessToken]] as const) {
  test(`401 recovery still rejects the ${name} access token in a successful reply`, async () => {
    let calls = 0;
    const response = await run(request(), {
      access: async () => old,
      refresh: async () => {
        accountStatus = { ...fixtureAccount(), credential: { ...fixtureAccount().credential, access: fresh.accessToken } };
        return fresh;
      },
      fetch: transport(() => ++calls === 1
        ? new Response(null, { status: 401 })
        : new Response(`{"response":{"text":"${echoed}"}}`)),
    });
    expect(calls).toBe(2);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(safeUpstreamError);
  });
}
test("cancellation while discarding a 401 detaches a stalled body without refreshing", async () => {
  const ac = new AbortController();
  const cancel = Promise.withResolvers<void>();
  let refreshes = 0;
  const pending = run(request(undefined, ac.signal), {
    access: async () => old,
    refresh: async () => { refreshes++; return fresh; },
    fetch: transport(() => new Response(new ReadableStream({
      cancel() { queueMicrotask(() => ac.abort()); return cancel.promise; },
    }), { status: 401 })),
  });
  try {
    const status = await Promise.race([pending.then(response => response.status), Bun.sleep(200).then(() => 0)]);
    expect(status).toBe(499);
    expect(refreshes).toBe(0);
  } finally {
    cancel.resolve();
    await pending;
  }
});

test("persistent 401 is terminal and safe error headers retain numeric Retry-After", async () => {
  let calls = 0, refreshes = 0;
  const response = await run(request(), {
    access: async () => old, refresh: async () => { refreshes++; return fresh; },
    fetch: transport(() => { calls++; return new Response("private upstream diagnostics", { status: 401, headers: { "Retry-After": "5", "Set-Cookie": "private" } }); }),
  });
  expect(response.status).toBe(401); expect(calls).toBe(2); expect(refreshes).toBe(1);
  expect(response.headers.get("retry-after")).toBe("5"); expect(response.headers.has("set-cookie")).toBe(false);
  expect(await response.text()).not.toContain("private");
});
test("invalid input, configured byte cap and disabled provider never acquire OAuth", async () => {
  let accessCalls = 0;
  const deps = { access: async () => { accessCalls++; return old; }, refresh: async () => fresh, fetch: transport(() => { throw new Error("unexpected send"); }) };
  expect((await run(request("[]"), deps)).status).toBe(400);
  expect((await run(request(), deps, false, { ...config, maxInboundBodyBytes: 2 })).status).toBe(413);
  expect((await run(request(), deps, false, { ...config, providers: { "google-antigravity": { ...config.providers["google-antigravity"], disabled: true } } })).status).toBe(503);
  expect(accessCalls).toBe(0);
});
test("stream cancellation releases upstream and active turn without a resend", async () => {
  const baseline = getActiveTurnCount();
  let calls = 0, cancelled = false;
  const response = await run(request(), {
    access: async () => old, refresh: async () => { throw new Error("unexpected refresh"); },
    fetch: transport(() => {
      calls++;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":{"text":"hello"}}\n\n')); }, cancel() { cancelled = true; } }));
    }),
  }, true);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
  await reader.cancel();
  await Bun.sleep(0);
  expect(cancelled).toBe(true); expect(calls).toBe(1); expect(getActiveTurnCount()).toBe(baseline);
});
test("client cancellation during headers reaches the physical fetch", async () => {
  const baseline = getActiveTurnCount();
  const ac = new AbortController();
  const result = run(request(undefined, ac.signal), {
    access: async () => old, refresh: async () => fresh,
    fetch: transport((_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      ac.abort();
    })),
  });
  expect((await result).status).toBe(499); expect(getActiveTurnCount()).toBe(baseline);
});
test("malformed stream terminates delivery and never retries after output", async () => {
  let calls = 0;
  const response = await run(request(), {
    access: async () => old, refresh: async () => { throw new Error("unexpected refresh"); },
    fetch: transport(() => { calls++; return new Response('data: {"response":{"text":"first"}}\n\ndata: {}\n\n'); }),
  }, true);
  await expect(response.text()).rejects.toThrow(); expect(calls).toBe(1);
});

test("refresh failure returns a terminal error and releases the turn", async () => {
  const baseline = getActiveTurnCount();
  let calls = 0;
  const response = await run(request(), { access: async () => old, refresh: async () => { throw new Error("fixture-refresh-failure"); }, fetch: transport(() => { calls++; return new Response("{}", { status: 401 }); }) });
  expect(response.status).toBe(502); expect(calls).toBe(1); expect(getActiveTurnCount()).toBe(baseline);
});
test("header deadline aborts fetch and body stall aborts stream without replay", async () => {
  const baseline = getActiveTurnCount();
  const response = await run(request(), {
    access: async () => old, refresh: async () => fresh,
    fetch: transport((_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))),
  }, false, { ...config, connectTimeoutMs: 10 });
  expect(response.status).toBe(502);
  let cancelled = false;
  const stream = await run(request(), {
    access: async () => old, refresh: async () => fresh,
    fetch: transport(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }))),
  }, true, { ...config, stallTimeoutSec: 1 });
  await expect(stream.text()).rejects.toThrow();
  expect(cancelled).toBe(true); expect(getActiveTurnCount()).toBe(baseline);
});

test("native delivery logging observes EOF, failure and cancellation without changing bytes", async () => {
  const { logGeminiNativeDelivery } = await import("../../src/server/gemini-native-log");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const context = () => ({ model: "gemini-test", provider: "google-antigravity" });
  const id = `gemini-native-fixture-${crypto.randomUUID()}`;
  const raw = '{"unknown":9007199254740993123}';
  const delivered = logGeminiNativeDelivery(new Response(raw), request(), id, Date.now(), context());
  expect(await delivered.text()).toBe(raw);
  expect(getRequestLogEntries().find(row => row.requestId === id)?.status).toBe(200);
  const failedId = `${id}-failure`;
  const failed = logGeminiNativeDelivery(new Response(new ReadableStream({ pull(c) { c.error(new Error("fixture failure")); } })), request(), failedId, Date.now(), context());
  await expect(failed.text()).rejects.toThrow();
  expect(getRequestLogEntries().find(row => row.requestId === failedId)?.status).toBe(502);
  const cancelledId = `${id}-cancel`;
  const cancelled = logGeminiNativeDelivery(new Response(new ReadableStream({})), request(), cancelledId, Date.now(), context());
  await cancelled.body!.cancel();
  expect(getRequestLogEntries().find(row => row.requestId === cancelledId)?.status).toBe(499);
});

test("native physical sends consume the workflow ceiling across requests and 401 recovery", async () => {
  const { createAdmittedHttpTurn } = await import("../../src/server/admitted-http-turn");
  const { bindWorkflowBudgetConfig, currentWorkflowBudgetPolicy } = await import("../../src/lib/workflow-budget-config");
  const { workflowBudgetSnapshot, clearWorkflowBudgetForRoot } = await import("../../src/lib/workflow-budget");
  const rootId = `gemini-workflow-fixture-${crypto.randomUUID()}`;
  bindWorkflowBudgetConfig({ workflowBudget: { maxPhysicalSends: 1 } });
  const guarded = createAdmittedHttpTurn(() => undefined, () => new Response(null, { status: 503 }));
  const call = (deps: GeminiNativeDeps) => {
    const req = request();
    req.headers.set("x-codex-parent-thread-id", rootId);
    req.headers.set("thread-id", rootId);
    return guarded(req, config, lease => handleGeminiNative(req, config, "gemini-test", undefined, lease, deps));
  };
  let sends = 0;
  try {
    const deps = { access: async () => old, refresh: async () => fresh,
      fetch: transport(() => { sends++; return new Response('{"response":{}}'); }) };
    const first = await call(deps);
    expect(first.status).toBe(200); await first.text();
    expect(workflowBudgetSnapshot(rootId, currentWorkflowBudgetPolicy())?.sends).toBe(1);
    expect((await call(deps)).status).toBe(429);
    expect(sends).toBe(1);
    clearWorkflowBudgetForRoot(rootId);
    sends = 0;
    const recovered = await call({ ...deps, fetch: transport(() => { sends++; return new Response("{}", { status: 401 }); }) });
    expect(recovered.status).toBe(429);
    expect(recovered.headers.get("x-opencodex-local-refusal")).toBe("workflow_sends_exhausted");
    expect(sends).toBe(1);
  } finally {
    clearWorkflowBudgetForRoot(rootId);
    bindWorkflowBudgetConfig(null);
  }
});

test("native requests fail closed before OAuth when applicable token spend limits are configured", async () => {
  let accessCalls = 0, sends = 0;
  const deps = { access: async () => { accessCalls++; return old; }, refresh: async () => fresh,
    fetch: transport(() => { sends++; return new Response('{"response":{}}'); }) };
  for (const scope of ["root", "identity", "pool"] as const) {
    const req = request();
    req.headers.set("x-codex-parent-thread-id", "gemini-token-limit-fixture");
    const response = await run(req, deps, false, { ...config, spend: { [scope]: { maxTokens: 100 } } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { details: [{ reason: "gemini_native_spend_limits_unsupported" }] } });
  }
  expect(accessCalls).toBe(0); expect(sends).toBe(0);
  // Without a workflow root the root-only ceiling does not apply to this request.
  expect((await run(request(), deps, false, { ...config, spend: { root: { maxTokens: 100 } } })).status).toBe(200);
  expect(sends).toBe(1);
});

test("a token spend ceiling enabled during setup is rechecked before physical dispatch", async () => {
  const baseline = getActiveTurnCount();
  const liveConfig = { ...config };
  let sends = 0;
  const response = await run(request(), {
    access: async () => { liveConfig.spend = { pool: { maxTokens: 100 } }; return old; },
    refresh: async () => fresh,
    fetch: transport(() => { sends++; return new Response('{"response":{}}'); }),
  }, false, liveConfig);
  expect(response.status).toBe(503); expect(sends).toBe(0);
  expect(getActiveTurnCount()).toBe(baseline);
});

test("native SSE errors redact upstream diagnostics and delivery logs record failure", async () => {
  const { logGeminiNativeDelivery } = await import("../../src/server/gemini-native-log");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const req = request();
  const lease = tryAdmitTurn(undefined, req.signal)!;
  const context = { model: "gemini-test", provider: "google-antigravity" };
  const id = `gemini-native-error-fixture-${crypto.randomUUID()}`;
  const payload = '{"error":{"code":500,"message":"opaque upstream diagnostic","future":9007199254740993123}}';
  try {
    const response = await handleGeminiNative(req, config, "gemini-test", "sse", lease, {
      access: async () => old, refresh: async () => fresh,
      fetch: transport(() => new Response(`data: {"response":${payload}}\n\n`)),
    }, context);
    const delivery = logGeminiNativeDelivery(response, req, id, Date.now(), context);
    expect(delivery.status).toBe(200);
    const delivered = await delivery.text();
    expect(delivered).not.toContain("opaque upstream diagnostic");
    expect(JSON.parse(delivered.slice("data: ".length))).toEqual({
      error: { code: 502, message: "Antigravity upstream rejected the request", status: "INTERNAL" },
    });
    const row = getRequestLogEntries().find(entry => entry.requestId === id);
    expect(context).toMatchObject({ errorCode: "gemini_native_upstream_error" });
    expect(row).toMatchObject({ status: 502, terminalStatus: "failed", errorCode: "upstream_server_error", terminalSource: "upstream" });
    expect(JSON.stringify(row)).not.toContain("opaque upstream diagnostic");
  } finally { lease.release(); }
});

test("non-positive upstream stall settings stay disabled while delayed bodies complete", async () => {
  for (const stallTimeoutSec of [0, -1]) {
    let cancelled = false;
    const response = await run(request(), {
      access: async () => old, refresh: async () => fresh,
      fetch: transport(() => new Response(new ReadableStream({
        async start(controller) {
          await Bun.sleep(1100);
          if (!cancelled) { controller.enqueue(new TextEncoder().encode('{"response":{}}')); controller.close(); }
        },
        cancel() { cancelled = true; },
      }))),
    }, false, { ...config, stallTimeoutSec });
    expect(response.status).toBe(200); expect(cancelled).toBe(false);
  }
});

test("an idle partial upload times out locally and releases admission before OAuth", async () => {
  const baseline = getActiveTurnCount();
  let cancelled = false, accessCalls = 0;
  const req = new Request("http://localhost/v1beta/models/gemini-test:generateContent", {
    method: "POST", body: new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"contents":')); },
      cancel() { cancelled = true; },
    }),
  });
  const response = await run(req, {
    access: async () => { accessCalls++; return old; }, refresh: async () => fresh,
    fetch: transport(() => { throw new Error("unexpected send"); }),
  }, false, { ...config, stallTimeoutSec: 1 });
  expect(response.status).toBe(408); expect(cancelled).toBe(true); expect(accessCalls).toBe(0);
  expect(getActiveTurnCount()).toBe(baseline);
});

test("upload idle protection resets for each chunk and ends before slow OAuth setup", async () => {
  let cancelled = false;
  const req = new Request("http://localhost/v1beta/models/gemini-test:generateContent", {
    method: "POST", body: new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('{"con'));
        await Bun.sleep(600); if (cancelled) return;
        controller.enqueue(new TextEncoder().encode('tents":'));
        await Bun.sleep(600); if (cancelled) return;
        controller.enqueue(new TextEncoder().encode('[]}')); controller.close();
      },
      cancel() { cancelled = true; },
    }),
  });
  const response = await run(req, {
    access: async () => { await Bun.sleep(1100); return old; }, refresh: async () => fresh,
    fetch: transport(() => new Response('{"response":{}}')),
  }, false, { ...config, stallTimeoutSec: 1 });
  expect(response.status).toBe(200);
});

test("error responses retain status and Retry-After without decoding or waiting for their body", async () => {
  const baseline = getActiveTurnCount();
  for (const payload of [new Uint8Array([255]), new Uint8Array(16 * 1024 * 1024 + 1), undefined]) {
    let cancelled = false;
    const response = await run(request(), {
      access: async () => old, refresh: async () => fresh,
      fetch: transport(() => new Response(new ReadableStream({
        start(controller) { if (payload) controller.enqueue(payload); },
        cancel() { cancelled = true; },
      }), { status: 429, headers: { "Retry-After": "7" } })),
    });
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("7");
    expect(cancelled).toBe(true);
  }
  expect(getActiveTurnCount()).toBe(baseline);
});

test("known setup errors retain actionable auth, pacing and configuration responses", async () => {
  const { OAuthLoginRequiredError, OAuthAccountPausedError, OAuthTokenRefreshBusyError } = await import("../../src/oauth");
  const { RequestPacingQueueOverloadError } = await import("../../src/providers/request-pacing");
  for (const [error, status, retryAfter, message] of [
    [new OAuthLoginRequiredError("google-antigravity"), 503, null, "ocx login google-antigravity"],
    [new OAuthAccountPausedError(), 503, null, "resume"],
    [new OAuthTokenRefreshBusyError(), 503, "1", "refresh"],
    [new RequestPacingQueueOverloadError("google-antigravity", "queue_full", 7), 429, "7", "queue"],
  ] as const) {
    const response = await run(request(), {
      access: async () => { throw error; }, refresh: async () => fresh,
      fetch: transport(() => { throw new Error("unexpected send"); }),
    });
    expect(response.status).toBe(status); expect(response.headers.get("retry-after")).toBe(retryAfter);
    expect(await response.text()).toContain(message);
  }
  const response = await run(request(), {
    access: async () => old, refresh: async () => fresh,
    fetch: transport(() => { throw new Error("unexpected send"); }),
  }, false, { ...config, providers: { "google-antigravity": { ...config.providers["google-antigravity"], baseUrl: "http://169.254.169.254" } } });
  expect(response.status).toBe(503);
  const message = await response.text();
  expect(message).toContain("baseUrl"); expect(message).not.toContain("169.254.169.254");
});

test("queued native sends recheck paused, reauth and removed accounts before initial and 401 dispatch", async () => {
  const { waitForProviderRequestSlot, providerRequestPacingStatus } = await import("../../src/providers/request-pacing");
  const provider = { ...config.providers["google-antigravity"], requestPacing: { enabled: true, maxConcurrentRequests: 1 } };
  const cfg = { ...config, providers: { "google-antigravity": provider } };
  const baseline = getActiveTurnCount();
  for (const retry of [false, true]) for (const state of ["paused", "needsReauth", "removed"] as const) {
    accountStatus = fixtureAccount();
    let sends = 0;
    let blocker: Awaited<ReturnType<typeof waitForProviderRequestSlot>> | undefined;
    if (!retry) blocker = await waitForProviderRequestSlot("google-antigravity", provider, "gemini-test");
    const ac = new AbortController();
    const pending = run(request(undefined, ac.signal), {
      access: async () => old,
      refresh: async () => { blocker = await waitForProviderRequestSlot("google-antigravity", provider, "gemini-test"); return fresh; },
      fetch: transport(() => { sends++; return new Response('{"response":{}}', { status: retry ? 401 : 200 }); }),
    }, false, cfg);
    try {
      const deadline = Date.now() + 1000;
      while (providerRequestPacingStatus("google-antigravity", provider).queued !== 1 && Date.now() < deadline) await Bun.sleep(0);
      expect(providerRequestPacingStatus("google-antigravity", provider).queued).toBe(1);
      accountStatus = state === "removed" ? null : { ...fixtureAccount(), [state]: true };
      blocker!.release();
      expect((await pending).status).toBe(503);
      expect(sends).toBe(retry ? 1 : 0);
      expect(accountStatusSpy).toHaveBeenLastCalledWith("google-antigravity", old.accountId);
    } finally { blocker?.release(); ac.abort(); await pending; }
  }
  expect(getActiveTurnCount()).toBe(baseline);
});

test("buffered native errors redact upstream diagnostics and log failure", async () => {
  const { logGeminiNativeDelivery } = await import("../../src/server/gemini-native-log");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const req = request(), lease = tryAdmitTurn(undefined, req.signal)!;
  const context = { model: "gemini-test", provider: "google-antigravity" };
  const id = `gemini-buffered-error-fixture-${crypto.randomUUID()}`;
  const payload = '{"error":{"code":500,"message":"private buffered diagnostic","future":9007199254740993123}}';
  try {
    const response = await handleGeminiNative(req, config, "gemini-test", undefined, lease, {
      access: async () => old, refresh: async () => fresh,
      fetch: transport(() => new Response(`{"response":${payload}}`)),
    }, context);
    const delivery = logGeminiNativeDelivery(response, req, id, Date.now(), context);
    expect(delivery.status).toBe(502);
    expect(await delivery.json()).toEqual({
      error: { code: 502, message: "Antigravity upstream rejected the request", status: "UNAVAILABLE" },
    });
    const row = getRequestLogEntries().find(entry => entry.requestId === id);
    expect(row).toMatchObject({ status: 502, terminalStatus: "failed", errorCode: "upstream_server_error", terminalSource: "upstream" });
    expect(JSON.stringify(row)).not.toContain("private buffered diagnostic");
  } finally { lease.release(); }
});
