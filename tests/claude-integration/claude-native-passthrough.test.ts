import { afterEach, beforeEach, expect, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { logsFromApiBody } from "../helpers/logs-api";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { buildDesktop3pRegistry } from "../../src/claude/desktop-3p";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startTruncatedSseUpstream } from "../helpers/truncated-sse-upstream";
import { readRecentUsageEntries } from "../../src/usage/log";
import { tapAnthropicSseForLog } from "../../src/server/claude-messages";
import type { RequestLogContext } from "../../src/server/request-log";
import { TranslatorBudgetExceededError } from "../../src/lib/translator-budget";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-native-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-native-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

interface Captured { path: string; headers: Headers; body: any }

function mockAnthropicUpstream(captured: Captured[]) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      captured.push({ path: url.pathname + url.search, headers: req.headers, body: await req.json() });
      if (url.pathname.endsWith("/count_tokens")) {
        return Response.json({ input_tokens: 4242 });
      }
      const frames = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", content: [], model: "claude-fable-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 700000, cache_read_input_tokens: 690000, cache_creation_input_tokens: 1000, output_tokens: 1 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "native hi" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
}

function cfg(anthropicBaseUrl: string, extraClaude?: Record<string, unknown>): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, liveModels: false, models: ["test-model"] },
    },
    connectTimeoutMs: 250,
    claudeCode: { anthropicBaseUrl, ...extraClaude },
  } as OcxConfig;
}

const OAUTH_HEADERS = {
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
  "authorization": "Bearer sk-ant-oat01-tst",
  "user-agent": "claude-cli/2.1.200",
  "x-app": "cli",
};

function claudeBody(): Record<string, unknown> {
  return {
    model: "claude-fable-5",
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "prior thoughts", signature: "sig-real" }],
      },
      { role: "user", content: "hi" },
    ],
  };
}

