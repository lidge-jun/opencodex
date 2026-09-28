/**
 * Claude Sonnet 5.5 request contract (platform.claude.com Sonnet 5.5 migration guide, 2026-09-29).
 *
 * Sonnet 5 accepts `thinking: {type: "disabled"}`; Sonnet 5.5 returns 400 for it and for
 * `enabled`, forced tool choice and non-default sampling parameters. Its lowest setting is
 * `between_tools`, accepted at low..high effort.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { sidecarThinkingOff } from "../../../src/adapters/anthropic-model-contract";
import type { OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;
const TOOL = { name: "lookup", description: "Look something up", parameters: { type: "object", properties: {} } } as OcxTool;

async function wireBody(modelId: string, options: Record<string, unknown>, tools?: OcxTool[]): Promise<Record<string, unknown>> {
  const parsed = {
    modelId,
    stream: false,
    options,
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }], ...(tools ? { tools } : {}) },
  } as unknown as OcxParsedRequest;
  const { body } = await createAnthropicAdapter(provider).buildRequest(parsed);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as Record<string, unknown>;
}

describe("Claude Sonnet 5.5 wire contract", () => {
  test("reasoning none sends between_tools with no effort and no sampling parameters", async () => {
    for (const modelId of ["claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"]) {
      const body = await wireBody(modelId, { reasoning: "none", temperature: 0.2, topP: 0.9 });
      expect(body.thinking, modelId).toEqual({ type: "between_tools" });
      expect(body.output_config, modelId).toBeUndefined();
      expect(body.temperature, modelId).toBeUndefined();
      expect(body.top_p, modelId).toBeUndefined();
    }
  });

  test("Sonnet 5 keeps the explicit disable", async () => {
    const body = await wireBody("claude-sonnet-5", { reasoning: "none", temperature: 0.2 });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.temperature).toBe(0.2);
  });

  test("an effort uses the adaptive wire at every documented rung", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const body = await wireBody("claude-sonnet-5-5", { reasoning: effort });
      expect((body.thinking as { type?: string }).type, effort).toBe("adaptive");
      expect(body.output_config, effort).toEqual({ effort });
    }
  });

  test("sampling parameters are dropped even when no reasoning is requested", async () => {
    const body = await wireBody("claude-sonnet-5-5", { temperature: 0.2, topP: 0.9 });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  test("forced tool choices degrade to auto while Sonnet 5 keeps them", async () => {
    expect((await wireBody("claude-sonnet-5-5", { toolChoice: "required" }, [TOOL])).tool_choice).toEqual({ type: "auto" });
    expect((await wireBody("claude-sonnet-5-5", { toolChoice: { name: "lookup" } }, [TOOL])).tool_choice).toEqual({ type: "auto" });
    expect((await wireBody("claude-sonnet-5", { toolChoice: "required" }, [TOOL])).tool_choice).toEqual({ type: "any" });
  });

  test("sidecars ask Sonnet 5.5 for between_tools and keep disabled elsewhere", () => {
    expect(sidecarThinkingOff("claude-sonnet-5-5")).toEqual({ type: "between_tools" });
    expect(sidecarThinkingOff("claude-sonnet-5")).toEqual({ type: "disabled" });
    expect(sidecarThinkingOff("claude-haiku-4-5")).toEqual({ type: "disabled" });
  });
});
