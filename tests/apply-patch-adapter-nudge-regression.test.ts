import { expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createCommandCodeAdapter } from "../src/adapters/command-code";
import { createGoogleAdapter } from "../src/adapters/google";
import { createKiroAdapter } from "../src/adapters/kiro";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function codeModeParsed(modelId: string): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    options: {},
    context: {
      systemPrompt: ["Use apply_patch for local file edits."],
      messages: [{ role: "user", content: "Patch a file.", timestamp: 1 }],
      tools: [
        {
          name: "exec",
          description: "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };",
          parameters: { type: "object", properties: { input: { type: "string" } } },
        },
        {
          name: "wait",
          description: "Wait for work to finish.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "request_user_input",
          description: "Ask the user for input.",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
  } as OcxParsedRequest;
}

function assertApplyPatchIsNotForbidden(body: string): void {
  const normalized = body.replace(/\\n/g, " ").replace(/\s+/g, " ");

  // Make sure the adapter actually exercised the shared catalog-nudge call site;
  // otherwise a missing nudge would make the prohibition assertion vacuous.
  expect(normalized).toContain("current tool catalog as ground truth");

  // Protect against both the original shared warning and adapter-specific wording
  // that would steer routed models away from Codex's own patch tool.
  expect(normalized).not.toMatch(/(?:do not|don't|never|must not|cannot|can't)[^.]{0,260}\bapply_patch\b/i);
  expect(normalized).not.toMatch(/\bapply_patch\b[^.]{0,180}\b(?:forbidden|unavailable|off-limits)\b/i);
}

test("routed adapter call sites never forbid Codex apply_patch", async () => {
  const cases: Array<{
    name: string;
    modelId: string;
    build: (parsed: OcxParsedRequest) => Promise<{ body: string }>;
  }> = [
    {
      name: "openai-chat",
      modelId: "grok-4.6",
      build: async parsed => createOpenAIChatAdapter({
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        apiKey: "test-key",
      } as OcxProviderConfig).buildRequest(parsed),
    },
    {
      name: "anthropic-oauth",
      modelId: "claude-haiku-4-5",
      build: async parsed => createAnthropicAdapter({
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        apiKey: "test-oauth-token",
      } as OcxProviderConfig).buildRequest(parsed),
    },
    {
      name: "google",
      modelId: "gemini-3-pro",
      build: async parsed => createGoogleAdapter({
        adapter: "google",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "test-key",
      } as OcxProviderConfig).buildRequest(parsed),
    },
    {
      name: "command-code",
      modelId: "deepseek/deepseek-v4-flash",
      build: async parsed => createCommandCodeAdapter({
        adapter: "command-code",
        baseUrl: "https://api.commandcode.ai",
        authMode: "oauth",
        apiKey: "test-command-key",
        defaultMaxOutputTokens: 64_000,
      } as OcxProviderConfig).buildRequest(parsed),
    },
    {
      name: "kiro",
      modelId: "claude-sonnet-4.5",
      build: async parsed => {
        parsed._kiroAuthContext = { apiRegion: "us-east-1" };
        return createKiroAdapter({
          adapter: "kiro",
          baseUrl: "https://runtime.us-east-1.kiro.dev",
          authMode: "key",
          apiKey: "ksk_test",
        } as OcxProviderConfig).buildRequest(parsed);
      },
    },
  ];

  for (const adapterCase of cases) {
    const request = await adapterCase.build(codeModeParsed(adapterCase.modelId));
    expect(request.body, `${adapterCase.name} should serialize a request body`).toBeTruthy();
    assertApplyPatchIsNotForbidden(request.body);
  }
});