test("unmapped claude model + sk-ant credential passes through verbatim", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify(claudeBody()),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("native hi");
    expect(text).toContain("message_stop");

    expect(captured).toHaveLength(1);
    const hit = captured[0];
    expect(hit.path).toBe("/v1/messages?beta=true");
    // Caller's own OAuth credential and beta headers forwarded verbatim.
    expect(hit.headers.get("authorization")).toBe("Bearer sk-ant-oat01-tst");
    expect(hit.headers.get("anthropic-beta")).toBe(OAUTH_HEADERS["anthropic-beta"]);
    expect(hit.headers.get("user-agent")).toBe("claude-cli/2.1.200");
    expect(hit.headers.get("x-app")).toBe("cli");
    // Body untouched: thinking signature, cache_control, max_tokens all intact.
    expect(hit.body).toEqual(claudeBody());

    // Request log: native provider tag + usage incl. cache detail from the SSE tap.
    const logs = logsFromApiBody(await (await fetch(new URL("/api/logs?tail=1", server.url))).json());
    const row = logs.at(-1);
    expect(row).toBeDefined();
    expect(row.status).toBe(200);
    expect(row.model).toBe("claude-fable-5");
    // raw input 700000 + cache read 690000 + cache write 1000 (inclusive convention)
    expect(row.usage.inputTokens).toBe(1391000);
    expect(row.usage.outputTokens).toBe(42);
    expect(row.usage.cacheReadInputTokens).toBe(690000);

    const claudeUsage = await fetch(new URL("/api/usage?range=all&surface=claude", server.url)).then(response => response.json()) as {
      surface: string;
      summary: { requests: number; totalTokens: number };
      models: Array<{ provider: string; model: string }>;
    };
    expect(claudeUsage.surface).toBe("claude");
    expect(claudeUsage.summary).toMatchObject({ requests: 1, totalTokens: 1391042 });
    expect(claudeUsage.models).toEqual([expect.objectContaining({ provider: "anthropic-native", model: "claude-fable-5" })]);

    const codexUsage = await fetch(new URL("/api/usage?range=all&surface=codex", server.url)).then(response => response.json()) as {
      surface: string;
      summary: { requests: number };
    };
    expect(codexUsage.surface).toBe("codex");
    expect(codexUsage.summary.requests).toBe(0);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("native passthrough persists conversationId from metadata.user_id", async () => {
  const { createHash } = await import("node:crypto");
  const { clearRequestLogsForTests } = await import("../../src/server/request-log");
  clearRequestLogsForTests();
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const userId = "user_session_opaque_abc";
    const res = await fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify({
        ...claudeBody(),
        metadata: { user_id: userId },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const logs = logsFromApiBody<{
      provider?: string;
      conversationId?: string;
    }>(await (await fetch(new URL("/api/logs?tail=1", server.url))).json());
    expect(logs).toHaveLength(1);
    expect(logs[0]?.provider).toBe("anthropic-native");
    expect(logs[0]?.conversationId).toBe(createHash("sha256").update(userId).digest("hex").slice(0, 32));
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("count_tokens passes through with native credentials", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const { authorization: _drop, ...withoutAuth } = OAUTH_HEADERS;
    const res = await fetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: { ...withoutAuth, "x-api-key": "sk-ant-api03-key" },
      body: JSON.stringify({ model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 4242 });
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/messages/count_tokens");
    expect(captured[0].headers.get("x-api-key")).toBe("sk-ant-api03-key");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

// The legacy claude-ocx spelling is what a picker saved before the ocx-claude aliases.
test.each([
  "ocx-claude-native--claude-fable-5-1",
  "claude-ocx-native--claude-fable-5-1",
])("Fable 1M picker alias %s preserves native passthrough on both Messages endpoints", async pickerModel => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const messagesWithoutMarker = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify({ ...claudeBody(), model: pickerModel }),
    });
    expect(messagesWithoutMarker.status).toBe(200);
    await messagesWithoutMarker.text();

    const messagesWithMarker = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify({ ...claudeBody(), model: `${pickerModel}[1m]` }),
    });
    expect(messagesWithMarker.status).toBe(200);
    await messagesWithMarker.text();

    const countTokens = await fetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify({ model: `${pickerModel}[1m]`, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(countTokens.status).toBe(200);
    expect(await countTokens.json()).toEqual({ input_tokens: 4242 });

    expect(captured).toHaveLength(3);
    expect(captured[0]!.body.model).toBe("claude-fable-5-1");
    expect(captured[1]!.body.model).toBe("claude-fable-5-1");
    expect(captured[2]!.body.model).toBe("claude-fable-5-1");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("exposed native passthrough requires dedicated admission and never forwards admission credentials", async () => {
  const admissionSecret = "sk-ant-api03-key";
  const providerBearer = "sk-ant-oat01-provider";
  const providerApiKey = "sk-ant-api03-provider";
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig({
    ...cfg(upstream.url.toString().replace(/\/$/, "")),
    hostname: "0.0.0.0",
    apiKeys: [{ id: "remote", name: "remote", key: admissionSecret, createdAt: "2026-08-12" }],
  } as OcxConfig);
  const server = startServer(0);
  const messagesUrl = `http://127.0.0.1:${server.port}/v1/messages`;
  try {
    // The routed Messages surface still accepts legacy bearer admission, but native passthrough
    // on an exposed bind requires the dedicated header so provider credentials stay unambiguous.
    const withoutDedicated = await globalThis.fetch(messagesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${admissionSecret}`,
        "x-api-key": providerApiKey,
      },
      body: JSON.stringify(claudeBody()),
    });
    expect(withoutDedicated.status).not.toBe(200);
    await withoutDedicated.body?.cancel();
    expect(captured).toHaveLength(0);

    const bearerProvider = await globalThis.fetch(messagesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencodex-api-key": admissionSecret,
        authorization: `Bearer ${providerBearer}`,
        "x-api-key": admissionSecret,
      },
      body: JSON.stringify(claudeBody()),
    });
    expect(bearerProvider.status).toBe(200);
    await bearerProvider.text();
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("authorization")).toBe(`Bearer ${providerBearer}`);
    expect(captured[0].headers.get("x-api-key")).toBeNull();
    expect(captured[0].headers.get("x-opencodex-api-key")).toBeNull();

    // CodeRabbit follow-up: the inverse layout must also keep the real provider x-api-key while
    // removing an admission secret carried in Authorization.
    const apiKeyProvider = await globalThis.fetch(messagesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencodex-api-key": admissionSecret,
        authorization: `Bearer ${admissionSecret}`,
        "x-api-key": providerApiKey,
      },
      body: JSON.stringify(claudeBody()),
    });
    expect(apiKeyProvider.status).toBe(200);
    await apiKeyProvider.text();
    expect(captured).toHaveLength(2);
    expect(captured[1].headers.get("authorization")).toBeNull();
    expect(captured[1].headers.get("x-api-key")).toBe(providerApiKey);
    expect(captured[1].headers.get("x-opencodex-api-key")).toBeNull();

    for (const headerName of ["authorization", "x-api-key"] as const) {
      const headers = new Headers({
        "content-type": "application/json",
        "x-opencodex-api-key": admissionSecret,
      });
      if (headerName === "authorization") {
        headers.append(headerName, `Bearer ${providerBearer}`);
        headers.append(headerName, `Bearer ${admissionSecret}`);
      } else {
        headers.append(headerName, providerApiKey);
        headers.append(headerName, admissionSecret);
      }
      const ambiguous = await globalThis.fetch(messagesUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(claudeBody()),
      });
      expect(ambiguous.status).not.toBe(200);
      await ambiguous.body?.cancel();
      expect(captured).toHaveLength(2);
    }
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test.each([false, true])("Desktop mapping errors follow admission on both endpoints (fastRows=%s)", async fastRows => {
  const admissionSecret = "desktop-admission-fixture";
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  const config = cfg(upstream.url.origin);
  config.hostname = "0.0.0.0";
  config.fastRows = fastRows;
  config.apiKeys = [{ id: "desktop", name: "desktop", key: admissionSecret, createdAt: "2026-09-06" }];
  // Any default-provider fallback is observable at the same upstream as native dispatch.
  config.providers.mock!.baseUrl = new URL("/v1", upstream.url).href;
  saveConfig(config);
  const server = startServer(0);
  buildDesktop3pRegistry([], []);
  try {
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      for (const model of ["claude-opus-4-8-20260202", "claude-opus-4-8-20260202--fast[1m]", "claude-opus-4-8-zzz"]) {
        for (const credential of [undefined, "wrong-admission-fixture", admissionSecret]) {
          const headers = new Headers(OAUTH_HEADERS);
          if (credential !== undefined) headers.set("x-opencodex-api-key", credential);
          const response = await globalThis.fetch(`http://127.0.0.1:${server.port}${path}`, {
            method: "POST", headers, signal: AbortSignal.timeout(5_000),
            body: JSON.stringify({ ...claudeBody(), model }),
          });
          const body = await response.json() as { type: string; error: { type: string; code?: string; message: string } };
          expect(body.type).toBe("error");
          if (credential !== admissionSecret) {
            expect(response.status).toBe(401);
            expect(body.error.type).toBe("authentication_error");
            expect(body.error.code).not.toBe("desktop_model_mapping_unavailable");
            expect(response.headers.get("retry-after")).toBeNull();
          } else if (model === "claude-opus-4-8-zzz") {
            expect(response.status).toBe(400);
            expect(body.error.type).toBe("invalid_request_error");
            expect(response.headers.get("retry-after")).toBeNull();
          } else {
            expect(response.status).toBe(503);
            expect(body.error).toMatchObject({ type: "api_error", code: "desktop_model_mapping_unavailable" });
            expect(response.headers.get("retry-after")).toBe("1");
          }
          expect(captured).toEqual([]);
        }
      }
    }
  } finally {
    await server.stop(true);
    upstream.stop(true);
    buildDesktop3pRegistry([], []);
  }
}, { timeout: SERVER_BUDGET_MS });

test("alias/mapped models and non-anthropic credentials do NOT pass through", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, ""), { modelMap: { "claude-haiku-4-5": "mock/test-model" } }));
  const server = startServer(0);
  try {
    // Mapped claude id with sk-ant creds -> translate path (mock provider is unreachable -> upstream error, NOT passthrough).
    const mapped = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] }),
    });
    expect(mapped.status).not.toBe(200);

    // Alias id with sk-ant creds -> translate path too.
    const alias = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify({ model: "ocx-claude-mock--test-model", max_tokens: 10, messages: [{ role: "user", content: "x" }] }),
    });
    expect(alias.status).not.toBe(200);

    // Claude model with placeholder bearer -> translate path (no sk-ant credential).
    const placeholder = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer opencodex-local" },
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] }),
    });
    expect(placeholder.status).not.toBe(200);

    expect(captured).toHaveLength(0); // the anthropic upstream never saw any of them
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("nativePassthrough:false disables the pierce", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, ""), { nativePassthrough: false }));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).not.toBe(200);
    expect(captured).toHaveLength(0);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

