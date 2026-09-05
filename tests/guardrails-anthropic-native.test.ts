import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { handleClaudeMessages } from "../src/server/claude-messages";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import {
  installIsolatedCodexHome,
  type IsolatedCodexHome,
} from "./helpers/isolated-codex-home";

setDefaultTimeout(15_000);

const SECRET = "sk_live_abcdefghijklmnopqrstuvwx";
const PLACEHOLDER = "<STRIPE_ACCESS_TOKEN_1>";
const BASE64_DOCUMENT = "UERGIGJ5dGVz";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-guardrails-anthropic-native-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-guardrails-anthropic-native-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(anthropicBaseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-key",
        allowPrivateNetwork: true,
        models: ["test-model"],
      },
    },
    claudeCode: { anthropicBaseUrl },
    guardrails: {
      enabled: true,
      mode: "enforce",
      failurePolicy: "block",
    },
  } as OcxConfig;
}

function documentBody(): Record<string, unknown> {
  return {
    model: "claude-fable-5",
    max_tokens: 64,
    stream: false,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          title: SECRET,
          source: { type: "text", media_type: "text/plain", data: SECRET },
        },
        {
          type: "document",
          title: "opaque.pdf",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: BASE64_DOCUMENT,
          },
        },
      ],
    }],
  };
}

function withoutVolatileMessageFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVolatileMessageFields);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "id" || key === "created") continue;
    output[key] = withoutVolatileMessageFields(child);
  }
  return output;
}

function canonicalMessagesResponse(body: string, contentType: string | null): string {
  if (!contentType?.includes("text/event-stream")) {
    return JSON.stringify(withoutVolatileMessageFields(JSON.parse(body)));
  }
  return body.split("\n").map(line => {
    if (!line.startsWith("data: ")) return line;
    return `data: ${JSON.stringify(withoutVolatileMessageFields(
      JSON.parse(line.slice(6)),
    ))}`;
  }).join("\n");
}

test("active Guardrails marks the Anthropic request-log context as privacy-sensitive", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        id: "msg-guardrails-log-context",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "accepted" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const logCtx: RequestLogContext = { model: "", provider: "" };

  try {
    const response = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(documentBody()),
      }),
      config(upstream.url.toString().replace(/\/$/, "")),
      logCtx,
    );
    await response.text();

    expect(logCtx.sensitiveDataProtectionActive).toBe(true);
  } finally {
    upstream.stop(true);
  }
});

