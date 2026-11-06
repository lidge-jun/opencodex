import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";
import { decodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

function stallReason(frame: { data: Record<string, unknown> }): string | undefined {
  const response = frame.data.response as Record<string, unknown> | undefined;
  const details = response?.incomplete_details as Record<string, unknown> | undefined;
  return details?.reason as string | undefined;
}

// Manual beat-loop seam: the bridge arms its heartbeat/stall watchdog through options.timers, so
// the test drives ticks deterministically instead of waiting on wall-clock intervals.
function beatSeam() {
  let beatTick: (() => void) | undefined;
  const timers = {
    setInterval(handler: () => void, _ms: number) {
      beatTick = handler;
      return 1;
    },
    clearInterval(_id: unknown) {
      beatTick = undefined;
    },
  };
  return { timers, tick: () => beatTick?.() };
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("bridge stall watchdog budget", () => {
  for (const hidden of [false, true]) {
    for (const earlyEnd of [false, true]) {
      test(`stall preserves late signature, hidden=${hidden}, earlyEnd=${earlyEnd}`, async () => {
        const { timers, tick } = beatSeam();
        const stalled = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let cancelled = 0;
        async function* upstream(): AsyncGenerator<AdapterEvent> {
          yield { type: "thinking_delta", thinking: "signed thought" };
          yield { type: "tool_call_start", id: "call_stall", name: "read" };
          yield { type: "tool_call_delta", arguments: "{}" };
          if (earlyEnd) yield { type: "tool_call_end" };
          yield { type: "thinking_signature", signature: "stall-sig", afterOutput: true };
          stalled.resolve();
          await release.promise;
        }
        const framesPromise = collectSse(bridgeToResponsesSSE(
          upstream(), "model", undefined, undefined, undefined,
          () => { cancelled++; release.resolve(); }, 500,
          { stallTimeoutSec: 1, hideThinkingSummary: hidden, timers },
        ));
        try {
          await stalled.promise;
          // Clear the last upstream activity, then exhaust the two-tick stall budget.
          tick(); tick(); tick();
          const frames = await framesPromise;
          const added = frames.filter(frame => frame.event === "response.output_item.added").map(frame => frame.data);
          const done = frames.filter(frame => frame.event === "response.output_item.done").map(frame => frame.data);
          expect(added.map(event => event.output_index)).toEqual(added.map((_, index) => index));
          expect(done.map(event => event.output_index)).toEqual(added.map(event => event.output_index));
          const items = done.map(event => event.item as Record<string, unknown>);
          const tool = items.find(item => item.type === "function_call")!;
          expect(tool.status).toBe(earlyEnd ? "completed" : "incomplete");
          const carriers = items.filter(item => typeof item.encrypted_content === "string");
          expect(carriers).toHaveLength(1);
          expect(decodeReasoningEnvelope(carriers[0]!.encrypted_content as string)).toEqual({
            sig: "stall-sig", aft: tool.id, ...(hidden ? { txt: "signed thought" } : {}),
          });
          const terminal = frames.filter(frame => frame.event === "response.incomplete");
          expect(terminal).toHaveLength(1);
          expect(stallReason(terminal[0]!)).toBe("upstream_stall_timeout");
          expect((terminal[0]!.data.response as Record<string, unknown>).output).toEqual(items);
          expect(frames.some(frame => frame.event === "response.completed" || frame.event === "response.failed")).toBe(false);
          expect(cancelled).toBe(1);
        } finally { release.resolve(); }
      });
    }
  }

  for (const mode of ["normal", "multiple", "afterOutput"] as const) {
    test(`hidden thinking does not issue a stalled open tool, mode=${mode}`, async () => {
      const { timers, tick } = beatSeam();
      const stalled = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocks = mode === "multiple" ? 2 : 1;
      /** Interleave signed hidden blocks into an argument stream that subsequently stalls. */
      async function* upstream(): AsyncGenerator<AdapterEvent> {
        yield { type: "tool_call_start", id: "call_hidden_stall", name: "read" };
        yield { type: "tool_call_delta", arguments: '{"value":' };
        for (let i = 0; i < blocks; i++) {
          yield { type: "thinking_delta", thinking: `hidden-${i}` };
          yield { type: "thinking_signature", signature: `sig-${i}`, ...(mode === "afterOutput" ? { afterOutput: true } : {}) };
          if (i === 0) yield { type: "tool_call_delta", arguments: '"ok"' };
        }
        stalled.resolve();
        await release.promise;
      }
      const framesPromise = collectSse(bridgeToResponsesSSE(
        upstream(), "model", undefined, undefined, undefined, () => release.resolve(), 500,
        { stallTimeoutSec: 1, hideThinkingSummary: true, timers },
      ));
      try {
        await stalled.promise;
        tick(); tick(); tick();
        const frames = await framesPromise;
        const added = frames.filter(frame => frame.event === "response.output_item.added").map(frame => frame.data);
        const done = frames.filter(frame => frame.event === "response.output_item.done").map(frame => frame.data);
        const items = done.map(event => event.item as Record<string, unknown>);
        const tool = items.find(item => item.type === "function_call")!;
        expect(tool.status).toBe("incomplete");
        expect(tool.arguments).toBe('{"value":"ok"');
        expect(frames.filter(frame => frame.event === "response.function_call_arguments.done")).toHaveLength(0);
        expect(added.map(event => event.output_index)).toEqual(added.map((_, index) => index));
        expect(done.map(event => event.output_index)).toEqual(added.map(event => event.output_index));
        expect(items.filter(item => item.encrypted_content).map(item => decodeReasoningEnvelope(item.encrypted_content as string)))
          .toEqual(Array.from({ length: blocks }, (_, i) => ({ sig: `sig-${i}`, txt: `hidden-${i}`, ...(mode === "afterOutput" ? { aft: tool.id } : {}) })));
        const terminal = frames.filter(frame => frame.event === "response.incomplete");
        expect(terminal).toHaveLength(1);
        expect(stallReason(terminal[0]!)).toBe("upstream_stall_timeout");
        expect((terminal[0]!.data.response as Record<string, unknown>).output).toEqual(items);
      } finally { release.resolve(); }
    });
  }

  test("a disabled budget (stallTimeoutSec: 0) does not kill a silent upstream on the first beat", async () => {
    // Regression: resolveStallTimeoutSec(0) used to floor to 1s, and maxStallTicks then rounded to
    // 0, so `++stallTicks >= 0` tripped the watchdog on the very first silent beat — killing a
    // healthy but silent turn after ~one heartbeat interval (~2s in production). A disabled budget
    // must leave the stream open; only wire keepalives flow until the upstream actually emits.
    const heartbeatMs = 50;
    const { timers, tick } = beatSeam();

    let release: (() => void) | undefined;
    const gate = () => new Promise<void>(resolve => { release = resolve; });

    async function* silentThenDone(): AsyncGenerator<AdapterEvent> {
      await gate(); // fully silent: no heartbeats, no data, until released
      yield { type: "text_delta", text: "ok" };
      yield { type: "done" };
    }

    const framesPromise = collectSse(bridgeToResponsesSSE(
      silentThenDone(),
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      heartbeatMs,
      { stallTimeoutSec: 0, timers },
    ));

    await flush(); // let the bridge arm its beat loop and block on the silent upstream
    // Far more silent beats than the single beat a zero budget would have tripped on.
    for (let i = 0; i < 25; i++) tick();
    await flush();

    // The stream must still be open — a resolved promise here would mean the watchdog killed it.
    const raced = await Promise.race([
      framesPromise.then(() => "settled"),
      new Promise<string>(resolve => setTimeout(() => resolve("alive"), 25)),
    ]);
    expect(raced).toBe("alive");

    release?.();
    const frames = await framesPromise;
    expect(frames.some(f => stallReason(f) === "upstream_stall_timeout")).toBe(false);
    expect(frames.some(f => f.event === "response.completed")).toBe(true);
  });

  test("an unset budget on a local upstream is disabled and survives a silent stretch", async () => {
    // Mirrors the LM Studio path: config leaves stallTimeoutSec unset and the upstream is local,
    // so the budget resolves to disabled. The bug re-armed a 300s wall here; the fix must not.
    const heartbeatMs = 50;
    const { timers, tick } = beatSeam();

    let release: (() => void) | undefined;
    const gate = () => new Promise<void>(resolve => { release = resolve; });

    async function* silentThenDone(): AsyncGenerator<AdapterEvent> {
      await gate();
      yield { type: "text_delta", text: "hi" };
      yield { type: "done" };
    }

    const framesPromise = collectSse(bridgeToResponsesSSE(
      silentThenDone(),
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      heartbeatMs,
      { localUpstream: true, timers }, // stallTimeoutSec unset
    ));

    await flush();
    for (let i = 0; i < 25; i++) tick();
    await flush();

    const raced = await Promise.race([
      framesPromise.then(() => "settled"),
      new Promise<string>(resolve => setTimeout(() => resolve("alive"), 25)),
    ]);
    expect(raced).toBe("alive");

    release?.();
    const frames = await framesPromise;
    expect(frames.some(f => stallReason(f) === "upstream_stall_timeout")).toBe(false);
    expect(frames.some(f => f.event === "response.completed")).toBe(true);
  });

  test("an armed budget still kills a silent upstream (watchdog intact for public)", async () => {
    // Guard against over-correction: a positive budget on a public upstream must still terminate a
    // silent stream. stallTimeoutSec 1 → maxStallTicks = ceil(1000/50) = 20 silent beats.
    const heartbeatMs = 50;
    const stallTimeoutSec = 1;
    const maxStallTicks = Math.ceil((stallTimeoutSec * 1000) / heartbeatMs);
    const { timers, tick } = beatSeam();

    async function* silent(): AsyncGenerator<AdapterEvent> {
      await new Promise<void>(() => {}); // never emits
    }

    const framesPromise = collectSse(bridgeToResponsesSSE(
      silent(),
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      heartbeatMs,
      { stallTimeoutSec, localUpstream: false, timers },
    ));

    await flush();
    for (let i = 0; i < maxStallTicks + 2; i++) tick();

    const frames = await framesPromise;
    expect(frames.some(f => stallReason(f) === "upstream_stall_timeout")).toBe(true);
  });
});
