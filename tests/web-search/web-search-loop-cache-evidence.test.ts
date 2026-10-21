import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest, OcxUsage } from "../../src/types";
import { cacheProvenance } from "../../src/usage/cache-telemetry";
import { runWithWebSearch } from "../../src/web-search/loop";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const usage = (extra: Partial<OcxUsage> = {}): OcxUsage => ({ inputTokens: 100, outputTokens: 1, ...extra });
const search = (value?: OcxUsage): AdapterEvent[] => [
  { type: "tool_call_start", id: "search", name: "web_search" },
  { type: "tool_call_delta", arguments: JSON.stringify({ query: "fixture" }) },
  { type: "tool_call_end" }, { type: "done", usage: value },
];
const answer = (value?: OcxUsage): AdapterEvent[] => [{ type: "text_delta", text: "answer" }, { type: "done", usage: value }];
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// No API-key billing wrapper and no live model/search requests: evidence must be captured by
// the loop itself, not fabricated from its final sum by the outer request transport callback.
async function drive(passes: AdapterEvent[][]) {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
  const reported: (OcxUsage | undefined)[] = [];
  const adapter: ProviderAdapter = {
    name: "fixture",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async () => new Response("synthetic"),
    async *parseStream() { yield* passes.shift()!; },
  };
  const parsed: OcxParsedRequest = { modelId: "fixture", stream: true, options: {},
    context: { messages: [], tools: [buildWebSearchTool()] } };
  const response = await runWithWebSearch({ parsed, adapter, backend: "exa", exaApiKey: "fixture",
    hostedTool: { type: "web_search" }, settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 },
    maxSearches: 1, incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    onUsage: value => reported.push(value) });
  const text = await response.text();
  const terminal = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
    .find(frame => frame.type === "response.completed" || frame.type === "response.failed");
  return { reported, text, clientUsage: terminal?.response?.usage };
}

describe("web-search physical-round cache evidence", () => {
  test("zero plus read/write evidence is complete without reducing canonical reads", async () => {
    const { reported, text, clientUsage } = await drive([
      search(usage({ cachedInputTokens: 0 })), answer(usage({ cachedInputTokens: 40, cacheCreationInputTokens: 10 })),
    ]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ inputTokens: 200, outputTokens: 2, cachedInputTokens: 40,
      cacheTelemetry: { source: "aggregate", usagePresent: true, complete: true, read: 40, creation: 10,
        readComplete: true, creationComplete: false } });
    expect(cacheProvenance(reported[0])).toBe("observed");
    expect(clientUsage).toMatchObject({ input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 40 } });
    expect(text).not.toContain("cacheTelemetry");
    expect(text).not.toContain("readComplete");
  });

  test.each([true, false])("missing cache fields remain unknown (first=%s)", async missingFirst => {
    const known = usage({ cachedInputTokens: 40 });
    const { reported } = await drive([search(missingFirst ? usage() : known), answer(missingFirst ? known : usage())]);
    expect(reported[0]).toMatchObject({ inputTokens: 200,
      cacheTelemetry: { source: "aggregate", complete: false, read: 40, readComplete: false } });
    expect(cacheProvenance(reported[0])).toBe("unknown");
  });

  test.each([true, false])("missing whole usage remains unknown (first=%s)", async missingFirst => {
    const known = usage({ cachedInputTokens: 0 });
    const { reported } = await drive([search(missingFirst ? undefined : known), answer(missingFirst ? known : undefined)]);
    expect(reported[0]).toMatchObject({ inputTokens: 100,
      cacheTelemetry: { source: "aggregate", complete: false, read: 0, readComplete: false } });
    expect(cacheProvenance(reported[0])).toBe("unknown");
  });

  test("write-only and read-only rounds keep their partial sums without asserting a full read denominator", async () => {
    const { reported } = await drive([search(usage({ cacheCreationInputTokens: 10 })), answer(usage({ cachedInputTokens: 40 }))]);
    expect(reported[0]?.cacheTelemetry).toEqual({ source: "aggregate", usagePresent: true, complete: true,
      read: 40, creation: 10, readComplete: false, creationComplete: false });
  });

  test("an unreported empty forced-answer retry stays in completeness accounting", async () => {
    const { reported } = await drive([search(usage({ cachedInputTokens: 0 })), [{ type: "done" }], answer(usage({ cachedInputTokens: 40 }))]);
    expect(reported[0]).toMatchObject({ inputTokens: 200,
      cacheTelemetry: { complete: false, read: 40, readComplete: false } });
  });

  test.each(["error", "EOF"])("a physical %s without usage leaves earlier evidence incomplete", async kind => {
    const failed: AdapterEvent[] = kind === "error" ? [{ type: "error", message: "synthetic failure" }] : [];
    const { reported, text } = await drive([search(usage({ cachedInputTokens: 40 })), failed]);
    expect(text).toContain("response.failed");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.cacheTelemetry).toMatchObject({ complete: false, read: 40, readComplete: false });
  });

  test("reported error usage is observed before accumulation and counted once", async () => {
    const { reported, text } = await drive([search(usage({ cachedInputTokens: 40 })), [
      { type: "error", message: "synthetic failure", usage: usage({ cachedInputTokens: 5 }) },
    ]]);
    expect(text).toContain("response.failed");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ inputTokens: 200,
      cacheTelemetry: { complete: true, read: 45, readComplete: true } });
  });

  test("a single physical response is not tainted by the empty hidden accumulator", async () => {
    const { reported } = await drive([answer(usage({ cachedInputTokens: 0 }))]);
    expect(reported[0]?.cacheTelemetry).toEqual({ source: "adapter", usagePresent: true, read: 0 });
  });
});
