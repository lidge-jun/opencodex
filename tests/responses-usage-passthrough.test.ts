import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "key",
} as const;

const EXTRA_USAGE = {
  input_tokens: 3,
  output_tokens: 2,
  total_tokens: 5,
  subscription: { window: { used_percent: 12 } },
  future_counter_v2: "wire-value",
  input_tokens_details: { cached_tokens: 1, audio_tokens: 7 },
  output_tokens_details: { reasoning_tokens: 1, audio_tokens: 9 },
};

function completedSse(usage: unknown): Response {
  return new Response([
    'data: {"type":"response.output_text.delta","delta":"hi"}',
    "",
    'data: ' + JSON.stringify({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [
        { type: "message", status: "completed", content: [{ type: "output_text", text: "hi" }] },
      ], usage },
    }),
    "",
    "data: [DONE]",
    "",
  ].join("\n"));
}

async function collect(stream: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("raw usage passthrough (openai/codex#41980 parity)", () => {
  test("streamed response.completed keeps unknown usage fields on the adapter event", async () => {
    const adapter = createAdapter(provider as never);
    const events = await collect(adapter.parseStream!(completedSse(EXTRA_USAGE)));
    const done = events.find(event => event.type === "done");
    expect(done).toBeDefined();
    expect(done?.usage?.inputTokens).toBe(3);
    expect(done?.usage?.outputTokens).toBe(2);
    expect(done?.usage?.rawUsage).toEqual(EXTRA_USAGE);
  });

  test("metadata-only usage (zero counts, extras present) is not dropped", async () => {
    const adapter = createAdapter(provider as never);
    const usage = { subscription: { window: { used_percent: 4 } } };
    const events = await collect(adapter.parseStream!(completedSse(usage)));
    const done = events.find(event => event.type === "done");
    expect(done?.usage?.rawUsage).toEqual(usage);
    expect(done?.usage?.inputTokens).toBe(0);
  });

  test("canonical-only usage stays narrow (no rawUsage clone, zero-count still suppressed)", async () => {
    const adapter = createAdapter(provider as never);
    const events = await collect(adapter.parseStream!(completedSse({
      input_tokens: 3, output_tokens: 2, total_tokens: 5,
      input_tokens_details: { cached_tokens: 1 },
    })));
    const done = events.find(event => event.type === "done");
    expect(done?.usage?.rawUsage).toBeUndefined();

    const zeroed = await collect(adapter.parseStream!(completedSse({ input_tokens: 0, output_tokens: 0 })));
    expect(zeroed.find(event => event.type === "done")?.usage).toBeUndefined();
  });

  test("buildResponseJSON rebuild merges extras under normalized known keys", () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "hi" },
      { type: "done", endTurn: true, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedInputTokens: 1, reasoningOutputTokens: 1, rawUsage: EXTRA_USAGE } },
    ];
    const json = buildResponseJSON(events, "gpt-live");
    const usage = json.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(3);
    expect(usage.output_tokens).toBe(2);
    expect(usage.total_tokens).toBe(5);
    expect(usage.subscription).toEqual({ window: { used_percent: 12 } });
    expect(usage.future_counter_v2).toBe("wire-value");
    expect(usage.input_tokens_details).toEqual({ audio_tokens: 7, cached_tokens: 1 });
    expect(usage.output_tokens_details).toEqual({ audio_tokens: 9, reasoning_tokens: 1 });
  });

  test("buildResponseJSON keeps strict-client zero defaults when there are no extras", () => {
    const json = buildResponseJSON([
      { type: "text_delta", text: "hi" },
      { type: "done", endTurn: true, usage: { inputTokens: 3, outputTokens: 2 } },
    ], "gpt-live");
    expect(json.usage).toEqual({
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  test("bridged streaming response.completed keeps unknown usage fields", async () => {
    const sse = bridgeToResponsesSSE(
      (async function* () {
        yield { type: "text_delta", text: "hi" } as AdapterEvent;
        yield { type: "done", endTurn: true, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedInputTokens: 1, reasoningOutputTokens: 1, rawUsage: EXTRA_USAGE } } as AdapterEvent;
      })(),
      "gpt-live",
    );
    let terminal: Record<string, unknown> | undefined;
    for await (const chunk of sse) {
      const text = new TextDecoder().decode(chunk);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
        const parsed = JSON.parse(line.slice(5).trim()) as { type?: string; response?: Record<string, unknown> };
        if (parsed.type === "response.completed") terminal = parsed.response;
      }
    }
    const usage = terminal?.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(3);
    expect(usage.subscription).toEqual({ window: { used_percent: 12 } });
    expect(usage.future_counter_v2).toBe("wire-value");
  });

  test("an unknown-shaped known key never leaks through the raw spread", () => {
    const json = buildResponseJSON([
      { type: "text_delta", text: "hi" },
      { type: "done", endTurn: true, usage: {
        inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedInputTokens: 1,
        rawUsage: {
          input_tokens: 3, output_tokens: 2, total_tokens: 5,
          extra: true,
          input_tokens_details: { cached_tokens: 1, cache_write_tokens: "not-a-number", audio_tokens: 7 },
        },
      } },
    ], "gpt-live");
    const usage = json.usage as Record<string, unknown>;
    expect(usage.extra).toBe(true);
    expect(usage.input_tokens_details).toEqual({ audio_tokens: 7, cached_tokens: 1 });
  });

  test("empty-completion retry merge keeps the content attempt's raw usage", async () => {
    const { mergeUsage } = await import("../src/server/responses/empty-completion-guard");
    const first = { inputTokens: 0, outputTokens: 0, rawUsage: { marker: "first" } };
    const second = { inputTokens: 3, outputTokens: 2, rawUsage: { subscription: { window: { used_percent: 9 } } } };
    const merged = mergeUsage(first, second);
    expect(merged?.rawUsage).toEqual(second.rawUsage);
    expect(mergeUsage(second, undefined)?.rawUsage).toEqual(second.rawUsage);
    expect(mergeUsage(first, undefined)?.rawUsage).toEqual(first.rawUsage);
    expect(mergeUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1 })?.rawUsage).toBeUndefined();
  });
});
