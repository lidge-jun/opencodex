import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../src/config";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../src/codex/model-entitlements";
import { buildCursorIntegrationStatus } from "../src/server/management/cursor-integration-routes";
import { handleChatCompletions } from "../src/server/chat-completions";
import { handleClaudeMessages } from "../src/server/claude-messages";
import {
  effortRowId,
  expandCursorEffortRow,
  parseEffortRowId,
} from "../src/server/effort-row";
import { handleResponses } from "../src/server/responses";
import { startServer } from "../src/server";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";

setDefaultTimeout(SERVER_BUDGET_MS);

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-cursor-effort-rows-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  resetCodexModelEntitlementCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

function discoveryConfig(cursorEffortRows?: boolean): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    ...(cursorEffortRows === undefined ? {} : { cursorEffortRows }),
    providers: {
      anthropic: {
        adapter: "openai-chat",
        baseUrl: "https://anthropic.test/v1",
        liveModels: false,
        models: ["claude-fable-5-1", "claude-opus-5"],
        modelReasoningEfforts: {
          "claude-fable-5-1": ["none", "low", "high", "max"],
          "claude-opus-5": ["low", "high", "max"],
        },
      },
      cursor: {
        adapter: "openai-chat",
        baseUrl: "https://cursor.test/v1",
        liveModels: false,
        models: ["kimi-k3", "gpt-5.6-sol"],
        modelReasoningEfforts: {
          "kimi-k3": ["minimal", "medium", "ultra"],
          "gpt-5.6-sol": ["low", "medium", "high", "xhigh"],
        },
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        liveModels: false,
      },
    },
  };
}

async function rawModelList(config: OcxConfig): Promise<{ text: string; data: Array<Record<string, unknown>> }> {
  saveConfig(config);
  const server = startServer(0, { managementApi: { loadCursorEffortTable: () => null } });
  try {
    const response = await fetch(new URL("/v1/models", server.url));
    expect(response.status).toBe(200);
    const text = await response.text();
    return { text, data: (JSON.parse(text) as { data: Array<Record<string, unknown>> }).data };
  } finally {
    await server.stop(true);
  }
}

