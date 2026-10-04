import { describe, expect, test } from "bun:test";
import { injectPonytail, injectPonytailToRawBody, PONYTAIL_PROMPTS } from "../../src/optimize";
import type { OcxParsedRequest } from "../../src/types/request";

describe("Ponytail prompt injection", () => {
  test("injects ponytail prompt into parsed.context.systemPrompt", () => {
    const parsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      stream: false,
      options: {},
      context: {
        systemPrompt: ["You are a coding assistant."],
        messages: [{ role: "user", content: "Write a function", timestamp: Date.now() }],
      },
    };

    injectPonytail(parsed, "full");

    expect(parsed.context.systemPrompt?.length).toBe(2);
    expect(parsed.context.systemPrompt![1]).toContain("lazy senior developer");
    expect(parsed.context.systemPrompt![1]).toBe(PONYTAIL_PROMPTS.full);
  });

  test("is idempotent and does not inject multiple times", () => {
    const parsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      stream: false,
      options: {},
      context: {
        systemPrompt: ["You are a coding assistant."],
        messages: [],
      },
    };

    injectPonytail(parsed, "ultra");
    injectPonytail(parsed, "ultra");

    expect(parsed.context.systemPrompt?.length).toBe(2);
  });

  test("supports lite, full, and ultra intensity levels", () => {
    expect(PONYTAIL_PROMPTS.lite).toContain("Lite:");
    expect(PONYTAIL_PROMPTS.full).toContain("Full:");
    expect(PONYTAIL_PROMPTS.ultra).toContain("Ultra:");
  });

  test("injects into rawBody instructions string", () => {
    const rawBody: Record<string, unknown> = {
      instructions: "Base system instruction.",
      input: "Hello",
    };

    injectPonytailToRawBody(rawBody, "lite");
    expect(typeof rawBody.instructions).toBe("string");
    expect(rawBody.instructions as string).toContain("Base system instruction.");
    expect(rawBody.instructions as string).toContain("lazy senior developer");
  });
});
