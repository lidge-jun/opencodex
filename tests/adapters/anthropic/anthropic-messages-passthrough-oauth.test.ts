/**
 * The managed native Messages builder for an Anthropic OAuth account (PF-10): the adapter's
 * OAuth header placement, the Claude Code identity block, the OAuth tool-name prefix with its
 * reverse map, and the rule that an OAuth token is sent to `api.anthropic.com` only.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import {
  anthropicMessagesNativeWireBody,
  anthropicOAuthWireBody,
  buildAnthropicMessagesPassthroughRequest,
} from "../../../src/adapters/anthropic/passthrough";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../../src/oauth/anthropic";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const ACCESS = "fixture-oauth-access-token";

function oauthProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
    apiKey: ACCESS,
    ...overrides,
  } as OcxProviderConfig;
}

const SOURCE = {
  model: "selector",
  max_tokens: 64,
  stream: true,
  system: "fixture system",
  tools: [
    { name: "lookup", description: "fixture", input_schema: { type: "object", properties: {} } },
    { type: "web_search_20250305", name: "web_search" },
    { type: "bash_20250124", name: "bash" },
  ],
  tool_choice: { type: "tool", name: "lookup" },
  messages: [
    { role: "user", content: "fixture question" },
    { role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
      { type: "tool_use", id: "toolu_2", name: "bash", input: { command: "true" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "fixture result" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "" },
    ] },
  ],
};

describe("buildAnthropicMessagesPassthroughRequest with OAuth", () => {
  test("places the credential and fingerprint exactly as the adapter does", async () => {
    const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "claude-wire", SOURCE);
    expect(built.url).toBe("https://api.anthropic.com/v1/messages");
    expect(built.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(built.headers).not.toHaveProperty("x-api-key");
    expect(built.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);

    const parsed = {
      modelId: "claude-wire",
      stream: true,
      context: { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
      options: {},
    } as unknown as OcxParsedRequest;
    const adapterRequest = await createAnthropicAdapter(oauthProvider())
      .buildRequest(parsed, { headers: new Headers(), translatorBudget: createTranslatorBudget() });
    const adapterHeaders = adapterRequest.headers as Record<string, string>;
    const perRequest = new Set(["x-client-request-id"]);
    for (const [name, value] of Object.entries(adapterHeaders)) {
      if (name === "Content-Type" || perRequest.has(name)) continue;
      expect(built.headers[name]).toBe(value);
    }
    expect(Object.keys(built.headers).sort()).toEqual(Object.keys(adapterHeaders).sort());
  });

  test("an OAuth token is refused for any destination but api.anthropic.com", () => {
    for (const baseUrl of [
      "https://compatible.example",
      "http://api.anthropic.com",
      "https://api.anthropic.com.example",
      "https://api.anthropic.com:8443",
    ]) {
      expect(() => buildAnthropicMessagesPassthroughRequest(oauthProvider({ baseUrl }), "m", SOURCE))
        .toThrow("only to api.anthropic.com");
    }
    expect(() => buildAnthropicMessagesPassthroughRequest(oauthProvider({ apiKey: "" }), "m", SOURCE))
      .toThrow("oauth token missing");
  });

  test("the body carries the identity block and prefixed client tools; typed tools keep their names", () => {
    const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "claude-wire", SOURCE);
    const wire = built.wireBody as Omit<typeof SOURCE, "system"> & { system: unknown[] };
    expect(wire.system).toEqual([
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
      { type: "text", text: "fixture system" },
    ]);
    expect(wire.tools.map(tool => tool.name)).toEqual(["custom_lookup", "web_search", "bash"]);
    expect(wire.tool_choice).toEqual({ type: "tool", name: "custom_lookup" });
    const history = wire.messages[1]!.content as { name: string }[];
    expect(history.map(block => block.name)).toEqual(["custom_lookup", "bash"]);
    expect([...built.oauthToolNames!]).toEqual([["custom_lookup", "lookup"]]);
    // The source is untouched.
    expect(SOURCE.tools[0]!.name).toBe("lookup");
    expect(SOURCE.system).toBe("fixture system");
  });

  test("an identity block already present is not repeated", () => {
    const system = [{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION }, { type: "text", text: "more" }];
    expect(anthropicOAuthWireBody({ system, messages: [] }).body.system).toBe(system);
  });

  test("two caller names that meet under the prefix are refused", () => {
    const body = { messages: [], tools: [
      { name: "lookup", input_schema: { type: "object" } },
      { name: "custom_lookup", input_schema: { type: "object" } },
    ] };
    expect(() => anthropicOAuthWireBody(body)).toThrow("collide");
  });

  test("a key-auth provider gets no OAuth shaping", () => {
    const shaped = anthropicMessagesNativeWireBody({ baseUrl: "https://api.anthropic.com", authMode: "key" }, "m", SOURCE);
    expect(shaped.oauthToolNames).toBeUndefined();
    expect(shaped.wireBody.system).toBe("fixture system");
  });
});
