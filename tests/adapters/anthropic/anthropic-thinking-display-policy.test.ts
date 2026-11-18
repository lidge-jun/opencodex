import { expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";

const base = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "synthetic" } as const;
// Routed requests reach the adapter with the native wire id, which is also the key these maps use.
const opus55 = "claude-opus-5-5";
const sonnet5 = "claude-sonnet-5";
const updatesBeta = "thinking-display-updates-2026-08-18";

async function requestBody(
  provider: OcxProviderConfig,
  model: string,
  reasoning?: { effort?: string; summary?: string },
): Promise<{ thinking: unknown; beta: string | null }> {
  const adapter = createAnthropicAdapter(provider);
  const request = await adapter.buildRequest(parseRequest({
    model,
    input: "question",
    ...(reasoning ? { reasoning } : {}),
  }));
  return {
    thinking: JSON.parse(request.body as string).thinking,
    beta: new Headers(request.headers).get("anthropic-beta"),
  };
}

test("modelThinkingDisplay summarized sends summarized for native Opus 5.5 with bare effort", async () => {
  const { thinking, beta } = await requestBody({ ...base, modelThinkingDisplay: { "claude-opus-5-5": "summarized" } }, opus55, { effort: "high" });
  expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(beta ?? "").not.toContain(updatesBeta);
});

test("provider-level summarized applies when no model entry exists", async () => {
  const { thinking, beta } = await requestBody({ ...base, thinkingDisplay: "summarized" }, opus55);
  expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(beta ?? "").not.toContain(updatesBeta);
});

test("model-level updates overrides provider summarized for Opus 5.5", async () => {
  const { thinking, beta } = await requestBody({
    ...base,
    thinkingDisplay: "summarized",
    modelThinkingDisplay: { "claude-opus-5-5": "updates" },
  }, opus55, { effort: "high" });
  expect(thinking).toEqual({ type: "adaptive", display: "updates" });
  expect(beta).toContain(updatesBeta);
});

test("updates configured for a non-Opus-5.5 adaptive model keeps current behavior", async () => {
  const configured = await requestBody({ ...base, thinkingDisplay: "updates" }, sonnet5, { effort: "high" });
  const unset = await requestBody({ ...base }, sonnet5, { effort: "high" });
  expect(configured.thinking).toEqual(unset.thinking);
  expect(configured.thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(configured.beta ?? "").not.toContain(updatesBeta);
});

test("model-level auto overrides a provider-level policy for that model", async () => {
  const { thinking, beta } = await requestBody({
    ...base,
    thinkingDisplay: "summarized",
    modelThinkingDisplay: { "claude-opus-5-5": "auto" },
  }, opus55, { effort: "high" });
  expect(thinking).toEqual({ type: "adaptive", display: "updates" });
  expect(beta).toContain(updatesBeta);

  // The provider value still applies to a model with no entry of its own.
  const sonnet = await requestBody({ ...base, thinkingDisplay: "summarized" }, sonnet5, { effort: "high" });
  expect(sonnet.thinking).toEqual({ type: "adaptive", display: "summarized" });
});

test("explicit request summary detailed still wins over configured updates", async () => {
  const { thinking, beta } = await requestBody({
    ...base,
    thinkingDisplay: "updates",
    modelThinkingDisplay: { "claude-opus-5-5": "updates" },
  }, opus55, { effort: "high", summary: "detailed" });
  expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(beta ?? "").not.toContain(updatesBeta);
});

test("explicit request summary wins over configured omitted on every adaptive model", async () => {
  for (const model of [opus55, sonnet5]) {
    for (const summary of ["concise", "detailed"] as const) {
      const { thinking, beta } = await requestBody({ ...base, thinkingDisplay: "omitted" }, model, { effort: "high", summary });
      expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(beta ?? "").not.toContain(updatesBeta);
    }
  }
});

test("unset policy keeps Opus 5.5 updates and non-Opus summarized byte-identically", async () => {
  const opus = await requestBody({ ...base }, opus55, { effort: "high" });
  expect(opus.thinking).toEqual({ type: "adaptive", display: "updates" });
  expect(opus.beta).toContain(updatesBeta);
  const sonnet = await requestBody({ ...base }, sonnet5, { effort: "high" });
  expect(sonnet.thinking).toEqual({ type: "adaptive", display: "summarized" });
});

test("auto policy keeps hideThinkingSummary meaning on adaptive models", async () => {
  const adapter = createAnthropicAdapter({ ...base, thinkingDisplay: "auto" });
  const parsed = parseRequest({ model: sonnet5, input: "question", reasoning: { effort: "high" } });
  parsed.options.hideThinkingSummary = true;
  const request = await adapter.buildRequest(parsed);
  expect(JSON.parse(request.body as string).thinking).toEqual({ type: "adaptive" });
});

test("configured summarized overrides local summary hiding on adaptive models", async () => {
  for (const model of [opus55, sonnet5]) {
    const adapter = createAnthropicAdapter({ ...base, thinkingDisplay: "summarized" });
    const parsed = parseRequest({ model, input: "question", reasoning: { effort: "high" } });
    parsed.options.hideThinkingSummary = true;
    const request = await adapter.buildRequest(parsed);
    expect(JSON.parse(request.body as string).thinking).toEqual({ type: "adaptive", display: "summarized" });
  }
});

test("omitted policy sends adaptive thinking without a summarized display", async () => {
  for (const model of [opus55, sonnet5]) {
    const { thinking, beta } = await requestBody({ ...base, thinkingDisplay: "omitted" }, model, { effort: "high" });
    expect(thinking).toEqual({ type: "adaptive" });
    expect(beta ?? "").not.toContain(updatesBeta);
  }
});