// --- Generous image pipeline on the native branch (devlog 260714 .../040, P1-P5) ---

import { resetNormalizeStateForTests } from "../../src/adapters/anthropic-image-normalize";
import { sniffImageDimensions } from "../../src/adapters/anthropic-image-guard";

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function realPng(width: number, height: number): Promise<string> {
  const buf = await new Bun.Image(Buffer.from(ONE_PX_PNG, "base64")).resize(width, height).png().toBuffer();
  return Buffer.from(buf).toString("base64");
}

function imgBlock(data: string): Record<string, unknown> {
  return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

function imageBody(blocks: unknown[]): Record<string, unknown> {
  return {
    model: "claude-fable-5",
    max_tokens: 1000,
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "look" }, ...blocks] }],
  };
}

type WireBlock = { type: string; source?: { type?: string; media_type?: string; data?: string; file_id?: string } };

function capturedBlocks(captured: Captured[]): WireBlock[] {
  const msgs = (captured[0].body as { messages: Array<{ content: unknown }> }).messages;
  const content = msgs[0].content;
  return (Array.isArray(content) ? content : []) as WireBlock[];
}

async function postNative(serverUrl: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL(path, serverUrl), { method: "POST", headers: OAUTH_HEADERS, body: JSON.stringify(body) });
}

