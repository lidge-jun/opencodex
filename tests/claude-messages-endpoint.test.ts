import { afterEach, beforeEach, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { logsFromApiBody } from "./helpers/logs-api";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { clearableDeadline } from "../src/lib/abort";
import {
  clearRequestLogsForTests,
  getRequestLogEntries,
  type RequestLogContext,
} from "../src/server/request-log";
import { startServer } from "../src/server";
import { ownedServiceHomeInspection } from "./helpers/owned-service-home-inspection";
import {
  estimateClaudeRequestTokens,
  fetchWithHeaderDeadline,
  handleClaudeMessages,
  readBoundedPassthroughBody,
  resolvePassthroughBodyGuard,
  tapAnthropicSseForLog,
} from "../src/server/claude-messages";
import { estimateTokens } from "../src/lib/token-estimate";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import {
  acquireNativeMainProfileDrain,
  getNativeMainProfileRequestCount,
  resetLifecycleDrainStateForTests,
  tryAdmitTurn,
} from "../src/server/lifecycle";
import {
  blockNativeMainRecovery,
  completeNativeMainRecovery,
  nativeMainStartupGateSnapshot,
  waitForNativeMainStartupGate,
} from "../src/codex/native-profile-startup";

let testDir = "";
let previousHome: string | undefined;
let previousDesktopConfigDir: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-endpoint-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-endpoint-"));
  process.env.OPENCODEX_HOME = testDir;
  previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(testDir, "claude-desktop");
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  globalThis.fetch = originalFetch;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function mockChatUpstream() {
  return mockChatUpstreamCapturing().server;
}

function mockChatUpstreamCapturing() {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* keep streaming */ }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " from mock" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

function mockConfig(baseUrl: string, claudeCode?: OcxConfig["claudeCode"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl, apiKey: "k", allowPrivateNetwork: true },
    },
    ...(claudeCode ? { claudeCode } : {}),
  } as OcxConfig;
}

test("POST /v1/messages?beta=true streams an Anthropic-shaped turn end to end", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages?beta=true", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "placeholder",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "mock/test-model",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await response.text();
    const names = [...text.matchAll(/^event: (.+)$/gm)].map(m => m[1]);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_delta");
    expect(names).toContain("content_block_stop");
    expect(names.at(-2)).toBe("message_delta");
    expect(names.at(-1)).toBe("message_stop");
    expect(text).toContain("\"text_delta\"");
    expect(text).toContain("Hello");
    expect(text).toContain("\"stop_reason\":\"end_turn\"");

    // Request log regression (live smoke round 2): the tap must see the PRE-translation
    // Responses stream — the translated Anthropic stream has no response.completed, which
    // used to record a bogus 502 with no usage.
    const logs = logsFromApiBody<{
      status: number; model: string; usage?: { inputTokens: number; outputTokens: number }; usageStatus: string;
    }>(await (await fetch(new URL("/api/logs", server.url))).json());
    const row = logs.find(l => l.model === "test-model" || l.model === "mock/test-model");
    expect(row).toBeDefined();
    expect(row!.status).toBe(200);
    expect(row!.usage?.inputTokens).toBe(12);
    expect(row!.usage?.outputTokens).toBe(3);

    const claudeUsage = await fetch(new URL("/api/usage?range=all&surface=claude", server.url)).then(res => res.json()) as {
      surface: string;
      summary: { requests: number; totalTokens: number };
      models: Array<{ model: string }>;
    };
    expect(claudeUsage.surface).toBe("claude");
    expect(claudeUsage.summary).toMatchObject({ requests: 1, totalTokens: 15 });
    expect(claudeUsage.models).toEqual([expect.objectContaining({ model: "test-model" })]);

    const codexUsage = await fetch(new URL("/api/usage?range=all&surface=codex", server.url)).then(res => res.json()) as {
      surface: string;
      summary: { requests: number };
    };
    expect(codexUsage.surface).toBe("codex");
    expect(codexUsage.summary.requests).toBe(0);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
}, { timeout: SERVER_BUDGET_MS });

