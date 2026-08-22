import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_IDE_VERSION,
  CLAUDE_CODE_HEADERS,
  antigravityUserAgent,
  claudeCodeSessionId,
} from "../src/adapters/client-fingerprint";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function parsed(): OcxParsedRequest {
  return {
    modelId: "claude-opus-4-6",
    stream: false,
    options: {},
    context: { systemPrompt: ["You are Codex, a coding agent based on GPT-5."], messages: [{ role: "user", content: "hi" }] },
  } as unknown as OcxParsedRequest;
}

describe("client fingerprint — helpers", () => {
  test("antigravity UA has the real IDE shape, never the literal giveaway", async () => {
    const ua = antigravityUserAgent();
    expect(ua).toBe(`antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)`);
    expect(ua).not.toBe("antigravity");
  });

  test("antigravity UA honors explicit version and authMethod overrides", async () => {
    expect(antigravityUserAgent("9.9.9")).toBe("antigravity/ide/9.9.9 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)");
    expect(antigravityUserAgent(ANTIGRAVITY_IDE_VERSION, "api_key")).toBe(
      `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=api_key)`,
    );
  });

  test("GOOGLE_ANTIGRAVITY_USER_AGENT env override trims surrounding whitespace", async () => {
    const prevGoogle = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
    try {
      process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = "  custom-ua/1.2.3  ";
      expect(antigravityUserAgent()).toBe("custom-ua/1.2.3");
    } finally {
      if (prevGoogle === undefined) delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
      else process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = prevGoogle;
    }
  });

  test("whitespace-only GOOGLE_ANTIGRAVITY_USER_AGENT falls back to default UA", async () => {
    const prevGoogle = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
    try {
      process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = "   ";
      expect(antigravityUserAgent()).toBe(
        `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)`,
      );
    } finally {
      if (prevGoogle === undefined) delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
      else process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = prevGoogle;
    }
  });

  test("claude session id is a stable v4-shaped uuid per token", async () => {
    const a = claudeCodeSessionId("tok-abc");
    const b = claudeCodeSessionId("tok-abc");
    const c = claudeCodeSessionId("tok-xyz");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("claude session id never echoes the raw token", async () => {
    expect(claudeCodeSessionId("super-secret-token")).not.toContain("super-secret-token");
  });

  test("CLAUDE_CODE_HEADERS carries the first-party Stainless/App signature", async () => {
    expect(CLAUDE_CODE_HEADERS["X-App"]).toBe("cli");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Runtime"]).toBe("node");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Lang"]).toBe("js");
  });
});

describe("client fingerprint — anthropic OAuth headers", () => {
  const oauthProvider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "oauth-tok-123" } as unknown as OcxProviderConfig;
  const apiKeyProvider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-123" } as unknown as OcxProviderConfig;

  test("OAuth request carries the full Claude Code header set", async () => {
    const { headers } = await createAnthropicAdapter(oauthProvider).buildRequest(parsed());
    expect(headers["X-App"]).toBe("cli");
    expect(headers["X-Stainless-Runtime"]).toBe("node");
    expect(headers["X-Stainless-Lang"]).toBe("js");
    expect(headers["X-Stainless-Retry-Count"]).toBe("0");
    expect(headers["X-Stainless-Timeout"]).toBe("600");
    expect(headers["anthropic-beta"]).toBeDefined();
    expect(headers["X-Claude-Code-Session-Id"]).toMatch(/^[0-9a-f]{8}-/);
    expect(headers["x-client-request-id"]).toMatch(/^[0-9a-f]{8}-/);
  });

  test("session id is stable across requests with the same OAuth token", async () => {
    const a = (await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers["X-Claude-Code-Session-Id"];
    const b = (await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers["X-Claude-Code-Session-Id"];
    expect(a).toBe(b);
  });

  test("outgoing session-id header never echoes the raw OAuth token", async () => {
    const secretProvider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "oauth-super-secret-xyz" } as unknown as OcxProviderConfig;
    const { headers } = await createAnthropicAdapter(secretProvider).buildRequest(parsed());
    expect(headers["X-Claude-Code-Session-Id"]).not.toContain("oauth-super-secret-xyz");
    expect(headers["X-Claude-Code-Session-Id"]).not.toContain("super-secret");
  });

  test("per-request id differs between requests", async () => {
    const a = (await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers["x-client-request-id"];
    const b = (await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers["x-client-request-id"];
    expect(a).not.toBe(b);
  });

  test("API-key mode does NOT get the Claude Code CLI headers", async () => {
    const { headers } = await createAnthropicAdapter(apiKeyProvider).buildRequest(parsed());
    expect(headers["x-api-key"]).toBe("sk-ant-123");
    expect(headers["X-App"]).toBeUndefined();
    expect(headers["X-Claude-Code-Session-Id"]).toBeUndefined();
  });

  test("Accept + User-Agent fingerprint headers are sent on both OAuth and API-key paths", async () => {
    const oauth = (await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers;
    const apiKey = (await createAnthropicAdapter(apiKeyProvider).buildRequest(parsed())).headers;
    for (const headers of [oauth, apiKey]) {
      // Non-stream request advertises a JSON Accept and the pinned first-party SDK UA.
      expect(headers["Accept"]).toBe("application/json");
      expect(headers["User-Agent"]).toBe("@anthropic-ai/sdk/0.74.0");
    }
  });

  test("Accept negotiates SSE for a streaming request", async () => {
    const streaming = { ...parsed(), stream: true } as OcxParsedRequest;
    const { headers } = await createAnthropicAdapter(oauthProvider).buildRequest(streaming);
    expect(headers["Accept"]).toBe("text/event-stream");
    expect(headers["User-Agent"]).toBe("@anthropic-ai/sdk/0.74.0");
  });
});
