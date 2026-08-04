import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

// An adapter generator that yields one delta and then hangs forever without a terminal event —
// models a slow/stalled routed provider whose stream is cancelled by the client mid-flight.
async function* hangs(): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text: "partial" };
  await new Promise<void>(() => {}); // never resolves; the stream stays open until cancelled
  yield { type: "done" };            // unreachable
}

async function collectEventNames(stream: ReadableStream<Uint8Array>): Promise<string[]> {
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
    .map(frame => frame.split("\n").find(line => line.startsWith("event: "))?.slice(7) ?? "");
}

async function collectTextDeltas(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.split("\n").find(line => line.startsWith("data: "))?.slice(6))
    .filter((data): data is string => Boolean(data) && data !== "[DONE]")
    .map(data => JSON.parse(data) as { type?: string; delta?: string })
    .filter(data => data.type === "response.output_text.delta")
    .map(data => data.delta ?? "");
}

describe("bridge stream lifecycle (RC1 / RC2)", () => {
  test("pull backpressure bounds adapter consumption until the client reads", async () => {
    let consumed = 0;
    async function* burst(): AsyncGenerator<AdapterEvent> {
      for (let i = 0; i < 100; i++) {
        consumed += 1;
        yield { type: "text_delta", text: `${i}` };
      }
      yield { type: "done" };
    }

    const stream = bridgeToResponsesSSE(burst(), "routed/model");
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(consumed).toBeLessThanOrEqual(1);
    await stream.cancel();
  });

  test("resuming a gated bridge preserves adapter FIFO ordering", async () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "alpha" },
      { type: "text_delta", text: "beta" },
      { type: "text_delta", text: "gamma" },
      { type: "done" },
    ];
    const stream = bridgeToResponsesSSE(replay(events), "routed/model");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(await collectTextDeltas(stream)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("a healthy unread upstream does not trigger a false stall while pull-gated", async () => {
    let cancelled = false;
    async function* healthy(): AsyncGenerator<AdapterEvent> {
      let i = 0;
      while (!cancelled) {
        yield { type: "text_delta", text: `${i++}` };
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }
    const terminals: string[] = [];
    const stream = bridgeToResponsesSSE(
      healthy(), "routed/model", undefined, undefined, undefined,
      () => { cancelled = true; },
      10,
      { stallTimeoutSec: 1, onTerminal: status => terminals.push(status) },
    );

    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(terminals).toEqual([]);
    await stream.cancel();
  });

  test("a true upstream stall while reading emits incomplete, closes, and cancels upstream", async () => {
    let cancelled = false;
    const stream = bridgeToResponsesSSE(
      hangs(), "routed/model", undefined, undefined, undefined,
      () => { cancelled = true; },
      10,
      { stallTimeoutSec: 1 },
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const completed = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    })();
    try {
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stall stream did not close")), 2_500)),
      ]);
    } finally {
      await reader.cancel();
    }
    const names = text.split("\n\n")
      .map(frame => frame.split("\n").find(line => line.startsWith("event: "))?.slice(7) ?? "")
      .filter(Boolean);

    expect(names).toContain("response.incomplete");
    expect(names).not.toContain("response.completed");
    expect(cancelled).toBe(true);
  }, 3_000);

  test("terminal callback reports completed for a normal done event", async () => {
    const terminals: string[] = [];
    await collectEventNames(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "hi" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, 2_000, {
      onTerminal: status => terminals.push(status),
    }));
    expect(terminals).toEqual(["completed"]);
  });

  test("max_tokens done becomes response.incomplete instead of a false completion", async () => {
    const terminals: string[] = [];
    const names = await collectEventNames(bridgeToResponsesSSE(replay([
      { type: "done", stopReason: "max_tokens" },
    ]), "routed/model", undefined, undefined, undefined, undefined, 2_000, {
      onTerminal: status => terminals.push(status),
    }));
    expect(names).toContain("response.incomplete");
    expect(names).not.toContain("response.completed");
    expect(terminals).toEqual(["incomplete"]);
  });

  test("terminal callback reports failed for adapter errors", async () => {
    const terminals: string[] = [];
    await collectEventNames(bridgeToResponsesSSE(replay([
      { type: "error", message: "boom" },
    ]), "routed/model", undefined, undefined, undefined, undefined, 2_000, {
      onTerminal: status => terminals.push(status),
    }));
    expect(terminals).toEqual(["failed"]);
  });

  test("terminal callback reports incomplete for adapter EOF without terminal", async () => {
    const terminals: string[] = [];
    await collectEventNames(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "partial" },
    ]), "routed/model", undefined, undefined, undefined, undefined, 2_000, {
      onTerminal: status => terminals.push(status),
    }));
    expect(terminals).toEqual(["incomplete"]);
  });

  test("terminal callback does not report after client cancellation", async () => {
    let cancelled = false;
    async function* abortsAfterCancel(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "partial" };
      while (!cancelled) await new Promise(resolve => setTimeout(resolve, 0));
      throw new Error("cancelled upstream");
    }
    const terminals: string[] = [];
    const stream = bridgeToResponsesSSE(
      abortsAfterCancel(),
      "routed/model",
      undefined,
      undefined,
      undefined,
      () => { cancelled = true; },
      10,
      { onTerminal: status => terminals.push(status) },
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(terminals).toEqual([]);
  });

  test("RC1: a stream that ends WITHOUT a done event emits response.incomplete (not completed)", async () => {
    const names = await collectEventNames(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "hello" },
      // no { type: "done" } — models anthropic returning on EOF after message_stop
    ]), "routed/model"));
    expect(names.filter(n => n === "response.incomplete")).toHaveLength(1);
    expect(names).toContain("response.output_text.delta");
    expect(names).not.toContain("response.failed");
    expect(names).not.toContain("response.completed");
  });

  test("RC1: a normal done event yields exactly one response.completed (no double terminal)", async () => {
    const names = await collectEventNames(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "hi" },
      { type: "done" },
    ]), "routed/model"));
    expect(names.filter(n => n === "response.completed")).toHaveLength(1);
  });

  test("RC1: an error event yields response.failed and NO synthetic response.completed", async () => {
    const names = await collectEventNames(bridgeToResponsesSSE(replay([
      { type: "error", message: "boom" },
    ]), "routed/model"));
    expect(names).toContain("response.failed");
    expect(names).not.toContain("response.completed");
  });

  test("RC2: cancel() invokes the onCancel (upstream abort) hook and does not throw", async () => {
    let aborted = false;
    const stream = bridgeToResponsesSSE(hangs(), "routed/model", undefined, undefined, undefined, () => { aborted = true; });
    const reader = stream.getReader();
    await reader.read();   // response.created (enqueued before the read loop)
    await reader.cancel(); // client disconnects
    expect(aborted).toBe(true);
  });

  test("RC3: emits a parser-ignored response.heartbeat during upstream silence", async () => {
    // heartbeatMs = 10 so the keep-alive fires quickly; hangs() goes silent after one delta.
    const stream = bridgeToResponsesSSE(hangs(), "routed/model", undefined, undefined, undefined, undefined, 10);
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (let i = 0; i < 12; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += dec.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain("response.heartbeat");
  });

  test("RC3: configurable stall timeout emits response.incomplete after deadline", async () => {
    const stream = bridgeToResponsesSSE(
      hangs(), "routed/model", undefined, undefined, undefined, undefined, 50,
      { stallTimeoutSec: 1 },
    );
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (let i = 0; i < 100; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += dec.decode(value, { stream: true });
      if (text.includes("response.incomplete")) break;
    }
    await reader.cancel();
    expect(text).toContain("response.incomplete");
    expect(text).toContain("upstream_stall_timeout");
    expect(text).not.toContain("response.completed");
  });
});
