import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";

/**
 * Dispatch-priority regression test for the image bridge (PR #424).
 *
 * The image bridge and the web-search sidecar are both opt-in dispatch paths in
 * handleResponses(). The design contract is "image defers to web-search": when a
 * request is eligible for BOTH, the web-search sidecar wins and the image bridge
 * must NOT activate. This was previously broken because planImageBridge ran and
 * returned before planWebSearch was ever consulted.
 *
 * These tests drive handleResponses() end-to-end (real parser + real routing +
 * real planImageBridge) with only the adapter, the runners, and the web-search
 * planner stubbed, so they exercise the actual dispatch ordering in
 * src/server/responses/core.ts.
 *
 * NOTE: Full server-level integration testing of every adapter path is out of
 * scope here — the focus is the dispatch priority ordering at the planImageBridge
 * / planWebSearch fork (core.ts ~L1516).
 */

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

// --- Activation spies, flipped by the stubbed runners ---
let imageBridgeRun = false;
let webSearchRun = false;
/** Whether the stubbed adapter should expose runTurn (simulates Cursor-style adapters). */
let useRunTurnAdapter = false;
/** Spy: flipped when the stubbed runTurn is actually invoked. */
let runTurnCalled = false;
/** Controlled return value for the stubbed planWebSearch (truthy ⇒ web-search plan active). */
let mockWsPlan: unknown = undefined;

// --- Stub adapter-resolve: inject a minimal adapter so no real upstream is hit ---
const actualResolver = await import("../../src/server/adapter-resolve");
mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig) {
    const base = {
      name: "test",
      buildRequest: async () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async fetchResponse() {
        return new Response("data: {\"type\":\"done\"}\n\n", {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      },
      async *parseStream() { yield { type: "done" as const }; },
    };
    if (useRunTurnAdapter) {
      return {
        ...base,
        async runTurn(_parsed: unknown, _incoming: unknown, emit: (event: { type: string }) => void) {
          runTurnCalled = true;
          emit({ type: "done" });
        },
      } as ProviderAdapter;
    }
    return base as ProviderAdapter;
  },
}));

// --- Stub the image bridge runner: detect activation without hitting the real loop ---
mock.module("../../src/images/loop", () => ({
  runWithImageBridge: async () => {
    imageBridgeRun = true;
    return new Response("data: {\"type\":\"done\"}\n\n", {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  },
  clampImageMaxRounds: (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return 3;
    return Math.max(0, Math.min(10, Math.floor(value)));
  },
  DEFAULT_MAX_ROUNDS: 3,
  MAX_ROUNDS_HARD_LIMIT: 10,
}));

// --- Stub the web-search planner + runner: control eligibility and detect activation ---
mock.module("../../src/web-search/index", () => ({
  // Re-export the symbols parser.ts imports statically (deep path → no mock there).
  buildWebSearchTool: () => ({ name: "web_search", parameters: { type: "object", properties: {} } }),
  WEB_SEARCH_TOOL_NAME: "web_search",
  extractHostedWebSearch: (tools: unknown[]) => {
    if (!Array.isArray(tools)) return undefined;
    for (const t of tools) {
      if (t && typeof t === "object" && (t as Record<string, unknown>).type === "web_search") {
        return { search_context_size: "medium" };
      }
    }
    return undefined;
  },
  runWithWebSearch: async () => {
    webSearchRun = true;
    return new Response("data: {\"type\":\"done\"}\n\n", {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  },
  planWebSearch: () => mockWsPlan,
  shouldResolveOpenAiWebSearchSidecar: () => false,
}));

const { handleResponses } = await import("../../src/server/responses");

/** Routed (non-OpenAI) keyed provider + an xAI provider with an API key so the real planImageBridge returns a plan. */
function makeConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-key" },
      xai: { adapter: "openai", baseUrl: "https://api.x.ai", apiKey: "xai-test-token" },
    },
    images: { bridgeEnabled: true },
  } as OcxConfig;
}

function post(stream: boolean, tools: unknown[]): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/model", input: "hello", stream, tools }),
    }),
    makeConfig(),
    { model: "", provider: "" } as never,
    {},
  );
}

describe("image bridge dispatch priority (handler activation)", () => {
  test("stream=true + image_generation tool → image bridge activates and returns SSE", async () => {
    imageBridgeRun = false; webSearchRun = false; mockWsPlan = undefined;
    const res = await post(true, [{ type: "image_generation" }]);
    expect(imageBridgeRun).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  test("stream=false + image_generation tool → 400 (bridge requires stream=true)", async () => {
    imageBridgeRun = false; webSearchRun = false; mockWsPlan = undefined;
    const res = await post(false, [{ type: "image_generation" }]);
    expect(res.status).toBe(400);
    // The runner must not execute when the request is rejected upfront.
    expect(imageBridgeRun).toBe(false);
    expect((await res.text())).toContain("image bridge requires stream=true");
  });

  test("dual-tool (image_generation + web_search), both eligible → web-search wins, image bridge deferred", async () => {
    imageBridgeRun = false; webSearchRun = false;
    // A truthy plan ⇒ web-search is eligible; the image bridge must defer to it.
    mockWsPlan = { backend: "openai" };
    const res = await post(true, [{ type: "web_search" }, { type: "image_generation" }]);
    expect(webSearchRun).toBe(true);
    expect(imageBridgeRun).toBe(false);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  test("routed compaction with image_generation tool → image bridge does NOT hijack compaction (#424)", async () => {
    imageBridgeRun = false; webSearchRun = false; mockWsPlan = undefined;
    // A routed-compaction request carries both _compactionRequest and _imageGeneration:
    // compaction clears tools/_webSearch but leaves _imageGeneration, so without the
    // routedCompaction guard planImageBridge would activate and return a normal Responses
    // completion instead of the synthetic compaction item Codex expects.
    const res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/model",
          input: [{ type: "compaction_trigger" }],
          stream: true,
          tools: [{ type: "image_generation" }],
        }),
      }),
      makeConfig(),
      { model: "", provider: "" } as never,
      {},
    );
    expect(imageBridgeRun).toBe(false);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  test("dual-tool on a runTurn adapter → web-search path wins, runTurn does not eat the request (#424)", async () => {
    imageBridgeRun = false; webSearchRun = false; runTurnCalled = false;
    useRunTurnAdapter = true;
    mockWsPlan = { backend: "openai" };
    try {
      const res = await post(true, [{ type: "web_search" }, { type: "image_generation" }]);
      // Web-search sidecar must handle the turn.
      expect(webSearchRun).toBe(true);
      // Image bridge must not activate (design: image defers to web-search).
      expect(imageBridgeRun).toBe(false);
      // runTurn must NOT be reached — the web-search dispatch now runs before the runTurn early-return.
      expect(runTurnCalled).toBe(false);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
    } finally {
      useRunTurnAdapter = false;
    }
  });
});
