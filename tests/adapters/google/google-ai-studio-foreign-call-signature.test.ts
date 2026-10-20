/**
 * #7298: a combo hop can hand Gemini on AI Studio a functionCall another model issued. It carries
 * no Gemini thought signature, and Gemini 3 refuses an unsigned call in the current turn. AI Studio
 * now applies the same Gemini-only validator sentinel that Antigravity and Vertex already apply.
 */
import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import { THOUGHT_SIGNATURE_BYPASS } from "../../../src/adapters/google-antigravity-replay";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const aiStudio = {
  adapter: "google",
  googleMode: "ai-studio",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "ai-studio-test-key",
} as OcxProviderConfig;

const SIGNATURE = "CiQAx-history-thought-signature-0123456789abcdef";

async function modelParts(model: string, call: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const parsed = parseRequest({
    model,
    tools: [{ type: "function", name: "get_weather", parameters: { type: "object", properties: {} } }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}", ...call },
      { type: "function_call_output", call_id: "call_1", output: "rain" },
    ],
  });
  const built = await createGoogleAdapter(aiStudio).buildRequest(parsed);
  const body = JSON.parse(String(built.body)) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
  return body.contents.find(content => content.role === "model")!.parts;
}

describe("AI Studio foreign function call signature (#7298)", () => {
  test("a call issued by another model gets the validator sentinel on Gemini", async () => {
    const parts = await modelParts("gemini-4-argon", {});
    expect(parts[0]!.functionCall).toBeDefined();
    expect(parts[0]!.thoughtSignature).toBe(THOUGHT_SIGNATURE_BYPASS);
  });

  test("a real signature carried by history wins over the sentinel", async () => {
    const parts = await modelParts("gemini-4-argon", {
      extra_content: { google: { thought_signature: SIGNATURE } },
    });
    expect(parts[0]!.thoughtSignature).toBe(SIGNATURE);
  });

  test("a non-Gemini model on AI Studio never receives the Gemini-only sentinel", async () => {
    const parts = await modelParts("gemma-4-27b-it", {});
    expect(parts[0]!.thoughtSignature).toBeUndefined();
  });
});

