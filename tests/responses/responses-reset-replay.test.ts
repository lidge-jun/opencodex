import { describe, expect, test } from "bun:test";
import {
  ambiguousResendAllowanceFor,
  selfContainedChatBody,
  selfContainedResponsesBody,
} from "../../src/server/responses/reset-replay";
import { authorizeResendForRecovery } from "../../src/lib/request-resend-gate";
import { deferProtocolSafeResetRecovery } from "../../src/server/responses/combo-stream-preflight";

const prelude = 'event: response.created\ndata: {"type":"response.created","response":{"id":"first","output":[]}}\n\n';
const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"second","output":[]}}\n\n';
const responseLog = { model: "test", provider: "test" };

describe("deferred response metadata", () => {
  const baseHeaders = { "content-type": "text/event-stream", "x-request-id": "id-one", "x-codex-turn-state": "turn-one", "x-ratelimit-remaining-requests": "7", "x-model": "model-one" };
  test.each([
    ["status", { status: 201, headers: baseHeaders }],
    ["status text", { statusText: "Different", headers: baseHeaders }],
    ["content type", { headers: { ...baseHeaders, "content-type": "application/json" } }],
    ["turn state", { headers: { ...baseHeaders, "x-codex-turn-state": "turn-two" } }],
    ["quota", { headers: { ...baseHeaders, "x-ratelimit-remaining-requests": "6" } }],
    ["model", { headers: { ...baseHeaders, "x-model": "model-two" } }],
    ["request id", { headers: { ...baseHeaders, "x-request-id": "id-two" } }],
    ["missing header", { headers: { "content-type": "text/event-stream" } }],
    ["extra header", { headers: { ...baseHeaders, "x-new-provider-field": "value" } }],
    ["set-cookie", { headers: { ...baseHeaders, "set-cookie": "fixture=value" } }],
  ])("refuses a replacement with different %s and cancels its body", async (_name, replacementInit) => {
    let cancelled = false;
    const original = new Response(prelude, { headers: baseHeaders });
    const replacement = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode(completed)); controller.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), replacementInit);
    const result = deferProtocolSafeResetRecovery(original, responseLog, async () => replacement, { keepalive: "none" });
    expect(await result.text()).toBe(prelude);
    expect(result.status).toBe(200);
    expect([...result.headers]).toEqual([...original.headers]);
    expect(cancelled).toBe(true);
  });

  test("accepts equal metadata and leaves ordinary calls unchanged", async () => {
    const original = new Response(prelude, { headers: baseHeaders });
    const result = deferProtocolSafeResetRecovery(original, responseLog, async () => new Response(completed, { headers: baseHeaders }), { keepalive: "none" });
    expect(await result.text()).toBe(completed);
    expect([...result.headers]).toEqual([...original.headers]);
    let recovered = false;
    const ordinary = new Response(completed, { headers: baseHeaders });
    const unchanged = deferProtocolSafeResetRecovery(ordinary, responseLog, async () => { recovered = true; return null; }, { keepalive: "none" });
    expect(await unchanged.text()).toBe(completed);
    expect([...unchanged.headers]).toEqual([...ordinary.headers]);
    expect(recovered).toBe(false);
  });

  test("refuses a changed repeated header", async () => {
    const first = new Headers(baseHeaders);
    first.append("set-cookie", "a=1");
    first.append("set-cookie", "b=2");
    const second = new Headers(baseHeaders);
    second.append("set-cookie", "a=1");
    second.append("set-cookie", "b=3");
    const result = deferProtocolSafeResetRecovery(new Response(prelude, { headers: first }), responseLog,
      async () => new Response(completed, { headers: second }), { keepalive: "none" });
    expect(await result.text()).toBe(prelude);
  });

  test("retains the original read error on metadata refusal", async () => {
    const failure = new Error("original reset");
    let sent = false;
    const original = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prelude)); }
      else controller.error(failure);
    } }), { headers: baseHeaders });
    const result = deferProtocolSafeResetRecovery(original, responseLog, async () => new Response(completed, {
      headers: { ...baseHeaders, "x-request-id": "id-two" },
    }), { keepalive: "none" });
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(prelude);
    await expect(reader.read()).rejects.toBe(failure);
  });

  test("cancels a replacement arriving after the client disconnects", async () => {
    let announce!: () => void;
    let resolveReplacement!: (response: Response) => void;
    let cancelled = false;
    let aborted = false;
    const started = new Promise<void>(resolve => { announce = resolve; });
    const pending = new Promise<Response>(resolve => { resolveReplacement = resolve; });
    const result = deferProtocolSafeResetRecovery(new Response(prelude, { headers: baseHeaders }), responseLog,
      async (_error, _stage, signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        announce();
        return pending;
      }, { keepalive: "none" });
    const reader = result.body!.getReader();
    const read = reader.read();
    await started;
    await reader.cancel("client disconnected");
    expect(aborted).toBe(true);
    const cancelledBody = new Promise<void>(resolve => {
      resolveReplacement(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; resolve(); } },
        { highWaterMark: 0 }), { headers: baseHeaders }));
    });
    await cancelledBody;
    expect(cancelled).toBe(true);
    await read;
  });
});

const clientTurn = {
  store: false,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", name: "read", call_id: "c1", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "ok" },
  ],
  tools: [{ type: "function", name: "read" }],
};

