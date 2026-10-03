import { describe, expect, spyOn, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { createTranslatorBudget, retainTranslatedEvent, retainTranslatedEventBatch, TranslatorBudgetExceededError, type TranslatorBudget } from "../../src/lib/translator-budget";
import { releaseCompactionCiphertextLease } from "../../src/responses/compaction";
import type { AdapterEvent } from "../../src/types";

const ciphertext = "fixture-中文-ciphertext";
const sentinelBytes = 137;
function budgetWithSentinel() {
  const budget = createTranslatorBudget({ maxTurnBytes: 4096 });
  budget.chargeRetained(sentinelBytes, { kind: "retained_collectors" });
  return budget;
}
function parser(budget: TranslatorBudget) {
  const adapter = createResponsesPassthroughAdapter({ adapter: "openai-responses", baseUrl: "https://fixture.invalid/v1" });
  const wire = `data: ${JSON.stringify({ type: "response.completed", response: {
    output: [{ type: "compaction", encrypted_content: ciphertext }],
  } })}\n\n`;
  return adapter.parseStream(new Response(wire), budget);
}
function bridge(events: AsyncIterable<AdapterEvent>, budget: TranslatorBudget, compaction = true) {
  return bridgeToResponsesSSE(events, "fixture-model", undefined, undefined, undefined, undefined, 0, {
    translatorBudget: budget, compaction, stallTimeoutSec: 0,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
}
function outputFromWire(wire: string): Record<string, unknown>[] {
  const terminal = wire.split("\n\n").find(frame => frame.startsWith("event: response.completed\n"));
  expect(terminal).toBeDefined();
  return JSON.parse(terminal!.split("\ndata: ")[1]!).response.output;
}
async function retainedDone(budget: TranslatorBudget) {
  const iterator = parser(budget);
  const next = await iterator.next();
  expect(next.done).toBe(false);
  expect(next.value).toEqual({ type: "done", compactionEncryptedContent: ciphertext });
  retainTranslatedEvent(next.value!, budget);
  await iterator.return(undefined);
  return next.value!;
}
async function* replay(event: AdapterEvent) { yield event; }

// Real parser and bridge only: no provider send, fetch mock, or live credentials.
describe("Responses bridge transferred event ownership", () => {
  test("late done after cancellation releases both source leases, preserving another owner", async () => {
    const budget = budgetWithSentinel();
    const iterator = parser(budget);
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    const events: AsyncIterable<AdapterEvent> = { [Symbol.asyncIterator]() { return {
      async next() {
        const next = await iterator.next();
        if (!next.done) retainTranslatedEvent(next.value, budget);
        acquired.resolve();
        await release.promise;
        return next;
      },
      async return() { try { return await iterator.return(undefined); } finally { returned.resolve(); } },
    }; } };
    const reader = bridge(events, budget).getReader();
    try {
      await reader.read(); // response.created
      await reader.read(); // response.in_progress
      const pending = reader.read();
      await acquired.promise;
      expect(budget.snapshot().currentBytes).toBeGreaterThan(sentinelBytes);
      await reader.cancel();
      release.resolve();
      await pending;
      await returned.promise;
      // The cancelled read resolves before the in-flight producer's continuation.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes);
    } finally { release.resolve(); await reader.cancel(); reader.releaseLock(); budget.dispose(); }
  });

  test("cancel before first pull releases the bootstrap event without delivering it", async () => {
    const budget = budgetWithSentinel();
    const returned = Promise.withResolvers<void>();
    let yielded = 0;
    async function* events() {
      try { yielded++; yield await retainedDone(budget); } finally { returned.resolve(); }
    }
    try {
      await bridge(events(), budget).cancel();
      await returned.promise;
      expect(yielded).toBe(1);
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes);
    } finally { budget.dispose(); }
  });

  test.each(["throw", "reject"] as const)("bootstrap next() %s still closes its resource-owning iterator", async failure => {
    const budget = budgetWithSentinel();
    let cancelled = 0;
    let returned = 0;
    const source = new ReadableStream({ cancel() { cancelled++; } });
    const reader = source.getReader();
    const events: AsyncIterable<AdapterEvent> = { [Symbol.asyncIterator]() { return {
      next() {
        if (failure === "throw") throw new Error("fixture synchronous next failure");
        return Promise.reject(new Error("fixture rejected next failure"));
      },
      async return() {
        returned++;
        await reader.cancel();
        reader.releaseLock();
        return { done: true, value: undefined };
      },
    }; } };
    try {
      await bridge(events, budget).cancel();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(returned).toBe(1);
      expect(cancelled).toBe(1);
      expect(source.locked).toBe(false);
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes);
    } finally {
      if (source.locked) { await reader.cancel(); reader.releaseLock(); }
      budget.dispose();
    }
  });

  test("compaction continues release serialized heartbeat and text leases", async () => {
    const budget = budgetWithSentinel();
    const events: AdapterEvent[] = [{ type: "heartbeat" }, { type: "text_delta", text: "summary" }, { type: "done" }];
    retainTranslatedEventBatch(events, budget);
    try {
      const output = outputFromWire(await new Response(bridge((async function* () { yield* events; })(), budget)).text());
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes + Buffer.byteLength(JSON.stringify(output[0])));
    } finally { budget.dispose(); }
  });

  test("successful replacement releases raw ciphertext before terminal-frame admission", async () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 9400 });
    const encrypted = "x".repeat(3000);
    const adapter = createResponsesPassthroughAdapter({ adapter: "openai-responses", baseUrl: "https://fixture.invalid/v1" });
    const wire = `data: ${JSON.stringify({ type: "response.completed", response: {
      output: [{ type: "compaction", encrypted_content: encrypted }],
    } })}\n\n`;
    try {
      const output = outputFromWire(await new Response(bridge(adapter.parseStream(new Response(wire), budget), budget)).text());
      expect(output).toEqual([expect.objectContaining({ encrypted_content: encrypted })]);
      expect(budget.snapshot().overflows).toBe(0);
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify(output[0])));
    } finally { budget.dispose(); }
  });

  test("transferred ciphertext release is budget-bound and idempotent", async () => {
    const budget = budgetWithSentinel();
    const other = budgetWithSentinel();
    const iterator = parser(budget);
    try {
      const next = await iterator.next();
      await iterator.return(undefined);
      const before = budget.snapshot().currentBytes;
      releaseCompactionCiphertextLease(next.value!, other);
      expect(budget.snapshot().currentBytes).toBe(before);
      expect(other.snapshot().currentBytes).toBe(sentinelBytes);
      releaseCompactionCiphertextLease(next.value!, budget);
      releaseCompactionCiphertextLease(next.value!, budget);
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes);
    } finally { await iterator.return(undefined); other.dispose(); budget.dispose(); }
  });

  test.each(["stream", "buffered"] as const)("%s: failed finished-item reservation releases source leases", async mode => {
    const budget = budgetWithSentinel();
    const event = await retainedDone(budget);
    const original = budget.reserveTransient.bind(budget);
    const reserve = spyOn(budget, "reserveTransient").mockImplementation((bytes, scope) => {
      if (scope.kind === "retained_collectors") throw new TranslatorBudgetExceededError(scope.kind, 1);
      return original(bytes, scope);
    });
    try {
      if (mode === "stream") {
        const wire = await new Response(bridge(replay(event), budget)).text();
        expect(wire).toContain("translation_buffer_limit");
        expect(wire).not.toContain("event: response.completed");
      } else {
        expect(() => buildResponseJSON([event], "fixture-model", { compaction: true, translatorBudget: budget }))
          .toThrow("buffer exceeded");
      }
      expect(reserve.mock.calls.some(([, scope]) => scope.kind === "retained_collectors")).toBe(true);
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes);
    } finally { reserve.mockRestore(); budget.dispose(); }
  });

  test.each(["stream", "buffered"] as const)("%s: successful handoff retains only output and unrelated bytes", async mode => {
    const budget = budgetWithSentinel();
    try {
      const event = await retainedDone(budget);
      const output = mode === "stream"
        ? outputFromWire(await new Response(bridge(replay(event), budget)).text())
        : buildResponseJSON([event], "fixture-model", { compaction: true, translatorBudget: budget }).output as Record<string, unknown>[];
      expect(output).toEqual([expect.objectContaining({ type: "compaction", encrypted_content: ciphertext })]);
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes + Buffer.byteLength(JSON.stringify(output[0])));
    } finally { budget.dispose(); }
  });

  test.each(["stream", "buffered"] as const)("%s: an uncharged ciphertext field cannot release another owner's bytes", async mode => {
    const budget = budgetWithSentinel();
    const event: AdapterEvent = { type: "done", compactionEncryptedContent: ciphertext };
    try {
      const output = mode === "stream"
        ? outputFromWire(await new Response(bridge(replay(event), budget)).text())
        : buildResponseJSON([event], "fixture-model", { compaction: true, translatorBudget: budget }).output as Record<string, unknown>[];
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes + Buffer.byteLength(JSON.stringify(output[0])));
    } finally { budget.dispose(); }
  });

  test.each(["stream", "buffered"] as const)("%s: skipped compaction releases the unused ciphertext", async mode => {
    const budget = budgetWithSentinel();
    try {
      const event = await retainedDone(budget);
      const output = mode === "stream"
        ? outputFromWire(await new Response(bridge(replay(event), budget, false)).text())
        : buildResponseJSON([event], "fixture-model", { translatorBudget: budget }).output;
      expect(output).toEqual([]);
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes);
    } finally { budget.dispose(); }
  });
  test.each(["stream", "buffered"] as const)("%s: truncated compaction releases ciphertext without installing history", async mode => {
    const budget = budgetWithSentinel();
    try {
      const event = await retainedDone(budget);
      if (event.type !== "done") throw new Error("expected done fixture");
      event.stopReason = "max_tokens";
      if (mode === "stream") {
        const wire = await new Response(bridge(replay(event), budget)).text();
        expect(wire).toContain("event: response.incomplete");
        expect(wire).not.toContain('"type":"compaction"');
      } else {
        const result = buildResponseJSON([event], "fixture-model", { compaction: true, translatorBudget: budget });
        expect(result.status).toBe("incomplete");
        expect(result.output).toEqual([]);
      }
      expect(budget.snapshot().currentBytes).toBe(sentinelBytes);
    } finally { budget.dispose(); }
  });

});
