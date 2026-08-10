import { describe, expect, test } from "bun:test";
import { evidenceForModelRequest, evidenceFromBody } from "../src/routing/request-evidence";
import type { OcxConfig } from "../src/types";

function routingConfig(enabled: boolean): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka" },
    },
    routingProfiles: {
      smart: {
        alias: "ocx/auto",
        candidates: [
          { provider: "a", model: "fast", taskTiers: ["fast"] },
          { provider: "a", model: "balanced", taskTiers: ["balanced"] },
          { provider: "a", model: "powerful", taskTiers: ["powerful"] },
        ],
        ...(enabled ? { promptRouting: { enabled: true } } : {}),
      },
    },
  };
}

describe("request evidence extraction (RI-05)", () => {
  test("top-level responses input image part is detected", () => {
    const evidence = evidenceFromBody({
      input: [{ type: "input_image", image_url: "https://example.test/i.png" }],
    });
    expect(evidence.imageInputRequired).toBe(true);
  });

  test("images nested under input[].content are detected", () => {
    const evidence = evidenceFromBody({
      input: [{ type: "message", content: [{ type: "input_image", image_url: "https://example.test/i.png" }] }],
    });
    expect(evidence.imageInputRequired).toBe(true);
  });

  test("images nested under messages[].content are detected (chat/claude bodies)", () => {
    const evidence = evidenceFromBody({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/i.png" } }] }],
    });
    expect(evidence.imageInputRequired).toBe(true);
  });

  test("text-only bodies produce no image requirement", () => {
    const evidence = evidenceFromBody({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(evidence.imageInputRequired).toBeUndefined();
  });

  test("tools array produces toolsRequired", () => {
    const evidence = evidenceFromBody({
      tools: [{ type: "function", function: { name: "x" } }],
    });
    expect(evidence.toolsRequired).toBe(true);
  });

  test("does not inspect prompt text unless classification is explicitly enabled", () => {
    const body = { messages: [{ role: "user", content: "Hello!" }] };
    expect(evidenceFromBody(body)).toEqual({});
    expect(evidenceFromBody(body, { classifyPrompt: true })).toEqual({ taskTier: "fast" });
  });

  test("classifies only the latest user prompt across supported message shapes", () => {
    const evidence = evidenceFromBody({
      messages: [
        { role: "system", content: "Implement a complex repository migration." },
        { role: "user", content: "Investigate and refactor the entire codebase." },
        { role: "assistant", content: "How can I help?" },
        { role: "user", content: [{ type: "text", text: "你好" }] },
      ],
    }, { classifyPrompt: true });
    expect(evidence.taskTier).toBe("fast");

    expect(evidenceFromBody({
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello!" }] }],
    }, { classifyPrompt: true }).taskTier).toBe("fast");
  });

  test("defaults non-text prompts to the balanced tier", () => {
    const evidence = evidenceFromBody({
      input: [{
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
      }],
    }, { classifyPrompt: true });

    expect(evidence).toEqual({
      imageInputRequired: true,
      taskTier: "balanced",
    });
  });

  test("enables prompt classification only for the requested smart profile or alias", () => {
    const body = { messages: [{ role: "user", content: "Hello!" }] };
    expect(evidenceForModelRequest(routingConfig(true), "policy/smart", body).taskTier).toBe("fast");
    expect(evidenceForModelRequest(routingConfig(true), "ocx/auto", body).taskTier).toBe("fast");
    expect(evidenceForModelRequest(routingConfig(true), "a/fast", body).taskTier).toBeUndefined();
    expect(evidenceForModelRequest(routingConfig(false), "policy/smart", body).taskTier).toBeUndefined();
  });
});
