import { expect, spyOn, test } from "bun:test";
import { tapAnthropicSseForLog } from "../../src/server/messages-shared";
import { createMessagesSseErrorFilter } from "../../src/server/messages-sse-error-filter";
import { MessagesSseFrameContext } from "../../src/lib/messages-sse-error-presentation";

test("failed client enqueue retains original tap observation without a rescue enqueue", async () => {
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3},"delta":{}}\n\n')); } });
  const frames = new MessagesSseFrameContext(), ctx: any = {}, calls: unknown[] = [];
  const enqueue = spyOn(ReadableStreamDefaultController.prototype, "enqueue").mockImplementation(() => { throw new Error("synthetic closed client"); });
  let tapped: ReadableStream<Uint8Array> | undefined;
  try {
    tapped = tapAnthropicSseForLog(source, ctx, (status, meta) => calls.push({ status, ...meta }), { maxBytes: 0, stallMs: 0 }, frames, createMessagesSseErrorFilter(frames));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(ctx.usage.outputTokens).toBe(3);
    expect(calls).toEqual([{ status: 502, terminalStatus: "failed", closeReason: "terminal" }]);
  } finally { enqueue.mockRestore(); await tapped?.cancel().catch(() => {}); }
});
