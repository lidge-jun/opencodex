import { describe, expect, test } from "bun:test";
import { addFinalRequestLog, httpStatusForRequestLogTerminal, inspectResponseLogJson, inspectResponseLogSsePayload, type RequestLogContext } from "../../src/server/request-log";
import { relaySseWithFailedTail, relayWithAbort } from "../../src/server";
import { relaySseEagerBounded, type EagerRelayHooks } from "../../src/server/relay-eager";
import { noteRelaySyntheticTail } from "../../src/server/request-log-terminal-status";
import { collectBufferedResponsesSse } from "../../src/server/responses/buffered-sse-json";
import { bareUpstreamError, type BareUpstreamError } from "../../src/server/bare-upstream-error";
import { consumeForInspection, consumeForResponseLogMetadata, createSseInspector, MAX_TAIL_ERROR_MESSAGE_CHARS, upstreamErrorTailFrame } from "../../src/server/relay";
import { teeWithBoundedInspection } from "../../src/server/inspection-tee";
import { classifyCodexUpstreamOutcome } from "../../src/codex/routing/cooldown-math";
import { codexWsUpstreamFetch, streamingInit } from "../helpers/ws-upstream-fixtures";
import { readCodexWsStage } from "../../src/server/responses/codex-ws-wire";
import { TERMINAL_REFUSAL_FALLBACK_MESSAGE } from "../../src/lib/errors";
import { TranslatorBudgetExceededError } from "../../src/lib/translator-budget";
import { createOutboundCredentialMask, createTerminalErrorRedactionBlockRewrite } from "../../src/server/responses/terminal-error-redaction";
import { pumpResponsesSseToWebSocket, type WsData } from "../../src/server/ws-bridge";
import type { ServerWebSocket } from "bun";
import { OutboundCredentialRegistry, setOutboundCredentialRegistryForTests } from "../../src/lib/outbound-credential-registry";

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

function controlledSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelReasons: unknown[] = [];
  return {
    body: new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel(reason) { cancelReasons.push(reason); },
    }, { highWaterMark: 0 }),
    push(bytes: Uint8Array) { controller.enqueue(bytes); },
    close() { controller.close(); },
    error(reason: unknown) { controller.error(reason); },
    cancelReasons,
  };
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
  // Longer than every bound (512 message, 128 code/type): a slice taken before the mask would
  // keep a prefix the full-value mask no longer recognizes.
  const longCredential = `fixturelong${"Q7xk".repeat(180)}`;
  const longFrames: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["untyped policy message", { error: { code: "cyber_policy", message: longCredential } }],
    ["typed policy message", { type: "error", error: { code: "cyber_policy", message: longCredential } }],
    ["untyped unknown message", { error: { code: "mystery_code", message: longCredential } }],
    ["untyped code only", { error: { code: longCredential } }],
    ["untyped type only", { error: { type: longCredential } }],
  ];
  test.each(["tee", "eager"] as const)("%s never emits a prefix of a long selected credential", async mode => {
    const maskCredential = createOutboundCredentialMask({ authorization: `Bearer ${longCredential}` });
    for (const [name, payload] of longFrames) {
      const src = sourceStream([`event: error\ndata: ${JSON.stringify(payload)}\n\n`]);
      const out = await drain(mode === "tee"
        ? relaySseWithFailedTail(src, new AbortController(), undefined, { maskCredential })
        : relaySseEagerBounded(src, new AbortController(), parityHooks, { maskCredential }));
      const synthesized = out.split("\n").filter(line => line.includes('"response.failed"')).join("\n");
      expect([name, synthesized.length > 0, synthesized.includes(longCredential.slice(0, 64))]).toEqual([name, true, false]);
    }
  });

  test("the buffered collector never keeps a prefix of a long selected credential", async () => {
    const maskCredential = createOutboundCredentialMask({ authorization: `Bearer ${longCredential}` });
    for (const [name, payload] of longFrames) {
      const src = sourceStream([`event: error\ndata: ${JSON.stringify(payload)}\n\n`]);
      const result = await collectBufferedResponsesSse(src, new AbortController(), { maskCredential });
      const kept = JSON.stringify(result);
      expect([name, kept.includes(longCredential.slice(0, 64))]).toEqual([name, false]);
    }
  });

  test("bare copy is refused while the registry cannot vouch for every sent credential", () => {
    const oversized = `fixtureoversized${"Z9".repeat(9000)}`;
    const registry = new OutboundCredentialRegistry();
    registry.remember({ authorization: `Bearer ${oversized}` });
    expect(registry.complete()).toBe(false);
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      // The verdict every client boundary bounds: without a per-request mask it must not keep a prefix.
      const verdict = bareUpstreamError({ error: { code: "mystery_code", message: oversized } });
      expect([verdict?.message, verdict?.terminalStatus]).toEqual(["[REDACTED]", 502]);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, JSON.stringify({ error: { code: "mystery_code", message: oversized } }));
      expect([log.upstreamError, log.terminalHttpStatus]).toEqual(["[REDACTED]", 502]);
    } finally { restore(); }
  });

  test("the row keeps no prefix of a long credential this process sent", () => {
    const registry = new OutboundCredentialRegistry();
    registry.remember({ authorization: `Bearer ${longCredential}` });
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      for (const [name, payload] of longFrames) {
        const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
        inspectResponseLogSsePayload(log, JSON.stringify(payload));
        const stored = [log.upstreamError, log.upstreamErrorCode, log.upstreamErrorType].join("|");
        expect([name, stored.includes(longCredential.slice(0, 64))]).toEqual([name, false]);
      }
    } finally { restore(); }
  });

  test.each(["tee", "eager"] as const)("masks a JSON-escaped selected credential in a %s synthetic failure", async mode => {
    const credential = 'fixture"quoted\\token';
    const maskCredential = createOutboundCredentialMask({ authorization: `Bearer ${credential}` });
    const src = sourceStream([], { failAfter: true, error: new Error(`reset after ${credential}`) });
    const out = await drain(mode === "tee"
      ? relaySseWithFailedTail(src, new AbortController(), undefined, { maskCredential })
      : relaySseEagerBounded(src, new AbortController(), parityHooks, { maskCredential }));
    expect(failedMessage(out)).toContain("[REDACTED]");
    expect(failedMessage(out)).not.toContain(credential);
  });

  test("masks selected credentials in every synthetic refusal field", () => {
    const credential = "fixture-selected-credential";
    const maskCredential = createOutboundCredentialMask({ authorization: `Bearer ${credential}` });
    const frame = decoder.decode(upstreamErrorTailFrame(
      encoder, `refused ${credential}`, `invalid_${credential}`, maskCredential,
    ));
    expect(frame).not.toContain(credential);
    expect(frame).toContain("[REDACTED]");
  });
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

  test("clean EOF after a recorded upstream error reports that error instead of adapter_eof", async () => {
    const upstream = new AbortController();
    const src = sourceStream(['data: {"type":"response.in_progress"}\n\n']);
    const out = await drain(relaySseWithFailedTail(src, upstream, undefined, {
      upstreamError: "The usage limit has been reached",
    }));

    expect(out).toContain("event: response.failed");
    expect(out).toContain("The usage limit has been reached");
    expect(out).not.toContain('"reason":"adapter_eof"');
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("clean EOF after an upstream error keeps the same failed payload through eager relay", async () => {
    const upstream = new AbortController();
    const src = sourceStream(['data: {"type":"response.in_progress"}\n\n']);
    const out = await drain(relaySseEagerBounded(src, upstream, parityHooks, {
      upstreamError: "The usage limit has been reached",
    }));

    expect(out).toContain("event: response.failed");
    expect(out).toContain("The usage limit has been reached");
    expect(out).not.toContain('"reason":"adapter_eof"');
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
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

  const CREDENTIAL_CANARY = "sk-testCANARY9live";
  const OVERLONG_SUFFIX = "x".repeat(600);
  const BARE_ERROR_MESSAGE = "upstream failed " + CREDENTIAL_CANARY + " " + OVERLONG_SUFFIX;
  const EXPECTED_SYNTHETIC_MESSAGE = ("upstream failed [REDACTED] " + OVERLONG_SUFFIX)
    .slice(0, MAX_TAIL_ERROR_MESSAGE_CHARS);

  const sseDataFrame = (payload: unknown): string => "data: " + JSON.stringify(payload) + "\n\n";

  const synthesizedTail = (out: string, original: string): string => {
    expect(out.startsWith(original)).toBe(true);
    return out.slice(original.length);
  };

  const synthesizedFailedPayload = (tail: string): {
    type: string;
    response: { status: string; error: { type: string; code: string; message: string } };
  } => {
    const dataLine = tail.split("event: response.failed\ndata: ")[1]?.split("\n")[0];
    if (!dataLine) throw new Error("missing synthesized response.failed payload");
    return JSON.parse(dataLine) as {
      type: string;
      response: { status: string; error: { type: string; code: string; message: string } };
    };
  };

  test.each([
    [
      "tee",
      "flat",
      (src: ReadableStream<Uint8Array>) => relaySseWithFailedTail(src, new AbortController()),
      { type: "error", message: BARE_ERROR_MESSAGE },
    ],
    [
      "tee",
      "nested",
      (src: ReadableStream<Uint8Array>) => relaySseWithFailedTail(src, new AbortController()),
      { type: "error", error: { message: BARE_ERROR_MESSAGE } },
    ],
    [
      "eager",
      "flat",
      (src: ReadableStream<Uint8Array>) => relaySseEagerBounded(src, new AbortController(), parityHooks),
      { type: "error", message: BARE_ERROR_MESSAGE },
    ],
    [
      "eager",
      "nested",
      (src: ReadableStream<Uint8Array>) => relaySseEagerBounded(src, new AbortController(), parityHooks),
      { type: "error", error: { message: BARE_ERROR_MESSAGE } },
    ],
  ] as const)("%s %s bare error synthesizes a redacted capped failed tail", async (_mode, _shape, relay, payload) => {
    const original = sseDataFrame({ type: "response.in_progress" }) + sseDataFrame(payload);
    const out = await drain(relay(sourceStream([original])));
    const tail = synthesizedTail(out, original);
    const parsed = synthesizedFailedPayload(tail);

    expect(original).toContain(CREDENTIAL_CANARY);
    expect(out.slice(0, original.length)).toBe(original);
    expect(tail).toContain("event: response.failed");
    expect(tail).not.toContain(CREDENTIAL_CANARY);
    expect(parsed.type).toBe("response.failed");
    expect(parsed.response.status).toBe("failed");
    expect(parsed.response.error.code).toBe("upstream_server_error");
    expect(parsed.response.error.message).toBe(EXPECTED_SYNTHETIC_MESSAGE);
    expect(parsed.response.error.message).toHaveLength(MAX_TAIL_ERROR_MESSAGE_CHARS);
    expect(parsed.response.error.message).not.toContain(CREDENTIAL_CANARY);
    expect(terminalEvents(tail)).toEqual(["response.failed"]);
    expect(doneEvents(out)).toHaveLength(1);
    expect(doneEvents(tail)).toHaveLength(1);
    expect(tail.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(out).not.toContain('"reason":"adapter_eof"');
  });

  test.each(["tee", "eager"] as const)("%s existing terminal wins over a preceding bare error and does not duplicate DONE", async (mode) => {
    const original = sseDataFrame({ type: "error", message: BARE_ERROR_MESSAGE })
      + 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      + "data: [DONE]\n\n";
    const relay = mode === "tee"
      ? (src: ReadableStream<Uint8Array>) => relaySseWithFailedTail(src, new AbortController())
      : (src: ReadableStream<Uint8Array>) => relaySseEagerBounded(src, new AbortController(), parityHooks);
    const out = await drain(relay(sourceStream([original])));

    expect(out).toBe(original);
    expect(terminalEvents(out)).toEqual(["response.completed"]);
    expect(doneEvents(out)).toHaveLength(1);
    expect(out).not.toContain("event: response.failed");
  });
});


describe("optional Codex hint filtering preserves relay semantics", () => {
  for (const eager of [false, true]) {
    const relay = (chunks: string[], upstreamError?: string) => eager
      ? relaySseEagerBounded(sourceStream(chunks), new AbortController(), parityHooks,
        { upstreamError, terminalBoundary: { dropCodexSafetyBuffering: true } })
      : relaySseWithFailedTail(sourceStream(chunks), new AbortController(), undefined,
        { upstreamError, terminalBoundary: { dropCodexSafetyBuffering: true } });
    test(`policy failure plus hint is composed, eager=${eager}`, async () => {
      const frame = `event: error\r\ndata: ${JSON.stringify({ type: "error", safety_buffering: { enabled: true },
        error: { code: "cyber_policy", message: "blocked by upstream policy", type: "invalid_request_error" } })}\r\n\r\n`;
      const text = await drain(relay([frame.slice(0, 19), frame.slice(19)]));
      expect(text).not.toContain("safety_buffering");
      expect(text).toContain('"type":"response.failed"');
      expect(text).toContain('"code":"cyber_policy"');
      expect(text).toContain('"retryable":false');
      expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    });
    test(`metadata removal retains other frames and one terminal, eager=${eager}`, async () => {
      const metadata = 'data: {"type":"response.metadata","metadata":{"type":"safety_buffering"}}\n\n';
      const other = 'data: {"type":"codex.response.metadata","headers":{"x-codex-safety-buffering-enabled":"true"}}\n\n';
      const malformed = 'data: {malformed}\n\n';
      const terminal = 'data: {"type":"response.completed","response":{"status":"completed"},"safety_buffering":true}\n\ndata: [DONE]\n\n';
      const text = await drain(relay([metadata.slice(0, 7), metadata.slice(7), other, malformed, terminal]));
      expect(text).not.toContain('"type":"safety_buffering"');
      expect(text).not.toContain('"safety_buffering":true');
      expect(text).toContain(other);
      expect(text).toContain(malformed);
      expect(text).toContain('"type":"response.completed"');
      expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    });
    test(`hint-only EOF preserves captured error fallback, eager=${eager}`, async () => {
      const text = await drain(relay(['data: {"type":"response.metadata","metadata":{"type":"safety_buffering"}}\n\n'], "provider unavailable"));
      expect(text).toContain("provider unavailable");
      expect(text).not.toContain("adapter_eof");
      expect(text).not.toContain("safety_buffering");
    });
  }
});

/**
 * #5176: a final upstream refusal must end the turn rather than restart it.
 *
 * Codex classifies a `response.failed` terminal by `error.code` alone
 * (codex-rs/codex-api/src/sse/responses.rs:417-467). Only the codes collected in
 * CODEX_TERMINAL_CODES below end the turn; every other code falls through to the
 * trailing `_ => ApiError::Retryable` arm, which the client retries up to
 * `stream_max_retries` and renders as `Reconnecting N/5`. Codex has no handler
 * for a bare `error` event at all, so the terminal this relay synthesizes is the
 * only thing that carries the refusal to the client.
 *
 * `upstreamErrorTailFrame` (src/server/relay.ts) used to stamp
 * `upstream_server_error` on that terminal unconditionally, so the upstream
 * message survived and its verdict did not, and a refusal arrived as a retryable
 * transport failure. It now carries the verdict when the upstream gave one, and
 * leaves everything else classified exactly as before.
 */
describe("upstream refusal terminal mapping (#5176)", () => {
  // codex-rs/codex-api/src/sse/responses.rs:423-450, in branch order.
  const CODEX_TERMINAL_CODES = new Set([
    "context_length_exceeded",
    "insufficient_quota",
    "usage_not_included",
    "cyber_policy",
    "misalignment_policy_violation",
    "invalid_prompt",
    "bio_policy",
  ]);

  // The upstream copy quoted in #5176, and the code Codex pairs with safety-refusal
  // copy in its own fixture (responses.rs:1358-1366).
  const SAFETY_REFUSAL_MESSAGE =
    "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
  const SAFETY_REFUSAL_CODE = "invalid_prompt";

  const synthesizedError = (out: string): { code: string; message: string; type: string } => {
    const dataLine = out.split("event: response.failed\ndata: ")[1]?.split("\n")[0];
    if (!dataLine) throw new Error("missing synthesized response.failed payload");
    const parsed = JSON.parse(dataLine) as {
      response: { error: { code: string; message: string; type: string } };
    };
    return parsed.response.error;
  };

  const relayFor = (mode: "tee" | "eager", chunks: string[]) => mode === "tee"
    ? relaySseWithFailedTail(sourceStream(chunks), new AbortController())
    : relaySseEagerBounded(sourceStream(chunks), new AbortController(), parityHooks);

  test.each([
    ["tee", "flat"],
    ["tee", "nested"],
    ["eager", "flat"],
    ["eager", "nested"],
  ] as const)("%s %s bare refusal ends the turn with the upstream verdict", async (mode, shape) => {
    const bare = shape === "flat"
      ? { type: "error", code: SAFETY_REFUSAL_CODE, message: SAFETY_REFUSAL_MESSAGE }
      : {
        type: "error",
        error: {
          type: "invalid_request_error",
          code: SAFETY_REFUSAL_CODE,
          message: SAFETY_REFUSAL_MESSAGE,
        },
      };
    const original = 'data: {"type":"response.in_progress"}\n\n'
      + "data: " + JSON.stringify(bare) + "\n\n";

    const out = await drain(relayFor(mode, [original]));
    const error = synthesizedError(out);

    // The refusal text survives, which is why the client quotes it verbatim.
    expect(error.message).toBe(SAFETY_REFUSAL_MESSAGE);
    // ... and so does the verdict, so the client stops instead of reconnecting.
    expect(error.code).toBe(SAFETY_REFUSAL_CODE);
    expect(CODEX_TERMINAL_CODES.has(error.code)).toBe(true);
    expect(error.type).toBe("invalid_request_error");
    expect(out).toContain('"retryable":false');
  });

  test.each(["tee", "eager"] as const)(
    "%s recognizes refusal copy the upstream sent without a code",
    async (mode) => {
      const original = 'data: {"type":"response.in_progress"}\n\n'
        + "data: " + JSON.stringify({ type: "error", message: SAFETY_REFUSAL_MESSAGE }) + "\n\n";

      const error = synthesizedError(await drain(relayFor(mode, [original])));

      expect(error.code).toBe(SAFETY_REFUSAL_CODE);
      expect(CODEX_TERMINAL_CODES.has(error.code)).toBe(true);
    },
  );

  // The mirror-image defect this fix must not introduce: a real outage is not a
  // refusal, and giving it a terminal code would strand a turn that a reconnect
  // would have completed.
  test.each(["tee", "eager"] as const)(
    "%s leaves a transient upstream failure retryable",
    async (mode) => {
      const original = 'data: {"type":"response.in_progress"}\n\n'
        + "data: " + JSON.stringify({
          type: "error",
          code: "upstream_reset",
          message: "Upstream stream terminated unexpectedly: socket closed",
        }) + "\n\n";

      const out = await drain(relayFor(mode, [original]));
      const error = synthesizedError(out);

      expect(error.code).toBe("upstream_server_error");
      expect(error.type).toBe("upstream_error");
      expect(CODEX_TERMINAL_CODES.has(error.code)).toBe(false);
      expect(out).not.toContain('"retryable":false');
    },
  );

  // Refusal copy quoted inside a transport diagnostic must not outrank the code
  // the upstream actually sent, or the mirror-image defect returns through text.
  test.each(["tee", "eager"] as const)(
    "%s keeps an explicit non-refusal code over refusal copy in its message",
    async (mode) => {
      const original = 'data: {"type":"response.in_progress"}\n\n'
        + "data: " + JSON.stringify({
          type: "error",
          code: "upstream_reset",
          message: "Transport failed while forwarding: " + SAFETY_REFUSAL_MESSAGE,
        }) + "\n\n";

      const out = await drain(relayFor(mode, [original]));
      const error = synthesizedError(out);

      expect(error.code).toBe("upstream_server_error");
      expect(CODEX_TERMINAL_CODES.has(error.code)).toBe(false);
      expect(out).not.toContain('"retryable":false');
    },
  );

  // Codex accepts a refusal code with no message and supplies its own copy
  // (sse/responses.rs:446-451), so this shape must still end the turn rather
  // than fall through to the adapter_eof incomplete.
  test.each(["tee", "eager"] as const)(
    "%s ends the turn on a refusal code sent without a message",
    async (mode) => {
      const original = 'data: {"type":"response.in_progress"}\n\n'
        + "data: " + JSON.stringify({ type: "error", code: SAFETY_REFUSAL_CODE }) + "\n\n";

      const out = await drain(relayFor(mode, [original]));
      const error = synthesizedError(out);

      expect(error.code).toBe(SAFETY_REFUSAL_CODE);
      expect(error.message).toBe(TERMINAL_REFUSAL_FALLBACK_MESSAGE);
      expect(out).not.toContain('"reason":"adapter_eof"');
    },
  );

  // Code and message must be read from the same places. When the message is
  // nested under response.error and the code scan does not look there, the
  // event contributes text while its verdict goes unseen.
  test.each(["tee", "eager"] as const)(
    "%s reads a refusal nested under response.error",
    async (mode) => {
      const original = 'data: {"type":"response.in_progress"}\n\n'
        + "data: " + JSON.stringify({
          type: "error",
          response: {
            error: {
              type: "invalid_request_error",
              code: SAFETY_REFUSAL_CODE,
              message: "Invalid prompt.",
            },
          },
        }) + "\n\n";

      const error = synthesizedError(await drain(relayFor(mode, [original])));

      expect(error.code).toBe(SAFETY_REFUSAL_CODE);
      expect(error.message).toBe("Invalid prompt.");
    },
  );

  // Code and message share one precedence order. When two envelopes disagree,
  // the one that supplies the message supplies the verdict, so a refusal nested
  // below a transient code cannot promote the turn to terminal.
  test.each(["tee", "eager"] as const)(
    "%s takes the verdict from the envelope that supplied the message",
    async (mode) => {
      const original = 'data: {"type":"response.in_progress"}\n\n'
        + "data: " + JSON.stringify({
          type: "error",
          error: { type: "upstream_error", code: "upstream_reset", message: "socket closed" },
          response: {
            error: { code: SAFETY_REFUSAL_CODE, message: "Invalid prompt." },
          },
        }) + "\n\n";

      const out = await drain(relayFor(mode, [original]));
      const error = synthesizedError(out);

      expect(error.message).toBe("socket closed");
      expect(error.code).toBe("upstream_server_error");
      expect(CODEX_TERMINAL_CODES.has(error.code)).toBe(false);
      expect(out).not.toContain('"retryable":false');
    },
  );

  // The upstream ended the turn before the socket did, so the reset that
  // followed must not replace the refusal with a retryable upstream_reset.
  test.each(["tee", "eager"] as const)(
    "%s keeps a captured refusal when the upstream read then fails",
    async (mode) => {
      const chunks = ['data: {"type":"response.in_progress"}\n\n'
        + "data: " + JSON.stringify({
          type: "error",
          code: SAFETY_REFUSAL_CODE,
          message: SAFETY_REFUSAL_MESSAGE,
        }) + "\n\n"];
      const source = () => sourceStream(chunks, { failAfter: true });
      const out = await drain(mode === "tee"
        ? relaySseWithFailedTail(source(), new AbortController())
        : relaySseEagerBounded(source(), new AbortController(), parityHooks));
      const error = synthesizedError(out);

      expect(error.code).toBe(SAFETY_REFUSAL_CODE);
      expect(error.message).toBe(SAFETY_REFUSAL_MESSAGE);
      expect(out).not.toContain('"code":"upstream_reset"');
    },
  );
  /** Client relay output plus the terminal the tee inspection branch or eager hooks reported. */
  async function relayAndInspect(mode: "tee" | "eager", raw: string): Promise<{ out: string; reported: string[] }> {
    const reported: string[] = [];
    const src = sourceStream([raw]);
    if (mode === "eager") {
      const hooks = { ...parityHooks, onSynthetic: (kind: string) => { reported.push(kind); } };
      return { out: await drain(relaySseEagerBounded(src, new AbortController(), hooks)), reported };
    }
    const [client, inspection] = src.tee();
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const inspected = new Promise<void>(resolve => consumeForInspection(inspection, status => { reported.push(status); }, undefined, resolve, log));
    const out = await drain(relaySseWithFailedTail(client, new AbortController()));
    await inspected;
    return { out, reported };
  }

  test.each(["tee", "eager"] as const)("%s untyped error envelope ends in response.failed, not adapter_eof (#8216)", async (mode) => {
    // Captured gateway shape: heartbeat, an `error` object with no root `type`, DONE, EOF.
    const raw = ": PING\n\n"
      + 'data: {"error":{"message":"openai_error","type":"bad_response_status_code","param":"","code":"bad_response_status_code"}}\n\n'
      + "data: [DONE]\n\n";
    const { out, reported } = await relayAndInspect(mode, raw);

    expect(failedMessage(out)).toBe("openai_error");
    expect(out).toContain('"code":"upstream_server_error"');
    expect(terminalEvents(out)).toEqual(["response.failed"]);
    expect(doneEvents(out)).toHaveLength(1);
    expect(out).not.toContain("adapter_eof");
    expect(reported).toEqual(["failed"]);
  });

  test.each(["tee", "eager"] as const)("%s typed event carrying an error field is not a bare error (#8216)", async (mode) => {
    const raw = 'data: {"type":"response.in_progress","response":{"status":"in_progress"},'
      + '"error":{"message":"not a failure","code":"server_error"}}\n\n';
    const { out, reported } = await relayAndInspect(mode, raw);

    expect(terminalEvents(out)).toEqual(["response.incomplete"]);
    expect(out).toContain('"reason":"adapter_eof"');
    expect(out).not.toContain("event: response.failed");
    expect(doneEvents(out)).toHaveLength(1);
    expect(reported).toEqual(["incomplete"]);
  });

  test.each(["tee", "eager"] as const)("%s untyped refusal code without a message reports failed on both readers (#8216)", async (mode) => {
    // The client tail already carried the refusal; tee inspection used to read only the message and
    // reported `incomplete`, which account health counts as a non-failure.
    const raw = 'data: {"error":{"code":"invalid_prompt"}}\n\n';
    const { out, reported } = await relayAndInspect(mode, raw);

    expect(terminalEvents(out)).toEqual(["response.failed"]);
    expect(out).toContain('"code":"invalid_prompt"');
    expect(failedMessage(out)).toBe(TERMINAL_REFUSAL_FALLBACK_MESSAGE);
    expect(reported).toEqual(["failed"]);
  });

  test.each([
    ["tee", "untyped"], ["eager", "untyped"], ["tee", "typed"], ["eager", "typed"],
  ] as const)("%s %s error with a code but no message still ends in response.failed", async (mode, shape) => {
    const raw = shape === "untyped"
      ? 'data: {"error":{"code":"bad_response_status_code"}}\n\n'
      : 'data: {"type":"error","code":"bad_response_status_code"}\n\n';
    const { out, reported } = await relayAndInspect(mode, raw);

    expect(terminalEvents(out)).toEqual(["response.failed"]);
    expect(out).not.toContain("adapter_eof");
    expect(out).toContain('"code":"upstream_server_error"');
    // The upstream's own code is the only diagnostic it sent; keep it in the message.
    expect(failedMessage(out)).toContain("bad_response_status_code");
    expect(doneEvents(out)).toHaveLength(1);
    expect(reported).toEqual(["failed"]);
  });

  test.each(["tee", "eager"] as const)("%s untyped cyber_policy error is rewritten as the policy terminal (#8216)", async (mode) => {
    const raw = 'data: {"error":{"type":"invalid_request_error","code":"cyber_policy","message":"blocked by policy"}}\n\n'
      + 'data: {"type":"response.output_text.delta","delta":"late"}\n\n';
    const { out, reported } = await relayAndInspect(mode, raw);

    expect(terminalEvents(out)).toEqual(["response.failed"]);
    expect(out).not.toContain('data: {"error":');
    expect(out).not.toContain("late");
    expect(failedMessage(out)).toBe("blocked by policy");
    expect(out).toContain('"code":"cyber_policy"');
    expect(out).toContain('"retryable":false');
    expect(doneEvents(out)).toHaveLength(1);
    // The rewritten frame is a real terminal: tee inspection reports it, and eager synthesizes none.
    expect(reported).toEqual(mode === "tee" ? ["failed"] : []);
  });

  test.each(["tee", "eager"] as const)("%s untyped error envelope reaches a WebSocket client as response.failed (#8216)", async (mode) => {
    const raw = 'data: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n'
      + 'data: {"error":{"message":"openai_error","code":"bad_response_status_code"}}\n\n'
      + "data: [DONE]\n\n";
    const src = sourceStream([raw]);
    const relayed = mode === "tee"
      ? relaySseWithFailedTail(src, new AbortController())
      : relaySseEagerBounded(src, new AbortController(), parityHooks);
    const sent: string[] = [];
    const terminals: string[] = [];
    const ws = {
      readyState: 1,
      data: {} as WsData,
      send(message: string) { sent.push(message); return 1; },
    } as unknown as ServerWebSocket<WsData>;
    await pumpResponsesSseToWebSocket(ws, relayed, { onTerminal: status => { terminals.push(status); } });

    const types = sent.map(frame => (JSON.parse(frame) as { type?: unknown }).type);
    expect(types).toEqual(["response.created", "response.failed"]);
    expect((JSON.parse(sent[1]!) as { response: { error: { message: string } } }).response.error.message).toBe("openai_error");
    expect(terminals).toEqual(["failed"]);
  });
});


describe("bare upstream rate-limit/overload EOF diagnostics (#6740)", () => {
  const cases = [
    ["server_error", "server_is_overloaded", "server_error", "server_is_overloaded", 503],
    ["overloaded_error", "overloaded_error", "overloaded_error", "overloaded_error", 503],
    ["rate_limit_error", "rate_limit_exceeded", "rate_limit_error", "rate_limit_exceeded", 429],
    ["rate_limit_error", "rate_limit_error", "rate_limit_error", "rate_limit_error", 429],
    ["overloaded_error", undefined, "overloaded_error", "server_is_overloaded", 503],
    ["rate_limit_error", undefined, "rate_limit_error", "rate_limit_exceeded", 429],
    ["server_error", "server_error", "upstream_error", "upstream_server_error", 502],
    ["rate_limit_error", "unknown_code", "upstream_error", "upstream_server_error", 502],
    ["server_error", undefined, "upstream_error", "upstream_server_error", 502],
  ] as const;
  for (const mode of ["tee", "eager"] as const) {
    test.each(cases)(`${mode} preserves only recognized class %s / %s`, async (type, code, expectedType, expectedCode, status) => {
      const message = "upstream diagnostic fixture";
      const bare = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, code, message } })}\n\n`;
      const src = sourceStream([bare.slice(0, 15), bare.slice(15)]);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const out = await drain(mode === "tee"
        ? relaySseWithFailedTail(src, new AbortController())
        : relaySseEagerBounded(src, new AbortController(), parityHooks));
      const payload = out.split("event: response.failed\ndata: ")[1]!.split("\n")[0]!;
      const terminal = JSON.parse(payload).response;
      expect(terminal.error).toEqual({ type: expectedType, code: expectedCode, message });
      expect(terminal.last_error).toEqual(terminal.error);
      expect(terminalEvents(out)).toEqual(["response.failed"]);
      expect(doneEvents(out)).toHaveLength(1);
      expect(out).not.toContain('"retryable":false');
      inspectResponseLogJson(log, payload);
      expect(log.terminalHttpStatus).toBe(status);
    });
  }
});

describe("untyped upstream error envelopes", () => {
  for (const mode of ["tee", "eager"] as const) {
    test(`${mode} defers copy-only policy to a genuine completed terminal`, async () => {
      const src = sourceStream([
        'data: {"error":{"message":"blocked for high-risk cybersecurity activity"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ]);
      const text = await drain(mode === "tee" ? relaySseWithFailedTail(src, new AbortController())
        : relaySseEagerBounded(src, new AbortController(), parityHooks));
      expect(terminalEvents(text)).toEqual(["response.completed"]);
    });

    test.each([["rate_limit_exceeded", 429], ["overloaded_error", 503]] as const)(
      `${mode} retains untyped %s on a subsequent reset`, async (code, status) => {
        const src = sourceStream([`data: ${JSON.stringify({ error: { code } })}\n\n`], { failAfter: true });
        const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
        const outcomes: Array<[string, number]> = [];
        const onTerminal = (kind: string, value?: number) => outcomes.push([kind, value ?? log.terminalHttpStatus ?? 502]);
        let done: Promise<void> = Promise.resolve();
        let relayed: ReadableStream<Uint8Array>;
        if (mode === "tee") {
          const [client, inspection] = src.tee();
          done = new Promise(resolve => consumeForInspection(inspection, onTerminal, undefined, resolve, log));
          relayed = relaySseWithFailedTail(client, new AbortController());
        } else {
          const inspector = createSseInspector({ logCtx: log, onTerminal });
          relayed = relaySseEagerBounded(src, new AbortController(), { ...parityHooks,
            inspectChunk: chunk => inspector.feed(chunk), finishInspection: () => inspector.finish(),
            sawTerminal: () => inspector.reported(), onSynthetic: (kind, reason) => onTerminal(kind, reason === "upstream_error" ? log.terminalHttpStatus : 502),
          });
        }
        const text = await drain(relayed);
        await done;
        expect(terminalEvents(text)).toEqual(["response.failed"]);
        expect(text).toContain(`"code":"${code}"`);
        expect(outcomes).toEqual([["failed", status]]);
      },
    );
    test(`${mode} keeps a code-only quota failure in the client and account outcome`, async () => {
      const src = sourceStream(['data: {"error":{"code":"rate_limit_exceeded"}}\n\n']);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const outcomes: Array<[string, number]> = [];
      const onTerminal = (kind: string, status?: number) => outcomes.push([kind, status ?? log.terminalHttpStatus ?? 502]);
      let done: Promise<void> = Promise.resolve();
      let relayed: ReadableStream<Uint8Array>;
      if (mode === "tee") {
        const [client, inspection] = src.tee();
        done = new Promise(resolve => consumeForInspection(inspection, onTerminal, undefined, resolve, log));
        relayed = relaySseWithFailedTail(client, new AbortController());
      } else {
        const inspector = createSseInspector({ logCtx: log, onTerminal });
        relayed = relaySseEagerBounded(src, new AbortController(), { ...parityHooks,
          inspectChunk: chunk => inspector.feed(chunk), finishInspection: () => inspector.finish(),
          sawTerminal: () => inspector.reported(), onSynthetic: (kind, reason) => onTerminal(kind, reason === "upstream_error" ? log.terminalHttpStatus : 502),
        });
      }
      const text = await drain(relayed);
      await done;
      expect(terminalEvents(text)).toEqual(["response.failed"]);
      expect(text).toContain('"code":"rate_limit_exceeded"');
      expect(outcomes).toEqual([["failed", 429]]);
      expect(classifyCodexUpstreamOutcome(outcomes[0]![1])).toBe("quota");
    });

    test(`${mode} keeps a later genuine terminal authoritative over untyped error copy`, async () => {
      const src = sourceStream([
        'data: {"error":{"code":"rate_limit_exceeded","message":"cyber policy blocked"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ]);
      const out = await drain(mode === "tee" ? relaySseWithFailedTail(src, new AbortController())
        : relaySseEagerBounded(src, new AbortController(), parityHooks));
      expect(terminalEvents(out)).toEqual(["response.completed"]);
      expect(out).not.toContain('"code":"cyber_policy"');
    });

    test(`${mode} records a refusal rather than the reset that follows it`, async () => {
      const src = sourceStream(['data: {"error":{"message":"blocked by our safety systems"}}\n\n'], { failAfter: true });
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const outcomes: Array<[string, number]> = [];
      const onTerminal = (kind: string, status?: number) => outcomes.push([kind, status ?? log.terminalHttpStatus ?? 502]);
      let done: Promise<void> = Promise.resolve();
      let relayed: ReadableStream<Uint8Array>;
      if (mode === "tee") {
        const [client, inspection] = src.tee();
        done = new Promise(resolve => consumeForInspection(inspection, onTerminal, undefined, resolve, log));
        relayed = relaySseWithFailedTail(client, new AbortController());
      } else {
        const inspector = createSseInspector({ logCtx: log, onTerminal });
        relayed = relaySseEagerBounded(src, new AbortController(), { ...parityHooks,
          inspectChunk: chunk => inspector.feed(chunk), finishInspection: () => inspector.finish(),
          sawTerminal: () => inspector.reported(), onSynthetic: (kind, reason) => onTerminal(kind, reason === "upstream_error" ? log.terminalHttpStatus : 502),
        });
      }
      const text = await drain(relayed);
      await done;
      expect(terminalEvents(text)).toEqual(["response.failed"]);
      expect(text).toContain('"code":"invalid_prompt"');
      expect(outcomes).toEqual([["failed", 400]]);
      expect(classifyCodexUpstreamOutcome(outcomes[0]![1])).toBe("caller");
    });

    test(`${mode} does not infer policy from copy when an explicit quota code is present`, async () => {
      const src = sourceStream(['data: {"error":{"code":"rate_limit_exceeded","message":"blocked by our safety systems"}}\n\n']);
      const text = await drain(mode === "tee" ? relaySseWithFailedTail(src, new AbortController())
        : relaySseEagerBounded(src, new AbortController(), parityHooks));
      expect(terminalEvents(text)).toEqual(["response.failed"]);
      const terminal = JSON.parse(text.split("event: response.failed\ndata: ")[1]!.split("\n")[0]!).response;
      expect(terminal.error.code).toBe("rate_limit_exceeded");
      expect(terminal.retryable).toBeUndefined();
    });

    test(`${mode} does not treat a typed non-error event with an error field as a bare error`, async () => {
      const src = sourceStream(['data: {"type":"response.in_progress","error":{"message":"fixture"}}\n\n']);
      const text = await drain(mode === "tee" ? relaySseWithFailedTail(src, new AbortController())
        : relaySseEagerBounded(src, new AbortController(), parityHooks));
      expect(terminalEvents(text)).toEqual(["response.incomplete"]);
      expect(text).toContain('"reason":"adapter_eof"');
    });
  }

  test("untyped buffered JSON does not set provisional SSE account status", () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogJson(log, '{"error":{"code":"rate_limit_exceeded"}}');
    expect(log.terminalHttpStatus).toBeUndefined();
  });

  test("untyped evidence cannot replace an earlier typed provisional status", () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(log, '{"type":"error","code":"rate_limit_exceeded"}');
    inspectResponseLogSsePayload(log, '{"error":{"code":"server_error"}}');
    expect(log.terminalHttpStatus).toBe(429);
  });

  test("later bare error evidence updates the provisional account status", () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(log, '{"error":{"code":"rate_limit_exceeded"}}');
    expect(log.terminalHttpStatus).toBe(429);
    inspectResponseLogSsePayload(log, '{"error":{"code":"invalid_prompt"}}');
    expect(log.terminalHttpStatus).toBe(400);
    inspectResponseLogSsePayload(log, '{"type":"response.completed","response":{"status":"completed"}}');
    expect(log.terminalHttpStatus).toBeUndefined();
  });

  test.each([
    [{ type: "invalid_request_error", message: "fixture" }, 400],
    [{ type: "authentication_error", message: "fixture" }, 401],
    [{ type: "permission_error", message: "fixture" }, 403],
    [{ type: "not_found_error", message: "fixture" }, 404],
    [{ code: "rate_limit_exceeded" }, 429],
    [{ code: "server_is_overloaded" }, 503],
    [{ code: "invalid_prompt" }, 400],
  ] as const)("records provisional status for an untyped error and retires it on a real terminal", (error, status) => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(log, JSON.stringify({ error }));
    expect(log.terminalHttpStatus).toBe(status);
    inspectResponseLogSsePayload(log, '{"type":"response.completed","response":{"status":"completed"}}');
    expect(log.terminalHttpStatus).toBeUndefined();
  });

  test("redacts the selected credential in an untyped error before client delivery", async () => {
    const secret = 'fixture"chosen\\credential';
    const rewrite = createTerminalErrorRedactionBlockRewrite({ authorization: `Bearer ${secret}` });
    const block = `data: ${JSON.stringify({ error: { code: "cyber_policy", message: `blocked ${secret}` } })}`;
    // The untyped envelope never reaches the client; the policy terminal built from it carries masked copy.
    const maskCredential = createOutboundCredentialMask({ authorization: `Bearer ${secret}` });
    const result = await drain(relaySseWithFailedTail(sourceStream([`${rewrite(block).join("\n")}\n\n`]), new AbortController(), undefined, { maskCredential }));
    expect(result).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(result).toContain("[REDACTED]");
  });

  test("does not retain an echoed outbound credential in untyped error diagnostics", () => {
    const credential = "fixture_selected_credential_8299";
    const registry = new OutboundCredentialRegistry();
    registry.remember({ authorization: `Bearer ${credential}` });
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, JSON.stringify({ error: { message: `fixture ${credential}` } }));
      expect(log.upstreamError ?? "").not.toContain(credential);
    } finally { restore(); }
  });

  describe("a bare frame after a genuine terminal leaves the row alone", () => {
    const terminals = [
      ["completed", { type: "response.completed", response: { status: "completed" } }],
      ["incomplete", { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }],
      ["incomplete", { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } }],
    ] as const;
    const bares = [
      { error: { code: "rate_limit_exceeded", message: "untyped quota" } },
      { type: "error", error: { code: "rate_limit_exceeded", message: "typed quota" } },
      { error: { code: "cyber_policy", message: "untyped policy" } },
    ];
    const rowState = (log: RequestLogContext, kind: "completed" | "incomplete") => ({
      status: log.terminalHttpStatus, policy: log.terminalErrorCode, code: log.upstreamErrorCode,
      type: log.upstreamErrorType, row: httpStatusForRequestLogTerminal(kind, log),
    });

    test.each(terminals)("%s terminal keeps its row through every later bare frame", (kind, terminal) => {
      for (const bare of bares) {
        const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
        inspectResponseLogSsePayload(log, JSON.stringify(terminal));
        const before = rowState(log, kind);
        inspectResponseLogSsePayload(log, JSON.stringify(bare));
        expect([bare, rowState(log, kind)]).toEqual([bare, before]);
      }
    });

    test("the metadata consumer, which inspects past the terminal, keeps a max_output_tokens turn at 200", async () => {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      await new Promise<void>(resolve => consumeForResponseLogMetadata(sourceStream([
        `event: response.incomplete\ndata: ${JSON.stringify(terminals[1][1])}\n\n`,
        `event: error\ndata: ${JSON.stringify(bares[0])}\n\n`,
      ]), log, undefined, resolve));
      expect(httpStatusForRequestLogTerminal("incomplete", log)).toBe(200);
      expect(log.terminalHttpStatus).toBeUndefined();
    });

    test("untyped copy after a terminal stays redacted when it echoes an outbound credential", () => {
      const credential = "fixture_post_terminal_credential_8415";
      const registry = new OutboundCredentialRegistry();
      registry.remember({ authorization: `Bearer ${credential}` });
      const restore = setOutboundCredentialRegistryForTests(registry);
      try {
        const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
        inspectResponseLogSsePayload(log, JSON.stringify(terminals[0][1]));
        inspectResponseLogSsePayload(log, JSON.stringify({ error: { message: `fixture ${credential}` } }));
        expect(log.upstreamError ?? "").not.toContain(credential);
      } finally { restore(); }
    });
  });
});


describe("genuine relay terminals supersede provisional bare errors", () => {
  for (const mode of ["tee", "eager"] as const) {
    test.each([
      ["rate_limit_error", "rate_limit_exceeded", "server_error", "server_is_overloaded", 503, "transient"],
      ["server_error", "server_is_overloaded", "invalid_request_error", "invalid_prompt", 400, "caller"],
    ] as const)(`${mode} reports the genuine terminal to the pool classifier after %s`, async (bareType, bareCode, type, code, status, healthClass) => {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const outcomes: number[] = [];
      const onTerminal = () => outcomes.push(log.terminalHttpStatus ?? 502);
      const src = sourceStream([
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: bareType, code: bareCode, message: "bare diagnostic" } })}\n\n`,
        `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { type, code, message: "genuine terminal" } } })}\n\n`,
      ]);
      let relayed: ReadableStream<Uint8Array>;
      let inspectionDone: Promise<void> = Promise.resolve();
      if (mode === "tee") {
        const [client, inspection] = src.tee();
        inspectionDone = new Promise(resolve => consumeForInspection(inspection, onTerminal, undefined, resolve, log));
        relayed = relaySseWithFailedTail(client, new AbortController());
      } else {
        const inspector = createSseInspector({ logCtx: log, onTerminal });
        relayed = relaySseEagerBounded(src, new AbortController(), { ...parityHooks,
          inspectChunk: chunk => inspector.feed(chunk), finishInspection: () => inspector.finish(),
          sawTerminal: () => inspector.reported(),
        });
      }
      const text = await drain(relayed);
      await inspectionDone;
      expect(outcomes).toEqual([status]);
      expect(classifyCodexUpstreamOutcome(outcomes[0]!)).toBe(healthClass);
      expect(log.terminalHttpStatus).toBe(status);
      expect(terminalEvents(text)).toEqual(["response.failed"]);
      expect(doneEvents(text)).toHaveLength(1);
    });
  }
});