test("P1: 30-image history arrives age-tiered — newest pass through, older shrink, none dropped", async () => {
  resetNormalizeStateForTests();
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const src = await realPng(1500, 1000);
    const res = await postNative(String(server.url), "/v1/messages", imageBody(Array.from({ length: 30 }, () => imgBlock(src))));
    expect(res.status).toBe(200);
    const images = capturedBlocks(captured).filter(b => b.type === "image");
    expect(images).toHaveLength(30);
    // Wire order oldest first: 0-9 tier2 (<=700 jpeg), 10-23 tier1 (<=1024), 24-29 tier0 pass-through png.
    for (let i = 0; i < 10; i++) {
      expect(images[i].source?.media_type).toBe("image/jpeg");
      const d = sniffImageDimensions(images[i].source?.data ?? "");
      expect(Math.max(d!.width, d!.height)).toBeLessThanOrEqual(700);
    }
    for (let i = 24; i < 30; i++) {
      expect(images[i].source?.media_type).toBe("image/png");
      expect(images[i].source?.data).toBe(src);
    }
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("P2: dimension-oversized image is re-encoded (normalized), not dropped", async () => {
  resetNormalizeStateForTests();
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const res = await postNative(String(server.url), "/v1/messages", imageBody([imgBlock(await realPng(4000, 3000))]));
    expect(res.status).toBe(200);
    const [img] = capturedBlocks(captured).filter(b => b.type === "image");
    expect(img.source?.media_type).toBe("image/jpeg");
    const d = sniffImageDimensions(img.source?.data ?? "");
    expect(Math.max(d!.width, d!.height)).toBeLessThanOrEqual(2000);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("P2b: 101 images trip the guard's 100-cap — exactly one oldest textified", async () => {
  resetNormalizeStateForTests();
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const res = await postNative(String(server.url), "/v1/messages", imageBody(Array.from({ length: 101 }, () => imgBlock(ONE_PX_PNG))));
    expect(res.status).toBe(200);
    const blocks = capturedBlocks(captured);
    expect(blocks.filter(b => b.type === "image")).toHaveLength(100);
    expect(blocks.filter(b => b.type === "text").length).toBeGreaterThanOrEqual(2); // original text + 1 omitted note
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("P4: count_tokens body is normalized identically to the real send", async () => {
  resetNormalizeStateForTests();
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const body = imageBody([imgBlock(await realPng(4000, 3000))]);
    delete body.stream;
    const res = await postNative(String(server.url), "/v1/messages/count_tokens", body);
    expect(res.status).toBe(200);
    const [img] = capturedBlocks(captured).filter(b => b.type === "image");
    expect(img.source?.media_type).toBe("image/jpeg");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("P5: Files API image source passes through untouched", async () => {
  resetNormalizeStateForTests();
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const fileBlock = { type: "image", source: { type: "file", file_id: "file_abc123" } };
    const res = await postNative(String(server.url), "/v1/messages", imageBody([fileBlock]));
    expect(res.status).toBe(200);
    const [img] = capturedBlocks(captured).filter(b => b.type === "image");
    expect(img.source).toEqual({ type: "file", file_id: "file_abc123" });
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});


test.each([false, true])("catalog-published native dates retain identity while unknown dates are unavailable (fastRows=%s)", async fastRows => {
  const published = "claude-opus-4-8-20260402";
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  const config = cfg(upstream.url.origin, { desktopNativeModels: false });
  config.fastRows = fastRows;
  config.providers.anthropic = {
    adapter: "anthropic", baseUrl: upstream.url.origin, apiKey: "test-native-key",
    allowPrivateNetwork: true, liveModels: false, models: [published],
  };
  saveConfig(config);
  buildDesktop3pRegistry([], []);
  const server = startServer(0);
  try {
    // Publish the fixture's genuine identity through the real hub catalog path.
    const catalog = await fetch(new URL("/v1/models?ids=desktop", server.url), {
      headers: { "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(5_000),
    });
    expect(catalog.status).toBe(200);
    const list = await catalog.json() as { data: Array<{ id: string }> };
    expect(list.data.some(row => row.id === published)).toBe(true);
    for (const model of [published, `${published}[1m]`, "claude-opus-4-8", "claude-haiku-4-5"]) {
      for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
        const response = await fetch(new URL(path, server.url), {
          method: "POST", headers: OAUTH_HEADERS, signal: AbortSignal.timeout(5_000),
          body: JSON.stringify({ ...claudeBody(), model }),
        });
        expect(response.status).toBe(200);
        await response.text();
        expect(captured.at(-1)!.body.model).toBe(model.replace("[1m]", ""));
        expect(captured.at(-1)!.path).toBe(path);
      }
    }
    expect(captured).toHaveLength(8);
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const response = await fetch(new URL(path, server.url), {
        method: "POST", headers: OAUTH_HEADERS, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ ...claudeBody(), model: "claude-opus-4-8-20260403" }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect((await response.json() as { error: { type: string; code: string } }).error).toMatchObject({
        type: "api_error", code: "desktop_model_mapping_unavailable",
      });
    }
    expect(captured).toHaveLength(8);
  } finally {
    await server.stop(true);
    upstream.stop(true);
    buildDesktop3pRegistry([], []);
  }
}, { timeout: SERVER_BUDGET_MS });

// --- tool_use.id wire-contract sanitize on the native branch ---
// The Anthropic adapter normalizes tool call ids (#1780), but this branch bypasses that
// adapter, so third-party ids like Devin's `Bash:0#<hex>` would reach api.anthropic.com
// verbatim and 400 on `^[a-zA-Z0-9_-]+$`. The passthrough sanitizes before serialize.

test("non-conforming tool_use ids are rewritten on the wire, pairing preserved, conforming ids untouched", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const pollutedA = "Bash:0#abcdef1234567890";
    const pollutedB = "Read:7#fedcba0987654321";
    const conforming = "toolu_01KeepMeVerbatim";
    const body = {
      model: "claude-fable-5",
      max_tokens: 1000,
      messages: [
        { role: "user", content: "run them" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: pollutedA, name: "Bash", input: { cmd: "a" } },
            { type: "server_tool_use", id: pollutedB, name: "web_search", input: { q: "b" } },
            { type: "tool_use", id: conforming, name: "Read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: pollutedA, content: "ok-a" },
            { type: "web_search_tool_result", tool_use_id: pollutedB, content: [] },
            { type: "tool_result", tool_use_id: conforming, content: "ok-c" },
          ],
        },
        { role: "user", content: "go on" },
      ],
    };
    const res = await postNative(String(server.url), "/v1/messages", body);
    expect(res.status).toBe(200);
    await res.text();

    const msgs = captured[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const callBlocks = msgs[1].content;
    const resultBlocks = msgs[2].content;
    const wireA = callBlocks[0].id as string;
    const wireB = callBlocks[1].id as string;
    for (const wire of [wireA, wireB]) {
      expect(wire).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(wire.length).toBeLessThanOrEqual(64);
    }
    expect(wireA).not.toBe(pollutedA);
    expect(wireB).not.toBe(pollutedB);
    expect(wireA).not.toBe(wireB);
    expect(resultBlocks[0].tool_use_id).toBe(wireA);
    expect(resultBlocks[1].tool_use_id).toBe(wireB);
    expect(callBlocks[2].id).toBe(conforming);
    expect(resultBlocks[2].tool_use_id).toBe(conforming);

    // count_tokens shares the branch; the allocator is deterministic per raw id.
    const res2 = await postNative(String(server.url), "/v1/messages/count_tokens", body);
    expect(res2.status).toBe(200);
    const msgs2 = captured[1].body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs2[1].content[0].id).toBe(wireA);
    expect(msgs2[2].content[0].tool_use_id).toBe(wireA);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

function toolRoundTrip(callId: string, extraCallId?: string) {
  const calls: Array<Record<string, unknown>> = [{ type: "tool_use", id: callId, name: "Bash", input: { cmd: "a" } }];
  const results: Array<Record<string, unknown>> = [{ type: "tool_result", tool_use_id: callId, content: "ok" }];
  if (extraCallId !== undefined) {
    calls.push({ type: "tool_use", id: extraCallId, name: "Read", input: {} });
    results.push({ type: "tool_result", tool_use_id: extraCallId, content: "ok-2" });
  }
  return {
    model: "claude-fable-5",
    max_tokens: 1000,
    messages: [
      { role: "user", content: "run" },
      { role: "assistant", content: calls },
      { role: "user", content: results },
    ],
  };
}

test("an empty tool_use id fails locally with 400 and never reaches the upstream", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const res = await postNative(String(server.url), "/v1/messages", toolRoundTrip(""));
    expect(res.status).toBe(400);
    const payload = await res.json() as { type?: string; error?: { type?: string } };
    expect(payload.error?.type).toBe("invalid_request_error");
    expect(captured).toHaveLength(0);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("an overlength id is rewritten within 64 characters and a colliding valid id stays byte-identical", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
  const server = startServer(0);
  try {
    const overlength = "toolu_" + "x".repeat(80);
    const polluted = "call:a";
    const res = await postNative(String(server.url), "/v1/messages", toolRoundTrip(overlength));
    expect(res.status).toBe(200);
    await res.text();
    const msgs = captured[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const wire = msgs[1].content[0].id as string;
    expect(wire).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(wire.length).toBeLessThanOrEqual(64);
    expect(msgs[2].content[0].tool_use_id).toBe(wire);

    // A valid id that equals the polluted id's rewritten form keeps its bytes; the
    // rewrite moves aside so the two calls never share a wire id.
    const res2 = await postNative(String(server.url), "/v1/messages", toolRoundTrip(polluted, "placeholder"));
    await res2.text();
    const rewritten = (captured[1].body.messages as Array<{ content: Array<Record<string, unknown>> }>)[1].content[0].id as string;
    const res3 = await postNative(String(server.url), "/v1/messages", toolRoundTrip(polluted, rewritten));
    expect(res3.status).toBe(200);
    await res3.text();
    const msgs3 = captured[2].body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs3[1].content[1].id).toBe(rewritten);
    expect(msgs3[2].content[1].tool_use_id).toBe(rewritten);
    const moved = msgs3[1].content[0].id as string;
    expect(moved).not.toBe(rewritten);
    expect(moved).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(moved.length).toBeLessThanOrEqual(64);
    expect(msgs3[2].content[0].tool_use_id).toBe(moved);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

// --- Mid-stream upstream reset: the stream had started, then the upstream socket went away ---

const PARTIAL_TURN_SSE = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", content: [], model: "claude-fable-5", stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half an ans" } })}\n\n`,
].join("");

test("a mid-stream upstream reset ends the native stream with an Anthropic error event and logs a failed turn", async () => {
  const { clearRequestLogsForTests } = await import("../../src/server/request-log");
  clearRequestLogsForTests();
  const upstream = startTruncatedSseUpstream(PARTIAL_TURN_SSE);
  saveConfig(cfg(`http://127.0.0.1:${upstream.port}`));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify(claudeBody()),
    });
    expect(res.status).toBe(200);
    // The body ends cleanly with a protocol terminal the client can act on, instead of a
    // connection reset (or, on some Bun releases, a bare chunked EOF) after "half an ans".
    const text = await res.text();
    expect(text).toContain("half an ans");
    expect(text).toContain("\n\nevent: error\ndata: ");
    const errorFrame = JSON.parse(text.slice(text.lastIndexOf("data: ") + 6).trim()) as { type: string; error: { type: string; message: string } };
    expect(errorFrame.type).toBe("error");
    expect(errorFrame.error.type).toBe("api_error");
    expect(errorFrame.error.message).toContain("anthropic passthrough upstream stream failed: ");
    // The committed request is not replayed.
    expect(upstream.requests()).toBe(1);

    const logs = logsFromApiBody<{
      status?: number;
      terminalStatus?: string;
      closeReason?: string;
      transportPhase?: string;
      terminalSource?: string;
      failureCause?: string;
      upstreamError?: string;
      usage?: { inputTokens?: number };
    }>(await (await fetch(new URL("/api/logs?tail=1", server.url))).json());
    expect(logs).toHaveLength(1);
    const row = logs[0]!;
    // Same row the Responses relay writes for a mid-stream reset: a truncated 200 body is not a
    // completed turn.
    expect(row.status).toBe(502);
    expect(row.terminalStatus).toBe("failed");
    expect(row.closeReason).toBe("terminal");
    expect(row.transportPhase).toBe("mid_stream");
    expect(row.terminalSource).toBe("synthetic");
    expect(row.failureCause).toBe("transport-ambiguous");
    expect(row.upstreamError).toContain("anthropic passthrough upstream stream failed: ");
    // Usage seen before the reset is still recorded.
    expect(row.usage?.inputTokens).toBe(12);
  } finally {
    await server.stop(true);
    upstream.stop();
  }
});

test("a translator budget overflow still errors the tapped stream for callers that map it", async () => {
  const overflow = new TranslatorBudgetExceededError("live_transient", 1024);
  let sent = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(overflow);
        return;
      }
      sent = true;
      controller.enqueue(new TextEncoder().encode(PARTIAL_TURN_SSE));
    },
  });
  const calls: unknown[] = [];
  const logCtx: RequestLogContext = { model: "claude-fable-5", provider: "anthropic-native" };
  const tapped = tapAnthropicSseForLog(source, logCtx, (status, meta) => calls.push({ status, ...meta }), { stallMs: 5_000, maxBytes: 0 });
  // The non-streaming native Messages fold turns this error into a 413; an error frame would
  // have reached it as a generic 502 instead.
  await expect(new Response(tapped).text()).rejects.toBe(overflow);
  expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
  expect(logCtx.transportPhase).toBeUndefined();
});