test("non-streaming /v1/messages returns an Anthropic message JSON", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, any>;
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.model).toBe("mock/test-model");
    expect(json.stop_reason).toBe("end_turn");
    expect(json.content[0].type).toBe("text");
    expect(json.content[0].text).toContain("Hello");
    expect(typeof json.usage.input_tokens).toBe("number");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("Desktop OFF leaves Claude messages and health live", async () => {
  const upstream = mockChatUpstream();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const disabled = await fetch(new URL("/api/native-integrations/claude-desktop", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()) as { desiredEnabled: boolean }).toMatchObject({ desiredEnabled: false });

    const message = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "still live" }],
      }),
    });
    expect(message.status).toBe(200);
    expect((await message.json()) as { type: string }).toMatchObject({ type: "message" });
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("native generated-agent passthrough preserves legacy thinking", async () => {
  let captured: Record<string, unknown> | null = null;
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured = await req.json() as Record<string, unknown>;
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const config = mockConfig("http://127.0.0.1:1/v1", {
    anthropicBaseUrl: upstream.url.toString().replace(/\/$/, ""),
  });
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 16,
        system: [
          { type: "text", text: "<!-- ocx-route: claude-haiku-4-5 -->" },
          { type: "text", text: "<!-- ocx-effort: max -->" },
        ],
        thinking: { type: "enabled", budget_tokens: 31999 },
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toMatchObject({
      model: "claude-haiku-4-5",
      thinking: { type: "enabled", budget_tokens: 31999 },
    });
    expect(captured).not.toHaveProperty("output_config");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("native Anthropic passthrough clears the header deadline before streaming the body", async () => {
  const encoder = new TextEncoder();
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
          setTimeout(() => {
            controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
            controller.close();
          }, 600);
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const config = mockConfig("http://127.0.0.1:1/v1", {
    anthropicBaseUrl: upstream.url.toString().replace(/\/$/, ""),
  });
  config.connectTimeoutMs = 200;
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

// --- PR #136 follow-up hardening: deadline cleanup is guaranteed on EVERY fetch path ---

function spyDeadlineFactory() {
  const calls = { made: 0, clear: 0 };
  const factory: typeof clearableDeadline = (timeoutMs, parent) => {
    calls.made += 1;
    const real = clearableDeadline(timeoutMs, parent);
    return {
      ...real,
      clear: () => {
        calls.clear += 1;
        real.clear();
      },
    };
  };
  return { factory, calls };
}

test("fetchWithHeaderDeadline clears the deadline exactly once on the success path", async () => {
  const { factory, calls } = spyDeadlineFactory();
  const fetchImpl = (async () => new Response("ok")) as unknown as typeof fetch;
  const result = await fetchWithHeaderDeadline("http://127.0.0.1:1/x", {}, 60_000, undefined, factory, fetchImpl);
  expect(result.kind).toBe("response");
  expect(calls.made).toBe(1);
  expect(calls.clear).toBe(1);
});

test("fetchWithHeaderDeadline clears the deadline exactly once when fetch rejects (timer-leak regression)", async () => {
  const { factory, calls } = spyDeadlineFactory();
  const fetchImpl = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const result = await fetchWithHeaderDeadline("http://127.0.0.1:1/x", {}, 60_000, undefined, factory, fetchImpl);
  expect(result.kind).toBe("error");
  expect(calls.made).toBe(1);
  expect(calls.clear).toBe(1);
});

test("fetchWithHeaderDeadline classifies expiry as timeout and still clears exactly once", async () => {
  const { factory, calls } = spyDeadlineFactory();
  const fetchImpl = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch;
  const result = await fetchWithHeaderDeadline("http://127.0.0.1:1/x", {}, 10, undefined, factory, fetchImpl);
  expect(result.kind).toBe("timeout");
  expect(calls.made).toBe(1);
  expect(calls.clear).toBe(1);
});

test("native Anthropic passthrough returns 502 when the upstream connection is refused (reject-path activation)", async () => {
  const closed = Bun.serve({ port: 0, fetch: () => new Response() });
  const closedOrigin = closed.url.toString().replace(/\/$/, "");
  closed.stop(true);
  const config = mockConfig("http://127.0.0.1:1/v1", {
    anthropicBaseUrl: closedOrigin,
  });
  config.connectTimeoutMs = 60_000;
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(502);
    const json = await response.json() as Record<string, any>;
    expect(json.error?.type).toBe("api_error");
    expect(String(json.error?.message)).toContain("anthropic passthrough failed");
  } finally {
    await server.stop(true);
  }
});

// --- Body-occupancy guard (devlog 260716_passthrough_followups/010): idle + size, never total-wall-clock ---

const sseEncoder = new TextEncoder();

function spyFinalize() {
  const calls: Array<{ status: number; closeReason: string }> = [];
  return {
    calls,
    finalize: (status: number, meta: { closeReason: string }) => calls.push({ status, closeReason: meta.closeReason }),
  };
}

function freshLogCtx(): RequestLogContext {
  return { model: "claude-test", provider: "anthropic-native" };
}

const MESSAGE_START_FRAME = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n';

// #1170: the space after `data:` is optional in text/event-stream. This tap extracted usage with
// a hardcoded `data: ` prefix, so a compliant provider that omits the space produced a logged turn
// with no usage at all.
const UNSPACED_USAGE_FRAMES = [
  'event:message_start\ndata:{"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n',
  'event:message_delta\ndata:{"type":"message_delta","usage":{"output_tokens":7}}\n\n',
].join("");

test("A0: usage extraction accepts unspaced data fields (#1170)", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEncoder.encode(UNSPACED_USAGE_FRAMES));
      controller.close();
    },
  });
  const { calls, finalize } = spyFinalize();
  const ctx = freshLogCtx();
  const tap = tapAnthropicSseForLog(upstream, ctx, finalize, { stallMs: 5_000, maxBytes: 0 });
  const text = await new Response(tap).text();

  // The bytes pass through untouched either way; what the strict prefix broke was the inspection.
  expect(text).toContain("message_start");
  // "terminal" rather than "eof" is itself part of the fix: recognizing the unspaced
  // `message_delta` is what lets the tap classify the close as a real terminal frame.
  expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
  expect(ctx.usage).toEqual(expect.objectContaining({ inputTokens: 11, outputTokens: 7 }));
});

