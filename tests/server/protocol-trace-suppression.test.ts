import { afterEach, describe, expect, test } from "bun:test";
import { addProtocolEntryReason, markAttemptProtocolPath, markProtocolBlocked, markProtocolEntry,
  markProtocolShadowPlanInput, protocolMarkFeatures, protocolTraceForRequest, protocolTraceSuppressed,
  suppressProtocolTrace } from "../../src/protocols/trace";
import type { ProtocolPlanInput } from "../../src/protocols/plan";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let server: ReturnType<typeof Bun.serve> | undefined;
let releaseSpend: (() => void) | undefined;
let sends = 0;

afterEach(async () => {
  releaseSpend?.();
  releaseSpend = undefined;
  await server?.stop(true);
  server = undefined;
});

function config(adapter: "openai-chat" | "openai-responses", combo = false): OcxConfig {
  sends = 0;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    sends++;
    await req.text();
    return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", model: "model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  releaseSpend = acquireOwnedSpendHome();
  return { port: 0, defaultProvider: "fixture", providers: { fixture: {
    adapter, baseUrl: `http://127.0.0.1:${server.port}/v1`, authMode: "key", apiKey: "fixture-key",
    allowPrivateNetwork: true, models: ["model"],
  } }, protocols: { unrepresentable: "reject", rollout: { nativeChatCombos: true, shadowPlan: true } },
  ...(combo ? { combos: { pair: { strategy: "failover", targets: [{ provider: "fixture", model: "model" }] } } } : {}),
  } as OcxConfig;
}

async function send(cfg: OcxConfig, body: Record<string, unknown>, suppressed: boolean) {
  const requestId = `suppression-${crypto.randomUUID()}`;
  const ctx: { model: string; provider: string; inboundProtocol?: "responses" | "chat" | "messages" } =
    { model: "", provider: "", inboundProtocol: "responses" };
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), cfg, ctx, { requestId, start: Date.now(), suppressProtocolTrace: suppressed });
  const text = await response.text();
  const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
  expect(rows).toHaveLength(1);
  return { response, text, ctx, row: rows[0]! };
}

describe("protocol trace suppression", () => {
  test("suppression clears prior marks and ignores every later request writer and attempt", () => {
    const ctx = { inboundProtocol: "responses" as const };
    const attempt = { ordinal: 1, adapter: "openai-chat" };
    markProtocolEntry(ctx, { inbound: "chat", lane: "native", features: ["request.tools"] });
    suppressProtocolTrace(ctx);
    expect(protocolTraceSuppressed(ctx)).toBe(true);
    let scanned = false;
    markProtocolEntry(ctx, { inbound: "chat", lane: "bridge", features: () => { scanned = true; return []; } });
    addProtocolEntryReason(ctx, "not-migrated");
    markProtocolShadowPlanInput(ctx, {} as ProtocolPlanInput);
    markProtocolBlocked(ctx, { inbound: "chat", reasonCodes: ["feature-unrepresentable"] });
    markAttemptProtocolPath(attempt, { mode: "translated", requestPath: ["chat", "ir", "other"] });
    expect(scanned).toBe(false);
    expect(protocolMarkFeatures(ctx)).toBeUndefined();
    expect(protocolTraceForRequest(ctx, [attempt])).toBeUndefined();
    expect(protocolTraceForRequest({ inboundProtocol: "responses" }, [attempt])).toBeDefined();
  });

  for (const combo of [false, true]) test(`native ${combo ? "combo" : "direct"} success preserves the original inbound protocol`, async () => {
    const cfg = config("openai-chat", combo);
    const body = { model: combo ? "combo/pair" : "fixture/model", messages: [{ role: "user", content: "hi" }] };
    const result = await send(cfg, body, true);
    expect(result.response.status).toBe(200);
    expect(sends).toBe(1);
    expect(result.ctx.inboundProtocol).toBe("responses");
    expect(result.row.inboundProtocol).toBe("responses");
    expect(result.row.protocolTrace).toBeUndefined();
    const ordinary = await send(cfg, body, false);
    expect(ordinary.response.status).toBe(200);
    if (!combo) expect(ordinary.ctx.inboundProtocol).toBe("chat");
    expect(ordinary.row.protocolTrace).toMatchObject({ inbound: "chat", mode: "native" });
  });

  test("representability rejection still blocks the send with no trace", async () => {
    const cfg = config("openai-responses");
    const body = { model: "fixture/model", n: 2, messages: [{ role: "user", content: "hi" }] };
    const result = await send(cfg, body, true);
    expect(result.response.status).toBe(400);
    expect(JSON.parse(result.text)).toMatchObject({ error: { code: "unsupported_feature" } });
    expect(sends).toBe(0);
    expect(result.row.protocolTrace).toBeUndefined();
    const ordinary = await send(cfg, body, false);
    expect(ordinary.response.status).toBe(400);
    expect(ordinary.row.protocolTrace).toMatchObject({ inbound: "chat", mode: "blocked" });
    expect(sends).toBe(0);
  });

  test("parser refusal retains its error without producing a trace", async () => {
    const cfg = config("openai-responses");
    const result = await send(cfg, { model: "fixture/model", messages: [{ role: "tool", content: "missing id" }] }, true);
    expect(result.response.status).toBe(400);
    expect(sends).toBe(0);
    expect(result.row.protocolTrace).toBeUndefined();
  });
});
