import { describe, expect, test } from "bun:test";
import type { AdapterEvent, OcxParsedRequest, OcxUsage } from "../../src/types";
import { guardEmptyCompletionEventStream, mergeUsage as mergeEmpty } from "../../src/server/responses/empty-completion-guard";
import { guardTerminalEventStream, mergeUsage as mergeTerminal } from "../../src/server/responses/terminal-guard";
import { cacheProvenance, usageFromResponsesPayload } from "../../src/usage/cache-telemetry";

const value = (extra: Partial<OcxUsage> = {}): OcxUsage => ({ inputTokens: 100, outputTokens: 1, ...extra });
const events = async function* (...items: AdapterEvent[]): AsyncGenerator<AdapterEvent> { yield* items; };
const parsed: OcxParsedRequest = { modelId: "fixture", stream: true, options: {}, context: {
  messages: [{ role: "user", content: "Check and fix this code", timestamp: 1 }],
  tools: [{ name: "exec_command", description: "run", parameters: {} }],
} };
async function terminal(source: AsyncIterable<AdapterEvent>) {
  let usage: OcxUsage | undefined;
  for await (const event of source) if (event.type === "done" || event.type === "incomplete" || event.type === "error") usage = event.usage;
  return usage;
}

for (const [name, merge] of [["empty", mergeEmpty], ["terminal", mergeTerminal]] as const) {
  describe(`${name} cache merger`, () => {
    test("the initial undefined accumulator is not a missing physical round", () => {
      const merged = merge(undefined, value({ cachedInputTokens: 0 }));
      expect(merged?.cacheTelemetry).toEqual({ source: "adapter", usagePresent: true, read: 0 });
      expect(cacheProvenance(merged)).toBe("observed");
    });
    test("two raw measurements preserve read-only counters and zero evidence", () => {
      const merged = merge(value({ cachedInputTokens: 40, cacheCreationInputTokens: 10 }), value({ cachedInputTokens: 0 }));
      expect(merged).toMatchObject({ inputTokens: 200, outputTokens: 2, cachedInputTokens: 40,
        cacheTelemetry: { source: "aggregate", complete: true, read: 40, creation: 10, readComplete: true, creationComplete: false } });
    });
    test.each([true, false])("mixed read aliases include every leg (explicit first=%s)", explicitFirst => {
      const cachedOnly = value({ cachedInputTokens: 40, cacheCreationInputTokens: 10 });
      const explicit = value({ cachedInputTokens: 5, cacheReadInputTokens: 5 });
      const merged = merge(explicitFirst ? explicit : cachedOnly, explicitFirst ? cachedOnly : explicit);
      expect(merged).toMatchObject({ cachedInputTokens: 45, cacheReadInputTokens: 45,
        cacheCreationInputTokens: 10, cacheTelemetry: { read: 45, complete: true, readComplete: true } });
    });
    test("a malformed cached alias cannot concatenate into the explicit read sum", () => {
      const merged = merge(value({ cachedInputTokens: "invalid" as unknown as number }), value({ cacheReadInputTokens: 5 }));
      expect(merged?.cacheReadInputTokens).toBe(5);
      expect(merged?.cacheTelemetry).toMatchObject({ read: 5, complete: false, readComplete: false });
    });
    test("missing fields and client-derived fields keep the sum incomplete", () => {
      for (const second of [value(), usageFromResponsesPayload({ input_tokens: 100, output_tokens: 1,
        input_tokens_details: { cached_tokens: 50 } })]) {
        const merged = merge(value({ cachedInputTokens: 40 }), second);
        expect(merged?.cacheTelemetry).toMatchObject({ source: "aggregate", complete: false, read: 40, readComplete: false });
        expect(cacheProvenance(merged)).toBe("unknown");
      }
    });
  });
}

for (const kind of ["empty", "terminal"] as const) {
  const run = (first: OcxUsage | undefined, second: OcxUsage | undefined) => terminal(kind === "empty"
    ? guardEmptyCompletionEventStream({ firstEvents: events({ type: "done", usage: first }),
      continuation: () => events({ type: "text_delta", text: "answer" }, { type: "done", usage: second }) })
    : guardTerminalEventStream({ parsed, adapterName: "openai-chat",
      firstEvents: events({ type: "text_delta", text: "Let me check." }, { type: "done", usage: first }),
      continuation: () => events({ type: "text_delta", text: "answer" }, { type: "done", usage: second }) }));
  test.each([true, false])(`${kind} guard retains a missing whole usage round (first=%s)`, async missingFirst => {
    const known = value({ cachedInputTokens: 40 });
    const merged = await run(missingFirst ? undefined : known, missingFirst ? known : undefined);
    expect(merged?.inputTokens).toBe(100);
    expect(merged?.cacheTelemetry).toMatchObject({ source: "aggregate", complete: false, read: 40, readComplete: false });
    expect(cacheProvenance(merged)).toBe("unknown");
  });
  test(`${kind} guard does not manufacture numeric usage for all missing rounds`, async () => {
    expect(await run(undefined, undefined)).toBeUndefined();
  });
}

test("a terminal-less empty round remains unknown after retry succeeds", async () => {
  const merged = await terminal(guardEmptyCompletionEventStream({ firstEvents: events(),
    continuation: () => events({ type: "text_delta", text: "answer" }, { type: "done", usage: value({ cachedInputTokens: 0 }) }) }));
  expect(merged?.cacheTelemetry).toMatchObject({ source: "aggregate", complete: false, read: 0, readComplete: false });
});
