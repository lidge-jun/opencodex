import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_IDE_VERSION,
  CLAUDE_CODE_HEADERS,
  antigravityUserAgent,
  claudeCodeSessionId,
  stainlessArchName,
  stainlessOsName,
} from "../../src/adapters/client-fingerprint";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import {
  CLAUDE_CLI_RUNTIME_VERSION,
  CLAUDE_CLI_SDK_PACKAGE_VERSION,
  CLAUDE_CLI_USER_AGENT,
} from "../../src/providers/claude-cli-identity";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "claude-opus-4-6",
    stream: false,
    options: {},
    context: { systemPrompt: ["You are Codex, a coding agent based on GPT-5."], messages: [{ role: "user", content: "hi" }] },
    ...overrides,
  } as unknown as OcxParsedRequest;
}

describe("client fingerprint — helpers", () => {
  test("antigravity UA has the real IDE shape, never the literal giveaway", async () => {
    const prevGoogle = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
    try {
      delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
      const ua = antigravityUserAgent();
      expect(ua).toBe(`antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)`);
      expect(ua).not.toBe("antigravity");
    } finally {
      if (prevGoogle !== undefined) process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = prevGoogle;
    }
  });

  test("antigravity UA honors explicit version and authMethod overrides", async () => {
    const prevGoogle = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
    try {
      delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
      expect(antigravityUserAgent("9.9.9")).toBe("antigravity/ide/9.9.9 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)");
      expect(antigravityUserAgent(ANTIGRAVITY_IDE_VERSION, "api_key")).toBe(
        `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=api_key)`,
      );
    } finally {
      if (prevGoogle !== undefined) process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = prevGoogle;
    }
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

  test("claude session id isolates distinct conversations on the same credential while staying deterministic per conversation", async () => {
    const convA1 = claudeCodeSessionId("tok-abc", "thread-alpha");
    const convA2 = claudeCodeSessionId("tok-abc", "  thread-alpha  ");
    const convB = claudeCodeSessionId("tok-abc", "thread-beta");
    const fallback = claudeCodeSessionId("tok-abc");
    expect(convA1).toBe(convA2);
    expect(convA1).not.toBe(convB);
    expect(convA1).not.toBe(fallback);
    expect(claudeCodeSessionId("tok-abc", "")).toBe(fallback);
    expect(claudeCodeSessionId("tok-abc", "   ")).toBe(fallback);
    expect(convA1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("CLAUDE_CODE_HEADERS carries the first-party Stainless/App signature", async () => {
    expect(CLAUDE_CODE_HEADERS["X-App"]).toBe("cli");
    expect(CLAUDE_CODE_HEADERS["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Runtime"]).toBe("node");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Lang"]).toBe("js");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Package-Version"]).toBe(CLAUDE_CLI_SDK_PACKAGE_VERSION);
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Runtime-Version"]).toBe(CLAUDE_CLI_RUNTIME_VERSION);
    expect(CLAUDE_CODE_HEADERS["X-Stainless-OS"]).toBe(stainlessOsName(process.platform));
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Arch"]).toBe(stainlessArchName(process.arch));
    expect(stainlessOsName("darwin")).toBe("MacOS");
    expect(stainlessOsName("linux")).toBe("Linux");
    expect(stainlessOsName("win32")).toBe("Windows");
    expect(stainlessArchName("arm64")).toBe("arm64");
    expect(stainlessArchName("x64")).toBe("x64");
  });
});

describe("client fingerprint — anthropic OAuth headers", () => {
  const oauthProvider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "oauth-tok-123" } as unknown as OcxProviderConfig;
  const apiKeyProvider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-123" } as unknown as OcxProviderConfig;

  test("OAuth request carries the full Claude Code header set", async () => {
    const { headers } = await createAnthropicAdapter(oauthProvider).buildRequest(parsed());
    expect(headers["X-App"]).toBe("cli");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["X-Stainless-Runtime"]).toBe("node");
    expect(headers["X-Stainless-Lang"]).toBe("js");
    expect(headers["X-Stainless-Retry-Count"]).toBe("0");
    expect(headers["X-Stainless-Timeout"]).toBe("600");
    expect(headers["X-Stainless-Package-Version"]).toBe("0.112.1");
    expect(headers["X-Stainless-Runtime-Version"]).toBe("v26.3.0");
    expect(headers["anthropic-beta"]).toBeDefined();
    expect(headers["X-Claude-Code-Session-Id"]).toMatch(/^[0-9a-f]{8}-/);
    expect(headers["x-client-request-id"]).toMatch(/^[0-9a-f]{8}-/);
  });

  test("session id is stable across requests with the same OAuth token", async () => {
    const a = (await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers["X-Claude-Code-Session-Id"];
    const b = (await createAnthropicAdapter(oauthProvider).buildRequest(parsed())).headers["X-Claude-Code-Session-Id"];
    expect(a).toBe(b);
  });

  test("session id separates distinct conversation threads on the same OAuth token", async () => {
    const adapter = createAnthropicAdapter(oauthProvider);
    const turnA1 = (await adapter.buildRequest(parsed({ _clientThreadId: "conv-1" }))).headers["X-Claude-Code-Session-Id"];
    const turnA2 = (await adapter.buildRequest(parsed({ _clientThreadId: "conv-1" }))).headers["X-Claude-Code-Session-Id"];
    const turnB = (await adapter.buildRequest(parsed({ _clientThreadId: "conv-2" }))).headers["X-Claude-Code-Session-Id"];
    expect(turnA1).toBe(turnA2);
    expect(turnA1).not.toBe(turnB);
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
    expect(oauth["Accept"]).toBe("application/json");
    expect(oauth["User-Agent"]).toBe(CLAUDE_CLI_USER_AGENT);
    expect(apiKey["Accept"]).toBe("application/json");
    expect(apiKey["User-Agent"]).toBe(`@anthropic-ai/sdk/${CLAUDE_CLI_SDK_PACKAGE_VERSION}`);
  });

  test("Accept negotiates SSE for a streaming request", async () => {
    const streaming = { ...parsed(), stream: true } as OcxParsedRequest;
    const { headers } = await createAnthropicAdapter(oauthProvider).buildRequest(streaming);
    expect(headers["Accept"]).toBe("text/event-stream");
    expect(headers["User-Agent"]).toBe(CLAUDE_CLI_USER_AGENT);
  });
});
