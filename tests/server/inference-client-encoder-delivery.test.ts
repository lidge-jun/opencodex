import { describe, expect, test } from "bun:test";
import {
  clientEncoderForDelivery,
  deliverClientEncodedResponse,
  directEncodersApply,
} from "../../src/server/inference/client-encoder-delivery";
import {
  attachClientWireLog,
  clientWireLogOf,
  clientWireOf,
  createClientWireLog,
  markClientWire,
  type ClientWireLogEvent,
} from "../../src/server/inference/client-wire";
import { beginInferenceAttempt } from "../../src/server/inference/attempt";
import { responseWithDeferredRequestLog } from "../../src/server/relay";
import type { RequestLogContext, RequestLogEntry } from "../../src/server/request-log";
import { markProtocolEntry, protocolTraceForRequest } from "../../src/protocols/trace";
import type { AdapterEvent, OcxConfig, OcxUsage } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const ON = { protocols: { rollout: { directEncoders: true } } } as Pick<OcxConfig, "protocols">;
const OFF = {} as Pick<OcxConfig, "protocols">;
const single = (adapter: string) => ({ provider: { adapter } });

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

describe("direct encoder gates", () => {
  test("the ingress gate is off by default and only takes one non-Responses target", () => {
    expect(directEncodersApply(OFF, single("anthropic"))).toBe(false);
    expect(directEncodersApply(ON, null)).toBe(false);
    expect(directEncodersApply(ON, single("anthropic"))).toBe(true);
    expect(directEncodersApply(ON, single("google"))).toBe(true);
    expect(directEncodersApply(ON, single("openai-responses"))).toBe(false);
    expect(directEncodersApply(ON, { ...single("anthropic"), combo: { id: "c" } })).toBe(false);
    expect(directEncodersApply(ON, { ...single("anthropic"), routeKind: "policy" })).toBe(false);
  });

  test("delivery re-checks the final route before encoding", () => {
    const clientEncoder = { protocol: "chat" as const, stream: true, model: "m" };
    const none = {};
    expect(clientEncoderForDelivery({}, none, false, "anthropic")).toBeUndefined();
    expect(clientEncoderForDelivery({ clientEncoder }, none, false, "anthropic")).toBe(clientEncoder);
    expect(clientEncoderForDelivery({ clientEncoder, comboAttempt: true }, none, false, "anthropic")).toBeUndefined();
    expect(clientEncoderForDelivery({ clientEncoder }, none, true, "anthropic")).toBeUndefined();
    expect(clientEncoderForDelivery({ clientEncoder }, none, false, "openai-responses")).toBeUndefined();
    const policy = { routeDecision: { routeKind: "policy" } } as unknown as Pick<RequestLogContext, "routeDecision">;
    expect(clientEncoderForDelivery({ clientEncoder }, policy, false, "anthropic")).toBeUndefined();
  });
});

describe("client-wire log channel", () => {
  test("events recorded before the subscription replay in order, later ones go straight through", () => {
    const log = createClientWireLog();
    const seen: ClientWireLogEvent["kind"][] = [];
    log.record({ kind: "observe", payload: {} });
    log.record({ kind: "terminal", status: "completed", payload: {} });
    log.subscribe(event => { seen.push(event.kind); });
    log.record({ kind: "cancel" });
    expect(seen).toEqual(["observe", "terminal", "cancel"]);
  });

  test("the channel is attached per Response identity", () => {
    const log = createClientWireLog();
    const response = attachClientWireLog(new Response("x"), log);
    expect(clientWireLogOf(response)).toBe(log);
    expect(clientWireLogOf(response.clone())).toBeUndefined();
  });
});

