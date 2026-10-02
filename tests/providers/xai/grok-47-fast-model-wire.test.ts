import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../../src/config";
import { XAI_OAUTH_DISCOVERY_URL } from "../../../src/oauth/xai";
import { saveCredential } from "../../../src/oauth/store";
import { XAI_GROK_CLI_BASE_URL } from "../../../src/providers/xai-transport";
import { startServer } from "../../../src/server";
import {
  clearRequestLogsForTests,
  getRequestLogEntries,
  observeRequestLogsForTests,
  type RequestLogEntry,
} from "../../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { readUsageEntries } from "../../../src/usage/log";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const LOGICAL_MODEL = "grok-4.7";
const FAST_MODEL = "grok-4.7-build-fast";
const SCOPED_KEY = "ocx_data_" + "a".repeat(40);
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth/token";
const BACKUP_BASE_URL = "https://grok47-backup.test/v1";
type Body = Record<string, unknown>;
type Server = ReturnType<typeof startServer>;
interface CapturedSend { url: string; body: Body; authorization: string | null }

let originalFetch: typeof fetch;
let previousHome: string | undefined;
let testDir: string;
let codexHome: IsolatedCodexHome;
let server: Server | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-grok47-wire-"));
  process.env.OPENCODEX_HOME = testDir;
  codexHome = installIsolatedCodexHome("ocx-grok47-wire-codex-");
  clearRequestLogsForTests();
});

afterEach(async () => {
  try {
    await server?.stop(true);
  } finally {
    server = undefined;
    globalThis.fetch = originalFetch;
    clearRequestLogsForTests();
    codexHome.restore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(testDir);
  }
});

function xaiConfig(
  authMode: "oauth" | "key" = "oauth",
  extra: Partial<OcxConfig> = {},
  providerExtra: Partial<OcxProviderConfig> = {},
): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    codexAutoStart: false,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode,
        refreshPolicy: "disabled",
        ...(authMode === "key" ? { apiKey: "fake-xai-wire-key" } : {}),
        models: [LOGICAL_MODEL],
        ...providerExtra,
      },
    },
    ...extra,
  } as OcxConfig;
}