describe("Codex WebSocket bare-error diagnostics never dispatch a second request", () => {
  for (const mode of ["tee", "eager"] as const) {
    test.each([
      ["rate_limit_error", "rate_limit_exceeded"],
      ["server_error", "server_is_overloaded"],
      ["server_error", "server_error"],
    ] as const)(`${mode} retains one response.create after %s / %s`, async (type, code) => {
      const originalWebSocket = globalThis.WebSocket;
      let httpDispatches = 0;
      const sockets: DiagnosticWebSocket[] = [];
      class DiagnosticWebSocket extends EventTarget {
        sent: string[] = [];
        readyState = 0;
        constructor() {
          super();
          sockets.push(this);
          queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
        }
        send(frame: string) {
          this.sent.push(frame);
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
            type: "error", error: { type, code, message: "upstream diagnostic fixture" },
          }) })));
        }
        close() { this.readyState = 3; }
      }
      globalThis.WebSocket = DiagnosticWebSocket as unknown as typeof WebSocket;
      try {
        const response = await codexWsUpstreamFetch("https://chatgpt.com/backend-api/codex/responses", streamingInit(),
          (async () => { httpDispatches++; throw new Error("post-send HTTP replay is forbidden"); }) as typeof fetch);
        const body = response.body!;
        const text = await drain(mode === "tee" ? relaySseWithFailedTail(body, new AbortController())
          : relaySseEagerBounded(body, new AbortController(), parityHooks));
        await Promise.resolve();
        expect(sockets).toHaveLength(1);
        expect(sockets[0]!.sent).toHaveLength(1);
        expect(JSON.parse(sockets[0]!.sent[0]!).type).toBe("response.create");
        expect(httpDispatches).toBe(0);
        expect(terminalEvents(text)).toEqual(["response.failed"]);
        expect(doneEvents(text)).toHaveLength(1);
      } finally { globalThis.WebSocket = originalWebSocket; }
    });
  }
});

