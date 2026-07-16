import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

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
  if (testDir) rmSync(testDir, { recursive: true, force: true });
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
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
    },
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
    const logs = await (await fetch(new URL("/api/logs", server.url))).json() as any[];
    const row = logs.find(l => l.provider === "anthropic-native");
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
    server.stop(true);
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
    server.stop(true);
    upstream.stop(true);
  }
});

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
      body: JSON.stringify({ model: "claude-ocx-mock--test-model", max_tokens: 10, messages: [{ role: "user", content: "x" }] }),
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
    server.stop(true);
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
    server.stop(true);
    upstream.stop(true);
  }
});

// --- Generous image pipeline on the native branch (devlog 260714 .../040, P1-P5) ---

import { resetNormalizeStateForTests } from "../src/adapters/anthropic-image-normalize";
import { sniffImageDimensions } from "../src/adapters/anthropic-image-guard";

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
    server.stop(true);
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
    server.stop(true);
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
    server.stop(true);
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
    server.stop(true);
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
    server.stop(true);
    upstream.stop(true);
  }
});
