import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_CLI_VERSION,
  ANTIGRAVITY_GOOG_API_CLIENT_UA,
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
  test("antigravity UA has the real CLI shape, never the literal giveaway", () => {
    const ua = antigravityUserAgent();
    expect(ua).toBe(`antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (aidev_client; os_type=darwin; arch=arm64)`);
    expect(ua).not.toBe("antigravity");
  });

  test("antigravity UA honors an explicit version override", () => {
    expect(antigravityUserAgent("9.9.9")).toBe("antigravity/cli/9.9.9 (aidev_client; os_type=darwin; arch=arm64)");
  });

  test("GOOGLE_ANTIGRAVITY_USER_AGENT env override wins over the default UA", async () => {
    const prev = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
    process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = "custom-ua/1.2.3";
    try {
      // Fresh module instance so the env-driven constant is re-evaluated at import time.
      const mod = await import(`../src/adapters/google-antigravity-wire?override=${Date.now()}`);
      expect(mod.ANTIGRAVITY_REQUEST_UA).toBe("custom-ua/1.2.3");
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
      else process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = prev;
    }
  });

  test("secondary google api client UA is pinned", () => {
    expect(ANTIGRAVITY_GOOG_API_CLIENT_UA).toMatch(/^google-api-nodejs-client\/[\d.]+$/);
  });

  test("claude session id is a stable v4-shaped uuid per token", () => {
    const a = claudeCodeSessionId("tok-abc");
    const b = claudeCodeSessionId("tok-abc");
    const c = claudeCodeSessionId("tok-xyz");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("claude session id never echoes the raw token", () => {
    expect(claudeCodeSessionId("super-secret-token")).not.toContain("super-secret-token");
  });

  test("CLAUDE_CODE_HEADERS carries the first-party Stainless/App signature", () => {
    expect(CLAUDE_CODE_HEADERS["X-App"]).toBe("cli");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Runtime"]).toBe("node");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Lang"]).toBe("js");
  });
});

describe("client fingerprint — anthropic OAuth headers", () => {
  const oauthProvider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "oauth-tok-123" } as unknown as OcxProviderConfig;
  const apiKeyProvider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-123" } as unknown as OcxProviderConfig;

  test("OAuth request carries the full Claude Code header set", () => {
    const { headers } = createAnthropicAdapter(oauthProvider).buildRequest(parsed());
    expect(headers["X-App"]).toBe("cli");
    expect(headers["X-Stainless-Runtime"]).toBe("node");
    expect(headers["X-Stainless-Lang"]).toBe("js");
    expect(headers["X-Stainless-Retry-Count"]).toBe("0");
    expect(headers["X-Stainless-Timeout"]).toBe("600");
    expect(headers["anthropic-beta"]).toBeDefined();
    expect(headers["X-Claude-Code-Session-Id"]).toMatch(/^[0-9a-f]{8}-/);
    expect(headers["x-client-request-id"]).toMatch(/^[0-9a-f]{8}-/);
  });

  test("session id is stable across requests with the same OAuth token", () => {
    const a = createAnthropicAdapter(oauthProvider).buildRequest(parsed()).headers["X-Claude-Code-Session-Id"];
    const b = createAnthropicAdapter(oauthProvider).buildRequest(parsed()).headers["X-Claude-Code-Session-Id"];
    expect(a).toBe(b);
  });

  test("outgoing session-id header never echoes the raw OAuth token", () => {
    const secretProvider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "oauth-super-secret-xyz" } as unknown as OcxProviderConfig;
    const { headers } = createAnthropicAdapter(secretProvider).buildRequest(parsed());
    expect(headers["X-Claude-Code-Session-Id"]).not.toContain("oauth-super-secret-xyz");
    expect(headers["X-Claude-Code-Session-Id"]).not.toContain("super-secret");
  });

  test("per-request id differs between requests", () => {
    const a = createAnthropicAdapter(oauthProvider).buildRequest(parsed()).headers["x-client-request-id"];
    const b = createAnthropicAdapter(oauthProvider).buildRequest(parsed()).headers["x-client-request-id"];
    expect(a).not.toBe(b);
  });

  test("API-key mode does NOT get the Claude Code CLI headers", () => {
    const { headers } = createAnthropicAdapter(apiKeyProvider).buildRequest(parsed());
    expect(headers["x-api-key"]).toBe("sk-ant-123");
    expect(headers["X-App"]).toBeUndefined();
    expect(headers["X-Claude-Code-Session-Id"]).toBeUndefined();
  });
});
