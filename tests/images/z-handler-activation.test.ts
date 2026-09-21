import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

// --- Activation spies, flipped by the stubbed runners ---
let imageBridgeRun = false;
let imageBridgeToolNames: string[] = [];
let imageBridgeToolChoice: unknown;
let webSearchRun = false;
/** Whether the stubbed adapter should expose runTurn (simulates Cursor-style adapters). */
let useRunTurnAdapter = false;
/** Spy: flipped when the stubbed runTurn is actually invoked. */
let runTurnCalled = false;
/** Controlled return value for the stubbed planWebSearch (truthy ⇒ web-search plan active). */
let mockWsPlan: unknown = undefined;

let handleResponses: typeof import("../../src/server/responses")["handleResponses"];
let releaseSpendHome: (() => void) | undefined;
// Retained so teardown can remove it. Nothing created this directory before the lease did:
// taking ownership mkdirs the state directory, so the suite now owns its removal too.
let ownedHome = "";

beforeAll(async () => {
  ownedHome = join(tmpdir(), "ocx-test-" + randomUUID());
  process.env.OPENCODEX_HOME = ownedHome;
  // Take the writer lease after this suite installs its home so direct handler dispatch can open the spend journal.
  releaseSpendHome = acquireOwnedSpendHome();

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

  const actualLoop = await import("../../src/images/loop");
  mock.module("../../src/images/loop", () => ({
    ...actualLoop,
    runWithImageBridge: async (args: {
      parsed: { options: { toolChoice?: unknown } };
      plan: { toolNames: Set<string> };
    }) => {
      imageBridgeRun = true;
      imageBridgeToolNames = [...args.plan.toolNames].sort();
      imageBridgeToolChoice = args.parsed.options.toolChoice;
      return new Response("data: {\"type\":\"done\"}\n\n", {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    },
  }));

  mock.module("../../src/web-search/index", () => ({
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

  ({ handleResponses } = await import("../../src/server/responses"));
});

afterAll(() => {
  // Release, then remove, then restore. An open lease inside a directory being deleted fails
  // the removal on Windows and leaves an unlinked live database on POSIX, and the removal has
  // to happen while OPENCODEX_HOME still names the directory being removed.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  if (ownedHome) removeTreeWithRetry(ownedHome);
  if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = PREV_HOME;
  mock.restore();
});

/** Routed (non-OpenAI) keyed provider + an xAI provider with an API key so the real planImageBridge returns a plan. */
function makeConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-key" },
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "xai-test-token" },
    },
    images: { bridgeEnabled: true },
  } as OcxConfig;
}

function post(stream: boolean, tools: unknown[], toolChoice?: unknown): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture/model",
        input: "hello",
        stream,
        tools,
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      }),
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
    // The bridge answers with a live SSE stream. Releasing it here means no reader is
    // still attached when this suite drops its lease in afterAll.
    await res.body?.cancel();
  });

  test("alias-only image tool_choice keeps canonical bridge interception armed", async () => {
    imageBridgeRun = false;
    imageBridgeToolNames = [];
    imageBridgeToolChoice = undefined;
    webSearchRun = false;
    mockWsPlan = undefined;
    const res = await post(
      true,
      [
        { type: "image_generation" },
        { type: "function", name: "generate_image", parameters: { type: "object" } },
      ],
      { type: "function", name: "generate_image" },
    );
    expect(imageBridgeRun).toBe(true);
    expect(imageBridgeToolChoice).toEqual({ name: "image_gen" });
    expect(imageBridgeToolNames).toContain("generate_image");
    expect(imageBridgeToolNames).toContain("image_gen");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body?.cancel();
  });

  test("stream=false + image_generation tool → 400 (bridge requires stream=true)", async () => {
    imageBridgeRun = false; webSearchRun = false; mockWsPlan = undefined;
    const res = await post(false, [{ type: "image_generation" }]);
    expect(res.status).toBe(400);
    expect(imageBridgeRun).toBe(false);
    expect((await res.text())).toContain("image bridge requires stream=true");
  });

  test("dual-tool (image_generation + web_search), both eligible → web-search wins, image bridge deferred", async () => {
    imageBridgeRun = false; webSearchRun = false;
    mockWsPlan = { backend: "openai" };
    const res = await post(true, [{ type: "web_search" }, { type: "image_generation" }]);
    expect(webSearchRun).toBe(true);
    expect(imageBridgeRun).toBe(false);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body?.cancel();
  });

  test("routed compaction with image_generation tool → image bridge does NOT hijack compaction (#424)", async () => {
    imageBridgeRun = false; webSearchRun = false; mockWsPlan = undefined;
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
    await res.body?.cancel();
  });

  test("dual-tool on a runTurn adapter → image bridge wins (web-search loop has no runTurn support)", async () => {
    imageBridgeRun = false; webSearchRun = false; runTurnCalled = false;
    useRunTurnAdapter = true;
    mockWsPlan = { backend: "openai" };
    try {
      const res = await post(true, [{ type: "web_search" }, { type: "image_generation" }]);
      expect(webSearchRun).toBe(false);
      expect(imageBridgeRun).toBe(true);
      expect(runTurnCalled).toBe(false);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      await res.body?.cancel();
    } finally {
      useRunTurnAdapter = false;
    }
  });

  test("image-only on a runTurn adapter → image bridge activates before runTurn early-return", async () => {
    imageBridgeRun = false; webSearchRun = false; runTurnCalled = false;
    useRunTurnAdapter = true;
    mockWsPlan = undefined;
    try {
      const res = await post(true, [{ type: "image_generation" }]);
      expect(imageBridgeRun).toBe(true);
      expect(webSearchRun).toBe(false);
      expect(runTurnCalled).toBe(false);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      await res.body?.cancel();
    } finally {
      useRunTurnAdapter = false;
    }
  });
});
