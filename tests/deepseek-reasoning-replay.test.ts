/**
 * DeepSeek V4 is stateless on the Responses API and requires the caller to replay
 * prior assistant reasoning text on every continuation (issue #875). The passthrough
 * sanitizer must therefore keep `reasoning.content` for models listed in
 * `preserveReasoningContentModels` (seeded for DeepSeek thinking models) while still
 * blanking it for ChatGPT-native passthrough and still stripping proxy-minted ocxr1
 * envelopes. A routable DeepSeek entry also has to be usable as a sub-agent model.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { sanitizeReasoningInputContent } from "../src/adapters/openai-responses";
import { buildSubagentModelChain, isSubagentModelUnavailable } from "../src/codex/subagent-model-fallback";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { OCX_REASONING_PREFIX } from "../src/responses/reasoning-envelope";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
const MODEL = "deepseek-v4-flash";

const RAW_REASONING = {
  type: "reasoning",
  id: "rs_1",
  summary: [],
  content: [{ type: "reasoning_text", text: "inspect the failing build" }],
};

function deepseekProvider(): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
}

describe("sanitizeReasoningInputContent respects replay-capable models", () => {
  test("keeps raw reasoning content for a preserve-listed model", () => {
    const out = sanitizeReasoningInputContent(
      { input: [RAW_REASONING] },
      { preserveContentModels: ["deepseek-v4-flash"], modelId: MODEL },
    ) as { input: Array<Record<string, unknown>> };
    expect(out.input[0].content).toEqual(RAW_REASONING.content);
  });

  test("still blanks raw reasoning content for non-preserving passthrough", () => {
    const out = sanitizeReasoningInputContent(
      { input: [RAW_REASONING] },
      { modelId: "gpt-5.6" },
    ) as { input: Array<Record<string, unknown>> };
    expect(out.input[0].content).toEqual([]);
  });

  test("still strips ocxr1 envelopes while preserving content for DeepSeek", () => {
    const enveloped = {
      ...RAW_REASONING,
      id: "rs_2",
      encrypted_content: `${OCX_REASONING_PREFIX}abc`,
    };
    const out = sanitizeReasoningInputContent(
      { input: [enveloped] },
      { preserveContentModels: ["deepseek-v4-flash"], modelId: MODEL },
    ) as { input: Array<Record<string, unknown>> };
    expect(out.input[0].content).toEqual(RAW_REASONING.content);
    expect(out.input[0].encrypted_content).toBeUndefined();
  });
});

describe("a DeepSeek Responses continuation keeps its reasoning replay", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("a tool-call follow-up carries reasoning content and tool output upstream", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Response.json({
        id: "resp_deepseek_2",
        object: "response",
        status: "completed",
        output: [],
      });
    }) as typeof fetch;

    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          store: false,
          input: [
            RAW_REASONING,
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: "{}" },
            { type: "function_call_output", call_id: "call_1", output: "build failed" },
          ],
        }),
      }),
      config,
      { model: "", provider: "" },
    );

    const input = capturedBody!.input as unknown[];
    expect(input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", content: RAW_REASONING.content }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
    ]));
  });
});

describe("DeepSeek V4 Flash is a viable sub-agent candidate", () => {
  test("it is routable and sits first in a sub-agent fallback chain", () => {
    const config = {
      defaultProvider: "deepseek",
      providers: { deepseek: deepseekProvider() },
    } as unknown as OcxConfig;
    const chain = buildSubagentModelChain("deepseek/deepseek-v4-flash", config);
    expect(chain[0]).toBe("deepseek/deepseek-v4-flash");
    expect(isSubagentModelUnavailable("deepseek/deepseek-v4-flash", config)).toBe(false);
  });
});
