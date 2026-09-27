/**
 * Managed native Messages lane (PF-08) against fake upstreams. With
 * `protocols.rollout.managedMessagesNative` on, a direct route to a key-auth `anthropic`
 * provider receives the caller's Messages body itself (allowlisted, wire model, the provider's
 * key) instead of the Responses replay. Everything here is a local fixture: no real credential
 * or service is reached.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { estimateClaudeRequestTokens, handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

interface Seen {
  path: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = (seen: Seen, index: number) => Response;

let upstream: ReturnType<typeof Bun.serve> | undefined;
let callerForward: ReturnType<typeof Bun.serve> | undefined;
let seen: Seen[] = [];
let callerForwardSeen: Seen[] = [];
let releaseSpendHome: (() => void) | undefined;
let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-native-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
  seen = [];
  callerForwardSeen = [];
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  await upstream?.stop(true);
  upstream = undefined;
  await callerForward?.stop(true);
  callerForward = undefined;
  clearKeyCooldowns();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

const MESSAGE_JSON = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-x",
  content: [{ type: "text", text: "fixture reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 3 },
};

const SSE_FRAMES = [
  { event: "message_start", data: { type: "message_start", message: { ...MESSAGE_JSON, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 2 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } } },
  { event: "message_stop", data: { type: "message_stop" } },
];
const sseText = (frames: readonly { event: string; data: unknown }[]) => frames.map(frame => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("");
const SSE_TEXT = sseText(SSE_FRAMES);
/** What the client receives: the upstream stream with its selector echoed in message_start. */
const ECHOED_SSE_TEXT = sseText(SSE_FRAMES.map((frame, index) => index === 0
  ? { ...frame, data: { ...frame.data, message: { ...(frame.data as { message: Record<string, unknown> }).message, model: "anth/claude-x" } } }
  : frame));

function ok(seenRequest: Seen): Response {
  if (seenRequest.body.stream === true) {
    return new Response(SSE_TEXT, { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json(MESSAGE_JSON);
}

function startUpstream(reply: Reply = ok): number {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const entry = { path: new URL(req.url).pathname, headers: req.headers, body: await req.json() as Record<string, unknown> };
    seen.push(entry);
    return reply(entry, seen.length - 1);
  } });
  return upstream.port!;
}

function fixtureConfig(port: number, options: { on?: boolean; pool?: boolean; claudeCode?: OcxConfig["claudeCode"] } = {}): OcxConfig {
  const { on = true, pool = false } = options;
  releaseSpendHome ??= acquireOwnedSpendHome();
  const config = {
    port: 0,
    defaultProvider: "anth",
    providers: { anth: {
      adapter: "anthropic",
      baseUrl: `http://127.0.0.1:${port}`,
      authMode: "key",
      apiKey: "fixture-key-alpha",
      allowPrivateNetwork: true,
      models: ["claude-x"],
      ...(pool ? { apiKeyPool: [
        { id: "k1", key: "fixture-key-alpha", addedAt: 1 },
        { id: "k2", key: "fixture-key-beta", addedAt: 2 },
      ] } : {}),
    } },
    ...(on ? { protocols: { rollout: { managedMessagesNative: true } } } : {}),
    ...(options.claudeCode ? { claudeCode: options.claudeCode } : {}),
  } as OcxConfig;
  saveConfig(config);
  return config;
}

const SOURCE_BODY = {
  model: "anth/claude-x",
  max_tokens: 64,
  top_k: 5,
  temperature: 0.3,
  thinking: { type: "enabled", budget_tokens: 1024 },
  metadata: { user_id: "fixture-user" },
  system: [{ type: "text", text: "fixture system", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "fixture question", cache_control: { type: "ephemeral" } }] }],
  tools: [{ name: "lookup", description: "fixture tool", input_schema: { type: "object", properties: {} } }],
  // Not on the allowlist: must not reach the provider.
  context_management: { edits: [] },
};

function messagesRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function rowFor(requestId: string) {
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function send(config: OcxConfig, body: Record<string, unknown>, headers?: Record<string, string>) {
  const requestId = `pf08-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(messagesRequest(body, headers), config, { model: "", provider: "" },
    { requestId, start: Date.now() });
  const text = await response.text();
  return { requestId, response, text };
}

describe("managed native Messages", () => {
  test("sends exactly the allowlisted source body with the provider key and no caller credential", async () => {
    const config = fixtureConfig(startUpstream());
    const { requestId, response, text } = await send(config, { ...SOURCE_BODY, stream: false }, {
      authorization: "Bearer fixture-admission-token",
      "x-api-key": "fixture-caller-key",
      "anthropic-beta": "fixture-beta",
    });
    expect(response.status).toBe(200);
    // The client's selector is echoed, as on the translated lane.
    expect(JSON.parse(text)).toEqual({ ...MESSAGE_JSON, model: "anth/claude-x" });
    expect(seen).toHaveLength(1);
    const sent = seen[0]!;
    expect(sent.path).toBe("/v1/messages");
    const { context_management: _dropped, ...allowlisted } = SOURCE_BODY;
    expect(sent.body).toEqual({ ...allowlisted, stream: false, model: "claude-x" });
    expect(sent.headers.get("x-api-key")).toBe("fixture-key-alpha");
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("anthropic-beta")).toBeNull();
    expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");

    const row = rowFor(requestId);
    expect(row.status).toBe(200);
    expect(row.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
    expect(row.protocolTrace).toMatchObject({ inbound: "messages", mode: "native", requestPath: ["messages", "messages"] });
    expect(JSON.stringify(row)).not.toContain("fixture-key-alpha");
  });

  test("relays the upstream stream (selector echoed in message_start) and records its usage", async () => {
    const config = fixtureConfig(startUpstream());
    const { requestId, response, text } = await send(config, { ...SOURCE_BODY, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toBe(ECHOED_SSE_TEXT);
    expect(seen[0]!.body.stream).toBe(true);
    const row = rowFor(requestId);
    expect(row.status).toBe(200);
    expect(row.usage).toMatchObject({ inputTokens: 7, outputTokens: 7, cacheReadInputTokens: 2 });
  });

  test("a 401 on the first pooled key fails over to the next key", async () => {
    const config = fixtureConfig(startUpstream((entry, index) => index === 0
      ? Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })
      : ok(entry)), { pool: true });
    const { response } = await send(config, { ...SOURCE_BODY, stream: false });
    expect(response.status).toBe(200);
    expect(seen.map(entry => entry.headers.get("x-api-key"))).toEqual(["fixture-key-alpha", "fixture-key-beta"]);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
  });

  test("a 429 on the first pooled key fails over to the next key", async () => {
    const config = fixtureConfig(startUpstream((entry, index) => index === 0
      ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        { status: 429, headers: { "retry-after": "30" } })
      : ok(entry)), { pool: true });
    const { response } = await send(config, { ...SOURCE_BODY, stream: false });
    expect(response.status).toBe(200);
    expect(seen.map(entry => entry.headers.get("x-api-key"))).toEqual(["fixture-key-alpha", "fixture-key-beta"]);
  });

  test("an upstream error answers in Anthropic shape without the key", async () => {
    const config = fixtureConfig(startUpstream(() => Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "bad fixture" } }, { status: 400 })));
    const { response, text } = await send(config, { ...SOURCE_BODY, stream: false });
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { type: "invalid_request_error", message: "bad fixture" } });
    expect(text).not.toContain("fixture-key-alpha");
  });

  test("switch off: the same request still takes the Responses bridge", async () => {
    const config = fixtureConfig(startUpstream(), { on: false });
    const { requestId, response } = await send(config, { ...SOURCE_BODY, stream: false });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    // The bridge rebuilds the body through the adapter, which has no top_k.
    expect(seen[0]!.body).not.toHaveProperty("top_k");
    expect(seen[0]!.body.stream).toBe(true);
    expect(rowFor(requestId).protocolTrace).toMatchObject({ inbound: "messages", mode: "legacy-bridge" });
  });

  test("caller-forward passthrough is decided first and keeps the caller's credential", async () => {
    callerForward = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      callerForwardSeen.push({ path: new URL(req.url).pathname, headers: req.headers, body: await req.json() as Record<string, unknown> });
      return Response.json(MESSAGE_JSON);
    } });
    const config = fixtureConfig(startUpstream(), {
      claudeCode: { anthropicBaseUrl: `http://127.0.0.1:${callerForward.port}` } as OcxConfig["claudeCode"],
    });
    const { response } = await send(config, { model: "claude-haiku-4-5", max_tokens: 16, stream: false,
      messages: [{ role: "user", content: "fixture" }] }, { "x-api-key": "sk-ant-fixture-caller" });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(0);
    expect(callerForwardSeen).toHaveLength(1);
    expect(callerForwardSeen[0]!.headers.get("x-api-key")).toBe("sk-ant-fixture-caller");
  });

  test("count_tokens counts the body the native lane sends", async () => {
    const config = fixtureConfig(startUpstream());
    await send(config, { ...SOURCE_BODY, stream: false });
    const sentBody = seen[0]!.body;
    const response = await handleClaudeCountTokens(new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SOURCE_BODY),
    }), config);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: estimateClaudeRequestTokens(sentBody, "anth/claude-x") });
    // Counting sends nothing.
    expect(seen).toHaveLength(1);
  });
});
