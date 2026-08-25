import { describe, expect, test } from "bun:test";
import { consumeForInspection, linkAbortSignal, relaySseWithFailedTail, relaySseWithHeartbeat, relayWithAbort } from "../src/server";

const root = new URL("../", import.meta.url);

async function readSource(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

describe("passthrough relayWithAbort (RC2, passthrough path)", () => {
  test("native passthrough SSE keeps the real platform gate and pure native relay invariants", async () => {
    const coreSource = await readSource("src/server/responses/core.ts");
    const relaySource = await readSource("src/server/relay.ts");
    const capsSource = await readSource("src/lib/bun-stream-caps.ts");
    const sseBranch = coreSource.slice(
      coreSource.indexOf("if (isEventStream && upstreamResponse.body)"),
      coreSource.indexOf("const body = relayWithAbort(upstreamResponse.body, upstream);"),
    );
    const logWrapper = relaySource.slice(
      relaySource.indexOf("export function responseWithDeferredRequestLog"),
      relaySource.indexOf("export function relaySseWithHeartbeat"),
    );
    const selector = capsSource.slice(
      capsSource.indexOf("export function selectEagerPath"),
    );

    expect(sseBranch).toContain("const terminalRepairPolicy = providerModelResponsesTerminalRepair(");
    expect(sseBranch).toContain("const passthroughSseBody = terminalRepairPolicy");
    expect(sseBranch).toContain(": upstreamResponse.body;");
    expect(sseBranch).toContain("passthroughSseBody.tee()");
    // Rewrite traffic is derived from the finalized block chain so every
    // provider-specific transform participates in the platform gate.
    expect(sseBranch).toContain("const repairConfig = route.provider.responsesItemIdRepair;");
    expect(sseBranch).toContain('const githubCopilotRepairEnabled = route.providerName === "github-copilot";');
    expect(sseBranch).toContain("const needsClientRewrite = clientBlockRewrite !== undefined;");
    expect(sseBranch).toContain("new Response(eagerBody");
    expect(sseBranch).toContain("const rewrittenBody = clientBlockRewrite !== undefined");
    expect(sseBranch).toContain("isCodexWsUpstreamResponse(upstreamResponse)");
    expect(sseBranch).toContain("forceCodexWsEagerRelay || eagerPath?.useEagerRelay || win32EagerRewrite");
    expect(sseBranch).not.toContain("win32TerminalRelay");
    // #864: win32 traffic that DOES need a client rewrite takes the eager single
    // reader with the payload rewrite applied inline — never the tee()+JS-pull
    // chain that loses the terminal block on Windows (Bun#32111).
    expect(sseBranch).toContain("win32EagerRewrite");
    expect(sseBranch).toContain("rewriteBlocks: clientBlockRewrite");
    // Elsewhere the failed-tail relay converts mid-stream resets into a clean response.failed.
    expect(sseBranch).toContain("relaySseWithFailedTail(rewrittenBody, upstream");
    expect(sseBranch).toContain("new Response(clientBody");
    expect(sseBranch).toContain("markNativePassthroughSseResponse");
    // #314/phase 100 two-platform contract: the real core gate delegates to the
    // selector, whose darwin branch admits only explicit config-eager decisions.
    expect(sseBranch).toContain("const eagerPath = selectEagerPath(");
    expect(sseBranch).toContain("config.streamMode ?? \"auto\",");
    expect(selector).toContain('platform !== "win32" && platform !== "darwin"');
    expect(selector).toContain('decision.reason === "config-eager"');
    expect(sseBranch).toContain("relaySseEagerBounded(passthroughSseBody, turnAc,");
    expect(sseBranch).not.toContain("relaySseWithHeartbeat(");
    expect(sseBranch).not.toContain("trackStreamLifetime(");
    expect(logWrapper.indexOf("isNativePassthroughSseResponse(response)")).toBeGreaterThanOrEqual(0);
    expect(logWrapper.indexOf("isNativePassthroughSseResponse(response)")).toBeLessThan(logWrapper.indexOf("trackSseForRequestLog("));
  });

  test("CASE B: relays body bytes verbatim and completes cleanly without aborting", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const relayed = relayWithAbort(streamFromChunks([enc.encode("event: a\n"), enc.encode("data: 1\n\n")]), ac)!;
    const reader = relayed.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text).toBe("event: a\ndata: 1\n\n");
    expect(ac.signal.aborted).toBe(false); // no spurious abort on normal completion
  });

  test("CASE A: client cancel aborts the upstream fetch", async () => {
    const ac = new AbortController();
    // An upstream that never produces — models a stalled connection the client gives up on.
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const relayed = relayWithAbort(body, ac)!;
    const reader = relayed.getReader();
    const pending = reader.read(); // stays pending (no data upstream)
    await reader.cancel();         // client disconnects
    expect(ac.signal.aborted).toBe(true);
    await pending.catch(() => {});
  });

  test("a null upstream body relays as null", () => {
    const ac = new AbortController();
    expect(relayWithAbort(null, ac)).toBeNull();
    expect(ac.signal.aborted).toBe(false);
  });

  test("SSE passthrough emits heartbeat comments while upstream is silent", async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const relayed = relaySseWithHeartbeat(body, ac, 5)!;
    const reader = relayed.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("heartbeat timeout")), 200)),
    ]);

    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe(": opencodex keepalive\n\n");

    await reader.cancel("client gone");
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("client gone");
  });

  test("SSE passthrough lifecycle callbacks run once on EOF and cancel", async () => {
    const enc = new TextEncoder();
    const lifecycle: string[] = [];
    const completed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n'),
    ]), new AbortController(), 15_000, undefined, {
      onStart: () => lifecycle.push("complete-start"),
      onDone: () => lifecycle.push("complete-done"),
    })!;

    await readAll(completed);
    expect(lifecycle).toEqual(["complete-start", "complete-done"]);

    const cancelAc = new AbortController();
    const cancelledLifecycle: string[] = [];
    const pendingBody = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const cancelled = relaySseWithHeartbeat(pendingBody, cancelAc, 15_000, undefined, {
      onStart: () => cancelledLifecycle.push("cancel-start"),
      onDone: () => cancelledLifecycle.push("cancel-done"),
    })!;
    const reader = cancelled.getReader();
    const pending = reader.read();
    await reader.cancel("client gone");

    expect(cancelAc.signal.aborted).toBe(true);
    expect(cancelledLifecycle).toEqual(["cancel-start", "cancel-done"]);
    await pending.catch(() => {});
  });

  test("SSE passthrough reports failed terminal payloads", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n'),
    ]), ac, 15_000, status => terminals.push(status))!;

    expect(await readAll(relayed)).toContain("response.failed");
    expect(terminals).toEqual(["failed"]);
  });

  test("tee/pull relay clean EOF synthesizes one adapter_eof incomplete and one DONE", async () => {
    const enc = new TextEncoder();
    const relayed = relaySseWithFailedTail(streamFromChunks([
      enc.encode('event: response.created\ndata: {"type":"response.created"}\n\n'),
    ]), new AbortController());
    const text = await readAll(relayed);
    expect(text.match(/event: response\.incomplete/g)?.length).toBe(1);
    expect(text).toContain('"reason":"adapter_eof"');
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
  });

  test("tee/pull relay suppresses a premature DONE before the synthetic terminal", async () => {
    const enc = new TextEncoder();
    const relayed = relaySseWithFailedTail(streamFromChunks([
      enc.encode('event: response.created\ndata: {"type":"response.created"}\n\ndata: [DONE]\n\n'),
    ]), new AbortController());
    const text = await readAll(relayed);
    expect(text.match(/event: response\.incomplete/g)?.length).toBe(1);
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text.indexOf("response.incomplete")).toBeLessThan(text.indexOf("data: [DONE]"));
  });

  test("tee/pull relay rewrites policy incomplete and top-level error to failed", async () => {
    const enc = new TextEncoder();
    for (const frame of [
      `event: response.incomplete\ndata: ${JSON.stringify({
        type: "response.incomplete",
        response: {
          status: "incomplete",
          error: { type: "invalid_request_error", code: "cyber_policy", message: "blocked" },
        },
      })}\n\n`,
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", code: "cyber_policy", message: "blocked" },
      })}\n\n`,
    ]) {
      const relayed = relaySseWithFailedTail(streamFromChunks([enc.encode(frame)]), new AbortController());
      const text = await readAll(relayed);
      expect(text.match(/event: response\.failed/g)?.length).toBe(1);
      expect(text).not.toContain("response.incomplete");
      expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
      expect(text).toContain('"type":"invalid_request_error"');
      expect(text).toContain('"code":"cyber_policy"');
    }
  });

  test("tee/pull normalizes structured policy response.failed while preserving metadata", async () => {
    const enc = new TextEncoder();
    const payload = JSON.stringify({
      type: "response.failed",
      sequence_number: 19,
      model: "gpt-policy",
      response: {
        id: "resp-structured-policy-pull",
        output: [{ type: "message", id: "item-structured-policy-pull" }],
        status: "failed",
        error: {
          type: "server_error",
          code: "cyber_policy",
          message: `blocked by upstream policy Authorization: ${["Bear", "er"].join("")} relaypullsecret123456`,
        },
      },
    });
    const relayed = relaySseWithFailedTail(streamFromChunks([
      enc.encode(`event: response.failed\ndata: ${payload}\n\n`),
    ]), new AbortController());

    const text = await readAll(relayed);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).toContain('"type":"server_error"');
    expect(text).toContain('"code":"cyber_policy"');
    expect(text).toContain("Authorization: Bearer [REDACTED]");
    expect(text).not.toContain("relaypullsecret123456");
    expect(text).toContain('"sequence_number":19');
    expect(text).toContain('"model":"gpt-policy"');
    expect(text).toContain('"id":"resp-structured-policy-pull"');
    expect(text).toContain('"output":[{"type":"message","id":"item-structured-policy-pull"}]');
  });

  test("tee/pull preserves a policy error before same-chunk frame-count overflow", async () => {
    const enc = new TextEncoder();
    const policy = JSON.stringify({
      type: "error",
      sequence_number: 24,
      response: {
        id: "resp-policy-pull-frame-count",
        output: [{ type: "message", id: "item-policy-pull-frame-count" }],
        status: "failed",
      },
      error: {
        type: "invalid_request_error",
        code: "cyber_policy",
        message: "blocked by upstream policy",
      },
    });
    const relayed = relaySseWithFailedTail(streamFromChunks([
      enc.encode(`event: error\ndata: ${policy}\n\n${"\n\n".repeat(4096)}`),
    ]), new AbortController());

    const text = await readAll(relayed);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).not.toContain("upstream_reset");
    expect(text).toContain('"code":"cyber_policy"');
    expect(text).toContain('"sequence_number":24');
    expect(text).toContain('"id":"resp-policy-pull-frame-count"');
    expect(text).toContain('"output":[{"type":"message","id":"item-policy-pull-frame-count"}]');
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
  });

  test("tee/pull preserves a policy error before same-chunk oversized trailing bytes", async () => {
    const enc = new TextEncoder();
    const policy = JSON.stringify({
      type: "error",
      sequence_number: 26,
      response: { id: "resp-policy-pull-byte-overflow", output: [], status: "failed" },
      error: {
        type: "invalid_request_error",
        code: "cyber_policy",
        message: "blocked by upstream policy",
      },
    });
    const oversizedTail = new Uint8Array(4 * 1024 * 1024 + 1).fill(120);
    const relayed = relaySseWithFailedTail(streamFromChunks([joinBytes([
      enc.encode(`event: error\ndata: ${policy}\n\n`),
      oversizedTail,
    ])]), new AbortController());

    const text = await readAll(relayed);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).not.toContain("upstream_reset");
    expect(text).toContain('"code":"cyber_policy"');
    expect(text).toContain('"sequence_number":26');
    expect(text).toContain('"id":"resp-policy-pull-byte-overflow"');
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
  });

  test("tee/pull parses each unframed EOF terminal once without adapter_eof", async () => {
    const enc = new TextEncoder();
    const cases = [
      {
        type: "response.completed",
        event: "response.completed",
        payload: {
          type: "response.completed",
          sequence_number: 41,
          response: { id: "resp-pull-unframed-completed", status: "completed", output: [] },
        },
      },
      {
        type: "response.failed",
        event: "response.failed",
        payload: {
          type: "response.failed",
          sequence_number: 42,
          response: { id: "resp-pull-unframed-failed", status: "failed", output: [] },
        },
      },
      {
        type: "response.incomplete",
        event: "response.incomplete",
        payload: {
          type: "response.incomplete",
          sequence_number: 43,
          response: { id: "resp-pull-unframed-incomplete", status: "incomplete", output: [] },
        },
      },
      {
        type: "error",
        event: "response.failed",
        payload: {
          type: "error",
          sequence_number: 44,
          response: {
            id: "resp-pull-unframed-policy",
            output: [{ type: "message", id: "item-pull-unframed-policy" }],
            status: "failed",
          },
          error: {
            type: "invalid_request_error",
            code: "cyber_policy",
            message: "blocked by upstream policy",
          },
        },
      },
    ] as const;

    for (const fixture of cases) {
      const relayed = relaySseWithFailedTail(streamFromChunks([
        enc.encode(`event: ${fixture.type}\ndata: ${JSON.stringify(fixture.payload)}`),
      ]), new AbortController());
      const text = await readAll(relayed);
      expect(text.match(/event: response\.(?:completed|failed|incomplete)/g)?.length).toBe(1);
      expect(text).toContain(`event: ${fixture.event}`);
      expect(text).not.toContain('"reason":"adapter_eof"');
      expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    }
  });

  test("tee/pull preserves an unframed terminal before a reader error", async () => {
    const enc = new TextEncoder();
    const cases = [
      {
        type: "response.completed",
        event: "response.completed",
        payload: {
          type: "response.completed",
          sequence_number: 51,
          response: { id: "resp-read-error-completed", status: "completed", output: [] },
        },
      },
      {
        type: "response.failed",
        event: "response.failed",
        payload: {
          type: "response.failed",
          sequence_number: 52,
          response: { id: "resp-read-error-failed", status: "failed", output: [] },
        },
      },
      {
        type: "response.incomplete",
        event: "response.incomplete",
        payload: {
          type: "response.incomplete",
          sequence_number: 53,
          response: { id: "resp-read-error-incomplete", status: "incomplete", output: [] },
        },
      },
      {
        type: "error",
        event: "response.failed",
        payload: {
          type: "error",
          sequence_number: 54,
          response: {
            id: "resp-read-error-policy",
            output: [{ type: "message", id: "item-read-error-policy" }],
            status: "failed",
          },
          error: {
            type: "invalid_request_error",
            code: "cyber_policy",
            message: "blocked by upstream policy",
          },
        },
      },
    ] as const;

    for (const fixture of cases) {
      let firstPull = true;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (firstPull) {
            firstPull = false;
            controller.enqueue(enc.encode(`event: ${fixture.type}\ndata: ${JSON.stringify(fixture.payload)}`));
          } else {
            controller.error(new Error("socket reset after unframed terminal"));
          }
        },
      });
      const relayed = relaySseWithFailedTail(body, new AbortController());
      const text = await readAll(relayed);
      expect(text.match(/event: response\.(?:completed|failed|incomplete)/g)?.length).toBe(1);
      expect(text).toContain(`event: ${fixture.event}`);
      expect(text).not.toContain("upstream_reset");
      expect(text).not.toContain('"reason":"adapter_eof"');
      expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
      if (fixture.type === "error") {
        expect(text).toContain('"sequence_number":54');
        expect(text).toContain('"id":"resp-read-error-policy"');
        expect(text).toContain('"output":[{"type":"message","id":"item-read-error-policy"}]');
      }
    }
  });

  test("tee/pull keeps an ordinary top-level error fail-closed on reader error", async () => {
    let firstPull = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstPull) {
          firstPull = false;
          controller.enqueue(new TextEncoder().encode(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "server_error", code: "upstream_error", message: "provider failed" },
            })}`,
          ));
        } else {
          controller.error(new Error("socket reset after ordinary error"));
        }
      },
    });
    const relayed = relaySseWithFailedTail(body, new AbortController());
    const text = await readAll(relayed);
    expect(text).toContain("event: error");
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).toContain('"code":"upstream_reset"');
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).not.toContain('"code":"cyber_policy"');
  });

  test("inspection read-error flush records an unframed policy terminal as failed 400", async () => {
    let firstPull = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstPull) {
          firstPull = false;
          controller.enqueue(new TextEncoder().encode(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              sequence_number: 55,
              response: { id: "resp-inspection-read-error-policy", output: [], status: "failed" },
              error: {
                type: "invalid_request_error",
                code: "cyber_policy",
                message: "blocked by upstream policy",
              },
            })}`,
          ));
        } else {
          controller.error(new Error("socket reset after inspection policy terminal"));
        }
      },
    });
    const terminals: Array<{ status: string; httpStatus?: number }> = [];
    let done!: () => void;
    const completed = new Promise<void>(resolve => { done = resolve; });
    consumeForInspection(
      body,
      (status, httpStatus) => terminals.push({ status, ...(httpStatus === undefined ? {} : { httpStatus }) }),
      undefined,
      done,
    );
    await completed;
    expect(terminals).toEqual([{ status: "failed", httpStatus: 400 }]);
  });

  test("SSE passthrough reports incomplete on EOF before a terminal payload", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.created\ndata: {"type":"response.created"}\n\n'),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["incomplete"]);
  });

  test("SSE passthrough does not report terminal status on client cancel", async () => {
    const ac = new AbortController();
    const terminals: string[] = [];
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const relayed = relaySseWithHeartbeat(body, ac, 15_000, status => terminals.push(status))!;
    const reader = relayed.getReader();
    const pending = reader.read();
    await reader.cancel("client gone");

    expect(ac.signal.aborted).toBe(true);
    expect(terminals).toEqual([]);
    await pending.catch(() => {});
  });

  test("SSE passthrough reports CRLF and multiline terminal payloads", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"id":"r1"}}\r\n\r\n'),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["completed"]);
  });

  test("SSE passthrough reports split terminal frames", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.completed\ndata: {"type":"response.'),
      enc.encode('completed","response":{"id":"r1"}}\n\n'),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["completed"]);
  });

  test("SSE passthrough treats DONE without a terminal as incomplete", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode("data: [DONE]\n\n"),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["incomplete"]);
  });

  test("SSE passthrough treats invalid JSON without a terminal as incomplete", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode("data: {not-json}\n\n"),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["incomplete"]);
  });

  test("turn-level abort signal aborts the upstream fetch before headers arrive", () => {
    const upstream = new AbortController();
    const turn = new AbortController();
    linkAbortSignal(upstream, turn.signal);
    expect(upstream.signal.aborted).toBe(false);
    turn.abort("replacement turn");
    expect(upstream.signal.aborted).toBe(true);
    expect(upstream.signal.reason).toBe("replacement turn");
  });
});
