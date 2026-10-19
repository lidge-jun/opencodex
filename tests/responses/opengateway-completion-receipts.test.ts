import { describe, expect, test } from "bun:test";
import { EMPTY_COMPLETION_MAX_BUFFERED_BYTES } from "../../src/server/responses/empty-completion-guard";
import { guardOpenGatewayCompletion } from "../../src/server/responses/opengateway-completion-guard";
import { attachResponseToolOwnership, responseToolOwnership } from "../../src/server/responses/response-tool-ownership";

const url = "https://apis.opengateway.ai/v1/responses";
const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

function snapshot(usage = { input_tokens: 2, output_tokens: 1 }, output: unknown[] = []) {
  return { id: "resp_1", object: "response", status: "completed", output, usage, error: null, incomplete_details: null };
}

function sse(events: unknown[], extra: Uint8Array[] = []): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encode(event));
      for (const chunk of extra) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function run(
  source: Response,
  extra: Record<string, unknown> = {},
  retrySource?: () => Response,
  signal = new AbortController().signal,
  timeouts: { holdTimeoutMs?: number; stallTimeoutMs?: number } = {},
) {
  const usages: unknown[] = [];
  let retries = 0;
  const result = await guardOpenGatewayCompletion(source, {
    url,
    body: { stream: source.headers.get("content-type")?.includes("event-stream") === true, store: false, input: "question", ...extra },
    signal,
    recordUsage(usage) { usages.push(usage); },
    retry: async () => {
      retries += 1;
      return retrySource?.() ?? Response.json(snapshot({ input_tokens: 9, output_tokens: 8 }));
    },
    ...timeouts,
  });
  return { result, usages, retries };
}

function head(text: string): { event: string; data: { type: string; response: Record<string, unknown> } } {
  const event = text.match(/^event: (\S+)/)?.[1];
  const dataLine = text.match(/^data: (.+)$/m)?.[1];
  if (!event || !dataLine) throw new Error(`missing SSE head: ${text.slice(0, 180)}`);
  return { event, data: JSON.parse(dataLine) };
}