function mockChatUpstream(): { server: ReturnType<typeof Bun.serve>; captured: Array<Record<string, unknown>> } {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as Record<string, unknown>;
      captured.push(body);
      if (body.stream !== true) {
        return Response.json({
          id: "chatcmpl_effort_row",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      return new Response([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

function ingressConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    cursorEffortRows: true,
    defaultProvider: "fixture",
    subagentEffortCap: "high",
    providers: {
      fixture: {
        adapter: "openai-chat",
        baseUrl,
        apiKey: "fixture-key",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["claude-effort-row-fixture"],
        modelReasoningEfforts: {
          "claude-effort-row-fixture": ["low", "high", "max"],
        },
      },
    },
  };
}

const childHeaders = {
  "content-type": "application/json",
  "x-openai-subagent": "collab_spawn",
};

describe("Cursor effort variant rows", () => {
  test("parseEffortRowId enables only the --<effort> grammar behind cursorEffortRows", () => {
    expect(parseEffortRowId("kimi/k3--high", {})).toBeNull();
    expect(parseEffortRowId("kimi/k3--high", { cursorEffortRows: false })).toBeNull();
    for (const id of ["kimi/k3@high", "kimi/k3:high", "kimi/k3-high", "kimi/k3--", "kimi/k3--turbo", "kimi/k3--none"]) {
      expect(parseEffortRowId(id, { cursorEffortRows: true })).toBeNull();
    }
    expect(parseEffortRowId("kimi/k3--high", { cursorEffortRows: true })).toEqual({
      baseId: "kimi/k3",
      effort: "high",
    });
    expect(parseEffortRowId("kimi/k3--high", { cursorEffortRows: true }, {
      knownIds: new Set(["kimi/k3--high"]),
    })).toBeNull();
  });

  test("Cursor-table model ids never become effort rows", () => {
    expect(parseEffortRowId("anthropic/claude-opus-5--high", { cursorEffortRows: true })).toBeNull();
    expect(parseEffortRowId("gpt-5.6-sol--high", { cursorEffortRows: true })).toBeNull();
  });

  test("cursorEffortRows false is byte-identical to an omitted flag", async () => {
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol"]);
    const omitted = await rawModelList(discoveryConfig());
    const disabled = await rawModelList(discoveryConfig(false));
    expect(disabled.text).toBe(omitted.text);
  });

  test("raw model discovery clones one complete row per supported effort only for table-less ids", async () => {
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol"]);
    const { data } = await rawModelList(discoveryConfig(true));
    const ids = data.map(row => row.id);
    expect(ids).toContain("anthropic/claude-fable-5-1--low");
    expect(ids).toContain("anthropic/claude-fable-5-1--high");
    expect(ids).toContain("anthropic/claude-fable-5-1--max");
    expect(ids).not.toContain("anthropic/claude-fable-5-1--none");
    expect(ids).toContain("cursor/kimi-k3--minimal");
    expect(ids).toContain("cursor/kimi-k3--medium");
    expect(ids).toContain("cursor/kimi-k3--ultra");
    expect(ids.some(id => id === "anthropic/claude-opus-5--high")).toBe(false);
    expect(ids.some(id => id === "cursor/gpt-5.6-sol--high")).toBe(false);

    for (const baseId of ["anthropic/claude-fable-5-1", "cursor/kimi-k3"]) {
      const base = data.find(row => row.id === baseId)!;
      const variants = data.filter(row => typeof row.id === "string" && row.id.startsWith(`${baseId}--`));
      const { id: _baseId, ...baseRest } = base;
      for (const variant of variants) {
        const { id: _variantId, ...variantRest } = variant;
        expect(variantRest).toEqual(baseRest);
      }
    }

    expect(expandCursorEffortRow(
      { id: "table-less", marker: { nested: true } },
      ["none", "high"],
      { cursorEffortRows: true },
    )).toEqual([
      { id: "table-less", marker: { nested: true } },
      { id: "table-less--high", marker: { nested: true } },
    ]);
  });

  test("Responses effort rows route the base model and pass through the existing cap", async () => {
    const upstream = mockChatUpstream();
    try {
      const config = ingressConfig(`${upstream.server.url.toString().replace(/\/$/u, "")}/v1`);
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: childHeaders,
        body: JSON.stringify({
          model: "fixture/claude-effort-row-fixture--max",
          stream: false,
          input: "hello",
        }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.captured[0]).toMatchObject({
        model: "claude-effort-row-fixture",
        reasoning_effort: "high",
      });
    } finally {
      upstream.server.stop(true);
    }
  });

  test("Chat effort rows use Responses normalization instead of the native-chat shortcut", async () => {
    const upstream = mockChatUpstream();
    try {
      const config = ingressConfig(`${upstream.server.url.toString().replace(/\/$/u, "")}/v1`);
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: childHeaders,
        body: JSON.stringify({
          model: "fixture/claude-effort-row-fixture--max",
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.captured[0]).toMatchObject({
        model: "claude-effort-row-fixture",
        reasoning_effort: "high",
      });
    } finally {
      upstream.server.stop(true);
    }
  });

  test("Messages effort rows resolve after route directives and before native passthrough", async () => {
    const upstream = mockChatUpstream();
    try {
      const config = ingressConfig(`${upstream.server.url.toString().replace(/\/$/u, "")}/v1`);
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          ...childHeaders,
          "x-api-key": "native-fixture-credential",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-fallback-model",
          max_tokens: 128,
          stream: false,
          system: [{ type: "text", text: "<!-- ocx-route: claude-effort-row-fixture--max -->" }],
          messages: [{ role: "user", content: "hello" }],
        }),
      }), config, { model: "", provider: "" } as RequestLogContext);
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.captured[0]).toMatchObject({
        model: "claude-effort-row-fixture",
        reasoning_effort: "high",
      });
    } finally {
      upstream.server.stop(true);
    }
  });

  test("Cursor integration status marks table-less bases and reports generated row ids", async () => {
    const config = discoveryConfig(true);
    const status = await buildCursorIntegrationStatus({
      config,
      deps: {
        loadCursorEffortTable: () => null,
        readRuntimePort: () => null,
      },
    }, []);
    const fable = status.models.find(model => model.id === "anthropic/claude-fable-5-1")!;
    expect(fable.tableLess).toBe(true);
    expect(fable.effortRows).toEqual([
      effortRowId(fable.id, "low"),
      effortRowId(fable.id, "high"),
      effortRowId(fable.id, "max"),
    ]);
    const kimi = status.models.find(model => model.id === "cursor/kimi-k3")!;
    expect(kimi.tableLess).toBe(true);
    expect(kimi.effortRows).toEqual([
      effortRowId(kimi.id, "minimal"),
      effortRowId(kimi.id, "medium"),
      effortRowId(kimi.id, "ultra"),
    ]);
    for (const id of ["anthropic/claude-opus-5", "cursor/gpt-5.6-sol"]) {
      const model = status.models.find(row => row.id === id)!;
      expect(model.tableLess).toBe(false);
      expect(model.effortRows).toEqual([]);
    }
  });
});
