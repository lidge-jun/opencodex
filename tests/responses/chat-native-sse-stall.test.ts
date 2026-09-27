import { describe, expect, test } from "bun:test";
import { nativeChatSse } from "../../src/server/chat-native-sse";
import { createTranslatorBudget } from "../../src/lib/translator-budget";

// nativeChatSse arms its pull deadline off performance.now() rather than an injectable timer, so
// these tests use small real wall-clock gaps: an armed budget must fire inside its window, and a
// disabled budget must not fire across a gap that comfortably exceeds it.
describe("nativeChatSse stall budget", () => {
  const encoder = new TextEncoder();
  const makeBudget = () => createTranslatorBudget({ maxResidentBytes: 1 << 20, maxLiveTransientBytes: 1 << 20 });
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  function pushText(source: ReadableStreamDefaultController<Uint8Array>, text: string) {
    source.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
  }

  test("a disabled budget (stallTimeoutSec: 0) survives a silent gap and completes", async () => {
    // Regression: a 0 budget used to resolve to a 1s floor and, for the pull deadline, expire on
    // the first read — cutting a silent local model almost immediately. Disabled must mean the
    // pull waits indefinitely (Infinity deadline) for the next byte.
    const budget = makeBudget();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    let terminalStatus = 0;

    const stream = nativeChatSse(body, {
      requestedModel: "mock/test-model",
      translatorBudget: budget,
      signal: abort.signal,
      stallTimeoutSec: 0,
      onUsage() {},
      onTerminal(status) { terminalStatus = status; },
    });

    const outputPromise = new Response(stream).text();
    // Stay silent well past any sub-second armed window, then deliver and close.
    await delay(120);
    pushText(source, "late but healthy");
    source.close();

    const result = await outputPromise;
    budget.dispose();

    expect(result).toContain("late but healthy");
    expect(result).toContain("data: [DONE]");
    expect(result).not.toContain("upstream_stall");
    expect(terminalStatus).toBe(200);
  });

  test("an unset budget on a local upstream is disabled and survives a silent gap", async () => {
    const budget = makeBudget();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });

    const stream = nativeChatSse(body, {
      requestedModel: "mock/test-model",
      translatorBudget: budget,
      signal: abort.signal,
      localUpstream: true, // stallTimeoutSec unset → disabled for local
      onUsage() {},
      onTerminal() {},
    });

    const outputPromise = new Response(stream).text();
    await delay(120);
    pushText(source, "slow local token");
    source.close();

    const result = await outputPromise;
    budget.dispose();

    expect(result).toContain("slow local token");
    expect(result).not.toContain("upstream_stall");
  });
});
