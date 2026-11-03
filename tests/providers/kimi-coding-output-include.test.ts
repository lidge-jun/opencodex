import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { OcxProviderConfig } from "../../src/types";

// #8075: Kimi Code's native Responses endpoint answers 400 for the output.encrypted_content
// include entry that Codex Desktop sends on every turn.
const provider: OcxProviderConfig = {
  adapter: "openai-responses", baseUrl: "https://api.kimi.com/coding/v1",
  authMode: "key", apiKey: "test-credential", modelSuffixBracketStrip: true,
};
const input = [
  { type: "message", role: "user", content: "read the file" },
  { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
  { type: "function_call_output", call_id: "call_1", output: "first line" },
];

function wire(include: unknown, target: OcxProviderConfig = provider): Record<string, unknown> {
  const raw = { model: "k3.1-pro[256k]", input, stream: true, ...(include === undefined ? {} : { include }) };
  const snapshot = JSON.stringify(raw);
  const budget = createTranslatorBudget();
  const request = createResponsesPassthroughAdapter(target)
    .buildRequest(parseRequest(raw), { headers: new Headers(), translatorBudget: budget });
  request.releaseBodyObservation?.();
  budget.dispose();
  expect(JSON.stringify(raw)).toBe(snapshot);
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("Kimi Code Responses include normalization (#8075)", () => {
  test("removes only output.encrypted_content and keeps the other entries in order", () => {
    const body = wire(["reasoning.encrypted_content", "output.encrypted_content", "message.output_text.logprobs"]);
    expect(body.include).toEqual(["reasoning.encrypted_content", "message.output_text.logprobs"]);
    expect(body.input).toEqual(input);
  });

  test("omits include when the rejected entry was the only one", () => {
    expect(wire(["output.encrypted_content"])).not.toHaveProperty("include");
  });

  test("removes every duplicate output.encrypted_content", () => {
    expect(wire(["output.encrypted_content", "reasoning.encrypted_content", "output.encrypted_content"]).include)
      .toEqual(["reasoning.encrypted_content"]);
  });

  test("an absent or already-supported include list is unchanged", () => {
    expect(wire(undefined)).not.toHaveProperty("include");
    expect(wire(["reasoning.encrypted_content"]).include).toEqual(["reasoning.encrypted_content"]);
  });

  test.each([
    "https://api.kimi.com/v1", "https://api.kimi.com/coding/v2",
    "https://api.kimi.com.evil.test/coding/v1", "https://kimi.example.test/coding/v1",
    "https://api.moonshot.ai/v1", "http://api.kimi.com/coding/v1", "https://api.kimi.com:444/coding/v1",
  ])("leaves other destinations untouched: %s", baseUrl => {
    const include = ["reasoning.encrypted_content", "output.encrypted_content"];
    expect(wire(include, { ...provider, baseUrl }).include).toEqual(include);
  });
});

