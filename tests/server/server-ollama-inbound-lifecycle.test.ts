import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { dispatchOllamaRoute, type OllamaRouteDeps } from "../../src/server/index/ollama-routes";
import { resetLifecycleDrainStateForTests, setDraining } from "../../src/server/lifecycle";
import { resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import type { NativeFinalLog, NativeFinalOutcome } from "../../src/server/native-final-log";
import { bufferedOllama, streamOllama } from "../../src/server/ollama-inbound";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Dispatcher ownership: which refusals expose a request id, the timeout override, drain.
describe("Ollama dispatcher arm", () => {
  const local = { port: 0, providers: {} } as unknown as OcxConfig;
  let timeouts: string[] = [];
  let ran = 0;
  const openAiRefusal = (status: number, retryAfter: string) => new Response(JSON.stringify({ error: { type: "server_error", code: "server_busy", message: "busy" } }), {
    status, headers: { "content-type": "application/json", "Retry-After": retryAfter },
  });
  function deps(run: OllamaRouteDeps["runAdmittedHttpTurn"]): OllamaRouteDeps {
    return {
      config: local, policy: local, requestMetricsLogContext: {},
      requestServer: { timeout: (req: Request, seconds: number) => { timeouts.push(new URL(req.url).pathname + ":" + seconds); } } as never,
      drainingResponse: () => openAiRefusal(503, "5"),
      runAdmittedHttpTurn: run,
    };
  }
  const call = (path: string, run: OllamaRouteDeps["runAdmittedHttpTurn"], method = "POST") => {
    const req = new Request("http://localhost" + path, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
    return dispatchOllamaRoute(req, new URL(req.url), deps(run));
  };
  beforeEach(() => { timeouts = []; ran = 0; });
  afterEach(() => resetLifecycleDrainStateForTests());

  test("generation disables the idle timeout; read-only routes and other paths do not", async () => {
    const run: OllamaRouteDeps["runAdmittedHttpTurn"] = async () => { ran++; return new Response(null, { status: 204 }); };
    await call("/api/chat", run);
    await call("/api/generate", run);
    await call("/api/tags", run, "GET");
    expect(await call("/api/config", run, "GET")).toBeUndefined();
    expect(await call("/v1/chat/completions", run)).toBeUndefined();
    expect(timeouts).toEqual(["/api/chat:0", "/api/generate:0"]);
    expect(ran).toBe(2);
  });

  test("drain refuses natively with retry advice, no row and no request id", async () => {
    setDraining(true);
    const res = (await call("/api/chat", async () => { ran++; return new Response(); }))!;
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("x-opencodex-request-id")).toBeNull();
    expect(await res.json()).toEqual({ error: "server temporarily unavailable; retry later" });
    expect(ran).toBe(0);
  });

  test("an unlogged active-turn refusal maps natively without an id", async () => {
    const res = (await call("/api/generate", async (_req, _policy, _work, _log, options) => options!.mapRefusal!(openAiRefusal(503, "1"))))!;
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.headers.get("x-opencodex-request-id")).toBeNull();
    expect(await res.json()).toEqual({ error: "server temporarily unavailable; retry later" });
  });

  test("a logged workflow refusal and admission cancellation expose their row id", async () => {
    const workflow = (await call("/api/chat", async (_req, _policy, _work, log, options) => {
      log!.onLogged!();
      return options!.mapRefusal!(openAiRefusal(429, "30"));
    }))!;
    expect(workflow.status).toBe(429);
    expect(workflow.headers.get("retry-after")).toBe("30");
    expect(workflow.headers.get("x-opencodex-request-id")).toMatch(/^ocx-/);
    expect(await workflow.json()).toEqual({ error: "request budget exhausted; retry later" });
    const cancelled = (await call("/api/chat", async (_req, _policy, _work, log, options) => {
      log!.onLogged!();
      return options!.onAdmissionError!(new Error("aborted"));
    }))!;
    expect(cancelled.status).toBe(499);
    expect(cancelled.headers.get("x-opencodex-request-id")).toMatch(/^ocx-/);
    expect(await cancelled.json()).toEqual({ error: "request cancelled" });
  });

  test("wrong methods get a native 405 instead of reaching management or the GUI", async () => {
    for (const [path, method, allow] of [["/api/chat", "GET", "POST"], ["/api/tags", "POST", "GET"], ["/api/version", "DELETE", "GET"]] as const) {
      const res = (await call(path, async () => { ran++; return new Response(); }, method))!;
      expect({ path, status: res.status, allow: res.headers.get("allow") }).toEqual({ path, status: 405, allow });
    }
    expect(ran).toBe(0);
  });
});

