import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { buildClaudeReplayConfig } from "../src/server/claude-messages";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { planVisionSidecar } from "../src/vision";
import { planWebSearch } from "../src/web-search";

const routed: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://routed.test/v1",
  apiKey: "routed-key",
  noVisionModels: ["text-model"],
};
const forward: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};
const headers = new Headers({ authorization: "Bearer chatgpt" });
const openAiSidecar = {
  providerName: "openai" as const,
  provider: forward,
  accountMode: "direct" as const,
  authContext: { kind: "main" as const, accountId: null },
  headers,
};
const request = parseRequest({
  model: "routed/text-model",
  input: [{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "Search and inspect this image" },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
    ],
  }],
  tools: [{ type: "web_search" }],
});

test("Claude replay overrides both sidecars while preserving global-only settings", () => {
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "routed",
    providers: { routed, forward },
    webSearchSidecar: {
      enabled: true,
      backend: "anthropic",
      model: "global-search",
      reasoning: "high",
      timeoutMs: 12_345,
      routedModelStallTimeoutMs: 23_456,
      maxSearchesPerTurn: 3,
    },
    visionSidecar: {
      enabled: true,
      backend: "anthropic",
      model: "global-vision",
      timeoutMs: 34_567,
      maxDescriptionsPerTurn: 4,
    },
    claudeCode: {
      webSearchSidecar: { backend: "openai", model: "claude-search" },
      visionSidecar: { backend: "openai", model: "claude-vision" },
    },
  };

  const effective = buildClaudeReplayConfig(config);
  expect(effective).not.toBe(config);
  expect(effective.webSearchSidecar).toEqual({
    enabled: true,
    backend: "openai",
    model: "claude-search",
    reasoning: "high",
    timeoutMs: 12_345,
    routedModelStallTimeoutMs: 23_456,
    maxSearchesPerTurn: 3,
  });
  expect(effective.visionSidecar).toEqual({
    enabled: true,
    backend: "openai",
    model: "claude-vision",
    timeoutMs: 34_567,
    maxDescriptionsPerTurn: 4,
  });

  const webPlan = planWebSearch(effective, request, false, routed, "text-model", openAiSidecar);
  const visionPlan = planVisionSidecar(effective, routed, "text-model", request, openAiSidecar);
  expect(webPlan).toMatchObject({
    backend: "openai",
    settings: { model: "claude-search", reasoning: "high", timeoutMs: 12_345 },
    maxSearches: 3,
    routedModelStallTimeoutMs: 23_456,
  });
  expect(visionPlan).toMatchObject({
    backend: "openai",
    settings: { model: "claude-vision", timeoutMs: 34_567 },
    maxDescriptionsPerTurn: 4,
  });

  // Native /v1/responses receives the original config, so Claude-only values never leak into Codex.
  expect(config.webSearchSidecar?.backend).toBe("anthropic");
  expect(config.webSearchSidecar?.model).toBe("global-search");
  expect(config.visionSidecar?.backend).toBe("anthropic");
  expect(config.visionSidecar?.model).toBe("global-vision");
});

test("unset Claude overrides inherit the global sidecar backend and model", () => {
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "routed",
    providers: { routed, forward },
    webSearchSidecar: { backend: "openai", model: "global-search" },
    visionSidecar: { backend: "openai", model: "global-vision" },
    claudeCode: {},
  };
  const effective = buildClaudeReplayConfig(config);

  expect(planWebSearch(effective, request, false, routed, "text-model", openAiSidecar)).toMatchObject({
    backend: "openai",
    settings: { model: "global-search" },
  });
  expect(planVisionSidecar(effective, routed, "text-model", request, openAiSidecar)).toMatchObject({
    backend: "openai",
    settings: { model: "global-vision" },
  });
});
