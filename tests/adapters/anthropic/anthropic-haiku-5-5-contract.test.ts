/**
 * Claude Haiku 5.5 request contract (platform.claude.com Haiku 5.5 migration guide,
 * read 2026-10-08): adaptive only, explicit disable at high effort or below, forced tools accepted.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import {
  rejectsForcedToolChoice, rejectsSamplingParameters, sidecarThinkingOff,
  supportsExplicitThinkingDisable, usesAdaptiveThinking, usesBetweenToolsFloor,
} from "../../../src/adapters/anthropic-model-contract";
import type { OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;
const TOOL = { name: "lookup", description: "Look something up", parameters: { type: "object", properties: {} } } as OcxTool;

async function wireBody(modelId: string, options: Record<string, unknown>, tools?: OcxTool[]): Promise<Record<string, unknown>> {
  const parsed = {
    modelId, stream: false, options,
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }], ...(tools ? { tools } : {}) },
  } as unknown as OcxParsedRequest;
  const { body } = await createAnthropicAdapter(provider).buildRequest(parsed);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as Record<string, unknown>;
}

describe("Claude Haiku 5.5 wire contract", () => {
  test.each(["claude-haiku-5-5", "anthropic/claude-haiku-5.5", "claude-haiku-5-5/variant"])("%s disables thinking without sending an effort", async modelId => {
    const body = await wireBody(modelId, { reasoning: "none", temperature: 0.2, topP: 0.9 });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  test.each(["low", "medium", "high", "xhigh", "max"])("%s uses adaptive thinking and never disables it", async effort => {
    const body = await wireBody("claude-haiku-5-5", { reasoning: effort, temperature: 0.2, topP: 0.9 });
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  test("omitted reasoning sends neither thinking nor effort and drops sampling", async () => {
    const body = await wireBody("claude-haiku-5-5", { temperature: 0.2, topP: 0.9 });
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  test("required and named tool choices survive at every effort", async () => {
    for (const reasoning of [undefined, "none", "medium", "xhigh", "max"]) {
      expect((await wireBody("claude-haiku-5-5", { reasoning, toolChoice: "required" }, [TOOL])).tool_choice).toEqual({ type: "any" });
      expect((await wireBody("claude-haiku-5-5", { reasoning, toolChoice: { name: "lookup" } }, [TOOL])).tool_choice).toEqual({ type: "tool", name: "lookup" });
    }
  });

  test("Haiku 4.5 keeps budget thinking and Sonnet 5.5 keeps its between_tools floor", async () => {
    expect((await wireBody("claude-haiku-4-5", { reasoning: "medium" })).thinking).toMatchObject({ type: "enabled", budget_tokens: 8192 });
    expect((await wireBody("claude-haiku-4-5", { temperature: 0.2 })).temperature).toBe(0.2);
    const sonnet = await wireBody("claude-sonnet-5-5", { reasoning: "none", toolChoice: "required" }, [TOOL]);
    expect(sonnet.thinking).toEqual({ type: "between_tools" });
    expect(sonnet.output_config).toBeUndefined();
    expect(sonnet.tool_choice).toEqual({ type: "auto" });
  });

  test.each([
    ["claude-haiku-4-5", false, false, false, false],
    ["claude-haiku-5-4", false, false, false, false],
    ["claude-haiku-5-5", true, true, false, false],
    ["claude-haiku-6", true, true, false, false],
    ["claude-sonnet-5", true, true, false, false],
    ["claude-sonnet-5-5", true, false, true, true],
    ["claude-opus-4-6", false, false, false, false],
    ["claude-opus-5-5", true, false, false, true],
    ["claude-fable-5", true, false, false, false],
    ["claude-fable-5-1", true, false, false, true],
  ] as const)("%s keeps its family predicates", (modelId, adaptive, disable, betweenTools, forcedRejected) => {
    expect(usesAdaptiveThinking(modelId)).toBe(adaptive);
    expect(supportsExplicitThinkingDisable(modelId)).toBe(disable);
    expect(usesBetweenToolsFloor(modelId)).toBe(betweenTools);
    expect(rejectsForcedToolChoice(modelId)).toBe(forcedRejected);
    expect(rejectsSamplingParameters(modelId)).toBe(adaptive);
  });

  test("sidecars disable Haiku 5.5 without an effort and preserve always-on controls", () => {
    expect(sidecarThinkingOff("claude-haiku-5-5")).toEqual({ thinking: { type: "disabled" } });
    expect(sidecarThinkingOff("claude-sonnet-5-5")).toEqual({ thinking: { type: "between_tools" } });
    for (const id of ["claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"]) {
      expect(sidecarThinkingOff(id)).toEqual({ output_config: { effort: "low" } });
    }
  });
});