describe("Codex WebSocket wrapper status and terminal kind reach the log (#6740)", () => {
  const frames = (terminal: Record<string, unknown>) => [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    { type: "response.in_progress", response: { id: "resp_fixture", status: "in_progress" } },
    terminal,
  ];
  const generic = { type: "server_error", code: "server_error", message: "An error occurred while processing your request." };
  test.each([
    ["a wrapped 503 error", { type: "error", status: 503, error: generic }, "error", 503, 503],
    ["a wrapped 500 error", { type: "error", status_code: 500, error: generic }, "error", 500, 500],
    ["an unwrapped error", { type: "error", error: generic }, "error", null, 502],
    ["a genuine failed terminal", { type: "response.failed", response: { id: "resp_fixture", status: "failed", error: generic } },
      "response.failed", null, 502],
  ] as const)("%s", async (_label, terminal, terminalEvent, terminalErrorStatus, loggedStatus) => {
    const originalWebSocket = globalThis.WebSocket;
    let httpDispatches = 0;
    const sockets: StageWebSocket[] = [];
    class StageWebSocket extends EventTarget {
      sent: string[] = [];
      readyState = 0;
      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
      }
      send(frame: string) {
        this.sent.push(frame);
        for (const event of frames(terminal)) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })));
        }
      }
      close() { this.readyState = 3; }
    }
    globalThis.WebSocket = StageWebSocket as unknown as typeof WebSocket;
    try {
      const response = await codexWsUpstreamFetch("https://chatgpt.com/backend-api/codex/responses", streamingInit(),
        (async () => { httpDispatches++; throw new Error("post-send HTTP replay is forbidden"); }) as typeof fetch);
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const outcomes: number[] = [];
      const inspector = createSseInspector({ logCtx: log, onTerminal: (_status, override) => outcomes.push(override ?? log.terminalHttpStatus ?? 502) });
      const text = await drain(relaySseEagerBounded(response.body!, new AbortController(), { ...parityHooks,
        inspectChunk: chunk => inspector.feed(chunk), finishInspection: () => inspector.finish(),
        sawTerminal: () => inspector.reported(),
        onSynthetic: () => { if (!inspector.reported()) outcomes.push(log.terminalHttpStatus ?? 502); },
      }));
      const stage = readCodexWsStage(response);
      expect(stage?.terminalEvent).toBe(terminalEvent);
      expect(stage?.terminalErrorStatus).toBe(terminalErrorStatus);
      expect(stage?.relayedEvents).toBe(3);
      expect(stage?.closeCode).toBeNull();
      expect(outcomes).toEqual([loggedStatus]);
      expect(classifyCodexUpstreamOutcome(outcomes[0]!)).toBe("transient");
      // The client tail is unchanged: an unrecognized code stays the generic retryable class.
      const payload = text.split("event: response.failed\ndata: ")[1]!.split("\n")[0]!;
      expect(JSON.parse(payload).response.error.code).toBe(terminal.type === "error" ? "upstream_server_error" : "server_error");
      expect(terminalEvents(text)).toEqual(["response.failed"]);
      expect(sockets[0]!.sent).toHaveLength(1);
      expect(httpDispatches).toBe(0);
    } finally { globalThis.WebSocket = originalWebSocket; }
  });
});

