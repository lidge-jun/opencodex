import { describe, expect, test } from "bun:test";
import {
  CODEX_MODEL_CAPACITY_MESSAGE,
  inspectCodexCapacityBeforeOutput,
  isCodexCapacityPayload,
} from "../src/server/responses/codex-capacity";

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("Codex model-capacity classification", () => {
  test("accepts structured code/type and only the exact standard message", () => {
    expect(isCodexCapacityPayload({ error: { code: "server_is_overloaded" } })).toBe(true);
    expect(isCodexCapacityPayload({ error: { type: "slow_down" } })).toBe(true);
    expect(isCodexCapacityPayload({ error: { message: CODEX_MODEL_CAPACITY_MESSAGE } })).toBe(true);
    expect(isCodexCapacityPayload({
      error: { message: `${CODEX_MODEL_CAPACITY_MESSAGE} retry later` },
    })).toBe(false);
    expect(isCodexCapacityPayload({ error: { message: "model unavailable" } })).toBe(false);
  });

  test("recognizes a fragmented SSE error after lifecycle-only frames", async () => {
    const source = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: error\ndata: {"type":"error","error":{"message":"Selected model is at ',
      'capacity. Please try a different model."}}\n\n',
    ];
    const inspected = await inspectCodexCapacityBeforeOutput(sseResponse(source), {
      streamRequested: true,
    });
    expect(inspected.kind).toBe("capacity");
    expect(await inspected.response.text()).toBe(source.join(""));
  });

  test("any substantive event commits the stream and forbids capacity replay", async () => {
    const source = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\n',
      `event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "server_is_overloaded", message: "busy" },
        },
      })}\n\n`,
    ].join("");
    const inspected = await inspectCodexCapacityBeforeOutput(sseResponse([source]), {
      streamRequested: true,
    });
    expect(inspected.kind).toBe("pass");
    expect(await inspected.response.text()).toBe(source);
  });

  test("non-capacity transient response stays byte-for-byte readable", async () => {
    const body = JSON.stringify({ error: { code: "upstream_server_error", message: "gateway reset" } });
    const inspected = await inspectCodexCapacityBeforeOutput(new Response(body, {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "application/json", "x-origin": "kept" },
    }), { streamRequested: false });
    expect(inspected.kind).toBe("pass");
    expect(inspected.response.status).toBe(502);
    expect(inspected.response.statusText).toBe("Bad Gateway");
    expect(inspected.response.headers.get("x-origin")).toBe("kept");
    expect(await inspected.response.text()).toBe(body);
  });
});
