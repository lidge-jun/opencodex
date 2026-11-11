import { afterAll, afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns, isComboTargetInCooldown } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import { activeRegistryMetrics, getActiveTurnCount, tryAdmitTurn } from "../../src/server/lifecycle";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";

// `mock.module` outlives this file: Bun keeps the override below for every file that runs after
// this one in the same process. This is a spread snapshot of the real module, taken before it.
const actualResolver = { ...(await import("../../src/server/adapter-resolve")) };
const actualResolveAdapter = actualResolver.resolveAdapter;
let customRunTurn: NonNullable<ProviderAdapter["runTurn"]> | undefined;

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter !== "test-run-turn") {
      return actualResolveAdapter(provider, cacheRetention);
    }
    return {
      name: "test-run-turn",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream(): AsyncGenerator<AdapterEvent> {
        yield { type: "error", message: "test runTurn adapter does not use parseStream" };
      },
      async runTurn(parsed, incoming, emit) {
        if (!customRunTurn) throw new Error("custom runTurn not installed");
        await customRunTurn(parsed, incoming, emit);
      },
    } satisfies ProviderAdapter;
  },
}));

afterAll(() => {  // Put the real module back for every later file in the same process.
  mock.module("../../src/server/adapter-resolve", () => actualResolver);
});

const { handleResponses } = await import("../../src/server/responses");

/**
 * Zero-output combo failover driven by a bare Responses SSE `error` event.
 *
 * This case was written in `server-combo-failover-e2e.test.ts` and moved here unchanged.
 * That file carries a file-size-ratchet cap, and two separately passing pull requests
 * (#4824 and #4817) grew it past that cap once both were on `dev`. The ratchet only ever
 * lowers a cap, so the way back under it is to hold new cases in a sibling file rather
 * than to raise the number.
 *
 * The harness below is the subset of that file's fixture these cases actually use: real
 * loopback upstreams, an isolated home, and the combo/request-log state that leaks
 * between tests. The loopback cases drive real adapters; the runTurn case uses the same
 * narrow resolver seam as the parent file to emit deterministic adapter events.
 */

// The parent file raises this for the same reason: a real loopback server plus combo
// failover exceeds the 5s default under full-suite load on Windows.
setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const provider = comboProviderFactory(() => undefined);
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-zero-output-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-zero-output-"));
  process.env.OPENCODEX_HOME = testDir;
  // Direct handler dispatches need the writer lease that startServer normally holds.
  releaseSpendHome = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  clearRequestLogsForTests();
  clearResponseStateForTests();
});

afterEach(async () => {
  customRunTurn = undefined;
  // Release before home teardown to prevent Windows removal failures and a live unlinked database.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  let responseStatePending = true;
  try {
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    clearResponseStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    clearCodexUpstreamHealth();
    clearRequestLogsForTests();
  }
  expect(responseStatePending).toBe(false);
});

/** Loopback upstream whose lifetime the afterEach owns. */
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

/** Provider base URL for a fixture server, without the trailing slash. */
function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

