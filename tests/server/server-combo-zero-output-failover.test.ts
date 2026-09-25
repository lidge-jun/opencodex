import { afterAll, afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
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
});