test("a read rejection that lands before the client abort listener still finalizes as a client cancel", async () => {
  // Bun can settle a fetch body read before it dispatches the abort listeners (see
  // consumeForInspection in src/server/relay.ts). Model that order: the signal is already
  // aborted when the read rejects, and its listener has not run.
  const signal = { aborted: false, reason: undefined as unknown, addEventListener() {}, removeEventListener() {} };
  let sent = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        signal.aborted = true;
        signal.reason = new DOMException("client went away", "AbortError");
        controller.error(signal.reason);
        return;
      }
      sent = true;
      controller.enqueue(new TextEncoder().encode(PARTIAL_TURN_SSE));
    },
  });
  const calls: unknown[] = [];
  const logCtx: RequestLogContext = { model: "claude-fable-5", provider: "anthropic-native" };
  const tapped = tapAnthropicSseForLog(source, logCtx, (status, meta) => calls.push({ status, ...meta }), {
    stallMs: 5_000,
    maxBytes: 0,
    reqSignal: signal as unknown as AbortSignal,
  });
  const text = await new Response(tapped).text();
  expect(text).not.toContain("event: error");
  expect(calls).toEqual([{ status: 499, closeReason: "client_cancel" }]);
  expect(logCtx.transportPhase).toBeUndefined();
  expect(logCtx.upstreamError).toBeUndefined();
});

