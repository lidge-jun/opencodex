import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePinnedEffort, applyPinnedEffort } from "../src/server/effort-policy";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

describe("model pinned reasoning effort policy", () => {
  const providerWithPinned: OcxProviderConfig = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    pinnedReasoningEffort: "high",
    modelPinnedReasoningEfforts: {
      "special-model": "max",
      "disabled-effort-model": "none",
    },
  };

  test("resolves model-specific pinned effort over provider-wide pinned effort", () => {
    const route = { provider: providerWithPinned, modelId: "special-model" };
    expect(resolvePinnedEffort(route)).toBe("max");
  });

  test("resolves provider-wide pinned effort when model is not specifically pinned", () => {
    const route = { provider: providerWithPinned, modelId: "other-model" };
    expect(resolvePinnedEffort(route)).toBe("high");
  });

  test("resolves global config modelPinnedEfforts fallback when provider has none", () => {
    const emptyProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const config = {
      modelPinnedEfforts: { "global-pinned": "max" },
    } as unknown as OcxConfig;
    const route = { provider: emptyProvider, modelId: "global-pinned" };
    expect(resolvePinnedEffort(route, undefined, config)).toBe("max");
  });

  test("applyPinnedEffort overrides caller effort in both parsed options and raw body", () => {
    const route = { provider: providerWithPinned, modelId: "special-model" };
    const parsed: OcxParsedRequest = {
      modelId: "special-model",
      context: { messages: [] },
      stream: true,
      options: { reasoning: "low" },
      _rawBody: { reasoning: { effort: "low" } },
    };

    const rewrite = applyPinnedEffort(parsed, route);
    expect(rewrite).toEqual({ from: "low", to: "max" });
    expect(parsed.options.reasoning).toBe("max");
    expect((parsed._rawBody as any).reasoning.effort).toBe("max");
  });

  test("applyPinnedEffort applies pinned effort when caller sent none", () => {
    const route = { provider: providerWithPinned, modelId: "other-model" };
    const parsed: OcxParsedRequest = {
      modelId: "other-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {},
    };

    const rewrite = applyPinnedEffort(parsed, route);
    expect(rewrite).toEqual({ from: undefined, to: "high" });
    expect(parsed.options.reasoning).toBe("high");
    expect((parsed._rawBody as any).reasoning.effort).toBe("high");
  });

  test("applyPinnedEffort with none strips effort from both shapes", () => {
    const route = { provider: providerWithPinned, modelId: "disabled-effort-model" };
    const parsed: OcxParsedRequest = {
      modelId: "disabled-effort-model",
      context: { messages: [] },
      stream: true,
      options: { reasoning: "high" },
      _rawBody: { reasoning: { effort: "high", summary: "auto" } },
    };

    const rewrite = applyPinnedEffort(parsed, route);
    expect(rewrite).toEqual({ from: "high", to: "none" });
    expect(parsed.options.reasoning).toBeUndefined();
    expect((parsed._rawBody as any).reasoning.effort).toBeUndefined();
    expect((parsed._rawBody as any).reasoning.summary).toBe("auto");
  });
});