/** Minimal completed Responses payload the backup target answers with. */
function responsesSuccess(text: string, model = "responses-model"): Record<string, unknown> {
  return {
    id: `resp-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_backup",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

/** Failover combo over the supplied providers, one target per provider in order. */
function comboConfig(
  providers: OcxConfig["providers"],
  targets = Object.keys(providers).map((name, index) => ({ provider: name, model: `m${index + 1}` })),
  extra: Partial<NonNullable<OcxConfig["combos"]>[string]> = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { free: { strategy: "failover", targets, ...extra } },
  };
}

describe("combo zero-output bare Responses error failover", () => {
  test("zero-output bare Responses SSE error hops before committing the child stream", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return new Response([
        "event: response.created",
        `data: ${JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress" } })}`,
        "",
        "event: error",
        `data: ${JSON.stringify({
          type: "error",
          message: "An error occurred while processing your request. Please include request ID r1.",
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const b = serve(() => {
      hits.push("b");
      return new Response([
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { ...responsesSuccess("bare-error backup", "m2"), status: "completed" },
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    });

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
    }), config, parent);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("bare-error backup");
    expect(hits).toEqual(["a", "b"]);
    expect(parent).toMatchObject({
      provider: "combo",
      model: "combo/free",
      resolvedModel: "m2",
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", status: 502 },
        { ordinal: 2, provider: "b", model: "m2" },
      ],
    });
  });

  test("a refused child relay does not settle the parent turn's admission lease", async () => {
    // Each passthrough child binds the parent's lease to its own relay controller. Cancelling the
    // refused first stream unbinds that controller; it must not settle the turn the next target
    // still runs in, or the second child is aborted on arrival ("turn already settled").
    const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
    const a = serve(() => sse({ type: "response.created", response: { id: "ra", status: "in_progress" } }, { type: "response.failed",
      response: { id: "ra", status: "failed", error: { type: "server_error", code: "upstream_server_error", message: "busy" } } }));
    const b = serve(() => sse({ type: "response.completed", response: responsesSuccess("lease backup", "m2") }));
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    });
    const turnAdmissionLease = tryAdmitTurn();
    if (!turnAdmissionLease) throw new Error("test turn admission unavailable");
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
      }), config, { model: "", provider: "" }, { turnAdmissionLease });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("lease backup");
      expect(getActiveTurnCount()).toBe(0);
    } finally { turnAdmissionLease.release(); }
  });

  test("a plain admission lease does not record an unmatched ladder unbind", async () => {
    const a = serve(() => Response.json(responsesSuccess("plain lease", "m1")));
    const config = comboConfig({ a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(a), "key-b") });
    const misses = activeRegistryMetrics().activeTurns!.releaseMisses;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
    }), config, { model: "", provider: "" }, { turnAdmissionLease: { release() {} } });
    expect(response.status).toBe(200);
    await response.text();
    expect(activeRegistryMetrics().activeTurns!.releaseMisses).toBe(misses);
  });

  // Both passthrough relay shapes, on every OS: "linux" selects tee, "win32" plus an explicit
  // eager-relay mode selects the eager bounded relay that Windows uses by default.
  for (const relay of ["tee", "eager"] as const)
  for (const exit of ["complete", "cancel", "abort"] as const)
  test(`accepted fallback keeps its turn lease until stream ${exit} (${relay} relay)`, async () => {
    setRelayPlatformForTests(relay === "eager" ? "win32" : "linux");
    const encoder = new TextEncoder();
    const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    const a = serve(() => new Response(frame({ type: "response.failed", response: {
      id: "ra", status: "failed", error: { type: "server_error", message: "busy" },
    } }), { headers: { "content-type": "text/event-stream" } }));
    let finish!: () => void;
    const b = serve(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(frame({ type: "response.output_text.delta", delta: "held fallback" }));
      finish = () => {
        controller.enqueue(frame({ type: "response.completed", response: responsesSuccess("held fallback", "m2") }));
        controller.close();
      };
    } }), { headers: { "content-type": "text/event-stream" } }));
    const config = { ...comboConfig({ a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b") }), streamMode: "eager-relay" as const };
    const caller = new AbortController();
    const lease = tryAdmitTurn(undefined, caller.signal);
    if (!lease) throw new Error("test turn admission unavailable");
    let releases = 0;
    // Await the release itself: a relay may legitimately settle it after the client's cancel.
    let released!: () => void;
    const releasedSignal = new Promise<void>(resolve => { released = resolve; });
    lease.attach({ release() { releases++; released(); } });
    const misses = activeRegistryMetrics().activeTurns!.releaseMisses;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, signal: caller.signal,
        body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
      }), config, { model: "", provider: "" }, { turnAdmissionLease: lease });
      expect(response.status).toBe(200);
      expect(getActiveTurnCount()).toBe(1);
      expect(releases).toBe(0);
      if (exit === "cancel") {
        await response.body!.cancel();
        if (relay === "eager") {
          // #44: after a client cancel the eager relay keeps draining upstream, still admitted,
          // until a terminal or its bounded drain window. A request abort releases at once; a
          // body cancel alone waits for the drain, which an upstream terminal ends here.
          expect(getActiveTurnCount()).toBe(1);
          expect(releases).toBe(0);
        }
        try { finish(); } catch { /* the tee relay already cancelled the upstream body */ }
      } else if (exit === "abort") {
        caller.abort();
        await response.text().catch(() => "");
      } else {
        finish();
        expect(await response.text()).toContain("held fallback");
      }
      await releasedSignal;
      expect(getActiveTurnCount()).toBe(0);
      expect(releases).toBe(1);
      expect(activeRegistryMetrics().activeTurns!.releaseMisses).toBe(misses);
    } finally { setRelayPlatformForTests(undefined); lease.release(); }
    expect(releases).toBe(1);
  });

  test("undeclared first adapter tool call hops without changing the request catalog", async () => {
    const requests: Record<string, unknown>[] = [];
    const upstream = (content: string) => serve(async request => {
      requests.push(await request.json() as Record<string, unknown>);
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: JSON.parse(content) }] })}`,
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const a = upstream(JSON.stringify({
      tool_calls: [{ index: 0, id: "call_stale", function: { name: "stale_tool", arguments: "{}" } }],
    }));
    const b = upstream(JSON.stringify({ content: "tool-safe backup" }));
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const tools = [{ type: "function", name: "current_tool", parameters: { type: "object" } }];

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true, tools }),
    }), config, { model: "", provider: "" });
    const body = await response.text();
    expect(body).toContain("tool-safe backup");
    expect(body).not.toContain("stale_tool");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toEqual(requests[1]?.tools);
    expect(JSON.stringify(requests[0]?.tools)).toContain("current_tool");
  });

  test("non-streaming undeclared adapter tool call hops without changing the request catalog", async () => {
    const catalogs: unknown[] = [];
    const hits: string[] = [];
    customRunTurn = async (parsed, _incoming, emit) => {
      hits.push(parsed.modelId);
      catalogs.push(structuredClone((parsed._rawBody as { tools?: unknown }).tools));
      if (parsed.modelId === "m1") {
        emit({ type: "tool_call_start", id: "call_stale", name: "stale_tool" });
        emit({ type: "tool_call_delta", arguments: "{}" });
        emit({ type: "tool_call_end" });
        emit({ type: "done" });
        return;
      }
      emit({ type: "text_delta", text: "non-streaming tool-safe backup" });
      emit({ type: "done" });
    };
    const config = comboConfig({
      a: provider("test-run-turn", "https://a.test/v1", "key-a"),
      b: provider("test-run-turn", "https://b.test/v1", "key-b"),
    });
    const tools = [{ type: "function", name: "current_tool", parameters: { type: "object" } }];

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, tools }),
    }), config, { model: "", provider: "" });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("non-streaming tool-safe backup");
    expect(body).not.toContain("stale_tool");
    expect(hits).toEqual(["m1", "m2"]);
    expect(catalogs).toHaveLength(2);
    expect(catalogs[0]).toEqual(catalogs[1]);
    expect(JSON.stringify(catalogs[0])).toContain("current_tool");
  });

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} undeclared tool call after a replay-unsafe heartbeat is never dispatched again`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        if (parsed.modelId === "m1") {
          emit({ type: "heartbeat", replayUnsafe: true });
          emit({ type: "tool_call_start", id: "call_stale", name: "stale_tool" });
          emit({ type: "tool_call_delta", arguments: "{}" });
          emit({ type: "tool_call_end" });
          emit({ type: "done" });
          return;
        }
        emit({ type: "text_delta", text: "must not run" });
        emit({ type: "done" });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "combo/free",
          input: "hello",
          stream,
          tools: [{ type: "function", name: "current_tool", parameters: { type: "object" } }],
        }),
      }), config, { model: "", provider: "" });
      const body = await response.text();
      expect(hits).toEqual(["m1"]);
      expect(body).not.toContain("must not run");
      expect(body).not.toContain('"name":"stale_tool"');
    });
  }

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} error after a replay-unsafe heartbeat stays on that child`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        if (parsed.modelId === "m1") {
          emit({ type: "heartbeat", replayUnsafe: true });
          emit({ type: "error", message: "transport lost after a local tool ran" });
          return;
        }
        emit({ type: "text_delta", text: "must not run" });
        emit({ type: "done" });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream }),
      }), config, { model: "", provider: "" });
      const body = await response.text();
      expect(hits).toEqual(["m1"]);
      expect(body).not.toContain("must not run");
    });
  }

  test("undeclared adapter tool call after text never replays on backup", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "already visible" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {
          tool_calls: [{ index: 0, id: "call_stale", function: { name: "stale_tool", arguments: "{}" } }],
        } }] })}`,
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const b = serve(() => {
      hits.push("b");
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/free",
        input: "hello",
        stream: true,
        tools: [{ type: "function", name: "current_tool", parameters: { type: "object" } }],
      }),
    }), config, { model: "", provider: "" });
    const body = await response.text();
    expect(body).toContain("already visible");
    expect(body).toContain("response.failed");
    expect(hits).toEqual(["a"]);
  });

  test("buffered undeclared tool call after text and replay-unsafe heartbeat never replays on backup", async () => {
    const hits: string[] = [];
    customRunTurn = async (parsed, _incoming, emit) => {
      hits.push(parsed.modelId);
      if (parsed.modelId === "m1") {
        emit({ type: "text_delta", text: "already visible text" });
        emit({ type: "heartbeat", replayUnsafe: true });
        emit({ type: "tool_call_start", id: "call_stale", name: "stale_tool" });
        emit({ type: "tool_call_delta", arguments: "{}" });
        emit({ type: "tool_call_end" });
        emit({ type: "done" });
        return;
      }
      emit({ type: "text_delta", text: "must not run" });
      emit({ type: "done" });
    };
    const config = comboConfig({
      a: provider("test-run-turn", "https://a.test/v1", "key-a"),
      b: provider("test-run-turn", "https://b.test/v1", "key-b"),
    });

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/free",
        input: "hello",
        stream: false,
        tools: [{ type: "function", name: "current_tool", parameters: { type: "object" } }],
      }),
    }), config, { model: "", provider: "" });
    const body = await response.text();
    expect(hits).toEqual(["m1"]);
    expect(body).not.toContain("must not run");
  });

  test("direct-SSE empty response.output_text.delta before max_output_tokens fails over to backup target", async () => {
    const hits: string[] = [];
    const encoder = new TextEncoder();
    const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    const a = serve(() => {
      hits.push("a");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame({ type: "response.created", response: { id: "r1", status: "in_progress" } }));
          controller.enqueue(frame({ type: "response.output_text.delta", delta: "" }));
          controller.enqueue(frame({
            type: "response.incomplete",
            response: {
              id: "r1",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [],
              usage: { input_tokens: 15, output_tokens: 0, total_tokens: 15 },
            },
          }));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const b = serve(() => {
      hits.push("b");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame({ type: "response.created", response: { id: "r2", status: "in_progress" } }));
          controller.enqueue(frame({ type: "response.output_text.delta", delta: "direct-sse backup answer" }));
          controller.enqueue(frame({ type: "response.completed", response: responsesSuccess("direct-sse backup answer", "m2") }));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    });

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
    }), config, { model: "", provider: "" });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("direct-sse backup answer");
    expect(hits).toEqual(["a", "b"]);
  });

  test("non-streaming openai-responses JSON is not inspected: its empty max_output_tokens limit reaches the client", async () => {
    // Non-streaming native JSON stays outside the combo preflight; only SSE and runTurn children fail
    // over on an empty max_output_tokens limit.
    const hits: string[] = [];
    const incomplete = {
      id: "resp_a",
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
      usage: { input_tokens: 15, output_tokens: 0, total_tokens: 15 },
    };
    const a = serve(() => {
      hits.push("a");
      return Response.json(incomplete);
    });
    const b = serve(() => {
      hits.push("b");
      return Response.json(responsesSuccess("passthrough json backup answer", "m2"));
    });
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    });

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
    }), config, { model: "", provider: "" });

    expect(response.status).toBe(200);
    const body = await response.json() as { status?: string; incomplete_details?: { reason?: string } };
    expect(body.status).toBe("incomplete");
    expect(body.incomplete_details?.reason).toBe("max_output_tokens");
    expect(hits).toEqual(["a"]);
  });

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} zero-output max_output_tokens terminal fails over to backup target`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        if (parsed.modelId === "m1") {
          emit({ type: "heartbeat" });
          emit({
            type: "incomplete",
            reason: "max_output_tokens",
            usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
          });
          return;
        }
        emit({ type: "text_delta", text: "zero-output failover backup" });
        emit({ type: "done" });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const parent: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream }),
      }), config, parent);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("zero-output failover backup");
      expect(hits).toEqual(["m1", "m2"]);
      expect(isComboTargetInCooldown("free", { provider: "a", model: "m1" })).toBe(false);
    });
  }

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} zero-output done length terminal fails over to backup target`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        if (parsed.modelId === "m1") {
          emit({ type: "heartbeat" });
          emit({
            type: "done",
            stopReason: "max_tokens",
            usage: { inputTokens: 15, outputTokens: 0, totalTokens: 15 },
          });
          return;
        }
        emit({ type: "text_delta", text: "done-limit backup" });
        emit({ type: "done" });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const parent: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream }),
      }), config, parent);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("done-limit backup");
      expect(hits).toEqual(["m1", "m2"]);
    });
  }

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} max_output_tokens after visible output does not fail over`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        if (parsed.modelId === "m1") {
          emit({ type: "text_delta", text: "partial output before limit" });
          emit({
            type: "incomplete",
            reason: "max_output_tokens",
          });
          return;
        }
        emit({ type: "text_delta", text: "must not run" });
        emit({ type: "done" });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream }),
      }), config, { model: "", provider: "" });
      const body = await response.text();
      expect(hits).toEqual(["m1"]);
      expect(body).toContain("partial output before limit");
      expect(body).not.toContain("must not run");
    });
  }

  test("remote compaction zero-output max_output_tokens terminal fails over to backup target", async () => {
    const hits: string[] = [];
    customRunTurn = async (parsed, _incoming, emit) => {
      hits.push(parsed.modelId);
      if (parsed.modelId === "m1") {
        emit({ type: "heartbeat" });
        emit({
          type: "incomplete",
          reason: "max_output_tokens",
          usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
        });
        return;
      }
      emit({ type: "text_delta", text: "compacted summary output" });
      emit({ type: "done" });
    };
    const config = comboConfig({
      a: provider("test-run-turn", "https://a.test/v1", "key-a"),
      b: provider("test-run-turn", "https://b.test/v1", "key-b"),
    });

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/free",
        input: [
          { type: "message", role: "user", content: "previous context" },
          { type: "compaction_trigger" },
        ],
        stream: true,
      }),
    }), config, parent);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('"type":"compaction"');
    expect(hits).toEqual(["m1", "m2"]);
  });

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} reasoning followed by max_output_tokens terminal fails over to backup target`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        if (parsed.modelId === "m1") {
          emit({ type: "heartbeat" });
          emit({ type: "thinking_delta", thinking: "deep reflection on problem..." });
          emit({
            type: "incomplete",
            reason: "max_output_tokens",
            usage: { inputTokens: 50, outputTokens: 200, totalTokens: 250 },
          });
          return;
        }
        emit({ type: "text_delta", text: "backup target answer" });
        emit({ type: "done" });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const parent: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream }),
      }), config, parent);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("backup target answer");
      expect(hits).toEqual(["m1", "m2"]);
    });
  }

  test("remote compaction with reasoning deltas before max_output_tokens terminal fails over to backup target", async () => {
    const hits: string[] = [];
    customRunTurn = async (parsed, _incoming, emit) => {
      hits.push(parsed.modelId);
      if (parsed.modelId === "m1") {
        emit({ type: "heartbeat" });
        emit({ type: "thinking_delta", thinking: "thinking during compaction..." });
        emit({
          type: "incomplete",
          reason: "max_output_tokens",
          usage: { inputTokens: 100, outputTokens: 500, totalTokens: 600 },
        });
        return;
      }
      emit({ type: "text_delta", text: "compacted summary output from backup" });
      emit({ type: "done" });
    };
    const config = comboConfig({
      a: provider("test-run-turn", "https://a.test/v1", "key-a"),
      b: provider("test-run-turn", "https://b.test/v1", "key-b"),
    });

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/free",
        input: [
          { type: "message", role: "user", content: "previous context" },
          { type: "compaction_trigger" },
        ],
        stream: true,
      }),
    }), config, parent);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('"type":"compaction"');
    expect(hits).toEqual(["m1", "m2"]);
  });

  test("streaming long reasoning sequence (>1024 deltas) followed by max_tokens terminal fails over to backup target", async () => {
    const hits: string[] = [];
    customRunTurn = async (parsed, _incoming, emit) => {
      hits.push(parsed.modelId);
      if (parsed.modelId === "m1") {
        emit({ type: "heartbeat" });
        for (let i = 0; i < 2_000; i++) {
          emit({ type: "thinking_delta", thinking: `step ${i} ` });
        }
        emit({
          type: "done",
          stopReason: "max_tokens",
          usage: { inputTokens: 100, outputTokens: 2000, totalTokens: 2100 },
        });
        return;
      }
      emit({ type: "text_delta", text: "long-reasoning backup answer" });
      emit({ type: "done" });
    };
    const config = comboConfig({
      a: provider("test-run-turn", "https://a.test/v1", "key-a"),
      b: provider("test-run-turn", "https://b.test/v1", "key-b"),
    });

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
    }), config, parent);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("long-reasoning backup answer");
    expect(hits).toEqual(["m1", "m2"]);
  });

  test("remote compaction with text deltas before max_tokens terminal fails over to backup target", async () => {
    const hits: string[] = [];
    customRunTurn = async (parsed, _incoming, emit) => {
      hits.push(parsed.modelId);
      if (parsed.modelId === "m1") {
        emit({ type: "heartbeat" });
        emit({ type: "thinking_delta", thinking: "analyzing conversation..." });
        emit({ type: "text_delta", text: "Partial summary of progress so far..." });
        emit({
          type: "done",
          stopReason: "max_tokens",
          usage: { inputTokens: 500, outputTokens: 4096, totalTokens: 4596 },
        });
        return;
      }
      emit({ type: "text_delta", text: "complete compacted summary from backup" });
      emit({ type: "done" });
    };
    const config = comboConfig({
      a: provider("test-run-turn", "https://a.test/v1", "key-a"),
      b: provider("test-run-turn", "https://b.test/v1", "key-b"),
    });

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/free",
        input: [
          { type: "message", role: "user", content: "long conversation" },
          { type: "compaction_trigger" },
        ],
        stream: true,
      }),
    }), config, parent);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('"type":"compaction"');
    expect(body).not.toContain("Incomplete response returned");
    expect(hits).toEqual(["m1", "m2"]);
  });

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} empty text_delta before max_output_tokens terminal fails over`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        if (parsed.modelId === "m1") {
          emit({ type: "heartbeat" });
          emit({ type: "text_delta", text: "" });
          emit({
            type: "incomplete",
            reason: "max_output_tokens",
            usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40 },
          });
          return;
        }
        emit({ type: "text_delta", text: "empty-delta backup answer" });
        emit({ type: "done" });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const parent: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream }),
      }), config, parent);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("empty-delta backup answer");
      expect(hits).toEqual(["m1", "m2"]);
    });
  }

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} combo exhaustion on zero-output token limit returns incomplete response and preserves usage`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        if (parsed.modelId === "m1") {
          emit({ type: "heartbeat" });
          emit({ type: "thinking_delta", thinking: "thinking target 1..." });
          emit({
            type: "incomplete",
            reason: "max_output_tokens",
            usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150 },
          });
          return;
        }
        emit({ type: "heartbeat" });
        emit({ type: "thinking_delta", thinking: "thinking target 2..." });
        emit({
          type: "incomplete",
          reason: "max_output_tokens",
          usage: { inputTokens: 60, outputTokens: 120, totalTokens: 180 },
        });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const parent: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream }),
      }), config, parent);

      expect(response.status).toBe(200);
      expect(hits).toEqual(["m1", "m2"]);
      expect(parent.attempts).toHaveLength(2);
      expect(parent.attempts?.[0]).toMatchObject({
        provider: "a",
        model: "m1",
        status: 502,
        usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150 },
      });
      expect(parent.attempts?.[1]).toMatchObject({
        provider: "b",
        model: "m2",
        status: 502,
        usage: { inputTokens: 60, outputTokens: 120, totalTokens: 180 },
      });

      if (!stream) {
        const body = await response.json();
        expect(body.status).toBe("incomplete");
        expect(body.incomplete_details?.reason).toBe("max_output_tokens");
        expect(body.usage).toMatchObject({
          input_tokens: 60,
          output_tokens: 120,
          total_tokens: 180,
        });
      } else {
        const text = await response.text();
        expect(text).toContain("response.incomplete");
        expect(text).toContain("max_output_tokens");
        expect(text).toContain('"output_tokens":120');
      }
    });
  }

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} replay-unsafe heartbeat after reasoning prevents failover`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        emit({ type: "thinking_delta", thinking: "pondering..." });
        emit({ type: "heartbeat", replayUnsafe: true });
        emit({
          type: "incomplete",
          reason: "max_output_tokens",
          usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const parent: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream }),
      }), config, parent);

      expect(response.status).toBe(200);
      expect(hits).toEqual(["m1"]);
      const body = await response.text();
      expect(body).toContain("max_output_tokens");
      expect(hits).not.toContain("m2");
    });
  }

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "non-streaming"} done pause_turn preserves child turn without failing over`, async () => {
      const hits: string[] = [];
      customRunTurn = async (parsed, _incoming, emit) => {
        hits.push(parsed.modelId);
        emit({ type: "done", stopReason: "pause_turn" });
      };
      const config = comboConfig({
        a: provider("test-run-turn", "https://a.test/v1", "key-a"),
        b: provider("test-run-turn", "https://b.test/v1", "key-b"),
      });

      const parent: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream }),
      }), config, parent);

      expect(response.status).toBe(200);
      expect(hits).toEqual(["m1"]);
      expect(hits).not.toContain("m2");
    });
  }

  test("translated Anthropic pause_turn stays on its target and delivers the incomplete", async () => {
    const hits: string[] = [];
    const anthropic = serve(async request => {
      hits.push("a");
      const body = await request.json() as { stream?: boolean };
      expect(body.stream).toBe(true);
      const frame = (name: string, data: Record<string, unknown>) =>
        `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
      return new Response([
        frame("message_start", { message: { id: "msg_1", model: "m1", usage: { input_tokens: 11, output_tokens: 0 } } }),
        frame("message_delta", { delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 7 } }),
        frame("message_stop", {}),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const backup = serve(() => {
      hits.push("b");
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: responsesSuccess("pause backup", "m2") })}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("anthropic", baseUrl(anthropic), "key-a"),
      b: provider("openai-responses", baseUrl(backup), "key-b"),
    });

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
    }), config, { model: "", provider: "" });

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(hits).toEqual(["a"]);
    expect(body).toContain("response.incomplete");
    expect(body).toContain('"reason":"max_output_tokens"');
    expect(body).toContain('"output_tokens":7');
    expect(body).not.toContain("pause backup");
  });

  for (const [name, details, endTurn] of [
    ["end_turn false", {}, false],
    ["retryable false", { retryable: false }, undefined],
  ] as const) {
    test(`empty max_output_tokens incomplete with ${name} stays on its target and is delivered`, async () => {
      const hits: string[] = [];
      const encoder = new TextEncoder();
      const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      const a = serve(() => {
        hits.push("a");
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(frame({ type: "response.created", response: { id: "r1", status: "in_progress" } }));
            controller.enqueue(frame({
              type: "response.incomplete",
              response: {
                id: "r1",
                status: "incomplete",
                ...(endTurn === false ? { end_turn: false } : {}),
                incomplete_details: { reason: "max_output_tokens", ...details },
                output: [],
                usage: { input_tokens: 9, output_tokens: 0, total_tokens: 9 },
              },
            }));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      });
      const b = serve(() => {
        hits.push("b");
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: responsesSuccess("limit backup", "m2") })}\n\n`,
          { headers: { "content-type": "text/event-stream" } });
      });
      const config = comboConfig({
        a: provider("openai-responses", baseUrl(a), "key-a"),
        b: provider("openai-responses", baseUrl(b), "key-b"),
      });

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
      }), config, { model: "", provider: "" });

      const body = await response.text();
      expect(response.status).toBe(200);
      expect(hits).toEqual(["a"]);
      expect(body).toContain("response.incomplete");
      expect(body).toContain('"reason":"max_output_tokens"');
      if (endTurn === false) expect(body).toContain('"end_turn":false');
      if (details.retryable === false) expect(body).toContain('"retryable":false');
      expect(body).not.toContain("limit backup");
    });
  }
});