const COMPLETE_TURN_SSE = PARTIAL_TURN_SSE + [
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

test("a reset after message_stop is a finished turn: no error event and a completed row", async () => {
  const { clearRequestLogsForTests } = await import("../../src/server/request-log");
  clearRequestLogsForTests();
  // Only the chunked-encoding trailer is lost; the turn itself arrived whole.
  const upstream = startTruncatedSseUpstream(COMPLETE_TURN_SSE);
  saveConfig(cfg(`http://127.0.0.1:${upstream.port}`));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify(claudeBody()),
    });
    const text = await res.text();
    expect(text.endsWith(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`)).toBe(true);
    expect(text).not.toContain("event: error");
    const logs = logsFromApiBody<{ status?: number; closeReason?: string; transportPhase?: string; upstreamError?: string }>(
      await (await fetch(new URL("/api/logs?tail=1", server.url))).json(),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 200, closeReason: "terminal" });
    expect(logs[0]!.transportPhase).toBeUndefined();
    expect(logs[0]!.upstreamError).toBeUndefined();
  } finally {
    await server.stop(true);
    upstream.stop();
  }
});

test("a terminal frame still in the buffer when the read fails counts as seen", async () => {
  // The reset can land after message_stop but before its blank-line delimiter.
  const withoutDelimiter = COMPLETE_TURN_SSE.slice(0, -2);
  let sent = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new Error("The socket connection was closed unexpectedly."));
        return;
      }
      sent = true;
      controller.enqueue(new TextEncoder().encode(withoutDelimiter));
    },
  });
  const calls: unknown[] = [];
  const logCtx: RequestLogContext = { model: "claude-fable-5", provider: "anthropic-native" };
  const tapped = tapAnthropicSseForLog(source, logCtx, (status, meta) => calls.push({ status, ...meta }), { stallMs: 5_000, maxBytes: 0 });
  const text = await new Response(tapped).text();
  // The delimiter is restored: an SSE parser drops an event that EOF cuts off before its blank line.
  expect(text).toBe(`${withoutDelimiter}\n\n`);
  expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
  expect(logCtx.usage).toEqual(expect.objectContaining({ inputTokens: 12, outputTokens: 5 }));
});

// --- A failed passthrough keeps its reason in the request log ---

async function nativeFailureRow(upstreamBase: string, extraClaude?: Record<string, unknown>, overrides?: Partial<OcxConfig>, requestBody?: Record<string, unknown>) {
  const { clearRequestLogsForTests } = await import("../../src/server/request-log");
  clearRequestLogsForTests();
  saveConfig({ ...cfg(upstreamBase, extraClaude), ...overrides });
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify({ ...claudeBody(), stream: false, ...requestBody }),
    });
    const text = await res.text();
    const logs = logsFromApiBody<{ status?: number; closeReason?: string; upstreamError?: string; errorCode?: string }>(
      await (await fetch(new URL("/api/logs?tail=1", server.url))).json(),
    );
    expect(logs).toHaveLength(1);
    return { res, text, row: logs[0]! };
  } finally {
    await server.stop(true);
  }
}

test("an upstream error response is relayed verbatim and its reason reaches the request log and usage.jsonl", async () => {
  const errorBody = { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 213000 tokens > 200000 maximum" }, request_id: "req_fixture" };
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json(errorBody, { status: 400 }) });
  try {
    const { res, text, row } = await nativeFailureRow(upstream.url.toString().replace(/\/$/, ""));
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual(errorBody);
    expect(row.status).toBe(400);
    expect(row.upstreamError).toBe("Provider error 400: invalid_request_error");
    // usage.jsonl carries failure diagnostics for >= 400 rows; this row used to persist none.
    expect(readRecentUsageEntries(1)[0]?.upstreamError).toBe(row.upstreamError);
  } finally {
    upstream.stop(true);
  }
});

test("a non-JSON upstream error still logs its status as the reason", async () => {
  const upstream = Bun.serve({ port: 0, fetch: () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }) });
  try {
    const { res, row } = await nativeFailureRow(upstream.url.toString().replace(/\/$/, ""));
    expect(res.status).toBe(502);
    expect(row.upstreamError).toBe("Provider error 502");
  } finally {
    upstream.stop(true);
  }
});

test("a credential echoed in an upstream error message is excluded from persistent diagnostics", async () => {
  const leaked = "sk-ant-api03-" + "Z".repeat(40);
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${leaked}` } }, { status: 401 }) });
  try {
    const { row } = await nativeFailureRow(upstream.url.toString().replace(/\/$/, ""));
    expect(row.status).toBe(401);
    expect(row.upstreamError).toBe("Provider error 401: authentication_error");
    expect(readRecentUsageEntries(1)[0]?.upstreamError).toBe(row.upstreamError);
    expect(row.upstreamError).not.toContain(leaked);
  } finally {
    upstream.stop(true);
  }
});

test.each(["account", "request body"] as const)("an upstream message cannot persist %s", async scenario => {
  const privateValue = scenario === "account" ? "review-fixture@example.test" : "synthetic-private-request-content-6295";
  const errorType = scenario === "account" ? "permission_error" : "invalid_request_error";
  let responseText = "";
  const upstream = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as { messages: { content: string }[] };
    responseText = JSON.stringify({ type: "error", error: {
      type: errorType,
      message: scenario === "account" ? `Account ${privateValue} is not authorized` : `Invalid message: ${JSON.stringify(body.messages)}`,
    } });
    return new Response(responseText, { status: 400, headers: { "content-type": "application/json", "retry-after": "7" } });
  } });
  try {
    const { res, text, row } = await nativeFailureRow(upstream.url.origin, undefined, undefined, {
      messages: [{ role: "user", content: privateValue }],
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(text).toBe(responseText);
    expect(text).toContain(privateValue);
    const usage = readRecentUsageEntries(1);
    expect(usage).toHaveLength(1);
    for (const record of [row, usage[0]]) {
      expect(record?.upstreamError).toBe(`Provider error 400: ${errorType}`);
      expect(JSON.stringify(record)).not.toContain(privateValue);
    }
  } finally {
    upstream.stop(true);
  }
});

test.each([
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
  "rate_limit_error", "api_error", "overloaded_error", "request_too_large",
])("a known error type %s uses only its closed diagnostic", async errorType => {
  const privateValue = "opaque-private-value-6295";
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ type: "error", error: { type: errorType, message: privateValue } }, { status: 500 }) });
  try {
    const { row } = await nativeFailureRow(upstream.url.origin);
    expect(row.upstreamError).toBe(`Provider error 500: ${errorType}`);
    expect(readRecentUsageEntries(1)[0]?.upstreamError).toBe(row.upstreamError);
    expect(JSON.stringify(row)).not.toContain(privateValue);
  } finally {
    upstream.stop(true);
  }
});

test.each([
  { type: "error", error: { type: "account-fixture@example.test", message: "private-content" } },
  { type: "error", error: { type: "toString", message: "private-content" } },
  { type: "error", error: { type: "constructor", message: "private-content" } },
  { type: "error", error: { type: "__proto__", message: "private-content" } },
  { type: "error", error: { type: { name: "api_error" }, message: "private-content" } },
  { type: "error", error: { message: "private-content" } },
  { type: "message", error: { type: "api_error", message: "private-content" } },
  { type: "error", error: ["api_error", "private-content"] },
  ["private-content"], null,
])("an unknown or malformed envelope %# records only HTTP status", async errorBody => {
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json(errorBody, { status: 502 }) });
  try {
    const { text, row } = await nativeFailureRow(upstream.url.origin);
    expect(JSON.parse(text)).toEqual(errorBody);
    expect(row.upstreamError).toBe("Provider error 502");
    expect(readRecentUsageEntries(1)[0]?.upstreamError).toBe("Provider error 502");
  } finally {
    upstream.stop(true);
  }
});