test("disabled Guardrails matches baseline across native and routed Messages paths", async () => {
  const captured: Array<{ body: string; path: string }> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.text();
      captured.push({ body, path });
      const parsed = JSON.parse(body) as { stream?: boolean };
      if (path.endsWith("/count_tokens")) {
        return Response.json({ input_tokens: 42 });
      }
      if (path.endsWith("/chat/completions")) {
        return new Response([
          `data: ${JSON.stringify({
            choices: [{
              index: 0,
              delta: { role: "assistant", content: "baseline" },
            }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (parsed.stream === true) {
        return new Response([
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "msg-disabled-native",
              type: "message",
              role: "assistant",
              model: "claude-fable-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "baseline" },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ].join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "msg-disabled-native",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "baseline" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const rootUrl = upstream.url.toString().replace(/\/$/, "");
  const routedConfig = (): OcxConfig => ({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: `${rootUrl}/v1`,
        apiKey: "test-key",
        allowPrivateNetwork: true,
        models: ["test-model"],
      },
    },
  }) as OcxConfig;
  const exercise = async (
    candidate: OcxConfig,
    body: Record<string, unknown>,
    native: boolean,
    path = "/v1/messages",
  ): Promise<{ body: string; contentType: string | null; status: number }> => {
    saveConfig(candidate);
    const proxy = startServer(0);
    try {
      const response = await fetch(new URL(path, proxy.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(native
            ? { authorization: "Bearer sk-ant-oat01-test" }
            : { "x-api-key": "placeholder" }),
        },
        body: JSON.stringify(body),
      });
      return {
        body: await response.text(),
        contentType: response.headers.get("content-type"),
        status: response.status,
      };
    } finally {
      await proxy.stop(true);
    }
  };

  try {
    const nativeCases = [
      { body: { ...documentBody(), stream: false }, path: "/v1/messages" },
      { body: { ...documentBody(), stream: true }, path: "/v1/messages" },
      { body: documentBody(), path: "/v1/messages/count_tokens" },
    ];
    for (const item of nativeCases) {
      const baselineConfig = config(rootUrl);
      delete baselineConfig.guardrails;
      const baseline = await exercise(
        baselineConfig,
        item.body,
        true,
        item.path,
      );
      const disabledConfig = config(rootUrl);
      disabledConfig.guardrails = { enabled: false };
      const disabled = await exercise(
        disabledConfig,
        item.body,
        true,
        item.path,
      );
      const upstreamRequests = captured.splice(0, 2);

      expect(disabled.status, item.path).toBe(baseline.status);
      expect(disabled.contentType, item.path).toBe(baseline.contentType);
      expect(
        canonicalMessagesResponse(disabled.body, disabled.contentType),
        item.path,
      ).toBe(canonicalMessagesResponse(baseline.body, baseline.contentType));
      expect(upstreamRequests[1], item.path).toEqual(upstreamRequests[0]);
    }

    for (const stream of [false, true]) {
      const body = {
        ...documentBody(),
        model: "mock/test-model",
        stream,
      };
      const baselineConfig = routedConfig();
      const baseline = await exercise(baselineConfig, body, false);
      const disabledConfig = routedConfig();
      disabledConfig.guardrails = { enabled: false };
      const disabled = await exercise(disabledConfig, body, false);
      const upstreamRequests = captured.splice(0, 2);

      expect(disabled.status, `routed stream=${stream}`).toBe(baseline.status);
      expect(disabled.contentType, `routed stream=${stream}`)
        .toBe(baseline.contentType);
      expect(
        canonicalMessagesResponse(disabled.body, disabled.contentType),
        `routed stream=${stream}`,
      ).toBe(canonicalMessagesResponse(baseline.body, baseline.contentType));
      expect(upstreamRequests[1], `routed stream=${stream}`)
        .toEqual(upstreamRequests[0]);
    }
  } finally {
    upstream.stop(true);
  }
});

test("Guardrails detect mode leaves native Messages and count_tokens wire bodies unchanged", async () => {
  const captured: Array<{ path: string; body: string }> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      captured.push({ path, body: await request.text() });
      if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 42 });
      return Response.json({
        id: "msg-guardrails-detect",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: `unchanged ${SECRET}` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const detectConfig = config(upstream.url.toString().replace(/\/$/, ""));
  detectConfig.guardrails = { enabled: true, mode: "detect", failurePolicy: "block" };
  saveConfig(detectConfig);
  const proxy = startServer(0);
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    authorization: "Bearer sk-ant-oat01-test",
  };

  try {
    const messages = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: JSON.stringify(documentBody()),
    });
    expect(messages.status).toBe(200);
    expect(await messages.text()).toContain(`unchanged ${SECRET}`);

    const countTokens = await fetch(new URL("/v1/messages/count_tokens", proxy.url), {
      method: "POST",
      headers,
      body: JSON.stringify(documentBody()),
    });
    expect(countTokens.status).toBe(200);
    expect(await countTokens.json()).toEqual({ input_tokens: 42 });

    expect(captured.map(entry => entry.path)).toEqual([
      "/v1/messages",
      "/v1/messages/count_tokens",
    ]);
    for (const entry of captured) {
      expect(entry.body).toContain(SECRET);
      expect(entry.body).not.toContain(PLACEHOLDER);
    }
  } finally {
    await proxy.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails protects Anthropic text documents in messages and count_tokens", async () => {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      captured.push({ path, body: await request.json() as Record<string, unknown> });
      if (path.endsWith("/count_tokens")) {
        return Response.json({ input_tokens: 42 });
      }
      return Response.json({
        id: "msg-guardrails-native",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: `echo ${PLACEHOLDER}` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  saveConfig(config(upstream.url.toString().replace(/\/$/, "")));
  const proxy = startServer(0);
  try {
    const messages = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: "Bearer sk-ant-oat01-test",
      },
      body: JSON.stringify(documentBody()),
    });
    expect(messages.status).toBe(200);
    expect(await messages.text()).toContain(`echo ${SECRET}`);

    const countTokens = await fetch(new URL("/v1/messages/count_tokens", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "sk-ant-api03-test",
      },
      body: JSON.stringify(documentBody()),
    });
    expect(countTokens.status).toBe(200);
    expect(await countTokens.json()).toEqual({ input_tokens: 42 });

    expect(captured.map(entry => entry.path)).toEqual([
      "/v1/messages",
      "/v1/messages/count_tokens",
    ]);
    for (const entry of captured) {
      const serialized = JSON.stringify(entry.body);
      expect(serialized).toContain(PLACEHOLDER);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).toContain(BASE64_DOCUMENT);
    }
  } finally {
    await proxy.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails masks native Anthropic SSE input and demasks split assistant text", async () => {
  let captured: Record<string, unknown> | undefined;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captured = await request.json() as Record<string, unknown>;
      return new Response([
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg-guardrails-native-sse",
            type: "message",
            role: "assistant",
            model: "claude-fable-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "echo <STRIPE_ACCESS" },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "_TOKEN_1>" },
        })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0,
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  saveConfig(config(upstream.url.toString().replace(/\/$/, "")));
  const proxy = startServer(0);
  try {
    const body = documentBody();
    body.stream = true;
    const response = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: "Bearer sk-ant-oat01-test",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const assistantText = [...text.matchAll(/^data: (\{.*\})$/gm)]
      .map(match => JSON.parse(match[1]!) as {
        type?: string;
        delta?: { type?: string; text?: unknown };
      })
      .filter(payload => payload.type === "content_block_delta"
        && payload.delta?.type === "text_delta")
      .map(payload => typeof payload.delta?.text === "string" ? payload.delta.text : "")
      .join("");

    expect(response.status).toBe(200);
    expect(assistantText).toBe(`echo ${SECRET}`);
    expect(text).not.toContain(PLACEHOLDER);
    expect(JSON.stringify(captured)).toContain(PLACEHOLDER);
    expect(JSON.stringify(captured)).not.toContain(SECRET);
  } finally {
    await proxy.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails routed translation ignores discarded Anthropic document sources", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captured.push(await request.json() as Record<string, unknown>);
      return new Response([
        `data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "ok" },
          }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        apiKey: "test-key",
        allowPrivateNetwork: true,
        models: ["test-model"],
      },
    },
    guardrails: {
      enabled: true,
      mode: "enforce",
      failurePolicy: "block",
    },
  } as OcxConfig);
  const proxy = startServer(0);
  try {
    const routedBody = documentBody();
    routedBody.model = "mock/test-model";
    routedBody.stream = true;
    const message = (routedBody.messages as Array<{
      content: Array<{
        title?: string;
        source?: { type?: string; data?: string };
      }>;
    }>)[0]!;
    message.content[0]!.title = "public attachment";
    message.content[0]!.source = {
      type: "text",
      data: "x".repeat(2 * 1024 * 1024 + 1),
    };
    const response = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "placeholder",
      },
      body: JSON.stringify(routedBody),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
    expect(captured).toHaveLength(1);
    const serialized = JSON.stringify(captured[0]);
    expect(serialized).toContain("[document: public attachment]");
    expect(serialized).not.toContain(PLACEHOLDER);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(BASE64_DOCUMENT);
  } finally {
    await proxy.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails masks routed Messages input and demasks collected JSON output", async () => {
  let captured: Record<string, unknown> | undefined;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captured = await request.json() as Record<string, unknown>;
      return new Response([
        `data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: `echo ${PLACEHOLDER}`,
            },
          }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        apiKey: "test-key",
        allowPrivateNetwork: true,
        models: ["test-model"],
      },
    },
    guardrails: {
      enabled: true,
      mode: "enforce",
      failurePolicy: "block",
    },
  } as OcxConfig);
  const proxy = startServer(0);
  try {
    const body = documentBody();
    body.model = "mock/test-model";
    body.stream = false;
    const response = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "placeholder",
      },
      body: JSON.stringify(body),
    });
    const json = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
    };

    expect(response.status).toBe(200);
    expect(json.content?.find(block => block.type === "text")?.text)
      .toContain(SECRET);
    expect(JSON.stringify(json)).not.toContain(PLACEHOLDER);
    expect(JSON.stringify(captured)).toContain(PLACEHOLDER);
    expect(JSON.stringify(captured)).not.toContain(SECRET);
  } finally {
    await proxy.stop(true);
    upstream.stop(true);
  }
});

test("provider scope leaves excluded native Messages and count_tokens unchanged", async () => {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      captured.push({ path, body: await request.json() as Record<string, unknown> });
      if (path.endsWith("/count_tokens")) {
        return Response.json({ input_tokens: 42 });
      }
      return Response.json({
        id: "msg-guardrails-excluded",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: `literal ${PLACEHOLDER}` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const scoped = config(upstream.url.toString().replace(/\/$/, ""));
  scoped.guardrails!.providerScope = {
    mode: "selected",
    providerIds: ["mock"],
  };
  saveConfig(scoped);
  const proxy = startServer(0);
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    authorization: "Bearer sk-ant-oat01-test",
  };

  try {
    const messages = await fetch(new URL("/v1/messages", proxy.url), {
      method: "POST",
      headers,
      body: JSON.stringify(documentBody()),
    });
    const countTokens = await fetch(new URL("/v1/messages/count_tokens", proxy.url), {
      method: "POST",
      headers,
      body: JSON.stringify(documentBody()),
    });
    const messagesText = await messages.text();

    expect(messages.status).toBe(200);
    expect(countTokens.status).toBe(200);
    expect(await countTokens.json()).toEqual({ input_tokens: 42 });
    expect(JSON.stringify(captured)).toContain(SECRET);
    expect(JSON.stringify(captured)).not.toContain(PLACEHOLDER);
    expect(messagesText).toContain(PLACEHOLDER);
    expect(messagesText).not.toContain(`literal ${SECRET}`);
  } finally {
    await proxy.stop(true);
    upstream.stop(true);
  }
});

test("native Messages scanner failure blocks or passes through messages and count_tokens", async () => {
  const oversized = `prefix ${"x".repeat(128 * 1024 + 1)}`;
  for (const failurePolicy of ["block", "passthrough"] as const) {
    const captured: Array<{ body: Record<string, unknown>; path: string }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        captured.push({ path, body: await request.json() as Record<string, unknown> });
        return path.endsWith("/count_tokens")
          ? Response.json({ input_tokens: 42 })
          : Response.json({
              id: `msg-guardrails-${failurePolicy}`,
              type: "message",
              role: "assistant",
              model: "claude-fable-5",
              content: [{ type: "text", text: "accepted" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
      },
    });
    const candidate = config(upstream.url.toString().replace(/\/$/, ""));
    candidate.guardrails!.failurePolicy = failurePolicy;
    saveConfig(candidate);
    const proxy = startServer(0);
    const headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: "Bearer sk-ant-oat01-test",
    };
    const body = {
      model: "claude-fable-5",
      max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: oversized }] }],
    };
    try {
      const responses = [];
      for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
        const response = await fetch(new URL(path, proxy.url), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        await response.text();
        responses.push(response);
      }

      if (failurePolicy === "block") {
        expect(responses.map(response => response.status)).toEqual([413, 413]);
        expect(captured).toHaveLength(0);
      } else {
        expect(responses.map(response => response.status)).toEqual([200, 200]);
        expect(captured.map(entry => entry.path)).toEqual([
          "/v1/messages",
          "/v1/messages/count_tokens",
        ]);
        expect(captured.every(entry => JSON.stringify(entry.body).includes(oversized))).toBe(true);
      }
    } finally {
      await proxy.stop(true);
      upstream.stop(true);
    }
  }
});
