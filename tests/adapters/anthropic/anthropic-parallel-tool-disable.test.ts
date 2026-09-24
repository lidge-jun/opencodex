/**
 * Audit F4 (2026-09-14): `options.parallelToolCalls === false` had no Anthropic
 * consumer. The caller asked for one tool call at a time and the request went out
 * unconstrained.
 *
 * Anthropic carries that intent as `disable_parallel_tool_use` nested INSIDE
 * `tool_choice`. Per the tool-use docs its per-mode meaning is:
 *   auto -> at most one call; any -> exactly one; tool -> exactly one;
 *   none -> tool use already off, so the flag is irrelevant.
 * The old code also emitted tool_choice only when an explicit choice was set, so a
 * request carrying only parallel_tool_calls:false emitted nothing at all — the
 * implicit default has to be stated for the flag to have somewhere to live.
 *
 * The flag constrains the model's OUTPUT, not execution order.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import type { OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;

const TOOL = { name: "lookup", description: "Look something up", parameters: { type: "object", properties: {} } } as OcxTool;
const OTHER_TOOL = { name: "write", description: "Write something", parameters: { type: "object", properties: {} } } as OcxTool;

async function toolChoiceOf(
  options: Record<string, unknown>,
  withTools = true,
  modelId = "anthropic/claude-sonnet-4.5",
  tools = [TOOL],
): Promise<Record<string, unknown> | undefined> {
  const parsed = {
    modelId,
    stream: false,
    options,
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }], ...(withTools ? { tools } : {}) },
  } as unknown as OcxParsedRequest;
  const { body } = await createAnthropicAdapter(provider).buildRequest(parsed);
  const parsedBody = JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as { tool_choice?: Record<string, unknown> };
  return parsedBody.tool_choice;
}

async function wireBodyOf(
  options: Record<string, unknown>,
  modelId: string,
  tools: OcxTool[],
): Promise<Record<string, unknown>> {
  const parsed = {
    modelId,
    stream: false,
    options,
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools },
  } as unknown as OcxParsedRequest;
  const { body } = await createAnthropicAdapter(provider).buildRequest(parsed);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as Record<string, unknown>;
}

describe("F4 parallel=false maps onto nested disable_parallel_tool_use", () => {
  test("implicit auto is synthesized so the intent has somewhere to live", async () => {
    expect(await toolChoiceOf({ parallelToolCalls: false }))
      .toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  test("an explicit auto carries the flag", async () => {
    expect(await toolChoiceOf({ toolChoice: "auto", parallelToolCalls: false }))
      .toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  test("required maps to any and carries the flag", async () => {
    expect(await toolChoiceOf({ toolChoice: "required", parallelToolCalls: false }))
      .toEqual({ type: "any", disable_parallel_tool_use: true });
  });

  test("a named tool choice carries the flag", async () => {
    const choice = await toolChoiceOf({ toolChoice: { name: "lookup" }, parallelToolCalls: false });

    expect(choice).toMatchObject({ type: "tool", disable_parallel_tool_use: true });
    expect(choice!.name).toBe("lookup");
  });

  test("allowed-tools auto and required both carry the flag", async () => {
    // The IR shape is { allowedTools, mode } (src/types/tools.ts:294-299), which
    // isAllowedToolChoice detects by the allowedTools key.
    expect(await toolChoiceOf({ toolChoice: { allowedTools: ["lookup"], mode: "auto" }, parallelToolCalls: false }))
      .toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(await toolChoiceOf({ toolChoice: { allowedTools: ["lookup"], mode: "required" }, parallelToolCalls: false }))
      .toEqual({ type: "any", disable_parallel_tool_use: true });
  });
});

describe("Claude Opus 5.5 forced tool choice compatibility", () => {
  test("required becomes auto because Opus 5.5 rejects forced tool use with adaptive thinking", async () => {
    const choice = await toolChoiceOf({ toolChoice: "required", reasoning: "medium" }, true, "anthropic/claude-opus-5-5");
    expect(choice).toEqual({ type: "auto" });
  });

  test("named becomes auto even when reasoning is omitted", async () => {
    const choice = await toolChoiceOf({ toolChoice: { name: "lookup" } }, true, "anthropic/claude-opus-5-5");
    expect(choice).toEqual({ type: "auto" });
  });

  test("named downgrade keeps the selected tool as the only candidate", async () => {
    const body = await wireBodyOf({ toolChoice: { name: "lookup" } }, "anthropic/claude-opus-5-5", [TOOL, OTHER_TOOL]);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect((body.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(["lookup"]);
  });

  test("allowed required keeps its allowlist when it becomes auto", async () => {
    const body = await wireBodyOf(
      { toolChoice: { allowedTools: ["lookup"], mode: "required" } },
      "anthropic/claude-opus-5-5",
      [TOOL, OTHER_TOOL],
    );
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect((body.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(["lookup"]);
  });

  test("dotted routed ids use the same Opus 5.5 compatibility rule", async () => {
    const choice = await toolChoiceOf({ toolChoice: "required" }, true, "anthropic/claude-opus-5.5");
    expect(choice).toEqual({ type: "auto" });
  });

  test("Opus 5.5 auto and none choices remain unchanged", async () => {
    expect(await toolChoiceOf({ toolChoice: "auto" }, true, "anthropic/claude-opus-5-5")).toEqual({ type: "auto" });
    expect(await toolChoiceOf({ toolChoice: "none" }, true, "anthropic/claude-opus-5-5")).toEqual({ type: "none" });
  });

  test("the parallel-call limit stays attached after the compatibility downgrade", async () => {
    const choice = await toolChoiceOf(
      { toolChoice: "required", reasoning: "medium", parallelToolCalls: false },
      true,
      "anthropic/claude-opus-5-5",
    );
    expect(choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  test("the Opus 5 forced choice contract remains unchanged", async () => {
    const choice = await toolChoiceOf({ toolChoice: "required", reasoning: "medium" }, true, "anthropic/claude-opus-5");
    expect(choice).toEqual({ type: "any" });
  });
});

describe("F4 cases that must not change", () => {
  test("none stays bare — tool use is already off, so the flag is irrelevant", async () => {
    expect(await toolChoiceOf({ toolChoice: "none", parallelToolCalls: false })).toEqual({ type: "none" });
  });

  test("no tools on the wire means no tool_choice at all", async () => {
    expect(await toolChoiceOf({ parallelToolCalls: false }, false)).toBeUndefined();
  });

  test("parallel unset is byte-identical to today", async () => {
    expect(await toolChoiceOf({ toolChoice: "auto" })).toEqual({ type: "auto" });
    expect(await toolChoiceOf({})).toBeUndefined();
  });

  test("parallel true never attaches the flag", async () => {
    expect(await toolChoiceOf({ toolChoice: "auto", parallelToolCalls: true })).toEqual({ type: "auto" });
    expect(await toolChoiceOf({ parallelToolCalls: true })).toBeUndefined();
  });
});