test("an unreachable upstream logs the fetch failure as the reason", async () => {
  // Stubbed like the reject-path activation test in claude-messages-endpoint.test.ts: a real
  // refusal can take longer than cfg()'s 250 ms header deadline on some platforms.
  const refusedOrigin = "http://127.0.0.1:1";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === refusedOrigin) throw Object.assign(new TypeError("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  try {
    const { res, text, row } = await nativeFailureRow(refusedOrigin);
    expect(res.status).toBe(502);
    expect(row.status).toBe(502);
    expect(row.upstreamError).toBe("anthropic passthrough failed: upstream connection error");
    expect(JSON.parse(text).error.message).toBe("anthropic passthrough failed: connect ECONNREFUSED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a credential in a local failure message is redacted for the client as well as the log", async () => {
  // Runtime failures can include identity or opaque data that secret redaction misses.
  const refusedOrigin = "http://127.0.0.1:1";
  const leaked = "sk-ant-api03-" + "Q".repeat(40);
  const privateValue = "runtime-fixture@example.test opaque-runtime-content-6295";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === refusedOrigin) throw new TypeError(`proxy rejected key ${leaked}: ${privateValue}`);
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  try {
    const { res, text, row } = await nativeFailureRow(refusedOrigin);
    expect(res.status).toBe(502);
    expect(text).not.toContain(leaked);
    expect(row.upstreamError).toBe("anthropic passthrough failed: upstream connection error");
    expect(row.upstreamError).not.toContain(leaked);
    expect(JSON.parse(text).error.message).toStartWith("anthropic passthrough failed: proxy rejected key ");
    const usage = readRecentUsageEntries(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.upstreamError).toBe(row.upstreamError);
    for (const record of [row, usage[0]]) {
      expect(JSON.stringify(record)).not.toContain(privateValue);
      expect(JSON.stringify(record)).not.toContain(leaked);
    }
    expect(JSON.parse(text).error.message).toContain(privateValue);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an upstream that never sends headers logs the header timeout as the reason", async () => {
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { /* accept, never answer */ } } });
  try {
    const { res, row } = await nativeFailureRow(`http://127.0.0.1:${silent.port}`);
    expect(res.status).toBe(504);
    expect(row.status).toBe(504);
    expect(row.upstreamError).toBe("anthropic passthrough timed out waiting for response headers");
  } finally {
    silent.stop(true);
  }
});

test("a non-stream body over the byte cap logs the cap as the reason", async () => {
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ type: "message", content: [{ type: "text", text: "x".repeat(4096) }] }) });
  try {
    const { res, row } = await nativeFailureRow(upstream.url.toString().replace(/\/$/, ""), { bodyMaxBytes: 1024 });
    expect(res.status).toBe(502);
    expect(row).toMatchObject({ status: 502, closeReason: "body_overflow" });
    expect(row.upstreamError).toBe("anthropic passthrough body exceeded 1024 bytes");
  } finally {
    upstream.stop(true);
  }
});

test("an oversized upstream error body is relayed verbatim but not parsed for the log reason", async () => {
  // 64 Ki characters: the order of the managed native lane's 64 KiB error read bound.
  const errorBody = { type: "error", error: { type: "invalid_request_error", message: "x".repeat(70 * 1024) } };
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json(errorBody, { status: 400 }) });
  try {
    const { res, text, row } = await nativeFailureRow(upstream.url.toString().replace(/\/$/, ""));
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual(errorBody);
    expect(row.upstreamError).toBe("Provider error 400");
  } finally {
    upstream.stop(true);
  }
});

test("a 3xx answer is not logged with an error reason", async () => {
  const upstream = Bun.serve({ port: 0, fetch: () => new Response("choose", { status: 300 }) });
  try {
    const { res, row } = await nativeFailureRow(upstream.url.toString().replace(/\/$/, ""));
    expect(res.status).toBe(300);
    expect(row.status).toBe(300);
    expect(row.upstreamError).toBeUndefined();
  } finally {
    upstream.stop(true);
  }
});

test("a 403 permission error is classified without consulting its upstream message", async () => {
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ type: "error", error: { type: "permission_error", message: "OAuth authentication is currently not supported." } }, { status: 403 }) });
  try {
    const { row } = await nativeFailureRow(upstream.url.toString().replace(/\/$/, ""));
    expect(row.status).toBe(403);
    expect(row.upstreamError).toBe("Provider error 403: permission_error");
    expect(row.errorCode).toBe("permission_denied");
  } finally {
    upstream.stop(true);
  }
});

/**
 * Sends a 200 status line and headers promising a JSON body, then nothing. Bun.serve holds the
 * headers of a streamed body until its first chunk, which would trip the header deadline instead.
 */
function startHeadersOnlyUpstream(onRequest?: () => void): { port: number; stop: () => void } {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        onRequest?.();
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n");
      },
    },
  });
  return { port: listener.port, stop: () => listener.stop(true) };
}

test("a non-stream body that stalls logs the stall as the reason", async () => {
  const upstream = startHeadersOnlyUpstream();
  try {
    const { res, row } = await nativeFailureRow(`http://127.0.0.1:${upstream.port}`, { bodyStallSec: 1 });
    expect(res.status).toBe(504);
    expect(row).toMatchObject({ status: 504, closeReason: "body_stall" });
    expect(row.upstreamError).toBe("anthropic passthrough body stalled: no upstream bytes for 1s");
  } finally {
    upstream.stop();
  }
});

test("a client that leaves while a non-stream body is pending logs the cancel as the reason", async () => {
  const { clearRequestLogsForTests } = await import("../../src/server/request-log");
  clearRequestLogsForTests();
  let reached!: () => void;
  const upstreamReached = new Promise<void>(resolve => { reached = resolve; });
  const upstream = startHeadersOnlyUpstream(() => reached());
  saveConfig(cfg(`http://127.0.0.1:${upstream.port}`));
  const server = startServer(0);
  try {
    const client = new AbortController();
    const pending = fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify({ ...claudeBody(), stream: false }),
      signal: client.signal,
    }).catch(() => undefined);
    await upstreamReached;
    await Bun.sleep(50);
    client.abort();
    await pending;
    let row: { status?: number; closeReason?: string; upstreamError?: string } | undefined;
    for (let i = 0; i < 100 && !row; i++) {
      row = logsFromApiBody<{ status?: number; closeReason?: string; upstreamError?: string }>(
        await (await fetch(new URL("/api/logs?tail=1", server.url))).json(),
      )[0];
      if (!row) await Bun.sleep(20);
    }
    expect(row).toMatchObject({ status: 499, closeReason: "client_cancel" });
    expect(row!.upstreamError).toBe("client closed request during anthropic passthrough");
  } finally {
    await server.stop(true);
    upstream.stop();
  }
});

// --- A stalled or over-cap stream is a visible incomplete turn, in the row and in usage.jsonl ---

