import { captureAnthropicRejectionPayloads, bindAnthropicRejectionResponse } from "../../src/adapters/anthropic-rejection-memo";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { afterEach, expect, test } from "bun:test";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import { createAnthropicThinkingRecovery, isAnthropicThinkingSignatureBindingRejectionMessage } from "../../src/server/responses/anthropic-thinking-recovery";
import { clearReasoningReplayCacheForTests, reasoningReplayOpaqueBlobRejectionMemoized } from "../../src/responses/reasoning-replay-cache";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";

const MESSAGE = "Invalid `signature` in `thinking` block. The block is bound to a different conversation.";
const rejection: AdapterEvent = { type: "error", status: 400, message: MESSAGE };
const success: AdapterEvent[] = [{ type: "text_delta", text: "answer" }, { type: "done" }];
function parsed(): OcxParsedRequest {
  return {
    modelId: "synthetic-model", stream: true, options: {},
    context: { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "prior", signature: "SyntheticSignature123456==" }] }] },
    _reasoningReplayScope: { clientThreadId: "synthetic-thread", current: {
      providerName: "synthetic-provider", adapterName: "anthropic", modelId: "synthetic-model",
      providerDestinationIdentity: "destination", providerDestinationDurableIdentity: "durable-destination",
      credentialIdentity: "credential", credentialDurableIdentity: "durable-credential",
    } },
  };
}
async function* stream(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> { yield* events; }
async function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const result: AdapterEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function httpRejection(message = MESSAGE): Response {
  const response = Response.json({ error: { message } }, { status: 400 });
  const request = { url: "https://example.test", method: "POST", headers: {}, body: "" };
  const budget = createTranslatorBudget();
  captureAnthropicRejectionPayloads(request, { messages: [{ role: "assistant", content: [
    { type: "thinking", signature: "SyntheticSignature123456==" },
  ] }] }, budget);
  bindAnthropicRejectionResponse(request, response);
  budget.dispose();
  return response;
}
function fixture() {
  const request = parsed();
  const abort = new AbortController();
  const guard = { attempted: false };
  const recovery = createAnthropicThinkingRecovery(request, abort.signal, guard, () => true);
  return { request, abort, guard, recovery };
}
afterEach(() => clearReasoningReplayCacheForTests());

test("classifier requires both exact validation phrases including backticks", () => {
  expect(isAnthropicThinkingSignatureBindingRejectionMessage(MESSAGE)).toBe(true);
  for (const message of [MESSAGE.replaceAll("`", ""), "Invalid `signature` in `thinking` block", "The block is bound to a different conversation", "invalid signature"]) {
    expect(isAnthropicThinkingSignatureBindingRejectionMessage(message)).toBe(false);
  }
});

for (const prefix of [
  { type: "heartbeat", replayUnsafe: true },
  { type: "assistant_boundary" },
  { type: "thinking_signature", signature: "new-signature" },
  { type: "redacted_thinking", data: "new-redacted" },
  { type: "web_search_call_begin", id: "search-effect" },
] satisfies AdapterEvent[]) {
  test(`replay fence retains ${prefix.type} and the original rejection`, async () => {
    const { recovery, guard } = fixture();
    let retried = false;
    const events = [prefix, rejection];
    expect(await collect(recovery.wrap(stream(events), () => { retried = true; return stream(success); }, () => "anthropic"))).toEqual(events);
    expect(retried).toBe(false);
    expect(guard.attempted).toBe(false);
  });
}

test("harmless ready heartbeats allow exactly one retry and close the old iterator first", async () => {
  const { recovery, guard, request } = fixture();
  let closed = false;
  let calls = 0;
  const original = (async function* () {
    try { yield { type: "heartbeat", preflightReady: true } as AdapterEvent; yield rejection; }
    finally { closed = true; }
  })();
  const events = await collect(recovery.wrap(original, () => {
    expect(closed).toBe(true);
    calls++;
    return stream([rejection]);
  }, () => "anthropic"));
  expect(events).toEqual([{ type: "heartbeat", preflightReady: true }, rejection]);
  expect(calls).toBe(1);
  expect(guard.attempted).toBe(true);
  expect(request._stripReasoningEncryptedContent).toBe(true);
  expect(request._dropForeignReasoningItemIds).toBe(true);
});

test("HTTP classification keeps incomplete/non-JSON/non-replayable bodies terminal", async () => {
  const marked = Response.json({ error: { message: MESSAGE } }, { status: 400 });
  markResponseNonReplayable(marked);
  for (const response of [new Response(MESSAGE, { status: 400 }), Response.json({ error: { message: MESSAGE.slice(0, 30) } }, { status: 400 }), Response.json({ error: { message: MESSAGE } }, { status: 500 }), marked]) {
    const { recovery, guard } = fixture();
    expect(await recovery.prepareHttp(response, "anthropic")).toBe(false);
    expect(guard.attempted).toBe(false);
    expect(response.bodyUsed).toBe(false);
  }
});

test("provider, missing state, pre-stripped and spent guards cannot arm recovery", async () => {
  for (const variant of ["provider", "state", "stripped", "attempted", "aborted"] as const) {
    const { recovery, request, guard, abort } = fixture();
    if (variant === "state") request.context.messages = [];
    if (variant === "stripped") request._stripReasoningEncryptedContent = true;
    if (variant === "attempted") guard.attempted = true;
    if (variant === "aborted") abort.abort();
    const events = await collect(recovery.wrap(stream([rejection]), () => { throw new Error("unexpected retry"); }, () => variant === "provider" ? "openai-chat" : "anthropic"));
    expect(events).toEqual([rejection]);
  }
});

test("redacted-only history qualifies, and HTTP success alone does not memoize", async () => {
  const { recovery, request } = fixture();
  request.context.messages = [{ role: "assistant", content: [{ type: "thinking", thinking: "", redacted: ["synthetic-redacted"] }] }];
  expect(await recovery.prepareHttp(httpRejection(), "anthropic")).toBe(true);
  recovery.rememberSuccess({ status: "completed", output: [{ type: "message" }] });
  expect(reasoningReplayOpaqueBlobRejectionMemoized(request._reasoningReplayScope)).toBe(false);
  await collect(recovery.wrap(stream(success), () => { throw new Error("unexpected retry"); }, () => "anthropic"));
  recovery.rememberSuccess({ status: "completed", output: [{ type: "message" }] });
  expect(reasoningReplayOpaqueBlobRejectionMemoized(request._reasoningReplayScope)).toBe(true);
});

for (const variant of ["empty", "no-terminal", "error", "incomplete", "cancelled", "changed-identity", "changed-thread", "failed-fold"] as const) {
  test(`does not memoize a ${variant} replacement`, async () => {
    const { recovery, request, abort } = fixture();
    const rejectedScope = structuredClone(request._reasoningReplayScope);
    const events: AdapterEvent[] = variant === "empty" ? [{ type: "done" }]
      : variant === "no-terminal" ? [success[0]!]
      : variant === "error" ? [success[0]!, rejection]
      : variant === "incomplete" ? [success[0]!, { type: "incomplete", reason: "max_output_tokens" }]
      : success;
    await collect(recovery.wrap(stream([rejection]), () => stream(events), () => "anthropic"));
    if (variant === "cancelled") abort.abort();
    if (variant === "changed-identity") request._reasoningReplayScope!.current = { ...request._reasoningReplayScope!.current!, credentialDurableIdentity: "another-credential" };
    if (variant === "changed-thread") request._reasoningReplayScope = { ...request._reasoningReplayScope!, clientThreadId: "another-thread" };
    recovery.rememberSuccess({ status: variant === "failed-fold" ? "failed" : "completed", output: [{ type: "message" }] });
    expect(reasoningReplayOpaqueBlobRejectionMemoized(rejectedScope)).toBe(false);
    expect(reasoningReplayOpaqueBlobRejectionMemoized(request._reasoningReplayScope)).toBe(false);
  });
}

test("a stray tool-end and done cannot memoize an empty validated output", async () => {
  const { recovery, request } = fixture();
  await collect(recovery.wrap(stream([rejection]), () => stream([
    { type: "tool_call_end" }, { type: "done" },
  ]), () => "anthropic"));
  recovery.rememberSuccess({ status: "completed", output: [] });
  expect(reasoningReplayOpaqueBlobRejectionMemoized(request._reasoningReplayScope)).toBe(false);
});
