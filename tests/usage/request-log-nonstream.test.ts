import { describe, expect, test } from "bun:test";
import { responseWithDeferredRequestLog } from "../../src/server/relay";
import { MAX_RESPONSE_LOG_INSPECTION_BYTES } from "../../src/server/response-log-body";
import type { RequestLogContext, RequestLogEntry } from "../../src/server/request-log";

const encoder = new TextEncoder();
function tracked(response: Response, context?: RequestLogContext) {
  const entries: RequestLogEntry[] = [];
  const logCtx = context ?? { model: "requested-model", provider: "fixture-provider" };
  const result = responseWithDeferredRequestLog(response, "ocx-test-bounded-nonstream", Date.now(), logCtx,
    entry => { entries.push(entry); });
  return { result, entries, logCtx };
}
function pendingSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancellations: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel(reason) { cancellations.push(reason); },
  }, { highWaterMark: 0 });
  return { body, controller, cancellations };
}

describe("deferred non-stream request log integration", () => {
  test("keeps original response status, statusText, headers and invalid UTF-8 bytes", async () => {
    const payload = new Uint8Array([255, 0, 128, 13, 10]);
    const { result, entries } = tracked(new Response(payload, {
      status: 503, statusText: "Fixture Unavailable",
      headers: { "content-type": "text/plain", "x-fixture": "preserved" },
    }));
    expect(result.status).toBe(503);
    expect(result.statusText).toBe("Fixture Unavailable");
    expect(result.headers.get("x-fixture")).toBe("preserved");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(payload);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe(503);
  });

  test("inspects complete small JSON using the existing metadata parser", async () => {
    const payload = JSON.stringify({ model: "resolved-model", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } });
    const { result, entries } = tracked(new Response(payload, { headers: { "content-type": "application/json" } }));
    expect(await result.text()).toBe(payload);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.resolvedModel).toBe("resolved-model");
    expect(entries[0]?.status).toBe(200);
  });

  test("does not overwrite routed model/usage context from oversized JSON", async () => {
    const payload = JSON.stringify({ model: "do-not-inspect", padding: "x".repeat(MAX_RESPONSE_LOG_INSPECTION_BYTES) });
    const { result, entries, logCtx } = tracked(new Response(payload, { headers: { "content-type": "application/json" } }));
    expect(await result.text()).toBe(payload);
    expect(entries).toHaveLength(1);
    expect(logCtx.resolvedModel).toBeUndefined();
    expect(logCtx.model).toBe("requested-model");
    expect(logCtx.usage).toBeUndefined();
  });

  test("non-JSON diagnostic text still uses the existing redaction/parser path", async () => {
    const payload = "synthetic provider failed: " + "x".repeat(12000);
    const { result, entries } = tracked(new Response(payload, { status: 502, headers: { "content-type": "text/plain" } }));
    expect(await result.text()).toBe(payload);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.upstreamError?.startsWith("synthetic provider failed:")).toBe(true);
    expect(entries[0]?.upstreamError?.length).toBeLessThanOrEqual(500);
  });

  test("cancellation follows the existing 499 convention without changing wire status", async () => {
    const source = pendingSource();
    const { result, entries } = tracked(new Response(source.body, { status: 200, headers: { "content-type": "application/json" } }));
    const reader = result.body!.getReader();
    const pending = reader.read();
    await reader.cancel("fixture client left");
    await pending;
    expect(result.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe(499);
    expect(source.cancellations).toEqual(["fixture client left"]);
  });

  test("a read failure is logged once as 502 and rejects the consumer", async () => {
    const source = pendingSource();
    const { result, entries, logCtx } = tracked(new Response(source.body, { headers: { "content-type": "application/json" } }));
    const reader = result.body!.getReader();
    const first = reader.read();
    source.controller.enqueue(encoder.encode('{"model":"not-complete"}'));
    await first;
    const failed = reader.read();
    source.controller.error(new Error("fixture transport reset"));
    await expect(failed).rejects.toThrow("fixture transport reset");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe(502);
    expect(logCtx.resolvedModel).toBeUndefined();
  });

  test("a bodyless response is unaffected", () => {
    const original = new Response(null, { status: 204 });
    const { result, entries } = tracked(original);
    expect(result).toBe(original);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe(204);
  });

  test("an unrelated non-error binary response is unaffected", async () => {
    const original = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } });
    const { result, entries } = tracked(original);
    expect(result).toBe(original);
    expect(entries).toHaveLength(1);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
