import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../../src/codex/model-entitlements";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import { applyCompactionRoutingOverride } from "../../src/server/responses/compaction-routing";

/**
 * #7590: the catalog offers `ultra` on native rows as a client-facing choice, but the ChatGPT
 * backend accepts only none..max and answers `ultra` with HTTP 400. The native passthrough
 * serializes the caller's raw body, so the fold to `max` must reach that body on every ingress.
 */

const inspectNativeCodexOwnership = ownedServiceHomeInspection("native ultra effort wire test");
const MODELS = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"];

describe("native ultra effort reaches the ChatGPT backend as max", () => {
  let testDir = "";
  let previousHome: string | undefined;
  let isolatedCodexHome: IsolatedCodexHome | null = null;
  const originalFetch = globalThis.fetch;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  const efforts: unknown[] = [];

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedCodexHome = installIsolatedCodexHome("ocx-native-ultra-");
    testDir = mkdtempSync(join(tmpdir(), "ocx-native-ultra-"));
    process.env.OPENCODEX_HOME = testDir;
    efforts.length = 0;
    writeFileSync(join(isolatedCodexHome.path, "auth.json"), JSON.stringify({
      tokens: { access_token: "native-main-token", account_id: "main-account-uuid" },
    }));
    seedCodexModelEntitlementsForTests("main", MODELS);
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { reasoning?: { effort?: unknown } };
        efforts.push(body.reasoning?.effort);
        // Mirror the backend contract from the issue rather than accepting any effort.
        if (body.reasoning?.effort === "ultra") {
          return Response.json({ error: { message: "Invalid value: 'ultra'.", param: "reasoning.effort" } }, { status: 400 });
        }
        return Response.json({
          id: "resp_ultra_test",
          object: "response",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const upstreamUrl = upstream.url;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
        return originalFetch(new URL(url.pathname.slice("/backend-api/codex".length) + url.search, upstreamUrl), init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
          noReasoningModels: ["gpt-6.1-sol"],
        },
      },
    } as OcxConfig);
    server = startServer(0, { inspectNativeCodexOwnership });
  });

  afterEach(async () => {
    if (server) await server.stop(true);
    server = undefined;
    upstream?.stop(true);
    upstream = undefined;
    globalThis.fetch = originalFetch;
    resetCodexModelEntitlementCacheForTests();
    process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) await removeTreeWithRetry(testDir);
  });

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(new URL(path, server!.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer proxy-client-token" },
      body: JSON.stringify(body),
    });
  }

  test("/v1/responses folds ultra to max and keeps an explicit max", async () => {
    for (const model of MODELS) {
      const response = await post("/v1/responses", {
        model,
        stream: false,
        input: [{ role: "user", content: "say ok" }],
        reasoning: { effort: "ultra" },
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    const control = await post("/v1/responses", {
      model: "gpt-6-astra",
      stream: false,
      input: [{ role: "user", content: "say ok" }],
      reasoning: { effort: "max" },
    });
    expect(control.status).toBe(200);
    await control.text();
    expect(efforts).toEqual([...MODELS.map(() => "max"), "max"]);
  }, SERVER_BUDGET_MS);

  test("/v1/chat/completions folds reasoning_effort ultra to max", async () => {
    const response = await post("/v1/chat/completions", {
      model: "gpt-6-astra",
      stream: false,
      messages: [{ role: "user", content: "say ok" }],
      reasoning_effort: "ultra",
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(efforts).toEqual(["max"]);
  }, SERVER_BUDGET_MS);

  test("saved noReasoningModels cannot bypass the native none-to-low wire clamp", async () => {
    const response = await post("/v1/responses", {
      model: "gpt-6.1-sol", stream: false, input: "hi", reasoning: { effort: "none" },
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(efforts).toEqual(["low"]);
  }, SERVER_BUDGET_MS);
});

describe("native capability normalization keeps parsed and raw effort aligned", () => {
  test.each(["direct", "compaction-switch", "failover"])("%s retains the native clamp with saved exclusions", async path => {
    const config: OcxConfig = {
      port: 0, defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", noReasoningModels: ["gpt-6.1-sol"] },
        gateway: { adapter: "openai-responses", authMode: "key", baseUrl: "https://example.test/v1", reasoningEfforts: [],
          modelCapabilities: { model: { supportsReasoning: true, supportsThinkingToggle: true, supportsReasoningEffort: false } } },
      },
      compactionRouting: { model: "gpt-6.1-sol", reasoningEffort: "none" },
    };
    const body: Record<string, unknown> = {
      model: path === "direct" ? "gpt-6.1-sol" : "gateway/model",
      input: [{ role: "user", content: "hi" }, ...(path === "compaction-switch" ? [{ type: "compaction_trigger" }] : [])],
      reasoning: { effort: "none", summary: "auto" },
    };
    const req = new Request("http://localhost/v1/responses", { headers: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "manual" } }),
    } });
    if (path === "compaction-switch") expect(applyCompactionRoutingOverride(body, req.headers, config)).not.toBeNull();
    const parsed = parseRequest(body);
    const normalize = async (model: string) => {
      const route = routeModel(config, model);
      await applyFinalRouteRequestNormalization({ parsed, route, config, req, inboundWire: "responses", logCtx: { model, provider: route.providerName } });
    };
    if (path === "failover") {
      await normalize("gateway/model");
      expect(parsed.options.reasoning).toBeUndefined();
      expect(parsed.options.thinkingEnabled).toBe(false);
      expect((parsed._rawBody as { reasoning: unknown }).reasoning).toEqual({ summary: "auto" });
    }
    await normalize("gpt-6.1-sol");
    expect(parsed.options.reasoning).toBe("low");
    expect((parsed._rawBody as { reasoning: unknown }).reasoning).toEqual({ effort: "low", summary: "auto" });
  });
});