describe("OpenGateway completion exact-head receipts", () => {
  test("SSE empty failure head is response.failed after one physical retry", async () => {
    const first = snapshot();
    const second = snapshot({ input_tokens: 4, output_tokens: 3 });
    const f = await run(sse([{ type: "response.completed", response: first }]), {}, () => sse([{ type: "response.completed", response: second }]));
    const text = await f.result.text();
    const parsed = head(text);
    expect(f.result.status).toBe(200);
    expect(f.result.headers.get("content-type")).toBe("text/event-stream");
    expect(parsed.event).toBe("response.failed");
    expect(parsed.data.type).toBe("response.failed");
    expect(parsed.data.response.status).toBe("failed");
    expect(parsed.data.response.error).toEqual({
      type: "upstream_error",
      code: "empty_completion_retry_failed",
      message: "OpenGateway returned no usable completion before output.",
    });
    expect(parsed.data.response.incomplete_details).toBeUndefined();
    expect(text).not.toContain("response.completed");
    expect(f.retries).toBe(1);
    expect(f.usages).toEqual([first.usage, second.usage]);
  });

  test("JSON empty failure head is 502 and records each attempt once", async () => {
    const first = snapshot();
    const second = snapshot({ input_tokens: 4, output_tokens: 3 });
    const owned = new Set([{ itemType: "web_search_call", callIdPrefix: "ws_" }]);
    const retry = Response.json(second);
    attachResponseToolOwnership(retry, owned);
    const f = await run(Response.json(first), {}, () => retry);
    const body = await f.result.json() as Record<string, unknown>;
    expect(f.result.status).toBe(502);
    expect(f.result.headers.get("content-type")).toContain("application/json");
    expect(body.status).toBe("failed");
    expect(body.error).toEqual({
      type: "upstream_error",
      code: "empty_completion_retry_failed",
      message: "OpenGateway returned no usable completion before output.",
    });
    expect(body.incomplete_details).toBeUndefined();
    expect(f.retries).toBe(1);
    expect(f.usages).toEqual([first.usage, second.usage]);
    expect(responseToolOwnership(f.result)).toEqual(owned);
  });

  test("reason-only JSON is not a delivered answer", async () => {
    const reasonOnly = snapshot({ input_tokens: 3, output_tokens: 2 }, [
      { id: "rs_1", type: "reasoning", summary: [] },
    ]);
    const answer = {
      ...snapshot({ input_tokens: 3, output_tokens: 2 }),
      id: "resp_answer",
      output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer" }] }],
    };
    const f = await run(Response.json(reasonOnly), {}, () => Response.json(answer));
    expect(f.retries).toBe(1);
    expect(f.usages).toEqual([reasonOnly.usage]);
    expect(await f.result.json()).toMatchObject({ id: "resp_answer", status: "completed" });
  });

  test("an empty output array is the same retry class as reason-only", async () => {
    const empty = snapshot({ input_tokens: 1, output_tokens: 0 }, []);
    const f = await run(Response.json(empty), {}, () => Response.json(empty));
    const body = await f.result.json() as { status: string; error: { code: string } };
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("empty_completion_retry_failed");
    expect(f.retries).toBe(1);
    expect(f.usages).toEqual([empty.usage, empty.usage]);
  });

  for (const streaming of [false, true]) {
    test(`${streaming ? "SSE" : "JSON"} max-output incomplete does not retry`, async () => {
      const body = snapshot({ input_tokens: 6, output_tokens: 16 });
      const source = streaming
        ? sse([{ type: "response.completed", response: body }])
        : Response.json(body);
      const f = await run(source, { max_output_tokens: 16 }, () => { throw new Error("retry"); });
      expect(f.retries).toBe(0);
      expect(f.usages).toEqual([body.usage]);
      expect(f.result.status).toBe(200);
      if (streaming) {
        const text = await f.result.text();
        const parsed = head(text);
        expect(f.result.headers.get("content-type")).toBe("text/event-stream");
        expect(parsed.event).toBe("response.incomplete");
        expect(parsed.data.response.status).toBe("incomplete");
        expect(parsed.data.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
        expect(parsed.data.response.error).toBeUndefined();
        expect(text).not.toContain("response.completed");
      } else {
        expect(f.result.headers.get("content-type")).toContain("application/json");
        const parsed = await f.result.json() as { status: string; incomplete_details: unknown; error?: unknown };
        expect(parsed).toMatchObject({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        });
        expect(parsed.error).toBeUndefined();
      }
    });
  }

  test("a stalled read cancels the owned source and does not retry", async () => {
    let cancelled = false;
    const source = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }), { headers: { "content-type": "text/event-stream" } });
    const f = await run(source, {}, undefined, new AbortController().signal, { stallTimeoutMs: 10, holdTimeoutMs: 1_000 });
    await expect(f.result.text()).rejects.toEqual(expect.objectContaining({ name: "TimeoutError" }));
    expect(cancelled).toBe(true);
    expect(f.retries).toBe(0);
  });

  test("consumer cancel resolves without waiting on a hanging upstream cancel", async () => {
    let cancelled = false;
    const source = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encode({ type: "response.created" })); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }), { headers: { "content-type": "text/event-stream" } });
    const f = await run(source, {}, undefined, new AbortController().signal, { holdTimeoutMs: 10 });
    const outcome = await Promise.race([
      f.result.body?.cancel().then(() => "resolved"),
      Bun.sleep(50).then(() => "hung"),
    ]);
    expect(outcome).toBe("resolved");
    expect(cancelled).toBe(true);
    expect(f.retries).toBe(0);
  });

  test("a replay-unsafe control is an exact pass-through with no retry", async () => {
    const source = sse([{ type: "response.completed", response: snapshot(), replayUnsafe: true }]);
    const expected = await source.clone().text();
    const f = await run(source);
    expect(f.result.status).toBe(200);
    expect(f.result.headers.get("content-type")).toBe("text/event-stream");
    expect(await f.result.text()).toBe(expected);
    expect(f.retries).toBe(0);
    expect(f.usages).toEqual([]);
  });

  test("size expiry forwards the original chunk and does not cancel a healthy source", async () => {
    const original = new Uint8Array(EMPTY_COMPLETION_MAX_BUFFERED_BYTES + 8);
    original[0] = 7;
    let cancelled = false;
    const source = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(original); controller.close(); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
    const f = await run(source, { stream: false });
    const reader = f.result.body?.getReader();
    if (!reader) throw new Error("missing body");
    const first = await reader.read();
    expect(first.value).toBe(original);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(cancelled).toBe(false);
    expect(f.retries).toBe(0);
  });
});
