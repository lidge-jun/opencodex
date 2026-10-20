import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInboundModel, anthropicToResponsesBody } from "../../src/claude/inbound";
import { claudeCodeForIngress } from "../../src/claude/intercept/model-bindings";
import { DesktopModelMappingUnavailableError } from "../../src/claude/inbound-records";
import { getConfigPath, getDefaultConfig, loadConfig, saveConfig, validateConfigCandidate } from "../../src/config";
import { routeModel } from "../../src/router";
import { startServer } from "../../src/server";
import type { OcxClaudeCodeConfig, OcxConfig } from "../../src/types";
import { managementFetch } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const tierRoutes = {
  opus: "mock/opus-target", sonnet: "mock/sonnet-target",
  haiku: "mock/haiku-target", fable: "mock/fable-target",
};
const cc: OcxClaudeCodeConfig = { tierRoutes };

function requestBody(model: string) {
  return { model, max_tokens: 16, messages: [{ role: "user", content: "hello" }] };
}

describe("Claude ingress tier routing", () => {
  test.each([
    ["claude-opus-5-5", "opus"], ["claude-sonnet-5-5", "sonnet"],
    ["claude-haiku-5-5", "haiku"], ["claude-fable-5-1", "fable"],
    ["claude-opus-99-1", "opus"], ["claude-sonnet-4-5-20250929", "sonnet"],
    ["claude-3-opus-20240229", "opus"], ["claude-3-5-sonnet-20241022", "sonnet"],
    ["claude-3-haiku-20240307", "haiku"], ["claude-3-5-sonnet-latest", "sonnet"],
    ["claude-sonnet-latest", "sonnet"], ["claude-sonnet-5-5[1M]", "sonnet"],
  ])("routes %s by tier", (model, tier) => {
    expect(resolveInboundModel(model, cc)).toBe(tierRoutes[tier as keyof typeof tierRoutes]);
  });

  test("unset policy and missing tiers preserve existing behavior and launcher defaults", () => {
    expect(resolveInboundModel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(resolveInboundModel("claude-sonnet-5-5", { tierRoutes: { opus: "mock/opus" } })).toBe("claude-sonnet-5-5");
    expect(resolveInboundModel("claude-sonnet-5-5", { tierModels: { sonnet: "mock/launch-only" } })).toBe("claude-sonnet-5-5");
  });

  test.each(["anthropic/claude-sonnet-5-5", "combo/claude-sonnet-5-5", "policy/claude-sonnet-5-5", "gpt-5.5", "sonnet", "claude-sonnet-custom", "claude-not-sonnet-5"])("preserves explicit or non-tier selector %s", model => {
    expect(resolveInboundModel(model, cc)).toBe(model);
  });

  test("discovery aliases and exact and dateless modelMap entries win", () => {
    const mapped = { ...cc, modelMap: { "claude-sonnet-5-5": "mock/dateless", "claude-sonnet-5-5-20250929": "mock/exact" } };
    expect(resolveInboundModel("ocx-claude-mock--claude-sonnet-5-5", mapped)).toBe("mock/claude-sonnet-5-5");
    expect(resolveInboundModel("claude-sonnet-5-5-20250929", mapped)).toBe("mock/exact");
    expect(resolveInboundModel("claude-sonnet-5-5-20260101", mapped)).toBe("mock/dateless");
    expect(resolveInboundModel("claude-sonnet-5-5", mapped)).toBe("mock/dateless");
  });

  test("explicit classifier configuration retains priority", () => {
    expect(resolveInboundModel("claude-opus-5-5", { ...cc, classifierModel: "mock/classifier" })).toBe("mock/classifier");
    expect(resolveInboundModel("claude-opus-5-5", { ...cc, classifierFallbacks: ["mock/fallback"] })).toBe("mock/fallback");
  });

  test("intercept bindings retain priority over global mappings and tiers", () => {
    const intercepted = claudeCodeForIngress({ ...cc, intercept: { modelMap: { "claude-sonnet-5-5": "mock/intercept" } } }, true);
    expect(resolveInboundModel("claude-sonnet-5-5", intercepted)).toBe("mock/intercept");
  });

  test("unresolved Desktop aliases retain their refusal rather than picking a tier", () => {
    expect(() => resolveInboundModel("claude-opus-4-8-20261231", cc)).toThrow(DesktopModelMappingUnavailableError);
  });

  test("translation forwards the target once, without recursively remapping it", () => {
    const policy = { tierRoutes: { sonnet: "claude-haiku-5-5", haiku: "mock/other" } };
    expect(anthropicToResponsesBody(requestBody("claude-sonnet-5-5"), policy).model).toBe("claude-haiku-5-5");
    for (const target of ["combo/balanced", "policy/quality"]) {
      expect(resolveInboundModel("claude-sonnet-5-5", { tierRoutes: { sonnet: target } })).toBe(target);
    }
  });

  test.each(["", " mock/model", "mock/model\n", 42, null])("ignores malformed runtime target %j", target => {
    expect(resolveInboundModel("claude-sonnet-5-5", { tierRoutes: { sonnet: target } } as OcxClaudeCodeConfig)).toBe("claude-sonnet-5-5");
  });
});

let home = "";
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-tier-routing-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

test("config validates sparse policies and rejects malformed tier keys and routes", () => {
  for (const policy of [{}, tierRoutes, { sonnet: "combo/balanced" }]) {
    expect(validateConfigCandidate({ ...getDefaultConfig(), claudeCode: { tierRoutes: policy } }).ok).toBe(true);
  }
  for (const policy of [null, [], "mock/model", { unknown: "mock/model" }, { opus: "" }, { opus: " mock/model" }, { opus: 42 }]) {
    expect(validateConfigCandidate({ ...getDefaultConfig(), claudeCode: { tierRoutes: policy } }).ok).toBe(false);
  }
});

test("malformed persisted policy drops only tier routing, preserving providers and modelMap", () => {
  const config = { ...getDefaultConfig(), claudeCode: { modelMap: { "claude-sonnet-5-5": "mock/preserved" }, tierRoutes: { sonnet: 42 } } };
  writeFileSync(getConfigPath(), JSON.stringify(config));
  const loaded = loadConfig();
  expect(loaded.providers).toEqual(config.providers);
  expect(loaded.claudeCode?.modelMap).toEqual(config.claudeCode.modelMap);
  expect(loaded.claudeCode?.tierRoutes).toBeUndefined();
});

test("generic router does not apply Claude ingress tier policy", () => {
  const config = { ...getDefaultConfig(), defaultProvider: "mock", providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.com/v1", models: ["claude-sonnet-5-5"] } }, claudeCode: cc } as OcxConfig;
  expect(routeModel(config, "mock/claude-sonnet-5-5").modelId).toBe("claude-sonnet-5-5");
});

test("Messages tier routing bypasses caller native passthrough and uses the selected provider", async () => {
  const captured: Array<{ model: string; authorization: string | null }> = [];
  let nativeCalls = 0;
  const upstream = Bun.serve({ port: 0, async fetch(req) {
    if (new URL(req.url).pathname.startsWith("/native")) { nativeCalls++; return Response.json({ error: "unexpected native call" }, { status: 500 }); }
    const body = await req.json() as { model: string };
    captured.push({ model: body.model, authorization: req.headers.get("authorization") });
    const chunk = { id: "chat-test", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "routed" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const config = {
    ...getDefaultConfig(), port: 0, defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).toString(), apiKey: "test-provider-key", authMode: "key", allowPrivateNetwork: true, liveModels: false, models: ["sonnet-target"] } },
    claudeCode: { tierRoutes: { sonnet: "mock/sonnet-target" }, anthropicBaseUrl: new URL("/native", upstream.url).toString() },
  } as OcxConfig;
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await managementFetch(new URL("/v1/messages", server.url), {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-tst" },
      body: JSON.stringify(requestBody("claude-sonnet-5-5")),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).toContain("routed");
    expect(captured).toEqual([{ model: "sonnet-target", authorization: "Bearer test-provider-key" }]);
    expect(nativeCalls).toBe(0);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});