test("A1: stalled upstream body gets an Anthropic timeout_error tail and body_stall close reason", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEncoder.encode(MESSAGE_START_FRAME));
      // never closes, never enqueues again — a dead-but-open upstream
    },
  });
  const { calls, finalize } = spyFinalize();
  const tap = tapAnthropicSseForLog(upstream, freshLogCtx(), finalize, { stallMs: 30, maxBytes: 0 });
  const text = await new Response(tap).text();
  expect(text).toContain("message_start"); // prior bytes preserved
  expect(text).toContain("\n\nevent: error\ndata: ");
  expect(text).toContain('"type":"timeout_error"');
  expect(calls).toEqual([{ status: 200, closeReason: "body_stall" }]);
});

test("A2: unbounded upstream body gets an api_error tail and body_overflow close reason", async () => {
  const flood = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(sseEncoder.encode('data: {"type":"content_block_delta"}\n\n'));
    },
  });
  const { calls, finalize } = spyFinalize();
  const tap = tapAnthropicSseForLog(flood, freshLogCtx(), finalize, { stallMs: 0, maxBytes: 120 });
  const text = await new Response(tap).text();
  expect(text).toContain("\n\nevent: error\ndata: ");
  expect(text).toContain('"type":"api_error"');
  expect(text).toContain("exceeded 120 bytes");
  expect(calls).toEqual([{ status: 200, closeReason: "body_overflow" }]);
});

test("A3: client abort mid-body finalizes 499 client_cancel, not 200 terminal (misclassification regression)", async () => {
  let upstreamCancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEncoder.encode(MESSAGE_START_FRAME));
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const ac = new AbortController();
  const { calls, finalize } = spyFinalize();
  const tap = tapAnthropicSseForLog(upstream, freshLogCtx(), finalize, { stallMs: 5_000, maxBytes: 0, reqSignal: ac.signal });
  const reader = tap.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  ac.abort(new DOMException("client went away", "AbortError"));
  // drain to settlement: onClientAbort closes the tap
  while (!(await reader.read()).done) { /* drain */ }
  expect(calls).toEqual([{ status: 499, closeReason: "client_cancel" }]);
  expect(upstreamCancelled).toBe(true);
});

test("A4: slow-but-alive stream outlives many idle windows (anti-total-wall-clock invariant)", async () => {
  let sent = 0;
  const upstream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === 0) {
        controller.enqueue(sseEncoder.encode(MESSAGE_START_FRAME));
        sent += 1;
        return;
      }
      if (sent < 7) {
        await new Promise(resolve => setTimeout(resolve, 50)); // silence (50ms) << stallMs (200ms), total (300ms) >> stallMs
        controller.enqueue(sseEncoder.encode('data: {"type":"content_block_delta"}\n\n'));
        sent += 1;
        return;
      }
      controller.enqueue(sseEncoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      controller.close();
    },
  });
  const { calls, finalize } = spyFinalize();
  const tap = tapAnthropicSseForLog(upstream, freshLogCtx(), finalize, { stallMs: 200, maxBytes: 0 });
  const text = await new Response(tap).text();
  expect(text).toContain("message_stop");
  expect(text).not.toContain("event: error");
  expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
});

test("A5: non-stream bounded read classifies stall and overflow, passes clean bodies through", async () => {
  const stalling = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEncoder.encode('{"partial":'));
    },
  }));
  expect(await readBoundedPassthroughBody(stalling, { stallMs: 30, maxBytes: 0 })).toEqual({ kind: "stall" });

  const flooding = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(sseEncoder.encode("x".repeat(40)));
    },
  }));
  expect(await readBoundedPassthroughBody(flooding, { stallMs: 0, maxBytes: 100 })).toEqual({ kind: "overflow" });

  const clean = new Response('{"usage":{"input_tokens":1}}');
  expect(await readBoundedPassthroughBody(clean, { stallMs: 1_000, maxBytes: 1_000 }))
    .toEqual({ kind: "ok", text: '{"usage":{"input_tokens":1}}' });

  // Client abort mid-read classifies deterministically (audit round 4 blocker) —
  // including the pre-aborted-signal path.
  const ac = new AbortController();
  const hanging = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEncoder.encode('{"partial":'));
    },
  }));
  const pending = readBoundedPassthroughBody(hanging, { stallMs: 5_000, maxBytes: 0, reqSignal: ac.signal });
  setTimeout(() => ac.abort(new DOMException("client went away", "AbortError")), 20);
  expect(await pending).toEqual({ kind: "client_cancel" });

  const preAborted = new AbortController();
  preAborted.abort();
  const neverRead = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEncoder.encode("x"));
    },
  }));
  expect(await readBoundedPassthroughBody(neverRead, { stallMs: 5_000, maxBytes: 0, reqSignal: preAborted.signal }))
    .toEqual({ kind: "client_cancel" });
});