function upstreamReply(body: Body, chat: boolean, sequence: number): Response {
  const model = body.model;
  const id = `resp-grok47-wire-${sequence}`;
  const output = [{
    id: `msg-grok47-wire-${sequence}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "wire fixture reply", annotations: [] }],
  }];
  if (chat) {
    const choice = { index: 0, message: { role: "assistant", content: "wire fixture reply" }, finish_reason: "stop" };
    const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    if (!body.stream) return Response.json({ id, object: "chat.completion", model, choices: [choice], usage });
    const chunk = { id, object: "chat.completion.chunk", model, choices: [{
      index: 0, delta: { role: "assistant", content: "wire fixture reply" }, finish_reason: "stop",
    }], usage };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  // Echo a tier despite the absent outbound field: it must not confirm a model serving lane.
  const response = {
    id, object: "response", status: "completed", model, output, service_tier: "priority",
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
  if (!body.stream) return Response.json(response);
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...output[0], content: [] } },
    { type: "response.content_part.added", item_id: output[0]!.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: output[0]!.id, output_index: 0, content_index: 0,
      delta: "wire fixture reply" },
    { type: "response.output_item.done", output_index: 0, item: output[0] },
    { type: "response.completed", response },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function launch(config = xaiConfig(), statuses: number[] = [], failingEndpoint?: string) {
  if (config.providers.xai?.authMode === "oauth") {
    await saveCredential("xai", {
      access: "fake-xai-old-access", refresh: "fake-xai-refresh", expires: Date.now() + 3_600_000,
      accountId: "fake-xai-wire-account", source: "oauth",
    });
  }
  saveConfig(config);
  const sends: CapturedSend[] = [];
  const counts = { refresh: 0 };
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = request.url;
    if (url === XAI_OAUTH_DISCOVERY_URL) {
      return Response.json({ authorization_endpoint: "https://auth.x.ai/oauth/authorize", token_endpoint: TOKEN_ENDPOINT });
    }
    if (url === TOKEN_ENDPOINT) {
      counts.refresh++;
      return Response.json({ access_token: "fake-xai-new-access", refresh_token: "fake-xai-new-refresh", expires_in: 3600 });
    }
    const endpoints = [
      `${XAI_GROK_CLI_BASE_URL}/responses`, `${XAI_GROK_CLI_BASE_URL}/chat/completions`,
      "https://api.x.ai/v1/responses", "https://api.x.ai/v1/chat/completions",
      `${BACKUP_BASE_URL}/responses`,
    ];
    if (!endpoints.includes(url)) throw new Error(`Unexpected outbound request: ${url}`);
    const body = await request.json() as Body;
    sends.push({ url, body, authorization: request.headers.get("authorization") });
    const status = url === failingEndpoint ? 500 : statuses.shift() ?? 200;
    if (status !== 200) return Response.json({ error: { message: "fixture rejected request" } }, { status });
    return upstreamReply(body, url.endsWith("/chat/completions"), sends.length);
  }) as typeof fetch;
  server = startServer(0);
  return { server, sends, counts };
}

async function post(proxy: Server, body: Body, path = "/v1/responses"): Promise<Body> {
  // Use the original fetch only for this known loopback server, bypassing the upstream stub.
  const response = await originalFetch(new URL(path, proxy.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  });
  const json = await response.json() as Body;
  expect(response.status).toBe(200);
  return json;
}

function responsesBody(extra: Body = {}): Body {
  return { model: "xai/grok-4.7--fast", input: "hello", stream: false, ...extra };
}

function assertFastSend(send: CapturedSend): void {
  expect(send.body.model).toBe(FAST_MODEL);
  expect(Object.hasOwn(send.body, "service_tier")).toBe(false);
}

function assertFastReceipts(receiptModel = LOGICAL_MODEL): void {
  const log = getRequestLogEntries().at(-1);
  const usage = readUsageEntries().at(-1);
  for (const receipt of [log, usage]) {
    expect(receipt?.model).toBe(receiptModel);
    expect(receipt?.wireModel).toBe(FAST_MODEL);
    expect(receipt?.attempts).toHaveLength(1);
    expect(receipt?.attempts?.[0]?.model).toBe(LOGICAL_MODEL);
    expect(receipt?.attempts?.[0]?.tierOutcome).toMatchObject({
      wireKind: "model-variant", wireValue: FAST_MODEL, fastOutcome: "applied",
      confirmation: "assumed", responseTierAuthoritative: false,
    });
  }
}

describe("Grok 4.7 Fast serialized upstream model", () => {
  test.each([
    { label: "--fast selector", config: xaiConfig(), body: responsesBody() },
    { label: "caller priority tier", config: xaiConfig(), body: responsesBody({ model: "xai/grok-4.7", service_tier: "priority" }) },
    { label: "global fastMode", config: xaiConfig("oauth", { fastMode: true }), body: responsesBody({ model: "xai/grok-4.7" }) },
  ])("OAuth Responses $label sends build-fast without a tier and preserves logical receipts", async ({ config, body }) => {
    const fixture = await launch(config);
    const json = await post(fixture.server, body);
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]!.url).toBe(`${XAI_GROK_CLI_BASE_URL}/responses`);
    assertFastSend(fixture.sends[0]!);
    expect(json.model).toBe(FAST_MODEL);
    assertFastReceipts();
  });

  test("plain OAuth Responses keeps grok-4.7 without a tier", async () => {
    const fixture = await launch();
    const json = await post(fixture.server, responsesBody({ model: "xai/grok-4.7" }));
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]!.body.model).toBe(LOGICAL_MODEL);
    expect(Object.hasOwn(fixture.sends[0]!.body, "service_tier")).toBe(false);
    expect(json.model).toBe(LOGICAL_MODEL);
  });

  test.each([
    { label: "Fast-only scope with --fast selector", allowed: FAST_MODEL, status: 200, body: responsesBody() },
    { label: "Fast-only scope with caller priority", allowed: FAST_MODEL, status: 200,
      body: responsesBody({ model: "xai/grok-4.7", service_tier: "priority" }) },
    { label: "Fast-only scope with global Fast", allowed: FAST_MODEL, status: 200, fastMode: true,
      body: responsesBody({ model: "xai/grok-4.7" }) },
    { label: "logical-only scope with Fast", allowed: LOGICAL_MODEL, status: 403, body: responsesBody() },
    { label: "unrelated scope with Fast", allowed: "other-model", status: 403, body: responsesBody() },
    { label: "Fast-only scope with plain request", allowed: FAST_MODEL, status: 403,
      body: responsesBody({ model: "xai/grok-4.7" }) },
    { label: "Fast-only scope with Fast disabled", allowed: FAST_MODEL, status: 403,
      fastMode: false, body: responsesBody() },
    { label: "Fast-only scope with key auth", allowed: FAST_MODEL, status: 403,
      keyAuth: true, body: responsesBody() },
    { label: "logical-only scope with Fast disabled", allowed: LOGICAL_MODEL, status: 200,
      fastMode: false, body: responsesBody() },
    { label: "Fast-only scope with an operator tier wire", allowed: FAST_MODEL, status: 403,
      operatorWire: true, body: responsesBody() },
    { label: "logical-only scope with an operator tier wire", allowed: LOGICAL_MODEL, status: 200,
      operatorWire: true, body: responsesBody() },
  ])("$label authorizes only the actual wire destination", async ({ allowed, status, body, fastMode, keyAuth, operatorWire }) => {
    const fixture = await launch(xaiConfig(keyAuth ? "key" : "oauth", { hostname: "0.0.0.0", fastMode, apiKeys: [{
      id: "scoped", name: "scoped", key: SCOPED_KEY, createdAt: "2026-09-30T00:00:00.000Z",
      allowedModels: [`xai/${allowed}`],
    }] }, operatorWire ? { fastWire: {
      kind: "service-tier", canonicalToWire: { priority: "priority" }, foreignCallerTiers: "verbatim",
    } } : {}));
    const url = new URL("/v1/responses", fixture.server.url);
    url.hostname = "127.0.0.1";
    const response = await originalFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SCOPED_KEY}` },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(status);
    const json = await response.json();
    if (status === 403) {
      expect(json).toMatchObject({ error: { type: "model_not_allowed_for_key" } });
      expect(fixture.sends).toHaveLength(0);
    } else {
      expect(fixture.sends).toHaveLength(1);
      expect(fixture.sends[0]!.body.model).toBe(allowed);
      expect(json).toMatchObject({ model: allowed });
    }
  });

  test.each([
    { label: "Chat", path: "/v1/chat/completions", content: {
      messages: [{ role: "user", content: "hello" }],
    } },
    { label: "Messages", path: "/v1/messages", content: {
      messages: [{ role: "user", content: "hello" }], max_tokens: 128,
    } },
    { label: "compact", path: "/v1/responses/compact", content: {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Retain task progress." }] }],
    } },
  ].flatMap(surface => [
    { policy: "Fast-only", allowed: FAST_MODEL, status: 200 },
    { policy: "logical-only", allowed: LOGICAL_MODEL, status: 403 },
    { policy: "global Fast-only", allowed: FAST_MODEL, status: 200, fastMode: true, plain: true },
    { policy: "disabled Fast-only", allowed: FAST_MODEL, status: 403, fastMode: false },
    { policy: "disabled logical-only", allowed: LOGICAL_MODEL, status: 200, fastMode: false },
    { policy: "operator wire Fast-only", allowed: FAST_MODEL, status: 403, operatorWire: true },
    { policy: "operator wire logical-only", allowed: LOGICAL_MODEL, status: 200, operatorWire: true },
    { policy: "native key Fast-only", allowed: FAST_MODEL, status: 403, keyAuth: true },
  ].map(policy => ({ ...surface, ...policy }))))(
    "cross-ingress $label $policy scope checks the actual wire model",
    async ({ path, content, allowed, status, fastMode, plain, operatorWire, keyAuth }) => {
      const fixture = await launch(xaiConfig(keyAuth ? "key" : "oauth", {
        hostname: "0.0.0.0", fastMode, apiKeys: [{
          id: "scoped", name: "scoped", key: SCOPED_KEY, createdAt: "2026-09-30T00:00:00.000Z",
          allowedModels: [`xai/${allowed}`],
        }],
      }, operatorWire ? { fastWire: {
        kind: "service-tier", canonicalToWire: { priority: "priority" }, foreignCallerTiers: "verbatim",
      } } : {}));
      const url = new URL(path, fixture.server.url);
      url.hostname = "127.0.0.1";
      const response = await originalFetch(url, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SCOPED_KEY}` },
        body: JSON.stringify({ model: plain ? "xai/grok-4.7" : "xai/grok-4.7--fast", stream: false, ...content }),
      });
      const json = await response.json();
      expect(response.status).toBe(status);
      if (status === 403) {
        expect(json).toMatchObject({ error: { type: "model_not_allowed_for_key" } });
        expect(fixture.sends).toHaveLength(0);
      } else {
        expect(fixture.sends).toHaveLength(1);
        expect(fixture.sends[0]!.body.model).toBe(allowed);
        if (allowed === FAST_MODEL) assertFastSend(fixture.sends[0]!);
        if (path.endsWith("/compact")) {
          expect(json.output).toEqual(expect.arrayContaining([expect.objectContaining({ type: "message" })]));
        }
      }
    },
    30_000,
  );

  test("key-auth --fast keeps grok-4.7 and priority on api.x.ai", async () => {
    const fixture = await launch(xaiConfig("key"));
    await post(fixture.server, responsesBody());
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]).toMatchObject({
      url: "https://api.x.ai/v1/chat/completions", authorization: "Bearer fake-xai-wire-key",
      body: { model: LOGICAL_MODEL, service_tier: "priority" },
    });
  });

  test("fastMode false suppresses --fast without changing the OAuth model", async () => {
    const fixture = await launch(xaiConfig("oauth", { fastMode: false }));
    await post(fixture.server, responsesBody());
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]!.body.model).toBe(LOGICAL_MODEL);
    expect(Object.hasOwn(fixture.sends[0]!.body, "service_tier")).toBe(false);
  });

  test.each([
    { label: "Chat Completions", path: "/v1/chat/completions", body: {
      model: "xai/grok-4.7--fast", messages: [{ role: "user", content: "hello" }], stream: false,
    } },
    { label: "Claude Messages", path: "/v1/messages", body: {
      model: "xai/grok-4.7--fast", messages: [{ role: "user", content: "hello" }], max_tokens: 128, stream: false,
    } },
  ])("$label ingress sends build-fast and never shows it to the client", async ({ path, body }) => {
    const fixture = await launch();
    const json = await post(fixture.server, body, path);
    expect(fixture.sends).toHaveLength(1);
    assertFastSend(fixture.sends[0]!);
    // Translated deliveries echo the client's own selector (chat-completions.ts, claude-messages.ts);
    // the serving-lane id stays internal.
    expect(json.model).toBe((body as Body).model);
    expect(JSON.stringify(json)).not.toContain(FAST_MODEL);
    assertFastReceipts();
  });

  test("OAuth reactive 401 replay sends build-fast without a tier on both sends", async () => {
    const fixture = await launch(xaiConfig(), [401, 200]);
    await post(fixture.server, responsesBody());
    expect(fixture.sends).toHaveLength(2);
    fixture.sends.forEach(assertFastSend);
    expect(fixture.sends.map(send => send.authorization)).toEqual([
      "Bearer fake-xai-old-access", "Bearer fake-xai-new-access",
    ]);
    expect(fixture.counts.refresh).toBe(1);
    assertFastReceipts();
    expect(readUsageEntries().at(-1)?.attempts?.[0]?.sendCount).toBe(2);
  });

  test("WebSocket response.create sends build-fast without a tier and preserves logical receipts", async () => {
    const fixture = await launch(xaiConfig("oauth", { websockets: true }));
    const url = new URL("/v1/responses", fixture.server.url);
    url.protocol = "ws:";
    const socket = new WebSocket(url);
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await new Promise<Body>((resolve, reject) => {
        let terminal: Body | undefined;
        let finalized: RequestLogEntry | undefined;
        const settle = () => { if (terminal && finalized) resolve(terminal); };
        unsubscribe = observeRequestLogsForTests(entry => {
          if (entry.provider !== "xai" || entry.model !== LOGICAL_MODEL) return;
          finalized = entry;
          settle();
        });
        timer = setTimeout(() => reject(new Error("Grok Fast WebSocket turn or receipt timed out")), 4_000);
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ type: "response.create", ...responsesBody({ stream: true }) }));
        }, { once: true });
        socket.addEventListener("message", event => {
          try {
            const payload = JSON.parse(String(event.data)) as Body;
            if (payload.type === "error" || payload.type === "response.failed") {
              reject(new Error(`Grok Fast WebSocket failed: ${JSON.stringify(payload)}`));
            } else if (payload.type === "response.completed") {
              terminal = payload.response as Body;
              settle();
            }
          } catch (error) { reject(error); }
        });
        socket.addEventListener("error", () => reject(new Error("Grok Fast WebSocket connection failed")), { once: true });
        socket.addEventListener("close", () => {
          if (!terminal) reject(new Error("Grok Fast WebSocket closed before completion"));
        }, { once: true });
      });
      expect(completed.status).toBe("completed");
      expect(fixture.sends).toHaveLength(1);
      expect(fixture.sends[0]!.url).toBe(`${XAI_GROK_CLI_BASE_URL}/responses`);
      assertFastSend(fixture.sends[0]!);
      assertFastReceipts();
      expect(getRequestLogEntries().at(-1)).toMatchObject({ status: 200, terminalStatus: "completed" });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      socket.close();
    }
  });

  test.each([
    { label: "global fastMode", fastMode: true, tier: {} },
    { label: "caller priority", fastMode: undefined, tier: { service_tier: "priority" } },
  ])("combo OAuth child with $label sends build-fast without a tier", async ({ label, fastMode, tier }) => {
    const comboId = label === "caller priority" ? "fast-child-caller" : "fast-child-global";
    const config = xaiConfig("oauth", {
      fastMode,
      combos: { [comboId]: { strategy: "failover", targets: [{ provider: "xai", model: LOGICAL_MODEL }] } },
    });
    const fixture = await launch(config);
    await post(fixture.server, responsesBody({ model: `combo/${comboId}`, ...tier }));
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]!.url).toBe(`${XAI_GROK_CLI_BASE_URL}/responses`);
    assertFastSend(fixture.sends[0]!);
    assertFastReceipts(`combo/${comboId}`);
  });

  test("combo OAuth 500 fallback keeps the backup model and its priority tier without a build-fast leak", async () => {
    // Combo targets select provider entries, not auth modes; one xai entry cannot mix OAuth and key auth.
    const backupModel = "backup-model";
    const config = xaiConfig("oauth", {
      combos: { "fast-failover": { strategy: "failover", targets: [
        { provider: "xai", model: LOGICAL_MODEL }, { provider: "backup", model: backupModel },
      ] } },
    });
    config.providers.backup = {
      adapter: "openai-responses", baseUrl: BACKUP_BASE_URL, authMode: "key",
      apiKey: "fake-backup-wire-key", models: [backupModel], supportsServiceTier: true,
    };
    const fixture = await launch(config, [], `${XAI_GROK_CLI_BASE_URL}/responses`);
    const json = await post(fixture.server, responsesBody({
      model: "combo/fast-failover", service_tier: "priority",
    }));
    const xaiSends = fixture.sends.slice(0, -1);
    expect(xaiSends.length).toBeGreaterThan(0);
    for (const send of xaiSends) {
      expect(send.url).toBe(`${XAI_GROK_CLI_BASE_URL}/responses`);
      assertFastSend(send);
    }
    expect(fixture.sends.at(-1)).toMatchObject({
      url: `${BACKUP_BASE_URL}/responses`, authorization: "Bearer fake-backup-wire-key",
      body: { model: backupModel, service_tier: "priority" },
    });
    expect(JSON.stringify(fixture.sends.at(-1)!.body)).not.toContain(FAST_MODEL);
    expect(json.model).toBe(backupModel);
    for (const receipt of [getRequestLogEntries().at(-1), readUsageEntries().at(-1)]) {
      expect(receipt).toMatchObject({
        model: "combo/fast-failover", resolvedModel: backupModel,
        attempts: [
          { provider: "xai", model: LOGICAL_MODEL, status: 500 },
          { provider: "backup", model: backupModel, status: 200 },
        ],
      });
      expect(receipt?.wireModel).not.toBe(FAST_MODEL);
      expect(receipt?.attempts?.[0]?.sendCount).toBe(xaiSends.length);
      expect(receipt?.attempts?.[1]?.sendCount).toBe(1);
      expect(receipt?.attempts?.[0]?.tierOutcome).toMatchObject({ wireKind: "model-variant", wireValue: FAST_MODEL });
      expect(receipt?.attempts?.[1]?.tierOutcome).toMatchObject({ wireKind: "service-tier", wireValue: "priority" });
    }
  });

  test.each(["low", "high", "xhigh"])("Fast sends the same reasoning as the plain request (%s)", async effort => {
    const fixture = await launch();
    await post(fixture.server, responsesBody({ model: "xai/grok-4.7", reasoning: { effort } }));
    await post(fixture.server, responsesBody({ reasoning: { effort } }));
    expect(fixture.sends).toHaveLength(2);
    expect(fixture.sends[0]!.body.model).toBe(LOGICAL_MODEL);
    assertFastSend(fixture.sends[1]!);
    expect(fixture.sends[1]!.body.reasoning).toEqual(fixture.sends[0]!.body.reasoning);
  });

  test.each([
    { label: "global Fast", config: xaiConfig("oauth", { fastMode: true }), tier: {} },
    { label: "caller priority", config: xaiConfig(), tier: { service_tier: "priority" } },
  ])("routed compaction with $label sends build-fast without a tier", async ({ config, tier }) => {
    const fixture = await launch(config);
    const json = await post(fixture.server, responsesBody({
      model: "xai/grok-4.7", ...tier,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Retain task progress." }] },
        { type: "compaction_trigger" }],
    }));
    expect(fixture.sends).toHaveLength(1);
    assertFastSend(fixture.sends[0]!);
    expect(JSON.stringify(fixture.sends[0]!.body)).not.toContain("compaction_trigger");
    expect(JSON.stringify(fixture.sends[0]!.body)).toContain("CONTEXT CHECKPOINT COMPACTION");
    expect(json.output).toEqual(expect.arrayContaining([expect.objectContaining({ type: "compaction" })]));
    assertFastReceipts();
  });
});