describe("Codex WebSocket terminal kind covers every plain-exchange ending (#6740)", () => {
  async function stageAfter(events: readonly Record<string, unknown>[], readBody = true) {
    const originalWebSocket = globalThis.WebSocket;
    class ScriptWebSocket extends EventTarget {
      readyState = 0;
      constructor() {
        super();
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
      }
      send() {
        for (const event of events) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })));
        }
      }
      close() { this.readyState = 3; }
    }
    globalThis.WebSocket = ScriptWebSocket as unknown as typeof WebSocket;
    try {
      const response = await codexWsUpstreamFetch("https://chatgpt.com/backend-api/codex/responses", streamingInit(),
        (async () => { throw new Error("post-send HTTP replay is forbidden"); }) as typeof fetch);
      if (readBody) await response.text().catch(() => "");
      else for (let tick = 0; tick < 20; tick++) await Promise.resolve();
      return readCodexWsStage(response);
    } finally { globalThis.WebSocket = originalWebSocket; }
  }
  const created = { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } };

  test.each([
    ["response.completed", { type: "response.completed", response: { id: "resp_fixture", status: "completed" } }],
    ["response.incomplete", { type: "response.incomplete", response: { id: "resp_fixture", status: "incomplete" } }],
    // WebSocket-only discriminator, normalized before it is recorded.
    ["response.incomplete", { type: "response.done", response: { id: "resp_fixture", status: "incomplete" } }],
    ["response.failed", { type: "response.done", response: { id: "resp_fixture", status: "failed" } }],
  ] as const)("records %s", async (expected, terminal) => {
    const stage = await stageAfter([created, terminal]);
    expect(stage?.terminalEvent).toBe(expected);
    expect(stage?.terminalErrorStatus).toBeNull();
  });

  test("an exchange with no terminal frame records none", async () => {
    const stage = await stageAfter([created], false);
    expect(stage?.terminalEvent).toBeNull();
    expect(stage?.terminalErrorStatus).toBeNull();
  });

  test("a terminal that arrives but overflows the relay queue is still recorded", async () => {
    const delta = (index: number) => ({ type: "response.output_text.delta", item_id: `item_${index}`, delta: "x".repeat(3_900_000) });
    const stage = await stageAfter([created, delta(1), delta(2),
      { type: "error", status: 503, error: { type: "server_error", code: "server_error", message: "y".repeat(700_000) } }], false);
    expect(stage?.relayedEvents).toBe(3);
    expect(stage?.requestBytes).not.toBeNull();
    expect(stage?.terminalEvent).toBe("error");
    expect(stage?.terminalErrorStatus).toBe(503);
  });
});

