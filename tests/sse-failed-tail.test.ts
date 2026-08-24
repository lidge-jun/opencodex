import { describe, expect, test } from "bun:test";
import { relaySseWithFailedTail, relayWithAbort } from "../src/server";
import { relaySseEagerBounded, type EagerRelayHooks } from "../src/server/relay-eager";
import { MAX_TAIL_ERROR_MESSAGE_CHARS } from "../src/server/relay";
import { TranslatorBudgetExceededError } from "../src/lib/translator-budget";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sourceStream(chunks: readonly string[], opts: { failAfter?: boolean; error?: Error } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
        return;
      }
      if (opts.failAfter) {
        controller.error(opts.error ?? Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" }));
        return;
      }
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

const parityHooks: EagerRelayHooks = {
  inspectChunk() {},
  finishInspection() {},
  sawTerminal: () => false,
  onSynthetic() {},
  onClientCancel() {},
  onDone() {},
};

function failedMessage(text: string): string {
  const payload = text.split("event: response.failed\ndata: ")[1]?.split("\n")[0];
  if (!payload) throw new Error("missing response.failed payload");
  return (JSON.parse(payload) as { response: { error: { message: string } } }).response.error.message;
}

function terminalEvents(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap(line => {
      const match = line.match(/^event: (response\.(?:completed|failed|incomplete))$/);
      return match ? [match[1]!] : [];
    });
}

function doneEvents(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line === "data: [DONE]");
}

