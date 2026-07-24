import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { bridgeToResponsesSSE } from "../src/bridge";
import { responsesSseToAnthropicSse } from "../src/claude/outbound";
import { pumpResponsesSseToWebSocket, type WsData } from "../src/server/ws-bridge";
import type { AdapterEvent } from "../src/types";

async function* burstGenerator(count: number): AsyncGenerator<AdapterEvent> {
  for (let i = 0; i < count; i++) {
    yield { type: "text_delta", text: `chunk-${i} ` } as AdapterEvent;
    if (i === 0 && pauseAfterFirstDelta) await pauseAfterFirstDelta;
  }
  yield { type: "done" } as AdapterEvent;
}

const BURST_COUNT = 40;
const LARGE_BURST_COUNT = 200;

let srv: ReturnType<typeof Bun.serve> | null = null;
let pauseAfterFirstDelta: Promise<void> | null = null;

beforeEach(() => {
  pauseAfterFirstDelta = null;
  srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const requestedCount = Number(new URL(req.url).searchParams.get("count"));
      const count = Number.isSafeInteger(requestedCount) && requestedCount > 0 ? requestedCount : BURST_COUNT;
      const sseStream = bridgeToResponsesSSE(
        burstGenerator(count),
        "test/model",
      );
      return new Response(sseStream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    },
  });
});

afterEach(() => {
  srv?.stop(true);
  srv = null;
});

describe("bridge live SSE delivery (issue #114 coalescing regression)", () => {
  test("Claude outbound observes the bridge first frame before a macrotask turn", async () => {
    const reader = responsesSseToAnthropicSse(
      bridgeToResponsesSSE(burstGenerator(1), "test/model"),
      "claude-test",
    ).getReader();
    let macrotaskRan = false;
    const timer = setTimeout(() => { macrotaskRan = true; }, 0);

    const first = await reader.read();

    clearTimeout(timer);
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("message_start");
    expect(macrotaskRan).toBe(false);
    await reader.cancel();
  });

  test("WebSocket pump observes the bridge first frame before a macrotask turn", async () => {
    let resolveFirstSend: (() => void) | undefined;
    const firstSend = new Promise<void>(resolve => { resolveFirstSend = resolve; });
    let sendCount = 0;
    const ws = {
      readyState: 1,
      data: {} as WsData,
      send(message: string) {
        if (sendCount++ === 0) {
          expect(JSON.parse(message).type).toBe("response.created");
          resolveFirstSend?.();
        }
        return 1;
      },
    } as unknown as ServerWebSocket<WsData>;
    const pump = pumpResponsesSseToWebSocket(
      ws,
      bridgeToResponsesSSE(burstGenerator(1), "test/model"),
    );
    let macrotaskRan = false;
    const timer = setTimeout(() => { macrotaskRan = true; }, 0);

    await firstSend;

    clearTimeout(timer);
    expect(macrotaskRan).toBe(false);
    await pump;
  });

  async function collectTextDeltaStats(res: Response): Promise<{ count: number; groups: number; maxGroup: number }> {
    expect(res.ok).toBe(true);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const groups = new Map<number, number>();
    let readIndex = 0;
    let rawText = "";
    let count = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      rawText += chunk;
      readIndex++;

      const frames = rawText.split("\n\n");
      rawText = frames.pop() ?? "";

      for (const frame of frames) {
        const trimmed = frame.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        const dataLine = trimmed.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const parsed = JSON.parse(dataLine.slice(6)) as { type?: string; delta?: string };
          if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
            count++;
            groups.set(readIndex, (groups.get(readIndex) ?? 0) + 1);
          }
        } catch {
        }
      }

      if (count >= LARGE_BURST_COUNT) break;
    }
    await reader.cancel();

    return { count, groups: groups.size, maxGroup: Math.max(...groups.values()) };
  }

  test(
    "the first text delta is delivered while the producer is paused",
    async () => {
      let releaseProducer: (() => void) | undefined;
      pauseAfterFirstDelta = new Promise<void>(resolve => { releaseProducer = resolve; });
      const url = `http://127.0.0.1:${srv!.port}/stream`;

      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        await Promise.race([
          (async () => {
            while (!text.includes("response.output_text.delta")) {
              const { done, value } = await reader.read();
              if (done) throw new Error("stream ended before the first text delta");
              text += decoder.decode(value, { stream: true });
            }
          })(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first text delta was not delivered live")), 500)),
        ]);
        expect(text).toContain("chunk-0");
      } finally {
        releaseProducer?.();
        await reader.cancel();
      }
    },
    10_000,
  );

  test(
    "large synchronous replays complete within a bounded duration",
    async () => {
      const startedAt = performance.now();
      const res = await fetch(`http://127.0.0.1:${srv!.port}/stream?count=${LARGE_BURST_COUNT}`, {
        headers: { Accept: "text/event-stream" },
      });
      const stats = await collectTextDeltaStats(res);
      const elapsedMs = performance.now() - startedAt;

      expect(stats.count).toBe(LARGE_BURST_COUNT);
      expect(elapsedMs).toBeLessThan(5_000);
    },
    10_000,
  );
});