async function stalledStreamRow(upstream: { url: URL }, extraClaude: Record<string, unknown>) {
  const { clearRequestLogsForTests } = await import("../../src/server/request-log");
  clearRequestLogsForTests();
  saveConfig(cfg(upstream.url.toString().replace(/\/$/, ""), extraClaude));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify(claudeBody()),
    });
    const text = await res.text();
    const logs = logsFromApiBody<{ status?: number; terminalStatus?: string; closeReason?: string; upstreamError?: string }>(
      await (await fetch(new URL("/api/logs?tail=1", server.url))).json(),
    );
    expect(logs).toHaveLength(1);
    return { res, text, row: logs[0]!, usage: readRecentUsageEntries(1)[0] };
  } finally {
    await server.stop(true);
  }
}

test("a stalled native stream logs a 502 incomplete row and keeps its diagnostics in usage.jsonl", async () => {
  const upstream = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(PARTIAL_TURN_SSE)); /* then silence */ },
  }), { headers: { "content-type": "text/event-stream" } }) });
  try {
    const { res, text, row, usage } = await stalledStreamRow(upstream, { bodyStallSec: 1 });
    expect(res.status).toBe(200);
    expect(text).toContain('"type":"timeout_error"');
    // Same row the Responses relay writes for a stall-timeout incomplete (httpStatusForRequestLogTerminal).
    expect(row).toMatchObject({ status: 502, terminalStatus: "incomplete", closeReason: "body_stall" });
    expect(row.upstreamError).toBe("anthropic passthrough body stalled: no upstream bytes for 1s");
    // usage.jsonl keeps failure diagnostics only for failed or non-completed rows; a 200 row dropped them.
    expect(usage).toMatchObject({ status: 502, terminalStatus: "incomplete", closeReason: "body_stall" });
  } finally {
    upstream.stop(true);
  }
});

test("a native stream over the byte cap logs a 502 incomplete row and keeps its diagnostics in usage.jsonl", async () => {
  const upstream = Bun.serve({ port: 0, fetch: () => new Response(PARTIAL_TURN_SSE, { headers: { "content-type": "text/event-stream" } }) });
  try {
    const { text, row, usage } = await stalledStreamRow(upstream, { bodyMaxBytes: 64 });
    expect(text).toContain("exceeded 64 bytes");
    expect(row).toMatchObject({ status: 502, terminalStatus: "incomplete", closeReason: "body_overflow" });
    expect(row.upstreamError).toBe("anthropic passthrough body exceeded 64 bytes");
    expect(usage).toMatchObject({ status: 502, terminalStatus: "incomplete", closeReason: "body_overflow" });
  } finally {
    upstream.stop(true);
  }
});

test("a turn that sent message_stop and then stalls is finished: 200 terminal, no error frame", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(COMPLETE_TURN_SSE)); /* never closes */ },
  });
  const calls: unknown[] = [];
  const logCtx: RequestLogContext = { model: "claude-fable-5", provider: "anthropic-native" };
  const tapped = tapAnthropicSseForLog(source, logCtx, (status, meta) => calls.push({ status, ...meta }), { stallMs: 30, maxBytes: 0 });
  const text = await new Response(tapped).text();
  expect(text).toBe(COMPLETE_TURN_SSE);
  expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
  expect(logCtx.upstreamError).toBeUndefined();
});

test("bytes past the cap after message_stop do not turn a finished turn into a failure", async () => {
  let sent = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(COMPLETE_TURN_SSE)); return; }
      controller.enqueue(new TextEncoder().encode(": keepalive padding ".repeat(64)));
    },
  });
  const calls: unknown[] = [];
  const logCtx: RequestLogContext = { model: "claude-fable-5", provider: "anthropic-native" };
  const cap = new TextEncoder().encode(COMPLETE_TURN_SSE).byteLength + 16;
  const tapped = tapAnthropicSseForLog(source, logCtx, (status, meta) => calls.push({ status, ...meta }), { stallMs: 0, maxBytes: cap });
  const text = await new Response(tapped).text();
  expect(text).toStartWith(COMPLETE_TURN_SSE);
  expect(text).not.toContain("event: error");
  expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
});

// SSE lines may end in CRLF, LF or CR. The tap forwards bytes untouched but must still see the frames.
function tapWithChunks(chunks: string[], guard: { stallMs: number; maxBytes: number }) {
  let index = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]!));
      // then silence (stall) or more bytes, per the test
    },
  });
  const calls: unknown[] = [];
  const logCtx: RequestLogContext = { model: "claude-fable-5", provider: "anthropic-native" };
  const tapped = tapAnthropicSseForLog(source, logCtx, (status, meta) => calls.push({ status, ...meta }), guard);
  return { tapped, calls, logCtx };
}

for (const [label, eol] of [["CRLF", "\r\n"], ["CR", "\r"]] as const) {
  test(`a ${label}-delimited turn that then stalls is finished, and its usage is read`, async () => {
    const turn = COMPLETE_TURN_SSE.replace(/\n/g, eol);
    const { tapped, calls, logCtx } = tapWithChunks([turn], { stallMs: 30, maxBytes: 0 });
    const text = await new Response(tapped).text();
    expect(text).toBe(turn);
    expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
    expect(logCtx.usage).toEqual(expect.objectContaining({ inputTokens: 12, outputTokens: 5 }));
  });
}

test("a CRLF delimiter split across chunks is one delimiter, not a frame boundary", async () => {
  const turn = COMPLETE_TURN_SSE.replace(/\n/g, "\r\n");
  // Cut every frame between its CR and LF so each chunk ends in a lone CR.
  const chunks = turn.split("\r\n").map((part, i, all) => (i < all.length - 1 ? `${part}\r` : part)).map((part, i) => (i === 0 ? part : `\n${part}`));
  expect(chunks.join("")).toBe(turn);
  const { tapped, calls, logCtx } = tapWithChunks(chunks, { stallMs: 30, maxBytes: 0 });
  await new Response(tapped).text();
  expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
  expect(logCtx.usage).toEqual(expect.objectContaining({ inputTokens: 12, outputTokens: 5 }));
});

test("a CRLF turn followed by bytes past the cap is finished, not a failure", async () => {
  const turn = COMPLETE_TURN_SSE.replace(/\n/g, "\r\n");
  const cap = new TextEncoder().encode(turn).byteLength + 16;
  const { tapped, calls } = tapWithChunks([turn, ": padding ".repeat(64)], { stallMs: 0, maxBytes: cap });
  const text = await new Response(tapped).text();
  expect(text).not.toContain("event: error");
  expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
});