test("A6: body-guard config normalization — 0 disables, negatives fall back, sub-second clamps to 1s", () => {
  const guardFor = (claudeCode: OcxConfig["claudeCode"]) =>
    resolvePassthroughBodyGuard(mockConfig("http://127.0.0.1:1/v1", claudeCode));
  expect(guardFor({ bodyStallSec: 0, bodyMaxBytes: 0 })).toMatchObject({ stallMs: 0, maxBytes: 0 });
  expect(guardFor({ bodyStallSec: -5, bodyMaxBytes: -1 })).toMatchObject({ stallMs: 90_000, maxBytes: 64 * 1024 * 1024 });
  expect(guardFor({ bodyStallSec: 0.5, bodyMaxBytes: 1024.9 })).toMatchObject({ stallMs: 1_000, maxBytes: 1024 });
  expect(guardFor(undefined)).toMatchObject({ stallMs: 90_000, maxBytes: 64 * 1024 * 1024 });
  expect(guardFor({ bodyStallSec: Number.NaN, bodyMaxBytes: Number.POSITIVE_INFINITY }))
    .toMatchObject({ stallMs: 90_000, maxBytes: 64 * 1024 * 1024 });
});

test("synthetic error tail parses as a terminal error in the Anthropic dialect (adapter fixture proof)", async () => {
  const adapter = createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://example.test", apiKey: "key" });
  const response = new Response([
    MESSAGE_START_FRAME,
    '\n\nevent: error\ndata: {"type":"error","error":{"type":"timeout_error","message":"anthropic passthrough body stalled: no upstream bytes for 90s"}}\n\n',
  ].join(""));
  const events: Array<{ type: string }> = [];
  for await (const event of adapter.parseStream(response, createTestTranslatorBudget())) events.push(event);
  const errorIndex = events.findIndex(e => e.type === "error");
  expect(errorIndex).toBeGreaterThanOrEqual(0);
  expect(events.slice(errorIndex + 1).filter(e => e.type === "done")).toHaveLength(0);
});