describe("one bare-error precedence rule across client, account and row", () => {
  type ClassName = "quota" | "overload" | "unknown" | "refusal";
  // A typed frame states its class on the envelope; an untyped one carries it inside `error`.
  const typed = (name: ClassName): Record<string, unknown> => ({
    quota: { code: "rate_limit_exceeded", message: "typed quota" },
    overload: { code: "server_is_overloaded", message: "typed overload" },
    unknown: { code: "gateway_broken", message: "typed unknown" },
    refusal: { code: "invalid_prompt", message: "typed refusal" },
  })[name];
  const untyped = (name: ClassName): Record<string, unknown> => ({
    quota: { code: "rate_limit_exceeded", message: "untyped quota" },
    overload: { code: "server_is_overloaded", message: "untyped overload" },
    unknown: { code: "mystery_code", message: "untyped unknown" },
    refusal: { code: "invalid_prompt", message: "untyped refusal" },
  })[name];
  const status = (name: ClassName): number => ({ quota: 429, overload: 503, unknown: 502, refusal: 400 })[name];
  const frame = (payload: Record<string, unknown>, kind: "typed" | "untyped"): string => `event: error\ndata: ${
    JSON.stringify(kind === "typed" ? { type: "error", ...payload } : { error: payload })}\n\n`;

  // Both modes see the same mixed frames. Precedence is a question about which verdict wins, so
  // the matrix ends on a clean EOF; reset and cancellation are asserted separately below.
  async function relayMixed(mode: "tee" | "eager", frames: readonly string[], log: RequestLogContext,
    opts: { failAfter?: boolean } = {}) {
    const outcomes: number[] = [];
    const reasons: (string | undefined)[] = [];
    // As the production recorder does: a status the relay states wins over the row's context.
    const onTerminal = (_kind: unknown, status?: number) => outcomes.push(status ?? log.terminalHttpStatus ?? 502);
    const src = sourceStream(frames, { failAfter: opts.failAfter });
    let relayed: ReadableStream<Uint8Array>;
    let inspectionDone: Promise<void> = Promise.resolve();
    let inspector: ReturnType<typeof createSseInspector> | undefined;
    if (mode === "tee") {
      const [client, inspection] = src.tee();
      inspectionDone = new Promise(resolve => consumeForInspection(inspection, onTerminal, undefined, resolve, log));
      relayed = relaySseWithFailedTail(client, new AbortController());
    } else {
      inspector = createSseInspector({ logCtx: log, onTerminal });
      relayed = relaySseEagerBounded(src, new AbortController(), { ...parityHooks,
        // Eager mode reports its synthetic reset through the hook, not the inspector.
        onSynthetic: (_kind, reason) => { reasons.push(reason); outcomes.push(log.terminalHttpStatus ?? 502); },
        inspectChunk: chunk => inspector.feed(chunk), finishInspection: () => inspector.finish(),
        sawTerminal: () => inspector.reported(),
      });
    }
    const text = await drain(relayed);
    if (mode === "eager") inspector?.finish();
    await inspectionDone;
    return { text, outcomes, reasons };
  }

  const failedCode = (text: string): string | undefined => text.split("\n")
    .filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6)) as { type?: string; response?: { error?: { code?: string } } })
    .find(event => event.type === "response.failed")?.response?.error?.code;
  const policyTyped = { code: "cyber_policy", message: "blocked by upstream policy" };

  test.each([
    ["typed quota → untyped policy", [frame(typed("quota"), "typed"), frame(policyTyped, "untyped")], "rate_limit_exceeded", 429],
    ["typed unknown → untyped policy", [frame(typed("unknown"), "typed"), frame(policyTyped, "untyped")], "upstream_server_error", 502],
    ["untyped policy → typed quota", [frame(policyTyped, "untyped"), frame(typed("quota"), "typed")], "cyber_policy", 400],
    ["typed policy → typed quota", [frame(policyTyped, "typed"), frame(typed("quota"), "typed")], "cyber_policy", 400],
    ["typed quota code with policy copy", [frame({ code: "rate_limit_exceeded", message: "flagged for possible cybersecurity risk" }, "typed")], "cyber_policy", 400],
  ] as const)("a policy frame decides client, account and row together: %s", async (_name, frames, code, status) => {
    for (const mode of ["tee", "eager"] as const) {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const { text, outcomes } = await relayMixed(mode, frames, log);
      expect([mode, failedCode(text)]).toEqual([mode, code]);
      expect([mode, outcomes]).toEqual([mode, [status]]);
      expect([mode, httpStatusForRequestLogTerminal("failed", log)]).toEqual([mode, status]);
    }
  });

  test.each([
    ["policy copy", "flagged for possible cybersecurity risk", "cyber_policy"],
    ["safety copy", "This request was blocked by our safety systems.", "invalid_prompt"],
  ] as const)("a %s refusal that echoes a sent credential stays a refusal on every reader", async (_name, copy, code) => {
    const secret = "fixture_refusal_echo_credential_8415";
    const registry = new OutboundCredentialRegistry();
    registry.remember({ authorization: `Bearer ${secret}` });
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      for (const mode of ["tee", "eager"] as const) {
        const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
        const { text, outcomes } = await relayMixed(mode, [frame({ code: "gateway_broken", message: `${copy} ${secret}` }, "untyped")], log);
        expect([mode, failedCode(text), outcomes, httpStatusForRequestLogTerminal("failed", log)]).toEqual([mode, code, [400], 400]);
        expect([mode, (log.upstreamError ?? "").includes(secret)]).toEqual([mode, false]);
      }
    } finally { restore(); }
  });

  test("a genuine terminal with the generic upstream identity is classified like on its own", () => {
    const failed = { type: "response.failed", response: { status: "failed", error: { type: "upstream_error", code: "upstream_server_error", message: "invalid api key" } } };
    const alone: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(alone, JSON.stringify(failed));
    const afterBare: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(afterBare, JSON.stringify({ type: "error", code: "mystery_code", message: "typed unknown" }));
    inspectResponseLogSsePayload(afterBare, JSON.stringify(failed));
    expect(httpStatusForRequestLogTerminal("failed", afterBare)).toBe(httpStatusForRequestLogTerminal("failed", alone));
    expect(alone.terminalHttpStatus).toBe(401);
  });

  test.each([
    ["a recognized quota code beside policy copy", { code: "rate_limit_exceeded", message: "flagged for possible cybersecurity risk" }, "rate_limit_exceeded", 429],
    ["copy-only policy refusal", { code: "gateway_broken", message: "flagged for possible cybersecurity risk" }, "cyber_policy", 400],
  ] as const)("the final row's error code follows the bare verdict: %s", async (_name, error, code, status) => {
    for (const mode of ["tee", "eager"] as const) {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const { text, outcomes } = await relayMixed(mode, [frame(error, "untyped")], log);
      const rows: Array<{ status: number; errorCode?: string }> = [];
      addFinalRequestLog("bare-row", 0, log, httpStatusForRequestLogTerminal("failed", log), { terminalStatus: "failed" }, entry => rows.push(entry));
      expect([mode, failedCode(text), outcomes, rows.map(row => [row.status, row.errorCode])]).toEqual([mode, code, [status], [[status, code]]]);
    }
  });

  test("a genuine terminal in the relay's exact tail shape stays genuine on the inspection row", async () => {
    // Byte-for-byte the shape the relay renders, but from upstream: only registered relay output is a tail.
    const copy = "flagged for possible cybersecurity risk";
    const error = { type: "rate_limit_error", code: "rate_limit_exceeded", message: copy };
    const genuine = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error, last_error: error } })}\n\n`;
    for (const mode of ["tee", "eager"] as const) {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const { text, outcomes } = await relayMixed(mode, [frame({ code: "rate_limit_exceeded", message: copy }, "untyped"), genuine], log);
      expect([mode, failedCode(text), outcomes, httpStatusForRequestLogTerminal("failed", log)]).toEqual([mode, "cyber_policy", [400], 400]);
    }
  });

  test("a genuine terminal that shares the verdict's fields is not mistaken for the relay tail", async () => {
    const copy = "flagged for possible cybersecurity risk";
    const genuine = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed",
      response: { status: "failed", error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: copy } } })}\n\n`;
    for (const mode of ["tee", "eager"] as const) {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const { text, outcomes } = await relayMixed(mode, [frame({ code: "rate_limit_exceeded", message: copy }, "untyped"), genuine], log);
      const rows: Array<{ status: number; errorCode?: string }> = [];
      addFinalRequestLog("genuine-tail", 0, log, httpStatusForRequestLogTerminal("failed", log), { terminalStatus: "failed" }, entry => rows.push(entry));
      expect([mode, failedCode(text), outcomes, rows.map(row => [row.status, row.errorCode])]).toEqual([mode, "cyber_policy", [400], [[400, "cyber_policy"]]]);
    }
  });

  test.each([
    ["an unrecognized untyped error", frame(untyped("unknown"), "untyped"), true],
    ["an unrecognized typed error", frame(typed("unknown"), "typed"), true],
    ["a recognized quota class", frame(typed("quota"), "typed"), false],
  ] as const)("a reset after %s keeps tee and eager attribution aligned", async (_name, bare, transport) => {
    const tee: RequestLogContext = { model: "fixture-model", provider: "openai",
      activeAttempt: {} as NonNullable<RequestLogContext["activeAttempt"]> };
    await relayMixed("tee", [bare], tee, { failAfter: true });
    expect(tee.activeAttempt?.streamAborted === true).toBe(transport);
    // Eager leaves the transport attribution to passthrough delivery when no reason is stated.
    const { reasons } = await relayMixed("eager", [bare], { model: "fixture-model", provider: "openai" }, { failAfter: true });
    expect(reasons).toEqual([transport ? undefined : "upstream_error"]);
  });

  for (const mode of ["tee", "eager"] as const) {
    for (const order of ["typed→untyped", "untyped→typed"] as const) {
      for (const first of ["quota", "overload", "unknown", "refusal"] as const) {
        for (const second of ["quota", "overload", "unknown", "refusal"] as const) {
          const winner = order === "typed→untyped" ? first : second;
          test(`${mode} ${order} ${first}/${second} keeps the typed ${winner} verdict`, async () => {
            const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
            const { text, outcomes } = await relayMixed(mode, order === "typed→untyped"
              ? [frame(typed(first), "typed"), frame(untyped(second), "untyped")]
              : [frame(untyped(first), "untyped"), frame(typed(second), "typed")], log);
            expect(outcomes).toEqual([status(winner)]);
            // The status the failed row records. A typed unknown leaves the context open so combo
            // preflight can still read explicit event fields, and the row falls back to 502; a
            // stale provisional status from the losing frame must not survive either way.
            expect(httpStatusForRequestLogTerminal("failed", log)).toBe(status(winner));
            expect(classifyCodexUpstreamOutcome(outcomes[0]!)).toBe(
              winner === "quota" ? "quota" : winner === "refusal" ? "caller" : "transient");
            const failed = text.split("event: response.failed\ndata: ")[1]?.split("\n")[0];
            const error = (JSON.parse(failed!) as { response: { error: { code: string }; retryable?: boolean } }).response;
            if (winner === "refusal") {
              expect(error.error.code).toBe("invalid_prompt");
              expect(error.retryable).toBe(false);
            } else if (winner === "quota") {
              expect(error.error.code).toBe("rate_limit_exceeded");
            } else if (winner === "overload") {
              expect(error.error.code).toBe("server_is_overloaded");
            } else {
              expect(error.error.code).toBe("upstream_server_error");
            }
          });
        }
      }
    }
  }

  test.each(["tee", "eager"] as const)("%s keeps the typed verdict after an untyped frame on the row", async mode => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    await relayMixed(mode, [frame(typed("quota"), "typed"), frame(untyped("unknown"), "untyped")], log);
    expect(log.terminalHttpStatus).toBe(429);
    expect(log.upstreamErrorCode).toBe("rate_limit_exceeded");
  });

  test.each(["tee", "eager"] as const)("%s lets a genuine failed terminal replace the bare verdict", async mode => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const { text, outcomes } = await relayMixed(mode, [
      frame(typed("quota"), "typed"),
      frame(untyped("unknown"), "untyped"),
      `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { type: "server_error", code: "server_is_overloaded", message: "genuine terminal" } } })}\n\n`,
    ], log);
    expect(outcomes).toEqual([503]);
    expect(log.terminalHttpStatus).toBe(503);
    expect(terminalEvents(text)).toEqual(["response.failed"]);
  });

  test.each(["tee", "eager"] as const)("%s retires the bare verdict on a genuine completed terminal", async mode => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const { text, outcomes } = await relayMixed(mode, [
      frame(typed("quota"), "typed"),
      frame(untyped("overload"), "untyped"),
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
    ], log);
    // The inspector reports the terminal before the row classifier retires the provisional bare
    // status; the row itself must end without one.
    expect(outcomes).toEqual([502]);
    expect(log.terminalHttpStatus).toBeUndefined();
    expect(terminalEvents(text)).toEqual(["response.completed"]);
  });

  test.each(["tee", "eager"] as const)("%s keeps reset handling after a typed verdict", async mode => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const { text } = await relayMixed(mode, [frame(typed("overload"), "typed")], log);
    expect(terminalEvents(text)).toEqual(["response.failed"]);
    expect(log.terminalHttpStatus).toBe(503);
    expect(log.upstreamErrorCode).toBe("server_is_overloaded");
  });

  test.each(["tee", "eager"] as const)("%s ignores a bare frame after a genuine terminal", async mode => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const { text } = await relayMixed(mode, [
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
      frame(typed("quota"), "typed"),
    ], log);
    expect(log.terminalHttpStatus).toBeUndefined();
    expect(terminalEvents(text)).toEqual(["response.completed"]);
  });

  test.each(["tee", "eager"] as const)("%s recognizes an explicit refusal the typed log classifier did not", async mode => {
    for (const kind of ["typed", "untyped"] as const) {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const refusal = { code: "gateway_broken", message: "This request was blocked by our safety systems." };
      const { text, outcomes } = await relayMixed(mode, [frame(refusal, kind)], log);
      expect(outcomes).toEqual([400]);
      expect(log.terminalHttpStatus).toBe(400);
      expect(log.upstreamErrorCode).toBe("invalid_prompt");
      expect(classifyCodexUpstreamOutcome(outcomes[0]!)).toBe("caller");
      const failed = text.split("event: response.failed\ndata: ")[1]?.split("\n")[0];
      const error = (JSON.parse(failed!) as { response: { error: { code: string }; retryable?: boolean } }).response;
      expect(error.error.code).toBe("invalid_prompt");
      expect(error.retryable).toBe(false);
    }
  });

  test.each(["tee", "eager"] as const)("%s keeps a reset after an ordinary untyped error as the transport failure", async mode => {
    // No recognized class and no refusal: the untyped envelope has no transport status, so the
    // socket reset that follows is still what the client is told went wrong, and the row stays
    // the synthetic 502 a reset already records.
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const { text } = await relayMixed(mode, [frame(untyped("unknown"), "untyped")], log, { failAfter: true });
    // The client's own error event echoes the provider's copy; the synthesized terminal neither
    // adopts the unrecognized code nor invents a provider verdict, matching the typed rule in
    // tests/server/relay-eager.test.ts ("ordinary top-level error fail-closed on reader error").
    expect(text).toContain('event: response.failed');
    expect(text).toContain('"code":"upstream_reset"');
    expect(text).not.toContain('"code":"upstream_server_error"');
    expect(text).not.toContain('"code":"mystery_code","message":"Upstream');
    expect(log.terminalHttpStatus).toBe(502);
  });

  test.each(["tee", "eager"] as const)("%s records a client cancellation after a typed verdict as a cancel", async mode => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const cancels: string[] = [];
    const terminals: string[] = [];
    const source = controlledSource();
    let relayed: ReadableStream<Uint8Array>;
    let inspectionDone: Promise<void> = Promise.resolve();
    if (mode === "tee") {
      const clientGone = new AbortController();
      const [client, inspection] = teeWithBoundedInspection(source.body, {
        clientGoneSignal: clientGone.signal, maxReadAheadBytes: 64,
      });
      inspectionDone = new Promise(resolve => consumeForInspection(inspection,
        kind => terminals.push(kind), undefined, resolve, log, () => cancels.push("cancel"), undefined, undefined,
        { clientGoneSignal: clientGone.signal, drainBounds: { ms: 100, bytes: 4_096 } }));
      relayed = relaySseWithFailedTail(client, new AbortController(), reason => clientGone.abort(reason));
    } else {
      const inspector = createSseInspector({ logCtx: log, onTerminal: kind => terminals.push(kind) });
      relayed = relaySseEagerBounded(source.body, new AbortController(), { ...parityHooks,
        inspectChunk: chunk => inspector.feed(chunk), finishInspection: () => inspector.finish(),
        sawTerminal: () => inspector.reported(), onClientCancel: () => cancels.push("cancel"),
        onSynthetic: kind => terminals.push(kind),
      }, { postCancelDrainMs: 100 });
    }
    source.push(encoder.encode(frame(typed("quota"), "typed")));
    const reader = relayed.getReader();
    await reader.read();
    await reader.cancel("client closed");
    await inspectionDone;
    // Eager mode keeps draining a silent upstream until its post-cancel bound expires.
    if (mode === "eager") await Bun.sleep(150);
    // Cancellation is not a failure the upstream stated: the client left, so no synthetic
    // terminal is invented and the row keeps only the provisional verdict it observed.
    expect(cancels).toEqual(["cancel"]);
    expect(terminals).toEqual([]);
    expect(log.terminalHttpStatus).toBe(429);
  });
});

