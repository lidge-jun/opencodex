import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createProductionAdapter } from "../../../src/adapters/openai-responses";
import { normalizeXaiResponsesWebSearch } from "../../../src/adapters/xai-web-search";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

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
  // Probed 2026-08-22, one field per request, against BOTH xAI destinations (api.x.ai and
  // cli-chat-proxy.grok.com), which behave identically: external_web_access 400s on every value
  // including `true`, search_context_size 400s, and user_location / search_content_types /
  // filters / enable_image_search are all accepted. Only the two refused fields are removed;
  // deleting the accepted ones was a silent capability loss.
  test("removes only the fields xAI refuses and keeps the accepted ones", () => {
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
      user_location: { type: "approximate", country: "KR" },
      search_content_types: ["text", "image"],
      enable_image_search: true,
    }]);
    expect(body.tool_choice).toEqual({ type: "web_search" });
    expect(JSON.stringify(body)).not.toContain("external_web_access");
    expect(JSON.stringify(body)).not.toContain("search_context_size");
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

  test("normalizes the Grok CLI proxy identically to the public API", () => {
    // Re-probed 2026-08-27 against cli-chat-proxy.grok.com: `web_search_preview` -> 422
    // "unknown variant", `external_web_access` -> 400 on every value including true,
    // `search_context_size` -> 400, while `user_location` and `search_content_types` -> 200.
    // The two hosts are one dialect, so one gate covers both.
    const cliProvider = { baseUrl: "https://cli-chat-proxy.grok.com/v1" };

    // A legacy `web_search_preview` reached the proxy verbatim and 422'd the whole turn.
    expect(normalizeXaiResponsesWebSearch({
      model: "grok-4.6",
      tools: [{ type: "web_search_preview", external_web_access: true }],
    }, cliProvider)).toEqual({
      model: "grok-4.6",
      tools: [{ type: "web_search" }],
    });

    // A cached/index-only declaration must NOT survive as live search. The downstream capability
    // strip only deletes the flag, so leaving the CLI proxy unnormalized turned "no network" into
    // an ordinary live web_search — the exact widening this normalizer exists to refuse.
    expect(normalizeXaiResponsesWebSearch({
      model: "grok-4.6",
      tools: [{ type: "web_search", external_web_access: false }],
    }, cliProvider)).toEqual({ model: "grok-4.6" });

    // Fields xAI accepts are still preserved on this host.
    expect(normalizeXaiResponsesWebSearch({
      model: "grok-4.6",
      tools: [{
        type: "web_search",
        external_web_access: true,
        search_context_size: "medium",
        user_location: { type: "approximate", country: "US" },
        search_content_types: ["text"],
      }],
    }, cliProvider)).toEqual({
      model: "grok-4.6",
      tools: [{
        type: "web_search",
        user_location: { type: "approximate", country: "US" },
        search_content_types: ["text"],
      }],
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