// Real HTTP lifecycle: zero-send refusals, cancellation, retries, and trace suppression.
describe("Ollama NDJSON settlement window", () => {
  test("a client cancel while the terminal waits for inner settlement still commits one 499", async () => {
    let release!: (settled: boolean) => void;
    const commits: NativeFinalOutcome[] = [];
    const finalLog: NativeFinalLog = {
      innerSettled: () => false,
      waitForInner: () => new Promise<boolean>(resolve => { release = resolve; }),
      commit: outcome => { commits.push(outcome); return commits.length === 1; },
    };
    const frame = (body: unknown) => "data: " + JSON.stringify(body) + "\n\n";
    const inner = new Response([
      frame({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ].join("")).body!;
    const reader = streamOllama("chat", "fx/m1", "time", inner, finalLog, new AbortController().signal).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("\"hi\"");
    const pendingTerminal = reader.read();
    await Bun.sleep(10); // The pull reached EOF and is now waiting in end() for settlement.
    expect(release).toBeDefined();
    await reader.cancel();
    release(true);
    await pendingTerminal.catch(() => undefined);
    await Bun.sleep(10);
    expect(commits).toEqual([{ status: 499, closeReason: "client_cancel" }]);
  });

  test("a buffered client that leaves while settlement is pending is a 499, not a success", async () => {
    let release!: (settled: boolean) => void;
    const commits: NativeFinalOutcome[] = [];
    const finalLog: NativeFinalLog = {
      innerSettled: () => false,
      waitForInner: () => new Promise<boolean>(resolve => { release = resolve; }),
      commit: outcome => { commits.push(outcome); return commits.length === 1; },
    };
    const client = new AbortController();
    const inner = Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
    const pending = bufferedOllama("chat", "fx/m1", "time", inner, finalLog, client.signal);
    await Bun.sleep(10);
    client.abort();
    release(true);
    const res = await pending;
    expect(res.status).toBe(499);
    expect(commits).toEqual([{ status: 499, closeReason: "client_cancel" }]);
  });

  test("data after the Chat terminator fails the stream instead of reporting success", async () => {
    const commits: NativeFinalOutcome[] = [];
    const finalLog: NativeFinalLog = {
      innerSettled: () => true,
      waitForInner: async () => true,
      commit: outcome => { commits.push(outcome); return commits.length === 1; },
    };
    const frame = (body: unknown) => "data: " + JSON.stringify(body) + "\n\n";
    const inner = new Response([
      frame({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
      frame({ error: { message: "late failure" } }),
    ].join("")).body!;
    const text = await streamOllama("chat", "fx/m1", "time", inner, finalLog, new AbortController().signal).text();
    const lines = text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some(line => line.done === true)).toBe(false);
    expect(typeof lines.at(-1)!.error).toBe("string");
    expect(commits).toEqual([{ status: 502, terminalStatus: "failed", closeReason: "terminal" }]);
  });
});

const saved = process.env.OPENCODEX_HOME;
let home = "";
let mode: "text" | "hang" | "flaky" = "text";
let sends = 0;
let upstreamAborted = false;
let upstream: ReturnType<typeof Bun.serve>;
const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
  "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices, ...extra }) + "\n\n";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-ollama-lifecycle-"));
  process.env.OPENCODEX_HOME = home;
  upstream = Bun.serve({ port: 0, idleTimeout: 30, async fetch(req) {
    const body = await req.json() as { stream?: boolean };
    sends++;
    if (mode === "flaky" && sends === 1) return Response.json({ error: { message: "fixture rate limit" } }, { status: 429, headers: { "retry-after": "30" } });
    if (mode === "hang") {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(chunk([{ index: 0, delta: { role: "assistant", content: "partial" } }])));
          req.signal.addEventListener("abort", () => { upstreamAborted = true; try { controller.close(); } catch { /* closed */ } });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
    if (body.stream !== true) {
      return Response.json({ id: "c", object: "chat.completion", created: 1, model: "m1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage });
    }
    return new Response([chunk([{ index: 0, delta: { role: "assistant", content: "ok" } }]), chunk([{ index: 0, delta: {}, finish_reason: "stop" }]), chunk([], { usage }), "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } });
  } });
});
afterAll(() => {
  upstream.stop(true);
  if (saved === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = saved;
  if (home) removeTreeWithRetry(home);
});
beforeEach(() => {
  mode = "text"; sends = 0; upstreamAborted = false;
  saveConfig({
    port: 0, defaultProvider: "fx",
    providers: { fx: { adapter: "openai-chat", baseUrl: upstream.url.origin + "/v1", authMode: "key", apiKey: "fixture-key-a", allowPrivateNetwork: true, models: ["m1"],
      apiKeyPool: [{ id: "a", key: "fixture-key-a", addedAt: 1 }, { id: "b", key: "fixture-key-b", addedAt: 2 }] } },
    routingProfiles: { daily: { alias: "daily", candidates: [{ provider: "fx", model: "m1" }] } },
    combos: { group: { alias: "group", strategy: "round-robin", targets: [{ provider: "fx", model: "m1" }] } },
  } as unknown as OcxConfig);
});

async function withServer(run: (base: URL, rowsSince: () => ReturnType<typeof getRequestLogEntries>) => Promise<void>) {
  const server = startServer(0);
  const earlier = new Set(getRequestLogEntries().map(entry => entry.requestId));
  try { await run(server.url, () => getRequestLogEntries().filter(entry => !earlier.has(entry.requestId))); } finally { await server.stop(true); }
}
const post = (base: URL, path: string, body: unknown, signal?: AbortSignal) =>
  fetch(new URL(path, base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
async function eventually(check: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
    await Bun.sleep(10);
  }
}

describe("Ollama generation lifecycle", () => {
  test("combo, policy and synthetic selectors refuse natively with zero sends and one logged row each", async () => {
    await withServer(async (base, rowsSince) => {
      for (const [model, status] of [["combo/group", 403], ["group", 403], ["policy/daily", 403], ["daily", 403], ["fx/m1--fast", 400]] as const) {
        const res = await post(base, "/api/chat", { model, messages: [{ role: "user", content: "hi" }], stream: false });
        expect({ model, status: res.status }).toEqual({ model, status });
        expect(typeof (await res.json() as { error: unknown }).error).toBe("string");
        const row = rowsSince().find(entry => entry.requestId === res.headers.get("x-opencodex-request-id"));
        expect(row?.status).toBe(status);
      }
      expect(sends).toBe(0);
      expect(rowsSince()).toHaveLength(5);
    });
  });

  test("client cancellation mid-stream aborts upstream and logs one 499 row", async () => {
    mode = "hang";
    await withServer(async (base, rowsSince) => {
      const abort = new AbortController();
      const res = await post(base, "/api/chat", { model: "fx/m1", messages: [{ role: "user", content: "hi" }] }, abort.signal);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("partial");
      abort.abort();
      await reader.cancel().catch(() => {});
      await eventually(() => upstreamAborted, "upstream abort");
      await eventually(() => rowsSince().length === 1, "one row");
      await Bun.sleep(150);
      expect(rowsSince()).toHaveLength(1);
      expect(rowsSince()[0]!.status).toBe(499);
    });
  });

  test("a key failover keeps both physical attempts on the live and persisted native row", async () => {
    mode = "flaky";
    await withServer(async (base, rowsSince) => {
      const res = await post(base, "/api/chat", { model: "fx/m1", messages: [{ role: "user", content: "hi" }], stream: false });
      expect(res.status).toBe(200);
      await res.text();
      await Bun.sleep(20);
      const rows = rowsSince();
      expect(rows).toHaveLength(1);
      const live = rows[0]!;
      expect(sends).toBe(2);
      expect(live.status).toBe(200);
      expect(live.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 });
      const expected = [
        { ordinal: 1, status: 429, sendCount: 1, failureCause: "rate-limit" },
        { ordinal: 2, status: 200, sendCount: 1, recoveryKinds: ["key-429"], usageStatus: "reported" },
      ];
      expect(live.attempts).toMatchObject(expected);
      expect((live as { attemptNormalizationDropped?: boolean }).attemptNormalizationDropped).not.toBe(true);
      const persisted = readFileSync(usageLogPath(), "utf8").split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as { requestId: string; status: number; attempts?: unknown[]; attemptNormalizationDropped?: boolean })
        .find(entry => entry.requestId === live.requestId);
      expect(persisted?.status).toBe(200);
      expect(persisted?.attempts).toMatchObject(expected);
      expect(persisted?.attemptNormalizationDropped).not.toBe(true);
    });
  });

  test("the workflow root survives the internal hop, so its token ceiling is enforced", async () => {
    // Each fixture reply reports 4 tokens; a root ceiling of 20 is spent within a few requests.
    const statuses = async (root: string | undefined) => {
      resetWorkflowBudgetsForTest();
      saveConfig({ ...loadConfig(), spend: { root: { maxTokens: 20 } } } as OcxConfig);
      const seen: number[] = [];
      await withServer(async base => {
        for (let i = 0; i < 10; i++) {
          const res = await fetch(new URL("/api/chat", base), {
            method: "POST",
            headers: { "content-type": "application/json", ...(root ? { "x-codex-parent-thread-id": root } : {}) },
            body: JSON.stringify({ model: "fx/m1", messages: [{ role: "user", content: "hi" }], stream: false, options: { num_predict: 1 } }),
          });
          seen.push(res.status);
          await res.text();
        }
      });
      return seen;
    };
    const rooted = await statuses("ollama-workflow-root-" + crypto.randomUUID());
    expect(rooted[0]).toBe(200);
    expect(rooted).toContain(429);
    // Without a root the request has no root scope, so the root ceiling never applies.
    expect(await statuses(undefined)).toEqual(Array(10).fill(200));
    resetWorkflowBudgetsForTest();
  });

  test("native rows carry no Chat protocol identity", async () => {
    await withServer(async (base, rowsSince) => {
      for (const stream of [false, true]) {
        const res = await post(base, "/api/generate", { model: "fx/m1", prompt: "hi", stream });
        expect(res.status).toBe(200);
        await res.text();
      }
      await Bun.sleep(20);
      const rows = rowsSince();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.protocolTrace).toBeUndefined();
        expect(row.inboundProtocol).toBeUndefined();
        expect(row.status).toBe(200);
        expect(row.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 });
        expect(row.attempts?.[0]).toMatchObject({ status: 200, sendCount: 1 });
      }
    });
  });
});