describe("relaySseWithFailedTail", () => {
  test("relays a healthy stream verbatim with no injected frame", async () => {
    const upstream = new AbortController();
    const src = sourceStream(["event: response.completed\n", 'data: {"type":"response.completed"}\n\n', "data: [DONE]\n\n"]);
    const out = await drain(relaySseWithFailedTail(src, upstream));
    expect(out).toBe('event: response.completed\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n');
    expect(out).not.toContain("response.failed");
    expect(upstream.signal.aborted).toBe(false);
  });

  test("closes at response.completed when the upstream keeps its SSE connection open", async () => {
    const upstream = new AbortController();
    let sourceCancelled = false;
    let sentTerminal = false;
    const src = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentTerminal) {
          sentTerminal = true;
          controller.enqueue(encoder.encode(
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          ));
        }
        // Deliberately never close: several Responses-compatible gateways keep
        // this connection alive after the protocol terminal event.
      },
      cancel() { sourceCancelled = true; },
    });

    const out = await Promise.race([
      drain(relaySseWithFailedTail(src, upstream)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("relay did not close at terminal")), 200)),
    ]);

    expect(out).toContain("response.completed");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(sourceCancelled).toBe(true);
    expect(upstream.signal.aborted).toBe(false);
  });

  test("drops frames coalesced after the terminal block", async () => {
    const upstream = new AbortController();
    const src = sourceStream([
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"must not leak"}\n\n',
    ]);

    const out = await drain(relaySseWithFailedTail(src, upstream));

    expect(out).toContain("response.completed");
    expect(out).not.toContain("must not leak");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("recognizes only a real DONE data event", async () => {
    const ordinaryText = 'data: {"type":"response.completed","response":{"status":"completed","note":"data: [DONE]"}}\n\n';
    const withRealDone = ordinaryText + "data: [DONE]\n\n";

    const ordinaryOut = await drain(relaySseWithFailedTail(sourceStream([ordinaryText]), new AbortController()));
    const realOut = await drain(relaySseWithFailedTail(sourceStream([withRealDone]), new AbortController()));

    expect(ordinaryOut.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(ordinaryOut.split("\ndata: [DONE]\n\n").length - 1).toBe(1);
    expect(realOut).toBe(withRealDone);
  });

  test("mid-stream error keeps prior bytes and appends a clean failed terminal", async () => {
    const upstream = new AbortController();
    const src = sourceStream(['data: {"type":"response.output_text.delta","delta":"hel', ""], { failAfter: true });
    const out = await drain(relaySseWithFailedTail(src, upstream));
    // Prior (partial) bytes preserved, then blank-line boundary, then the failed frame.
    expect(out.startsWith('data: {"type":"response.output_text.delta","delta":"hel')).toBe(true);
    expect(out).toContain("\n\nevent: response.failed\ndata: ");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    const dataLine = out.split("event: response.failed\ndata: ")[1]!.split("\n")[0]!;
    const parsed = JSON.parse(dataLine) as { type: string; response: { status: string; error: { code: string; message: string } } };
    expect(parsed.type).toBe("response.failed");
    expect(parsed.response.status).toBe("failed");
    expect(parsed.response.error.code).toBe("upstream_reset");
    expect(parsed.response.error.message).toContain("socket connection was closed unexpectedly");
    // Stream CLOSED (drain returned) rather than erroring, and the upstream fetch was aborted.
    expect(upstream.signal.aborted).toBe(true);
  });

  test("error before any bytes yields only the failed terminal", async () => {
    const upstream = new AbortController();
    const src = sourceStream([], { failAfter: true });
    const out = await drain(relaySseWithFailedTail(src, upstream));
    expect(out).toContain("event: response.failed\ndata: ");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("translator overflow failed tail preserves translation_buffer_limit", async () => {
    const upstream = new AbortController();
    const error = new TranslatorBudgetExceededError("live_transient", 32 * 1024 * 1024);
    const out = await drain(relaySseWithFailedTail(sourceStream([], { failAfter: true, error }), upstream));
    const payload = JSON.parse(out.split("event: response.failed\ndata: ")[1]!.split("\n")[0]!) as {
      response: { error: { code: string } };
    };
    expect(payload.response.error.code).toBe("translation_buffer_limit");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(upstream.signal.aborted).toBe(true);
  });

  test("client cancel aborts the upstream controller", async () => {
    const upstream = new AbortController();
    // A source that never ends on its own.
    const src = new ReadableStream<Uint8Array>({ pull() { /* stay pending */ } });
    const relayed = relaySseWithFailedTail(src, upstream);
    const reader = relayed.getReader();
    await reader.cancel(new DOMException("client closed", "AbortError"));
    expect(upstream.signal.aborted).toBe(true);
  });

  test("opt-in client-gone ownership cancels each branch reader without aborting upstream", async () => {
    for (const kind of ["sse", "plain"] as const) {
      const upstream = new AbortController();
      const reasons: unknown[] = [];
      let sourceCancels = 0;
      const src = new ReadableStream<Uint8Array>({
        pull() { /* stay pending */ },
        cancel() { sourceCancels += 1; },
      });
      const relayed = kind === "sse"
        ? relaySseWithFailedTail(src, upstream, reason => reasons.push(reason))
        : relayWithAbort(src, upstream, reason => reasons.push(reason))!;
      const reason = new DOMException(`${kind} client closed`, "AbortError");

      await relayed.getReader().cancel(reason);

      expect(reasons).toEqual([reason]);
      expect(sourceCancels).toBe(1);
      expect(upstream.signal.aborted).toBe(false);
    }
  });

  test("(090-10) legacy and eager failed tails are byte-identical before and after message truncation", async () => {
    for (const message of ["in-cap reset", `${"x".repeat(4_096)}-uncapped-suffix`]) {
      const error = new Error(message);
      const legacy = await drain(relaySseWithFailedTail(
        sourceStream([], { failAfter: true, error }),
        new AbortController(),
      ));
      const eager = await drain(relaySseEagerBounded(
        sourceStream([], { failAfter: true, error }),
        new AbortController(),
        parityHooks,
      ));

      expect(encoder.encode(eager)).toEqual(encoder.encode(legacy));
      if (message.length > MAX_TAIL_ERROR_MESSAGE_CHARS) {
        expect(failedMessage(eager).length).toBe(MAX_TAIL_ERROR_MESSAGE_CHARS);
        expect(failedMessage(legacy)).not.toContain("uncapped-suffix");
      }
    }
  });

  test("legacy and eager use the same bounded fallback when an error message getter throws", async () => {
    const error = new Error("unreachable");
    Object.defineProperty(error, "message", {
      get() { throw new Error("hostile message getter"); },
    });
    const legacy = await drain(relaySseWithFailedTail(
      sourceStream([], { failAfter: true, error }),
      new AbortController(),
    ));
    const eager = await drain(relaySseEagerBounded(
      sourceStream([], { failAfter: true, error }),
      new AbortController(),
      parityHooks,
    ));

    expect(encoder.encode(eager)).toEqual(encoder.encode(legacy));
    expect(failedMessage(eager)).toBe("Upstream stream terminated unexpectedly");
    expect(eager.split("data: [DONE]").length - 1).toBe(1);
  });

  test.each([
    [
      "clean EOF without a terminal",
      ['event: response.created\ndata: {"type":"response.created"}\n\n'],
      "incomplete",
    ],
    [
      "premature DONE followed by EOF",
      ["data: [DONE]\n\n"],
      "incomplete",
    ],
    [
      "valid delimiter-less terminal with LF",
      ['event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}'],
      "completed",
    ],
    [
      "valid delimiter-less terminal with CRLF",
      ['event: response.completed\r\ndata: {"type":"response.completed","response":{"status":"completed"}}'],
      "completed",
    ],
    [
      "high-confidence cyber_policy terminal normalization",
      [`event: error\ndata: ${JSON.stringify({
        type: "error",
        response: { id: "resp-policy-parity", status: "failed", output: [] },
        error: {
          type: "invalid_request_error",
          code: "cyber_policy",
          message: "blocked by upstream policy",
        },
      })}\n\n`],
      "policy-failed",
    ],
    [
      "malformed delimiter-less terminal-shaped JSON",
      ['data: {"type":"response.completed","response":{"status":"completed"}'],
      "malformed",
    ],
  ] as const)("pull/eager parity: %s", async (_name, chunks, expected) => {
    const pull = await drain(relaySseWithFailedTail(sourceStream(chunks), new AbortController()));
    const eager = await drain(relaySseEagerBounded(
      sourceStream(chunks),
      new AbortController(),
      parityHooks,
    ));

    expect(encoder.encode(eager)).toEqual(encoder.encode(pull));

    for (const text of [pull, eager]) {
      expect(terminalEvents(text)).toHaveLength(1);
      expect(doneEvents(text)).toHaveLength(1);
      if (expected === "incomplete") {
        expect(terminalEvents(text)).toEqual(["response.incomplete"]);
        expect(text).toContain('"reason":"adapter_eof"');
      } else if (expected === "completed") {
        expect(terminalEvents(text)).toEqual(["response.completed"]);
      } else if (expected === "policy-failed") {
        expect(terminalEvents(text)).toEqual(["response.failed"]);
        expect(text).toContain('"code":"cyber_policy"');
        expect(text).not.toContain('"reason":"adapter_eof"');
      } else {
        expect(terminalEvents(text)).toEqual(["response.incomplete"]);
        expect(text).not.toContain("event: response.completed");
        expect(text).toContain('data: {"type":"response.completed","response":{"status":"completed"}');
        expect(text).toContain('"reason":"adapter_eof"');
      }
    }
  });
});