describe("selfContainedResponsesBody", () => {
  test("accepts a turn whose second send can only repeat the inference", () => {
    expect(selfContainedResponsesBody(clientTurn)).toBe(true);
    expect(selfContainedResponsesBody({ store: false, input: "plain prompt" })).toBe(true);
    expect(selfContainedResponsesBody({
      store: false,
      input: [{ role: "user", content: "hi" }],
    })).toBe(true);
  });

  test("refuses anything that leaves state behind or continues someone else's turn", () => {
    for (const override of [
      { store: true },
      { store: undefined },
      { background: true },
      { previous_response_id: "resp_1" },
      { conversation: "conv_1" },
      { stream_id: undefined },
      { input: undefined },
      { input: { not: "a list" } },
    ]) {
      expect(selfContainedResponsesBody({ ...clientTurn, ...override })).toBe(false);
    }
    expect(selfContainedResponsesBody(null)).toBe(false);
    expect(selfContainedResponsesBody([clientTurn])).toBe(false);
  });

  test("refuses a catalog carrying anything the origin would execute", () => {
    for (const tools of [
      [{ type: "web_search" }],
      [{ type: "function", name: "read" }, { type: "mcp", server_label: "s" }],
      [{ type: "tool_search", execution: "server" }],
      [{ type: "namespace", name: "ns", tools: [{ type: "code_interpreter" }] }],
      [{ type: "namespace" }],
      "not a list",
    ]) {
      expect(selfContainedResponsesBody({ ...clientTurn, tools })).toBe(false);
    }
    expect(selfContainedResponsesBody({
      ...clientTurn,
      tools: [{ type: "namespace", name: "ns", tools: [{ type: "function", name: "read" }] }],
    })).toBe(true);
  });

  test("a hosted tool cannot ride in through a deferred declaration", () => {
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [...clientTurn.input, { type: "additional_tools", tools: [{ type: "web_search" }] }],
    })).toBe(false);
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [...clientTurn.input, { type: "tool_search_output", tools: [{ type: "function", name: "read" }] }],
    })).toBe(true);
  });

  test("an input item type this proxy does not recognise is refused", () => {
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [{ type: "image_generation_call", id: "ig1" }],
    })).toBe(false);
  });
});

describe("selfContainedChatBody", () => {
  const chatTurn = {
    model: "mock/test-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read" } }],
  };

  test("accepts a Chat turn whose second send can only repeat the inference", () => {
    expect(selfContainedChatBody(chatTurn)).toBe(true);
    expect(selfContainedChatBody({ model: "m", messages: [] })).toBe(true);
  });

  test("refuses anything that leaves state behind or continues someone else's turn", () => {
    for (const override of [
      { store: true },
      { previous_response_id: "resp_1" },
      { messages: undefined },
      { messages: "not a list" },
    ]) {
      expect(selfContainedChatBody({ ...chatTurn, ...override })).toBe(false);
    }
    expect(selfContainedChatBody(null)).toBe(false);
    expect(selfContainedChatBody([chatTurn])).toBe(false);
  });

  test("refuses hosted execution requested outside the tool catalog", () => {
    expect(selfContainedChatBody({ ...chatTurn, web_search_options: {} })).toBe(false);
    expect(selfContainedChatBody({ ...chatTurn, web_search_options: undefined })).toBe(true);
  });

  test("refuses a catalog carrying a tool the origin would execute", () => {
    for (const tools of [
      [{ type: "web_search" }],
      [{ type: "function", function: { name: "read" } }, { type: "code_interpreter" }],
      [{ function: { name: "read" } }],
      "not a list",
    ]) {
      expect(selfContainedChatBody({ ...chatTurn, tools })).toBe(false);
    }
  });
});

describe("ambiguousResendAllowanceFor", () => {
  test("absent or disabled policy grants nothing", () => {
    const claim = () => true;
    expect(ambiguousResendAllowanceFor({}, () => true, claim)).toBeUndefined();
    expect(ambiguousResendAllowanceFor({ retryOnReset: { enabled: false } }, () => true, claim)).toBeUndefined();
  });

  test("a bare opt-in spends one replacement for the whole request", () => {
    const limits: number[] = [];
    let left = 1;
    const grant = ambiguousResendAllowanceFor({ retryOnReset: {} }, () => true, limit => {
      limits.push(limit);
      return left-- > 0;
    })!;
    expect(grant.selfContained).toBe(true);
    expect(grant.claim()).toBe(true);
    expect(grant.claim()).toBe(false);
    // Both questions were asked at the same ceiling, against the one request-wide counter.
    expect(limits).toEqual([1, 1]);
  });

  test("the body judgment is lazy and reaches the gate as a refusal reason", () => {
    let judged = 0;
    const grant = ambiguousResendAllowanceFor({ retryOnReset: {} }, () => { judged += 1; return false; }, () => true)!;
    expect(judged).toBe(0);
    const decision = authorizeResendForRecovery("pre-header", "connection-reset", grant);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.refusal).toBe("ambiguous-request-not-replayable");
    expect(judged).toBe(1);
  });

  test("a provider that opted in still funds only what the operator asked for", () => {
    const seen: number[] = [];
    const grant = ambiguousResendAllowanceFor(
      { retryOnReset: { replacements: 2 } },
      () => true,
      limit => { seen.push(limit); return true; },
    )!;
    expect(grant.claim()).toBe(true);
    expect(seen).toEqual([2]);
  });
});