test("endpoint wiring: configured bodyStallSec bounds a stalled native passthrough stream", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sseEncoder.encode(MESSAGE_START_FRAME));
          // stalls forever
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const config = mockConfig("http://127.0.0.1:1/v1", {
    anthropicBaseUrl: upstream.url.toString().replace(/\/$/, ""),
    bodyStallSec: 1,
  });
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).toContain("timeout_error");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("native openai-responses route carries prompt_cache_key + synthesized session_id header", async () => {
  const capture: { headers?: Record<string, string>; body?: Record<string, any> } = {};
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/responses")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      capture.headers = Object.fromEntries(req.headers);
      capture.body = await req.json() as Record<string, any>;
      const frames = [
        `event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_1", status: "in_progress" } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "Hello" })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } })}\n\n`,
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.origin === "https://chatgpt.com") {
      if (url.pathname !== "/backend-api/codex/responses") {
        throw new Error(`unexpected canonical Codex path ${url.pathname}`);
      }
      return originalFetch(new URL("/responses", upstream.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig({
    port: 0,
    defaultProvider: "native",
    providers: {
      native: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "native/gpt-test",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "user_abc123_account__session_11111111-2222-3333-4444-555555555555" },
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "high" },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    // Native ChatGPT route: sampling params + user are stripped, but the cache-affinity
    // pair survives — prompt_cache_key in the body and a synthesized session_id header
    // (devlog 090: without the header the backend reported cached_tokens: 0 every turn).
    expect(capture.body?.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
    expect(capture.body?.user).toBeUndefined();
    expect(capture.body?.max_output_tokens).toBeUndefined();
    expect(capture.body?.reasoning?.effort).toBe("high");
    expect(capture.headers?.["session_id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    globalThis.fetch = originalFetch;
    await server.stop(true);
    upstream.stop(true);
  }
});

test("native openai-responses Claude route logs cyber terminals as 400 cyber_policy", async () => {
  clearRequestLogsForTests();
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return new Response([
        "event: response.failed",
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            status: "failed",
            error: { type: "invalid_request_error", code: "cyber_policy", message: "blocked" },
          },
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "native",
    providers: {
      native: {
        adapter: "openai-responses",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        authMode: "forward",
        allowPrivateNetwork: true,
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "native/gpt-test",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("blocked");
    const entry = getRequestLogEntries().findLast(e => e.surface === "claude");
    expect(entry).toMatchObject({
      status: 400,
      errorCode: "cyber_policy",
      terminalStatus: "failed",
      closeReason: "terminal",
      upstreamError: "blocked",
    });
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    clearRequestLogsForTests();
  }
});

test("custom forward openai-responses route never receives the main ChatGPT credential", async () => {
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "main-secret-must-not-leave", account_id: "main-account-must-not-leave" },
  }));
  const captured: Array<{ authorization: string | null; accountId: string | null }> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      captured.push({
        authorization: req.headers.get("authorization"),
        accountId: req.headers.get("chatgpt-account-id"),
      });
      return new Response([
        'event: response.created\ndata: {"response":{"id":"resp_1","status":"in_progress"}}\n\n',
        'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n',
        'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "custom",
    providers: {
      custom: {
        adapter: "openai-chat",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        authMode: "forward",
        allowPrivateNetwork: true,
        modelAdapters: { "gpt-test": "openai-responses" },
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer claude-placeholder" },
      body: JSON.stringify({
        model: "custom/gpt-test",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const responseBody = await response.text();
    expect({ status: response.status, body: responseBody }).toMatchObject({ status: 200 });
    expect(captured).toEqual([{ authorization: null, accountId: null }]);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("shadow-call rerouting cannot carry the main ChatGPT credential to a custom forward route", async () => {
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "main-secret-must-not-leave", account_id: "main-account-must-not-leave" },
  }));
  const captured: Array<{ authorization: string | null; accountId: string | null }> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      captured.push({
        authorization: req.headers.get("authorization"),
        accountId: req.headers.get("chatgpt-account-id"),
      });
      return new Response([
        'event: response.created\ndata: {"response":{"id":"resp_1","status":"in_progress"}}\n\n',
        'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n',
        'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
      custom: {
        adapter: "openai-chat",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        authMode: "forward",
        allowPrivateNetwork: true,
        modelAdapters: { "gpt-test": "openai-responses" },
      },
    },
    shadowCallIntercept: {
      enabled: true,
      model: "custom/gpt-test",
      sourceModels: ["gpt-5.6-luna"],
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer claude-placeholder" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const responseBody = await response.text();
    expect({ status: response.status, body: responseBody }).toMatchObject({ status: 200 });
    expect(captured).toEqual([{ authorization: null, accountId: null }]);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

/**
 * This case sandboxes CODEX_HOME, so the service installed on the developer's
 * machine is not evidence about it. See tests/helpers/owned-service-home.ts.
 */
const inspectNativeCodexOwnership = ownedServiceHomeInspection("claude replay main-enrichment test");

test("Claude replay owns optional main enrichment while routed work survives drain and recovery", async () => {
  resetLifecycleDrainStateForTests();
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "claude-main-access", account_id: "claude-main-account" },
  }));
  let upstreamCalls = 0;
  let finishUpstream: (() => void) | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const encoder = new TextEncoder();
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      upstreamCalls += 1;
      if (upstreamCalls > 1) {
        return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"held"}}]}\n\n'));
          finishUpstream = () => {
            finishUpstream = undefined;
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          };
          markStarted();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  let server = startServer(0, { inspectNativeCodexOwnership });
  await waitForNativeMainStartupGate();
  let drain: ReturnType<typeof acquireNativeMainProfileDrain> = null;
  let recoveryHomeId: string | null = null;
  try {
    await waitForNativeMainStartupGate();
    const pending = postMessages(server.url.toString(), {
      model: "mock/test-model",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hold" }],
    });
    await started;
    const response = await pending;
    expect(response.status).toBe(200);
    expect(getNativeMainProfileRequestCount()).toBe(1);
    drain = acquireNativeMainProfileDrain("claude-overlap");
    expect(drain).not.toBeNull();
    const routedDuringDrain = await postMessages(server.url.toString(), {
      model: "mock/test-model",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "routed during drain" }],
    });
    expect(routedDuringDrain.status).toBe(200);
    await routedDuringDrain.text();
    expect(upstreamCalls).toBe(2);

    finishUpstream?.();
    await response.text();
    expect(getNativeMainProfileRequestCount()).toBe(0);
    drain?.release();
    drain = null;

    recoveryHomeId = nativeMainStartupGateSnapshot().homeId ?? "claude-recovery-home";
    expect(blockNativeMainRecovery(recoveryHomeId, "manual")).toBe(true);
    const routedDuringRecovery = await postMessages(server.url.toString(), {
      model: "mock/test-model",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "routed during recovery" }],
    });
    expect(routedDuringRecovery.status).toBe(200);
    expect(upstreamCalls).toBe(3);

    completeNativeMainRecovery(recoveryHomeId);
    recoveryHomeId = null;
    await server.stop(true);
    saveConfig({
      port: 0,
      openaiProviderTierVersion: 2,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      codexAccounts: [],
      activeCodexAccountId: "__main__",
      autoSwitchThreshold: 0,
    } as OcxConfig);
    server = startServer(0, { inspectNativeCodexOwnership });
    await waitForNativeMainStartupGate();
    recoveryHomeId = nativeMainStartupGateSnapshot().homeId ?? "claude-main-recovery-home";
    expect(blockNativeMainRecovery(recoveryHomeId, "manual")).toBe(true);
    const mainBlocked = await postMessages(server.url.toString(), {
      model: "openai/gpt-test",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "main blocked" }],
    });
    expect(mainBlocked.status).toBe(503);
    expect(upstreamCalls).toBe(3);
  } finally {
    if (recoveryHomeId) completeNativeMainRecovery(recoveryHomeId);
    drain?.release();
    finishUpstream?.();
    await server.stop(true);
    upstream.stop(true);
    resetLifecycleDrainStateForTests();
  }
});

