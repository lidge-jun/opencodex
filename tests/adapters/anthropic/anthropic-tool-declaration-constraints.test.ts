import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { createRegisteredAdapter } from "../../../src/adapters/registry";
import { anthropicToResponsesBody } from "../../../src/claude/inbound";
import { parseRequest } from "../../../src/responses/parser";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

/**
 * #5210. `strict` and `allowed_callers` are declaration fields Anthropic defines, and the
 * Messages-to-Messages route rebuilt every tool from name, description and input_schema alone.
 * The request succeeded, so a caller had no way to learn that the schema was no longer enforced
 * or that the tool had been offered to a caller it was fenced off from. Each case below reads
 * the request the adapter actually sends.
 */

const anthropicProvider = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-x",
  authMode: "apiKey",
} as unknown as OcxProviderConfig;

function claudeTool(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "tool_a",
    description: "Controlled tool.",
    input_schema: { type: "object", properties: {} },
    ...extra,
  };
}

function parsedFromClaude(tool: Record<string, unknown>): OcxParsedRequest {
  return parseRequest(anthropicToResponsesBody({
    model: "anthropic/claude-sonnet-4.5",
    max_tokens: 64,
    messages: [{ role: "user", content: "Call the tool." }],
    tools: [tool],
  }));
}

async function anthropicTools(tool: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const { body } = await createAnthropicAdapter(anthropicProvider).buildRequest(parsedFromClaude(tool));
  return (JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as {
    tools: Array<Record<string, unknown>>;
  }).tools;
}

describe("anthropic tool declarations carry their caller-supplied constraints", () => {
  test("an explicit strict:true survives the round trip", async () => {
    const [tool] = await anthropicTools(claudeTool({ strict: true }));
    expect(tool.strict).toBe(true);
    expect(tool.name).toBe("tool_a");
    expect(tool.input_schema).toEqual({ type: "object", properties: {} });
  });

  test("an unstated strict stays absent rather than becoming an opt-out", async () => {
    const [tool] = await anthropicTools(claudeTool({}));
    expect(tool).not.toHaveProperty("strict");
    const [explicitFalse] = await anthropicTools(claudeTool({ strict: false }));
    expect(explicitFalse).not.toHaveProperty("strict");
  });

  test("allowed_callers reaches the upstream instead of being rebuilt away", async () => {
    const [tool] = await anthropicTools(claudeTool({ allowed_callers: ["code_execution_20260120"] }));
    expect(tool.allowed_callers).toEqual(["code_execution_20260120"]);
  });

  test("a tool without allowed_callers gains no key", async () => {
    const [tool] = await anthropicTools(claudeTool({}));
    expect(tool).not.toHaveProperty("allowed_callers");
  });
});

describe("wires without an allowed_callers counterpart refuse rather than widen", () => {
  const restricted = claudeTool({ allowed_callers: ["code_execution_20260120"] });
  const unrestricted = claudeTool({ allowed_callers: ["direct"] });
  const incoming = { headers: new Headers(), translatorBudget: createTestTranslatorBudget() };

  // The refusal is default-deny at the single guard every registered adapter passes through, so
  // a wire that never learned about the field cannot quietly rebuild the declaration without it.
  test.each([
    ["openai-chat", { adapter: "openai-chat", baseUrl: "https://gateway.example.internal/v1", apiKey: "k" }],
    ["google", { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" }],
    ["cursor", { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "k" }],
    ["devin", { adapter: "devin", baseUrl: "https://api.devin.ai", apiKey: "k" }],
    ["ollama-native", { adapter: "ollama-native", baseUrl: "http://127.0.0.1:11434", keyOptional: true }],
  ])("the %s wire refuses a caller-restricted declaration", async (_name, config) => {
    const adapter = createRegisteredAdapter(config as unknown as OcxProviderConfig);
    await expect(Promise.resolve().then(() => adapter.buildRequest(parsedFromClaude(restricted), incoming)))
      .rejects.toThrow(/cannot express tools\[\]\.allowed_callers/);
  });

  test("the Anthropic wire is the one that carries it", async () => {
    const adapter = createRegisteredAdapter(anthropicProvider);
    const { body } = await adapter.buildRequest(parsedFromClaude(restricted), incoming);
    const sent = JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as {
      tools: Array<Record<string, unknown>>;
    };
    expect(sent.tools[0]!.allowed_callers).toEqual(["code_execution_20260120"]);
  });

  test('the unrestricted ["direct"] default is not treated as a restriction', async () => {
    const adapter = createRegisteredAdapter({
      adapter: "openai-chat",
      baseUrl: "https://gateway.example.internal/v1",
      apiKey: "k",
    } as unknown as OcxProviderConfig);
    // Registered adapters may wrap buildRequest in a promise; await rather than assume a shape.
    const { body } = await adapter.buildRequest(parsedFromClaude(unrestricted), incoming);
    const built = JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as {
      tools: Array<{ function: { name: string } }>;
    };
    expect(built.tools.map(tool => tool.function.name)).toEqual(["tool_a"]);
  });
});