describe("management API pinned reasoning effort configuration", () => {
  let tempHome: string;
  function isolatedHome(): void {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-pinned-effort-"));
    process.env.OPENCODEX_HOME = tempHome;
  }

  function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
    return {
      version: 1,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://api.custom.com",
          allowPrivateNetwork: true,
        },
      },
      ...overrides,
    } as unknown as OcxConfig;
  }

  test("PATCH /api/providers sets and updates pinned reasoning efforts", async () => {
    isolatedHome();
    const config = makeConfig();
    const patchReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pinnedReasoningEffort: "high",
        modelPinnedReasoningEfforts: { "model-a": "max", "model-b": "low" },
      }),
    });
    const patchRes = await handleManagementAPI(patchReq, new URL(patchReq.url), config);
    expect(patchRes?.status).toBe(200);
    const provider = config.providers.custom;
    expect(provider.pinnedReasoningEffort).toBe("high");
    expect(provider.modelPinnedReasoningEfforts).toEqual({ "model-a": "max", "model-b": "low" });

    // Updating with whitespace key normalizes to trimmed model id
    const wsReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedReasoningEfforts: { "  model-c  ": "medium" },
      }),
    });
    const wsRes = await handleManagementAPI(wsReq, new URL(wsReq.url), config);
    expect(wsRes?.status).toBe(200);
    expect(config.providers.custom.modelPinnedReasoningEfforts).toEqual({ "model-a": "max", "model-b": "low", "model-c": "medium" });

    // Clearing a model pinned effort with whitespace key
    const wsClearReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedReasoningEfforts: { "  model-c  ": null },
      }),
    });
    const wsClearRes = await handleManagementAPI(wsClearReq, new URL(wsClearReq.url), config);
    expect(wsClearRes?.status).toBe(200);
    expect(config.providers.custom.modelPinnedReasoningEfforts).toEqual({ "model-a": "max", "model-b": "low" });

    // Clearing a model pinned effort
    const clearReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedReasoningEfforts: { "model-a": null },
      }),
    });
    const clearRes = await handleManagementAPI(clearReq, new URL(clearReq.url), config);
    expect(clearRes?.status).toBe(200);
    expect(config.providers.custom.modelPinnedReasoningEfforts).toEqual({ "model-b": "low" });
  });

  test("PATCH /api/providers rejects invalid reasoning effort values", async () => {
    isolatedHome();
    const config = makeConfig();
    const badReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pinnedReasoningEffort: "invalid-tier",
      }),
    });
    const badRes = await handleManagementAPI(badReq, new URL(badReq.url), config);
    expect(badRes?.status).toBe(400);
  });

  test("PUT /api/effort-caps supports modelPinnedEfforts roundtrip", async () => {
    isolatedHome();
    const config = makeConfig();
    const putReq = new Request("http://localhost/api/effort-caps", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedEfforts: { "gpt-5.5": "max", "claude-sonnet-4-6": "high" },
      }),
    });
    const putRes = await handleManagementAPI(putReq, new URL(putReq.url), config);
    expect(putRes?.status).toBe(200);
    expect(config.modelPinnedEfforts).toEqual({ "gpt-5.5": "max", "claude-sonnet-4-6": "high" });

    const getReq = new Request("http://localhost/api/effort-caps");
    const getRes = await handleManagementAPI(getReq, new URL(getReq.url), config);
    const data = await getRes?.json() as { modelPinnedEfforts: Record<string, string> };
    expect(data.modelPinnedEfforts).toEqual({ "gpt-5.5": "max", "claude-sonnet-4-6": "high" });

    // Partial merge: add one model, clear another
    const updateReq = new Request("http://localhost/api/effort-caps", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedEfforts: { "gemini-3.7-flash": "high", "gpt-5.5": null },
      }),
    });
    const updateRes = await handleManagementAPI(updateReq, new URL(updateReq.url), config);
    expect(updateRes?.status).toBe(200);
    expect(config.modelPinnedEfforts).toEqual({ "claude-sonnet-4-6": "high", "gemini-3.7-flash": "high" });
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";

describe("native chat completions effort policy", () => {
  const { chatCollabSurface, applyChatEffortCap } = require("../src/server/effort-policy");

  test("detects v2 collab surface in native chat tools", () => {
    const chatBody = {
      tools: [
        { type: "function", function: { name: "spawn_agent" } },
        { type: "function", function: { name: "send_message" } },
      ],
    };
    expect(chatCollabSurface(chatBody)).toBe("v2");
  });

  test("applyChatEffortCap respects effortCap ceiling over pinned effort", () => {
    const config = {
      effortCap: "low",
    };
    const chatBody = {
      reasoning_effort: "max",
    };
    const rewrite = applyChatEffortCap(chatBody, new Headers(), config, ["low", "medium", "high", "max"]);
    expect(rewrite).toEqual({ from: "max", to: "low", subagent: false });
    expect(chatBody.reasoning_effort).toBe("low");
  });
});