describe("deferred request log of a client-wire response", () => {
  const terminalPayload = (usage: Record<string, unknown> | null) => ({
    type: "response.completed",
    response: { id: "r", object: "response", status: "completed", model: "internal/model", output: [], usage },
  });

  test("the terminal writes one row with the tap's status mapping; a later cancel is ignored", () => {
    const rows: RequestLogEntry[] = [];
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    const log = createClientWireLog();
    const response = attachClientWireLog(markClientWire(new Response("data: x\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }), "chat"), log);
    const wrapped = responseWithDeferredRequestLog(response, "cw-1", Date.now(), logCtx, entry => rows.push(entry));
    expect(wrapped).toBe(response);
    expect(clientWireOf(wrapped)).toBe("chat");
    expect(rows).toHaveLength(0);
    log.record({
      kind: "terminal",
      status: "completed",
      payload: terminalPayload({ input_tokens: 11, output_tokens: 3, total_tokens: 14 }),
    });
    log.record({ kind: "cancel" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 200, terminalStatus: "completed", closeReason: "terminal" });
    expect(logCtx.transportPhase).toBe("terminal_sse");
    expect(logCtx.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
  });

  test("a cancel before any terminal is a 499 client cancel", () => {
    const rows: RequestLogEntry[] = [];
    const log = createClientWireLog();
    const response = attachClientWireLog(markClientWire(new Response("x"), "messages"), log);
    responseWithDeferredRequestLog(response, "cw-2", Date.now(), { model: "m", provider: "p" }, entry => rows.push(entry));
    log.record({ kind: "cancel" });
    log.record({ kind: "terminal", status: "completed", payload: terminalPayload(null) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 499, closeReason: "client_cancel" });
  });
});

describe("deliverClientEncodedResponse", () => {
  const usage: OcxUsage = { inputTokens: 9, outputTokens: 4 };
  const events: AdapterEvent[] = [
    { type: "text_delta", text: "hi" },
    { type: "done", usage },
  ];

  function delivery(stream: boolean, logCtx: RequestLogContext) {
    const calls: string[] = [];
    const completed: Record<string, unknown>[] = [];
    const bound: (OcxUsage | undefined)[] = [];
    return {
      calls,
      completed,
      bound,
      input: {
        encoder: { protocol: "chat" as const, stream, model: "client-model" },
        events: replay(events),
        logCtx,
        translatorBudget: createTestTranslatorBudget(),
        responseModelId: "internal/model",
        adapterName: "anthropic",
        fold: {},
        stopUpstream: () => { calls.push("stopUpstream"); },
        onStreamDone: () => { calls.push("streamDone"); },
        onCompletedResponse: (response: Record<string, unknown>) => { completed.push(response); },
        bindUsage: (value: OcxUsage | undefined) => { bound.push(value); },
      },
    };
  }

  test("streams the client wire, runs the completion effects once and marks the response", async () => {
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    beginInferenceAttempt(logCtx, { provider: "p", model: "m", adapter: "anthropic" });
    markProtocolEntry(logCtx, { inbound: "chat", lane: "bridge" });
    const run = delivery(true, logCtx);
    const response = await deliverClientEncodedResponse(run.input);
    expect(clientWireOf(response)).toBe("chat");
    expect(clientWireLogOf(response)).toBeDefined();
    const text = await response.text();
    expect(text).toContain("\"content\":\"hi\"");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(run.completed).toHaveLength(1);
    expect(run.completed[0]).toMatchObject({ status: "completed", model: "internal/model" });
    expect(run.bound).toEqual([usage]);
    expect(run.calls).toEqual(["stopUpstream", "streamDone"]);

    const trace = protocolTraceForRequest(logCtx, logCtx.attempts);
    expect(trace).toMatchObject({
      inbound: "chat",
      mode: "legacy-bridge",
      upstream: "messages",
      requestPath: ["chat", "responses-internal", "ir", "messages"],
      responsePath: ["messages", "ir", "chat"],
    });
  });

  test("a non-streaming client receives the folded completion with its terminal already logged", async () => {
    const rows: RequestLogEntry[] = [];
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    const run = delivery(false, logCtx);
    const response = await deliverClientEncodedResponse(run.input);
    expect(response.status).toBe(200);
    expect(clientWireOf(response)).toBe("chat");
    responseWithDeferredRequestLog(response, "cw-3", Date.now(), logCtx, entry => rows.push(entry));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ terminalStatus: "completed", closeReason: "terminal" });
    const body = await response.json() as { object: string; model: string; choices: { message: { content: string } }[] };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("client-model");
    expect(body.choices[0]!.message.content).toBe("hi");
    expect(run.completed).toHaveLength(1);
  });
});