describe("Codex WebSocket frames share the bare-error precedence rule", () => {
  const typedFrame = (code: string, message: string): string =>
    JSON.stringify({ type: "error", code, message });
  const untypedFrame = (code: string, message: string): string =>
    JSON.stringify({ error: { code, message } });

  test("a later untyped frame cannot replace a typed quota verdict on the WS row", () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(log, typedFrame("rate_limit_exceeded", "typed quota"));
    inspectResponseLogSsePayload(log, untypedFrame("mystery_code", "untyped unknown"));
    expect(log.terminalHttpStatus).toBe(429);
    expect(log.upstreamErrorCode).toBe("rate_limit_exceeded");
    expect(log.upstreamError).toBe("typed quota");
  });

  test("a later typed refusal replaces an untyped quota verdict on the WS row", () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(log, untypedFrame("rate_limit_exceeded", "untyped quota"));
    inspectResponseLogSsePayload(log, typedFrame("invalid_prompt", "typed refusal"));
    expect(log.terminalHttpStatus).toBe(400);
    expect(log.upstreamErrorCode).toBe("invalid_prompt");
    expect(log.upstreamError).toBe("typed refusal");
  });

  test("an explicit refusal message is recognized when the typed log classifier did not classify it", () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    // A typed frame whose class is not a refusal, but whose copy is the verified refusal phrase:
    // the terminal classifier has no structured refusal to key on, so the shared reducer must.
    inspectResponseLogSsePayload(log, JSON.stringify({ type: "error", code: "mystery_code",
      message: "This request was blocked by our safety systems." }));
    expect(log.terminalHttpStatus).toBe(400);
    expect(log.upstreamErrorCode).toBe("invalid_prompt");
  });

  test.each(["tee", "eager"] as const)("%s WS client receives the typed verdict after an untyped frame", async mode => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const src = sourceStream([
      `event: error\ndata: ${JSON.stringify({ type: "error", code: "rate_limit_exceeded", message: "typed quota" })}\n\n`,
      `event: error\ndata: ${JSON.stringify({ error: { code: "mystery_code", message: "untyped unknown" } })}\n\n`,
    ]);
    const relayed = mode === "tee"
      ? relaySseWithFailedTail(src, new AbortController())
      : relaySseEagerBounded(src, new AbortController(), parityHooks);
    const sent: string[] = [];
    const terminals: string[] = [];
    const ws = {
      readyState: 1,
      data: {},
      send(message: string) { sent.push(message); return 1; },
    } as unknown as ServerWebSocket<WsData>;
    // `untilEof` is the live Responses path: the first error frame is provisional, so the relay
    // must reach its synthesized terminal instead of stopping at the bare frame.
    await pumpResponsesSseToWebSocket(ws, relayed, { untilEof: true,
      onSsePayload: payload => inspectResponseLogSsePayload(log, payload),
      onTerminal: status => { terminals.push(status); } });
    const failed = sent.map(frame => JSON.parse(frame) as { type?: string; response?: { error?: { code?: string } } })
      .find(frame => frame.type === "response.failed");
    expect(failed?.response?.error?.code).toBe("rate_limit_exceeded");
    expect(terminals).toEqual(["failed"]);
    expect(log.terminalHttpStatus).toBe(429);
    expect(log.upstreamErrorCode).toBe("rate_limit_exceeded");
    expect(classifyCodexUpstreamOutcome(log.terminalHttpStatus!)).toBe("quota");
  });

  const wsPump = async (relayed: ReadableStream<Uint8Array>, log: RequestLogContext, rawUpstream = false) => {
    const sent: string[] = [];
    const terminals: Array<[string, number]> = [];
    const ws = { readyState: 1, data: {}, send(message: string) { sent.push(message); return 1; } } as unknown as ServerWebSocket<WsData>;
    // The live WS log observes the client stream and hands the row status to the account recorder.
    await pumpResponsesSseToWebSocket(ws, relayed, { untilEof: true, rawUpstream,
      onSsePayload: payload => inspectResponseLogSsePayload(log, payload),
      onTerminal: status => { terminals.push([status, log.terminalHttpStatus ?? 502]); } });
    return { frames: sent.map(frame => JSON.parse(frame) as { type?: string; response?: { error?: { code?: string } }; error?: { code?: string } }), terminals };
  };

  test.each(["tee", "eager"] as const)("%s WS row keeps the bare verdict behind the relay's own tail", async mode => {
    for (const copy of ["unauthorized request", "rate limit hit, slow down"]) {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      const src = sourceStream([`event: error\ndata: ${JSON.stringify({ error: { code: "mystery_code", message: copy } })}\n\n`]);
      const relayed = mode === "tee" ? relaySseWithFailedTail(src, new AbortController(), undefined, { onSyntheticTail: (payload, verdict) => noteRelaySyntheticTail(log, payload, verdict) }) : relaySseEagerBounded(src, new AbortController(), parityHooks, { onSyntheticTail: (payload, verdict) => noteRelaySyntheticTail(log, payload, verdict) });
      const { frames, terminals } = await wsPump(relayed, log);
      expect([copy, frames.find(frame => frame.type === "response.failed")?.response?.error?.code]).toEqual([copy, "upstream_server_error"]);
      expect([copy, terminals, httpStatusForRequestLogTerminal("failed", log)]).toEqual([copy, [["failed", 502]], 502]);
    }
  });

  test.each(["tee", "eager"] as const)("%s WS final row and attempt keep the verdict's code behind the relay tail", async mode => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai",
      activeAttempt: {} as NonNullable<RequestLogContext["activeAttempt"]> };
    const error = { code: "rate_limit_exceeded", message: "flagged for possible cybersecurity risk" };
    const src = sourceStream([`event: error\ndata: ${JSON.stringify({ error })}\n\n`]);
    const relayed = mode === "tee" ? relaySseWithFailedTail(src, new AbortController(), undefined, { onSyntheticTail: (payload, verdict) => noteRelaySyntheticTail(log, payload, verdict) }) : relaySseEagerBounded(src, new AbortController(), parityHooks, { onSyntheticTail: (payload, verdict) => noteRelaySyntheticTail(log, payload, verdict) });
    const { frames, terminals } = await wsPump(relayed, log);
    expect(frames.find(frame => frame.type === "response.failed")?.response?.error?.code).toBe("rate_limit_exceeded");
    expect(terminals).toEqual([["failed", 429]]);
    const rows: Array<{ status: number; errorCode?: string }> = [];
    addFinalRequestLog("ws-bare-row", 0, log, httpStatusForRequestLogTerminal("failed", log), { terminalStatus: "failed" }, entry => rows.push(entry));
    expect(rows.map(row => [row.status, row.errorCode])).toEqual([[429, "rate_limit_exceeded"]]);
    expect(log.activeAttempt?.errorCode).toBe("rate_limit_exceeded");
  });

  test.each(["tee", "eager"] as const)("%s WS row treats a genuine terminal with the verdict's fields as genuine", async mode => {
    const copy = "flagged for possible cybersecurity risk";
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const src = sourceStream([
      `event: error\ndata: ${JSON.stringify({ error: { code: "rate_limit_exceeded", message: copy } })}\n\n`,
      `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed",
        response: { status: "failed", error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: copy } } })}\n\n`,
    ]);
    const relayed = mode === "tee" ? relaySseWithFailedTail(src, new AbortController()) : relaySseEagerBounded(src, new AbortController(), parityHooks);
    const { frames, terminals } = await wsPump(relayed, log);
    expect(frames.find(frame => frame.type === "response.failed")?.response?.error?.code).toBe("cyber_policy");
    expect([terminals, httpStatusForRequestLogTerminal("failed", log)]).toEqual([[["failed", 400]], 400]);
  });

  test.each(["tee", "eager"] as const)("%s keeps a genuine terminal in the relay's exact tail shape genuine on the WS log", async mode => {
    // Byte-for-byte the shape the relay renders, but from upstream: only registered relay output is a tail.
    const copy = "flagged for possible cybersecurity risk";
    const error = { type: "rate_limit_error", code: "rate_limit_exceeded", message: copy };
    const genuine = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error, last_error: error } })}\n\n`;
    const bare = `event: error\ndata: ${JSON.stringify({ error: { code: "rate_limit_exceeded", message: copy } })}\n\n`;
    const wsLog: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const src = sourceStream([bare, genuine]);
    const tail = { onSyntheticTail: (payload: string, verdict?: BareUpstreamError) => noteRelaySyntheticTail(wsLog, payload, verdict) };
    const relayed = mode === "tee" ? relaySseWithFailedTail(src, new AbortController(), undefined, tail) : relaySseEagerBounded(src, new AbortController(), parityHooks, tail);
    const { terminals } = await wsPump(relayed, wsLog);
    expect([terminals, httpStatusForRequestLogTerminal("failed", wsLog)]).toEqual([[["failed", 400]], 400]);
  });

  test("a raw WS upstream body keeps an untyped envelope as the protocol error, off the row", async () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    const src = sourceStream([`event: error\ndata: ${JSON.stringify({ error: { code: "rate_limit_exceeded", message: "untyped quota" } })}\n\n`]);
    const { frames, terminals } = await wsPump(src, log, true);
    expect(frames.map(frame => frame.error?.code ?? frame.type)).toEqual(["websocket_protocol_error"]);
    expect(terminals).toEqual([["incomplete", 502]]);
    expect(log.terminalHttpStatus).toBeUndefined();
  });

  test("a genuine terminal clears diagnostics an untyped frame recorded", () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(log, JSON.stringify({ error: { code: "gateway_broken", message: "flagged for possible cybersecurity risk" } }));
    expect(log.upstreamErrorCode).toBe("cyber_policy");
    inspectResponseLogSsePayload(log, JSON.stringify({ type: "response.completed", response: { status: "completed" } }));
    expect([log.terminalHttpStatus, log.upstreamErrorCode, log.upstreamErrorType]).toEqual([undefined, undefined, undefined]);
  });

  test("an untyped credential echo stays redacted on the winning WS row", () => {
    const credential = "fixture-bare-echo-CANARY9live";
    const registry = new OutboundCredentialRegistry();
    registry.remember({ authorization: `Bearer ${credential}` });
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, JSON.stringify({ error: { code: "server_is_overloaded", message: `echo ${credential}` } }));
      expect(log.terminalHttpStatus).toBe(503);
      expect(log.upstreamError).not.toContain(credential);
    } finally { restore(); }
  });

  test("a genuine terminal replaces a typed verdict's code and copy on the row", () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(log, typedFrame("rate_limit_exceeded", "typed quota"));
    inspectResponseLogSsePayload(log, JSON.stringify({ type: "response.failed",
      response: { status: "failed", error: { code: "server_is_overloaded", message: "fixture overloaded" } } }));
    expect([log.terminalHttpStatus, log.upstreamErrorCode, log.upstreamError]).toEqual([503, "server_is_overloaded", "fixture overloaded"]);
  });

  test("a terminal that replaces a verdict's copy cannot store an echoed credential", () => {
    const credential = "fixture-terminal-echo-CANARY8415";
    const registry = new OutboundCredentialRegistry();
    registry.remember({ authorization: `Bearer ${credential}` });
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      inspectResponseLogSsePayload(log, typedFrame("rate_limit_exceeded", "typed quota"));
      inspectResponseLogSsePayload(log, JSON.stringify({ type: "response.failed",
        response: { status: "failed", error: { code: "server_is_overloaded", message: `echo ${credential}` } } }));
      expect(log.upstreamError ?? "").not.toContain(credential);
      expect(log.terminalHttpStatus).toBe(503);
    } finally { restore(); }
  });

  test.each([
    ["an incomplete reason after a typed verdict", (credential: string) => [typedFrame("rate_limit_exceeded", "typed quota"),
      JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: credential } } })], "incomplete"],
    ["a later terminal after a completion retired the verdict", (credential: string) => [typedFrame("rate_limit_exceeded", "typed quota"),
      JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
      JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: `echo ${credential}` } } })], "failed"],
  ] as const)("row copy cannot store an echoed credential: %s", (_name, frames, terminal) => {
    const credential = "fixture-secret-rowcopy-8415";
    const registry = new OutboundCredentialRegistry();
    registry.remember({ authorization: `Bearer ${credential}` });
    const restore = setOutboundCredentialRegistryForTests(registry);
    try {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      for (const payload of frames(credential)) inspectResponseLogSsePayload(log, payload);
      const rows: unknown[] = [];
      addFinalRequestLog("row-copy", 0, log, httpStatusForRequestLogTerminal(terminal, log), { terminalStatus: terminal }, entry => rows.push(entry));
      expect(log.upstreamError ?? "").not.toContain(credential);
      expect(JSON.stringify(rows)).not.toContain(credential);
    } finally { restore(); }
  });

  test("a bare frame after a genuine terminal does not supply the row copy", () => {
    const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
    inspectResponseLogSsePayload(log, JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "server_error" } } }));
    inspectResponseLogSsePayload(log, untypedFrame("gateway_broken", "flagged for possible cybersecurity risk"));
    expect(log.upstreamError ?? "").not.toContain("cybersecurity");
  });

  test("inspection without a request row reports the bare verdict's status at EOF", async () => {
    const reported: Array<[string, number | undefined]> = [];
    const src = sourceStream([`data: ${untypedFrame("rate_limit_exceeded", "untyped quota")}\n\n`]);
    await new Promise<void>(resolve => consumeForInspection(src, (status, http) => { reported.push([status, http]); }, undefined, resolve));
    expect(reported).toEqual([["failed", 429]]);
  });

  test("a completion after a policy terminal in the same stream is not kept as continuation state", async () => {
    const completed = `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [] } })}\n\n`;
    const kept = async (chunks: string[]): Promise<number> => {
      let count = 0;
      await new Promise<void>(resolve => consumeForInspection(sourceStream(chunks), () => {}, undefined, resolve,
        undefined, undefined, () => { count++; }));
      return count;
    };
    expect(await kept([completed])).toBe(1);
    expect(await kept([`data: ${untypedFrame("cyber_policy", "fixture blocked")}\n\n`, completed])).toBe(0);
    // A policy frame after an earlier genuine terminal ended nothing, so late completions still fire.
    const failed = `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "server_error" } } })}\n\n`;
    expect(await kept([failed, `data: ${typedFrame("cyber_policy", "fixture blocked")}\n\n`, completed])).toBe(1);
  });

  test.each([
    ["untyped", untypedFrame("cyber_policy", "fixture blocked")],
    ["typed", typedFrame("cyber_policy", "fixture blocked")],
  ] as const)("metadata inspection keeps a %s policy verdict over a later genuine terminal", async (_kind, policy) => {
    for (const later of [
      { type: "response.completed", response: { status: "completed" } },
      { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "fixture later" } } },
    ]) {
      const log: RequestLogContext = { model: "fixture-model", provider: "openai" };
      await new Promise<void>(resolve => consumeForResponseLogMetadata(sourceStream([
        `data: ${policy}\n\n`, `event: ${later.type}\ndata: ${JSON.stringify(later)}\n\n`,
      ]), log, undefined, resolve));
      expect([httpStatusForRequestLogTerminal("failed", log), log.terminalErrorCode, log.upstreamErrorCode]).toEqual([400, "cyber_policy", "cyber_policy"]);
    }
  });
});
