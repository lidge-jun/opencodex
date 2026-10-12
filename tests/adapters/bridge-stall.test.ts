import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";

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
