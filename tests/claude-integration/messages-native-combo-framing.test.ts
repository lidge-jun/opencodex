import { expect, test } from "bun:test";
import { preflightNativeMessagesResponse } from "../../src/server/messages-native-preflight";
import { tapAnthropicSseForLog } from "../../src/server/messages-shared";
import type { RequestLogContext } from "../../src/server/request-log";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../../src/server/sse-frame-buffer";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const refusal = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "fixture-private-echo" } });
const prelude = 'event: message_start\ndata: {"type":"message_start","message":{"content":[],"usage":{"input_tokens":5,"output_tokens":0}}}\n\n';

for (const [name, eventLines, failed] of [
  ["ordinary error", "event: error\n", true],
  ["data-only error", "", true],
  ["last event is error", "event: ping\nevent: error\n", true],
  ["ping-named error", "event: ping\n", false],
  ["last event is ping", "event: error\nevent: ping\n", false],
  ["trailing-space event", "event: error \n", false],
  ["extra-leading-space event", "event:  error\n", false],
  ["explicit empty event", "event:\n", false],
] as const) {
  test(`native combo preflight shares the tap's SSE event identity: ${name}`, async () => {
    const raw = prelude + eventLines + `data: ${refusal}\n\n`;
    const logCtx: RequestLogContext = { model: "fixture", provider: "anth" };
    const source = new Response(raw).body!;
    const tapped = tapAnthropicSseForLog(source, logCtx, () => {}, { stallMs: 0, maxBytes: 0 });
    const result = await preflightNativeMessagesResponse(new Response(tapped, {
      headers: { "content-type": "text/event-stream" },
    }), logCtx, createTestTranslatorBudget());
    const text = await result.response.text();
    expect(result.kind).toBe(failed ? "failed" : "accepted");
    if (failed) {
      expect(result.response.status).toBe(503);
      expect(logCtx.upstreamError).toBe("Provider stream failed (503)");
      expect(logCtx.usage?.inputTokens).toBe(5);
    } else {
      expect(text.startsWith(raw)).toBe(true);
      expect(text).toContain("upstream stream ended before message_stop");
      expect(logCtx.terminalSource).toBe("synthetic");
      expect(logCtx.upstreamError).not.toContain("fixture-private-echo");
    }
  });
}

for (const newline of ["\r\n", "\r"]) {
  test(`native combo preflight recognizes a refusal across ${JSON.stringify(newline)} chunk boundaries`, async () => {
    const bytes = new TextEncoder().encode((prelude + `event: error\ndata: ${refusal}\n\n`).replaceAll("\n", newline));
    let index = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(index, ++index));
      },
    });
    const result = await preflightNativeMessagesResponse(new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }), { model: "fixture", provider: "anth" }, createTestTranslatorBudget());
    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(503);
    await result.response.body!.cancel();
  });
}

for (const raw of [
  'data: {broken}\n\n',
  'data: [DONE]\n\n',
  'data: null\n\n',
  ': keepalive\n\n'.repeat(Math.ceil(MAX_CLIENT_SSE_FRAME_BYTES / 1024) + 1),
  ':'.repeat(MAX_CLIENT_SSE_FRAME_BYTES + 1),
]) {
  test(`native combo preflight commits opaque or capped bytes (${raw.length} bytes)`, async () => {
    const response = new Response(raw + `event: error\ndata: ${refusal}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
    const result = await preflightNativeMessagesResponse(response,
      { model: "fixture", provider: "anth" }, createTestTranslatorBudget());
    expect(result.kind).toBe("accepted");
    expect(await result.response.text()).toBe(raw + `event: error\ndata: ${refusal}\n\n`);
  });
}
