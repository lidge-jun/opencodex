import { expect, test } from "bun:test";
import { echoRequestedModel } from "../../src/server/messages-native";
import { guardNativeMessagesEmptyToolCatalog } from "../../src/server/messages-native-tool-guard";
import { tapAnthropicSseForLog } from "../../src/server/messages-shared";
import { relaySseWithPayloadRewrite } from "../../src/server/sse-payload-rewrite";
import { createMessagesSseErrorFilter } from "../../src/server/messages-sse-error-filter";
import { MessagesSseFrameContext, messagesSseFrameHooks } from "../../src/lib/messages-sse-error-presentation";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { claudeOverflowSsePayload } from "../../src/claude/outbound";
import { SSE_SENTINEL, sseFrame } from "../helpers/messages-sse-cases";
const encode = (text: string) => new TextEncoder().encode(text);
for (const rewritten of [false, true]) for (const ending of ["", "\n", "\r", "\r\n"]) test(`local tail after unfinished upstream block: rewrite=${rewritten}, ending=${JSON.stringify(ending)}`, async () => {
  const frames = new MessagesSseFrameContext(), budget = createTranslatorBudget();
  const ctx: any = {}, calls: unknown[] = [];
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode("event: ping\ndata: partial" + ending)); }, pull() { throw new Error(SSE_SENTINEL); } });
  const filter = createMessagesSseErrorFilter(frames);
  const tapped = tapAnthropicSseForLog(source, ctx, (status, meta) => calls.push({ status, ...meta }), { stallMs: 0, maxBytes: 0 }, frames, rewritten ? undefined : filter);
  try {
    const output = rewritten ? relaySseWithPayloadRewrite(tapped, claudeOverflowSsePayload, budget, messagesSseFrameHooks(frames), filter) : tapped;
    const text = await new Response(output).text();
    expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(SSE_SENTINEL);
    expect(text).toContain('"message":"anthropic passthrough upstream stream failed"');
    expect(calls).toEqual([{ status: 502, terminalStatus: "failed", closeReason: "terminal" }]);
    expect(ctx.upstreamError).toContain(SSE_SENTINEL);
  } finally { budget.dispose(); }
});
for (const event of ["ping", "unknown", "", null]) test(`guard OR-type decision remains original under event ${event}`, async () => {
  const frames = new MessagesSseFrameContext(), budget = createTranslatorBudget();
  let cancellations = 0; const callbacks: string[] = [], ctx: any = {};
  const raw = `${event === null ? "" : `event: ${event}\n`}data: ${JSON.stringify({ type: "error", error: { type: "api_error", message: SSE_SENTINEL } })}\n\n`;
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode(raw)); }, cancel() { cancellations++; } });
  try {
    const guarded = guardNativeMessagesEmptyToolCatalog(source, budget, message => callbacks.push(message), undefined, frames);
    const tapped = tapAnthropicSseForLog(guarded, ctx, () => {}, { stallMs: 0, maxBytes: 0 }, frames, createMessagesSseErrorFilter(frames));
    const text = await new Response(tapped).text();
    expect(text.startsWith(raw)).toBe(true); expect(text).toContain(SSE_SENTINEL);
    expect(callbacks).toEqual([]); expect(cancellations).toBe(1);
  } finally { budget.dispose(); }
});
for (const rewrite of [false, true]) test(`echo flag survives guard, tap and rewrite=${rewrite}`, async () => {
  const frames = new MessagesSseFrameContext(), budget = createTranslatorBudget();
  const bytes = encode(sseFrame("message_start", { type: "message_start", message: { model: "fixed", usage: {} }, request_id: SSE_SENTINEL }));
  frames.register(bytes, { echoRenamedError: true });
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  try {
    const guarded = guardNativeMessagesEmptyToolCatalog(source, budget, () => { throw new Error("Unexpected refusal"); }, undefined, frames);
    const filter = createMessagesSseErrorFilter(frames);
    const tapped = tapAnthropicSseForLog(guarded, {}, () => {}, { stallMs: 0, maxBytes: 0 }, frames, rewrite ? undefined : filter);
    const text = await new Response(rewrite ? relaySseWithPayloadRewrite(tapped, claudeOverflowSsePayload, budget, messagesSseFrameHooks(frames), filter) : tapped).text();
    expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(SSE_SENTINEL);
    expect(text.startsWith('event: message_start\ndata: {"type":"error"')).toBe(true);
  } finally { budget.dispose(); }
});
test.each(["coalesced", "split CRLF", "standalone LF"] as const)("empty-tool guard settles a renamed start with %s", async framing => {
  const comment = ": heartbeat\r\n\r";
  const start = sseFrame("error", { type: "message_start", message: { model: "wire", usage: {} }, request_id: SSE_SENTINEL });
  const stop = sseFrame("message_stop", { type: "message_stop" });
  const chunks = framing === "coalesced" ? [comment + "\n" + start + stop]
    : framing === "split CRLF" ? [comment, "\n" + start + stop] : [comment, "\n", start + stop];
  const frames = new MessagesSseFrameContext();
  const budget = createTranslatorBudget();
  const settlements: unknown[] = [];
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encode(chunk));
    controller.close();
  } });
  try {
    const echoed = echoRequestedModel(source, "requested", frames);
    const guarded = guardNativeMessagesEmptyToolCatalog(echoed, budget, () => {
      throw new Error("Unexpected tool refusal");
    }, undefined, frames);
    const tapped = tapAnthropicSseForLog(guarded, {}, (status, meta) => settlements.push({ status, ...meta }),
      { stallMs: 0, maxBytes: 0 }, frames, createMessagesSseErrorFilter(frames));
    const text = await new Response(tapped).text();
    expect(settlements).toEqual([{ status: 200, closeReason: "terminal" }]);
    expect(text.startsWith(comment + '\nevent: message_start\ndata: {"type":"error"')).toBe(true);
    expect(text.endsWith(stop)).toBe(true);
    expect(text).not.toContain(SSE_SENTINEL);
  } finally {
    budget.dispose();
  }
});

