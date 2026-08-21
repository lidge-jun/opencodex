import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { deriveOAuthIds } from "../src/providers/derive";
import {
  createWorkBuddyAdapter,
  findWorkBuddySseRecordEnd,
  resolveWorkBuddyUpstreamModel,
  sanitizeWorkBuddySseBlock,
  WORKBUDDY_MODELS,
} from "../src/adapters/workbuddy";
import { WORKBUDDY_UPSTREAM_CHAT_URL, resetWorkBuddyAuthCache } from "../src/oauth/workbuddy-credentials";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function minimalProvider(): OcxProviderConfig {
  return {
    adapter: "workbuddy",
    baseUrl: WORKBUDDY_UPSTREAM_CHAT_URL,
    authMode: "oauth",
    apiKey: "stored-access-token",
    models: [...WORKBUDDY_MODELS],
    defaultModel: "workbuddy/deepseek-v4-flash",
  };
}

function minimalRequest(model = "workbuddy/deepseek-v4-flash", stream = true): OcxParsedRequest {
  return {
    modelId: model,
    stream,
    context: { messages: [{ role: "user", content: "hello" }], tools: [] },
    options: {},
  };
}

describe("workbuddy provider registry", () => {
  const entry = PROVIDER_REGISTRY.find(provider => provider.id === "workbuddy");

  test("registry entry exists with expected shape", () => {
    expect(entry).toBeDefined();
    expect(entry?.adapter).toBe("workbuddy");
    expect(entry?.authKind).toBe("oauth");
    expect(entry?.oauthId).toBe("workbuddy");
    expect(entry?.baseUrl).toBe(WORKBUDDY_UPSTREAM_CHAT_URL);
    expect(entry?.defaultModel).toBe("workbuddy/deepseek-v4-flash");
    expect(entry?.liveModels).toBe(false);
    expect(entry?.featured).toBe(false);
  });

  test("oauth id is registered for login", () => {
    expect(deriveOAuthIds()).toContain("workbuddy");
  });
});

describe("workbuddy model mapping", () => {
  test("maps namespaced ids to upstream slugs", () => {
    expect(resolveWorkBuddyUpstreamModel("workbuddy/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(resolveWorkBuddyUpstreamModel("workbuddy/auto")).toBe("auto");
    expect(resolveWorkBuddyUpstreamModel("deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });
});

describe("workbuddy SSE sanitize", () => {
  test("drops conversationId events and non-JSON data lines", () => {
    const raw = [
      "event: conversationId",
      "data: conv-abc123",
      "",
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      "data: [DONE]",
    ].join("\n");
    expect(sanitizeWorkBuddySseBlock(raw)).toBe(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    );
  });

  test("findWorkBuddySseRecordEnd recognizes LF and CRLF delimiters", () => {
    expect(findWorkBuddySseRecordEnd('data: {"x":1}\n\nrest')).toEqual({ end: 13, delimiterLength: 2 });
    expect(findWorkBuddySseRecordEnd('data: {"x":1}\r\n\r\nrest')).toEqual({ end: 13, delimiterLength: 4 });
  });
});

describe("workbuddy adapter buildRequest", () => {
  let tempHome = "";

  beforeEach(() => {
    resetWorkBuddyAuthCache();
    tempHome = mkdtempSync(join(tmpdir(), "workbuddy-adapter-"));
    const authDir = join(tempHome, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth");
    mkdirSync(authDir, { recursive: true });
    process.env.WORKBUDDY_AUTH_FILE = join(authDir, "workbuddy-desktop.info");
    writeFileSync(process.env.WORKBUDDY_AUTH_FILE, JSON.stringify({
      auth: {
        accessToken: "desktop-access-token",
        refreshToken: "desktop-refresh-token",
        expiresAt: 4_102_444_800_000,
        domain: "personal.example.cn",
      },
      account: { uid: "desktop-user" },
    }), "utf8");
  });

  afterEach(() => {
    delete process.env.WORKBUDDY_AUTH_FILE;
    resetWorkBuddyAuthCache();
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("forces upstream streaming and injects WorkBuddy headers", () => {
    const adapter = createWorkBuddyAdapter(minimalProvider());
    const request = adapter.buildRequest(minimalRequest(), { inboundWire: "chat" });
    expect(request.url).toBe(WORKBUDDY_UPSTREAM_CHAT_URL);
    expect(request.headers?.Accept).toBe("text/event-stream");
    expect(request.headers?.["Content-Type"]).toBe("application/json");
    expect(request.headers?.Authorization).toBe("Bearer stored-access-token");
    expect(request.headers?.["X-User-Id"]).toBe("desktop-user");
    expect(request.headers?.["X-Domain"]).toBe("personal.example.cn");
    const body = JSON.parse(String(request.body)) as { model?: string; stream?: boolean };
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.stream).toBe(true);
  });

  test("merges configured provider headers from the base openai-chat request", () => {
    const adapter = createWorkBuddyAdapter({
      ...minimalProvider(),
      headers: { "X-Custom-Trace": "keep-me" },
    });
    const request = adapter.buildRequest(minimalRequest(), { inboundWire: "chat" });
    expect(request.headers?.["X-Custom-Trace"]).toBe("keep-me");
    expect(request.headers?.["Content-Type"]).toBe("application/json");
    expect(request.headers?.Accept).toBe("text/event-stream");
  });

  test("fetchResponse emits CRLF-framed SSE before upstream EOF", async () => {
    const adapter = createWorkBuddyAdapter(minimalProvider());
    const encoder = new TextEncoder();
    let sent = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"early"}}]}\r\n\r\n'));
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    try {
      const request = adapter.buildRequest(minimalRequest(), { inboundWire: "chat" });
      const response = await adapter.fetchResponse!(request, {});
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"content":"early"');
      reader.releaseLock();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetchResponse sanitizes upstream SSE before parseStream", async () => {
    const adapter = createWorkBuddyAdapter(minimalProvider());
    const upstream = [
      "event: conversationId",
      "data: conv-should-drop",
      "",
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    try {
      const request = adapter.buildRequest(minimalRequest(), { inboundWire: "chat" });
      const response = await adapter.fetchResponse!(request, {});
      const text = await response.text();
      expect(text).toContain('"content":"ok"');
      expect(text).not.toContain("conv-should-drop");
      expect(text).not.toContain("conversationId");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
