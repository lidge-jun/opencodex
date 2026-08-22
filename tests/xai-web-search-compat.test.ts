import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createProductionAdapter } from "../src/adapters/openai-responses";
import { normalizeXaiResponsesWebSearch } from "../src/adapters/xai-web-search";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

function createXaiAdapter() {
  return withTestTranslatorBudget(createProductionAdapter({
    adapter: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    authMode: "forward",
    headers: { authorization: "Bearer xai-oauth" },
  }));
}

function buildBody(rawBody: Record<string, unknown>): Record<string, unknown> {
  const request = createXaiAdapter().buildRequest({
    modelId: "grok-4.6",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: rawBody,
  });
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("xAI Responses web-search compatibility", () => {
  test("lowers Codex live-search fields to xAI's documented tool schema", () => {
    const body = buildBody({
      model: "grok-4.6",
      input: "latest xAI news",
      tools: [{
        type: "web_search",
        external_web_access: true,
        filters: { allowed_domains: ["x.ai"] },
        user_location: { type: "approximate", country: "KR" },
        search_context_size: "high",
        search_content_types: ["text", "image"],
      }],
      tool_choice: { type: "web_search" },
    });

    expect(body.tools).toEqual([{
      type: "web_search",
      filters: { allowed_domains: ["x.ai"] },
      enable_image_search: true,
    }]);
    expect(body.tool_choice).toEqual({ type: "web_search" });
    expect(JSON.stringify(body)).not.toContain("external_web_access");
    expect(JSON.stringify(body)).not.toContain("search_context_size");
    expect(JSON.stringify(body)).not.toContain("search_content_types");
    expect(JSON.stringify(body)).not.toContain("user_location");
  });

  test("omits cached-only search instead of silently widening it to xAI live search", () => {
    const body = buildBody({
      model: "grok-4.6",
      tools: [{ type: "web_search", external_web_access: false }],
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "web_search", external_web_access: false }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "web_search" }],
      },
    });

    expect(body.tools).toBeUndefined();
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    expect(body.tool_choice).toBe("none");
  });

  test("keeps public xAI search declarations live when the private access flag is absent", () => {
    const body = buildBody({
      model: "grok-4.6",
      input: "latest xAI news",
      tools: [{
        type: "web_search",
        filters: { excluded_domains: ["example.com"] },
        enable_image_understanding: true,
      }],
    });

    expect(body.tools).toEqual([{
      type: "web_search",
      filters: { excluded_domains: ["example.com"] },
      enable_image_understanding: true,
    }]);
  });

  test("normalizes the supported preview alias in declarations and selectors", () => {
    const direct = buildBody({
      model: "grok-4.6",
      input: "latest xAI news",
      tools: [{
        type: "web_search_preview",
        external_web_access: true,
        search_context_size: "medium",
      }],
      tool_choice: { type: "web_search_preview" },
    });

    expect(direct.tools).toEqual([{ type: "web_search" }]);
    expect(direct.tool_choice).toEqual({ type: "web_search" });

    const allowed = buildBody({
      model: "grok-4.6",
      input: "latest xAI news",
      tools: [{ type: "web_search_preview" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "web_search_preview" }],
      },
    });

    expect(allowed.tools).toEqual([{ type: "web_search" }]);
    expect(allowed.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "web_search" }],
    });
  });

  test("does not rewrite OpenAI, lookalike, or nonstandard-port providers", () => {
    const original = {
      model: "gpt-5.6-sol",
      tools: [{ type: "web_search", external_web_access: false }],
    };
    for (const baseUrl of [
      "https://chatgpt.com/backend-api/codex",
      "https://api.x.ai.example/v1",
      "https://api.x.ai:8443/v1",
      "http://api.x.ai/v1",
    ]) {
      expect(normalizeXaiResponsesWebSearch(original, { baseUrl })).toBe(original);
    }
  });
});