test("guard replacement retires a colliding echo flag and preserves callback-before-output", async () => {
  const frames = new MessagesSseFrameContext(), budget = createTranslatorBudget(); const order: string[] = [];
  const bytes = encode(sseFrame("message_start", { type: "message_start", message: { content: [{ type: "tool_use", name: SSE_SENTINEL }] } }));
  frames.register(bytes, { echoRenamedError: true });
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel() { order.push("cancel"); } });
  try {
    const guarded = guardNativeMessagesEmptyToolCatalog(source, budget, () => order.push("callback"), undefined, frames);
    const text = await new Response(tapAnthropicSseForLog(guarded, {}, () => {}, { stallMs: 0, maxBytes: 0 }, frames, createMessagesSseErrorFilter(frames))).text();
    order.push("delivered");
    expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(SSE_SENTINEL);
    expect(text).toContain('"code":"undeclared_tool_call"');
    expect(text).toContain('"message":"routed provider emitted undeclared client tool; only request-declared tools may be called"');
    expect(order).toEqual(["callback", "cancel", "delivered"]);
  } finally { budget.dispose(); }
});
test("fixed data growth never becomes a new translation-budget admission", async () => {
  const raw = "event: error\ndata: x\n\n";
  const budget = createTranslatorBudget({ maxTurnBytes: Buffer.byteLength(raw) * 2 });
  const frames = new MessagesSseFrameContext();
  try {
    const text = await new Response(relaySseWithPayloadRewrite(new Response(raw).body!, value => value, budget, messagesSseFrameHooks(frames), createMessagesSseErrorFilter(frames))).text();
    expect(text.length).toBeGreaterThan(raw.length * 2); expect(text).toContain('"type":"api_error"');
  } finally { budget.dispose(); }
});
