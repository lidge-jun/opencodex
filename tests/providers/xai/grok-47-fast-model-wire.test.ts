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
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth/token";
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

async function launch(config = xaiConfig(), statuses: number[] = []) {
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
    ];
    if (!endpoints.includes(url)) throw new Error(`Unexpected outbound request: ${url}`);
    const body = await request.json() as Body;
    sends.push({ url, body, authorization: request.headers.get("authorization") });
    if (statuses.shift() === 401) return Response.json({ error: { message: "fixture rejected access" } }, { status: 401 });
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

function assertFastReceipts(): void {
  const log = getRequestLogEntries().at(-1);
  const usage = readUsageEntries().at(-1);
  for (const receipt of [log, usage]) {
    expect(receipt?.model).toBe(LOGICAL_MODEL);
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