test("routed Claude requests give OpenAI sidecars main auth without leaking it to the routed provider", async () => {
  const mainAccessToken = "main-chatgpt-access";
  const mainAccountId = "main-chatgpt-account";
  const imageBytes = "aGVsbG8taW1hZ2UtYnl0ZXM=";
  const visionCaption = "A red OPENCODEX logo on a white background.";
  const sidecarCalls: Array<{ headers: Headers; body: Record<string, any>; kind: "vision" | "web-search" }> = [];
  const routedCalls: Array<{ authorization: string | null; body: Record<string, any> }> = [];

  const forward = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as Record<string, any>;
      const kind = Array.isArray(body.tools) && body.tools.some((tool: Record<string, unknown>) => tool.type === "web_search")
        ? "web-search"
        : "vision";
      sidecarCalls.push({ headers: new Headers(req.headers), body, kind });
      const text = kind === "vision" ? visionCaption : "OpenCodex search results are available.";
      return new Response([
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const routed = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as Record<string, any>;
      routedCalls.push({ authorization: req.headers.get("authorization"), body });
      const choosesWebSearch = routedCalls.length === 1
        && Array.isArray(body.tools)
        && body.tools.some((tool: Record<string, any>) => tool.function?.name === "web_search");
      const frames = choosesWebSearch
        ? [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_search", function: { name: "web_search", arguments: '{"query":"latest opencodex"}' } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]
        : [
            { choices: [{ index: 0, delta: { content: "Routed answer" } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ];
      return new Response(
        frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  const config = {
    port: 0,
    defaultProvider: "routed",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        codexAccountMode: "pool",
      },
      routed: {
        adapter: "openai-chat",
        baseUrl: `${routed.url.toString().replace(/\/$/, "")}/v1`,
        apiKey: "routed-provider-key",
        allowPrivateNetwork: true,
        noVisionModels: ["text-model"],
      },
    },
    webSearchSidecar: { backend: "openai" },
    visionSidecar: { backend: "openai" },
  } as OcxConfig;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const prefix = "/backend-api/codex";
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
      return originalFetch(new URL(`${url.pathname.slice(prefix.length)}${url.search}`, forward.url), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  saveConfig(config);
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: mainAccessToken, account_id: mainAccountId },
  }));
  let requestSequence = 0;
  const requestBody = {
    model: "routed/text-model",
    max_tokens: 128,
    stream: false,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Search for OpenCodex and inspect this logo." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageBytes } },
      ],
    }],
  };
  const invokeMessages = async (): Promise<number> => {
    const turnAdmissionLease = tryAdmitTurn();
    if (!turnAdmissionLease) throw new Error("test turn admission unavailable");
    const start = Date.now();
    try {
      const response = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "placeholder",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(requestBody),
        }),
        config,
        { model: "unknown", provider: "unknown", inboundProtocol: "messages" } as RequestLogContext,
        { requestId: `claude-sidecar-test-${++requestSequence}`, start, turnAdmissionLease },
      );
      await response.text();
      return response.status;
    } finally {
      turnAdmissionLease.release();
    }
  };
  try {
    expect(await invokeMessages()).toBe(200);

    expect(sidecarCalls.map(call => call.kind).sort()).toEqual(["vision", "web-search"]);
    for (const call of sidecarCalls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${mainAccessToken}`);
      expect(call.headers.get("chatgpt-account-id")).toBe(mainAccountId);
    }
    expect(sidecarCalls.find(call => call.kind === "vision")?.body.input).toEqual(expect.any(Array));
    expect(sidecarCalls.find(call => call.kind === "web-search")?.body.tools?.[0]?.type).toBe("web_search");
    expect(routedCalls.length).toBe(2);
    expect(routedCalls.every(call => call.authorization === "Bearer routed-provider-key")).toBe(true);
    const authenticatedRoutedBodies = JSON.stringify(routedCalls.map(call => call.body));
    expect(authenticatedRoutedBodies).toContain(visionCaption);
    expect(authenticatedRoutedBodies).not.toContain("[image omitted:");
    expect(authenticatedRoutedBodies).not.toContain(imageBytes);

    rmSync(join(isolatedCodexHome!.path, "auth.json"));
    const sidecarCountBeforeNoLogin = sidecarCalls.length;
    expect(await invokeMessages()).toBe(200);

    expect(sidecarCalls.length).toBe(sidecarCountBeforeNoLogin);
    expect(routedCalls.at(-1)?.authorization).toBe("Bearer routed-provider-key");
    const noLoginBody = JSON.stringify(routedCalls.at(-1)?.body);
    expect(noLoginBody).toContain("[image omitted: this model is text-only and the vision sidecar is unavailable (no ChatGPT login)]");
    expect(noLoginBody).not.toContain(imageBytes);
  } finally {
    await forward.stop(true);
    await routed.stop(true);
  }
});

test("bad body -> Anthropic-shaped 400; unknown /v1 path guard intact", async () => {
  saveConfig(mockConfig("http://127.0.0.1:1/v1"));
  const server = startServer(0);
  try {
    const bad = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_tokens: 5, messages: [{ role: "user", content: "x" }] }),
    });
    expect(bad.status).toBe(400);
    const badJson = await bad.json() as Record<string, any>;
    expect(badJson).toEqual({ type: "error", error: { type: "invalid_request_error", message: "model is required" } });

    const unknown = await fetch(new URL("/v1/does-not-exist", server.url), { method: "POST" });
    expect(unknown.status).toBe(404);
  } finally {
    await server.stop(true);
  }
});

test("count_tokens returns a positive estimate in the exact contract shape", async () => {
  saveConfig(mockConfig("http://127.0.0.1:1/v1"));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        system: "be brief",
        messages: [{ role: "user", content: "count me please, this is a sentence" }],
        tools: [{ name: "Read", input_schema: { type: "object" } }],
      }),
    });
    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["input_tokens"]);
    expect(json.input_tokens as number).toBeGreaterThan(0);
  } finally {
    await server.stop(true);
  }
});

/** Minimal PNG header (signature + IHDR) so the attachment sniffer can read real dimensions. */
function countTokensPngBase64(width: number, height: number): string {
  const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), 0x49, 0x48, 0x44, 0x52, // len + "IHDR"
    ...u32be(width), ...u32be(height),
    8, 6, 0, 0, 0, // bit depth, color type, etc.
  ];
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

test("count_tokens prices base64 attachments as attachments, not characters", async () => {
  saveConfig(mockConfig("http://127.0.0.1:1/v1"));
  const server = startServer(0);
  try {
    const data = "A".repeat(700_000); // ~512KB decoded; counting chars would report ~200k tokens
    const response = await fetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "what is in this screenshot?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
          ],
        }],
      }),
    });
    expect(response.status).toBe(200);
    const json = await response.json() as { input_tokens: number };
    // ceil(700000 * 3/4 / 512) = 1026 attachment tokens plus a small text remainder.
    expect(json.input_tokens).toBeGreaterThanOrEqual(1026);
    expect(json.input_tokens).toBeLessThan(2000);
  } finally {
    await server.stop(true);
  }
});

test("estimateClaudeRequestTokens matches the plain char estimate for text-only bodies", () => {
  const raw = {
    system: "be brief",
    messages: [{ role: "user", content: "count me please, this is a sentence" }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
  };
  const parts = [raw.system, JSON.stringify(raw.messages), JSON.stringify(raw.tools)];
  expect(estimateClaudeRequestTokens(raw, "m")).toBe(Math.max(1, estimateTokens(parts.join("\n"), "m")));
});

test("estimateClaudeRequestTokens prices sniffable images by pixel dimensions", () => {
  const raw = {
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: countTokensPngBase64(1500, 2000) } }],
    }],
  };
  const estimate = estimateClaudeRequestTokens(raw, "m");
  // ceil(1500 * 2000 / 750) = 4000 attachment tokens plus the JSON skeleton.
  expect(estimate).toBeGreaterThanOrEqual(4000);
  expect(estimate).toBeLessThan(4100);
});

test("estimateClaudeRequestTokens strips base64 documents nested in tool_result content", () => {
  const raw = {
    messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "Q".repeat(400_000) } }],
      }],
    }],
  };
  const estimate = estimateClaudeRequestTokens(raw, "m");
  // ceil(400000 * 3/4 / 512) = 586 tokens, nowhere near the ~114k a char count would report.
  expect(estimate).toBeGreaterThanOrEqual(586);
  expect(estimate).toBeLessThan(1000);
});

test("estimateClaudeRequestTokens does not charge base64 padding as payload bytes", () => {
  // Exactly 131072 decoded bytes: 174764 base64 chars ending in "=". Counting the padding
  // would yield 131073 bytes and charge 257 tokens instead of 256.
  const data = Buffer.from(new Uint8Array(131_072)).toString("base64");
  const raw = {
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }],
  };
  const stripped = {
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }] }],
  };

  expect(estimateClaudeRequestTokens(raw, "m")).toBe(
    Math.max(1, estimateTokens(JSON.stringify(stripped.messages), "m") + 256),
  );
});

test("estimateClaudeRequestTokens keeps base64-shaped tool_use input counted as text", () => {
  // tool_use.input is serialized into function_call arguments and sent upstream, so a
  // {type:"base64", data} shape inside it is NOT an attachment and must count as text.
  const raw = {
    messages: [{
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "upload", input: { type: "base64", data: "B".repeat(40_000) } }],
    }],
  };

  expect(estimateClaudeRequestTokens(raw, "m")).toBe(
    Math.max(1, estimateTokens(JSON.stringify(raw.messages), "m")),
  );
});

test("estimateClaudeRequestTokens leaves complete attachment-shaped tool_use input intact", () => {
  // Even a full {type:"image", source:{type:"base64", data}} object inside tool_use.input
  // is a tool argument, not an attachment: the translator replays it verbatim inside
  // function_call arguments, so it must count at its serialized size.
  const raw = {
    messages: [{
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "t1",
        name: "upload_image",
        input: { type: "image", source: { type: "base64", media_type: "image/png", data: "C".repeat(50_000) } },
      }],
    }],
  };

  expect(estimateClaudeRequestTokens(raw, "m")).toBe(
    Math.max(1, estimateTokens(JSON.stringify(raw.messages), "m")),
  );
});

test("estimateClaudeRequestTokens leaves attachment-shaped tool schemas intact", () => {
  // Tool definitions are forwarded to routed providers; an attachment-shaped example in a
  // schema is not an attachment either.
  const raw = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      name: "upload",
      input_schema: { type: "object" },
      example: { type: "image", source: { type: "base64", media_type: "image/png", data: "D".repeat(30_000) } },
    }],
  };
  const parts = [JSON.stringify(raw.messages), JSON.stringify(raw.tools)];

  expect(estimateClaudeRequestTokens(raw, "m")).toBe(
    Math.max(1, estimateTokens(parts.join("\n"), "m")),
  );
});

test("estimateClaudeRequestTokens counts text-source documents as ordinary text", () => {
  const text = "plain text document body ".repeat(40);
  const raw = {
    messages: [{
      role: "user",
      content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: text } }],
    }],
  };
  expect(estimateClaudeRequestTokens(raw, "m")).toBe(Math.max(1, estimateTokens(JSON.stringify(raw.messages), "m")));
});

test("claudeCode.enabled=false -> 403 permission_error on both routes", async () => {
  saveConfig(mockConfig("http://127.0.0.1:1/v1", { enabled: false }));
  const server = startServer(0);
  try {
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const response = await fetch(new URL(path, server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] }),
      });
      expect(response.status).toBe(403);
      const json = await response.json() as Record<string, any>;
      expect(json.error.type).toBe("permission_error");
    }
  } finally {
    await server.stop(true);
  }
});

async function postMessages(serverUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL("/v1/messages", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "placeholder", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
}

test("effort safety valve: routes with a definitive no-effort ladder get reasoning stripped (devlog 136 B6)", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  const base = `${upstream.url.toString().replace(/\/$/, "")}/v1`;
  const config = mockConfig(base);
  (config.providers.mock as Record<string, unknown>).noReasoningModels = ["test-model"];
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await postMessages(server.url.toString(), {
      model: "mock/test-model",
      max_tokens: 64,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured.length).toBe(1);
    expect(captured[0]!.reasoning_effort).toBeUndefined();
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("generated agent effort directive restores exact xhigh and max after Claude Code collapses them to a thinking budget", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    for (const effort of ["xhigh", "max"]) {
      const response = await postMessages(server.url.toString(), {
        model: "claude-haiku-4-5",
        max_tokens: 32000,
        stream: true,
        system: [
          { type: "text", text: "<!-- ocx-route: claude-ocx-mock--test-model -->" },
          { type: "text", text: `<!-- ocx-effort: ${effort} -->` },
        ],
        thinking: { type: "enabled", budget_tokens: 31999 },
        messages: [{ role: "user", content: "hi" }],
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(captured.map(body => ({ model: body.model, effort: body.reasoning_effort }))).toEqual([
      { model: "test-model", effort: "xhigh" },
      { model: "test-model", effort: "max" },
    ]);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("generated agent effort directive preserves routed Anthropic structured output", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push(await req.json() as Record<string, unknown>);
      return new Response([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"answer\\":\\"ok\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "mock-anthropic",
    providers: {
      "mock-anthropic": {
        adapter: "anthropic",
        baseUrl: upstream.url.toString().replace(/\/$/, ""),
        apiKey: "test-key",
        allowPrivateNetwork: true,
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  try {
    const response = await postMessages(server.url.toString(), {
      model: "claude-haiku-4-5",
      max_tokens: 32000,
      stream: true,
      system: [
        { type: "text", text: "<!-- ocx-route: claude-ocx-mock-anthropic--claude-sonnet-5 -->" },
        { type: "text", text: "<!-- ocx-effort: max -->" },
      ],
      thinking: { type: "enabled", budget_tokens: 31999 },
      output_config: {
        format: { type: "json_schema", schema },
      },
      messages: [{ role: "user", content: "Return JSON" }],
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.output_config).toEqual({
      effort: "max",
      format: { type: "json_schema", schema },
    });
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("unknown-ladder routes keep the requested effort (no false stripping)", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await postMessages(server.url.toString(), {
      model: "mock/test-model",
      max_tokens: 64,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured.length).toBe(1);
    expect(captured[0]!.reasoning_effort).toBe("low");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("defensive [1m] strip: a leaked context-variant marker still routes to the bare model (devlog 138)", async () => {
  const { server: upstream, captured } = mockChatUpstreamCapturing();
  saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const response = await postMessages(server.url.toString(), {
      model: "mock/test-model[1m]",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured.length).toBe(1);
    expect(captured[0]!.model).toBe("test-model");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("count_tokens is CJK-aware: Korean body counts more tokens than equal-length English (devlog 260712 B3)", async () => {
  saveConfig(mockConfig("http://127.0.0.1:1/v1"));
  const server = startServer(0);
  try {
    const count = async (content: string) => {
      const res = await fetch(new URL("/v1/messages/count_tokens", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "placeholder" },
        body: JSON.stringify({ model: "mock/test-model", messages: [{ role: "user", content }] }),
      });
      return (await res.json() as { input_tokens: number }).input_tokens;
    };
    const korean = "가나다라마바사아자차카타파하".repeat(40);
    const english = "abcdefghijklmn".repeat(40); // same char length
    expect(korean.length).toBe(english.length);
    expect(await count(korean)).toBeGreaterThan(await count(english));
  } finally {
    await server.stop(true);
  }
});
