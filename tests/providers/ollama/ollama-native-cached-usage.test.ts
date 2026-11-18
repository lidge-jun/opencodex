import { describe, expect, test } from "bun:test";
import { createOllamaNativeAdapter } from "../../../src/adapters/ollama-native";
import type { AdapterEvent } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

// #8101: the native usage parser dropped prompt_eval_cached_count, so cached input always read 0.
const adapter = () => createOllamaNativeAdapter({ adapter: "ollama-native", baseUrl: "http://127.0.0.1:11434", models: ["m"] });
const ndjson = (frames: unknown[]) => new Response(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n",
  { headers: { "content-type": "application/x-ndjson" } });
const final = (usage: Record<string, unknown>) => ({
  model: "m", message: { role: "assistant", content: "hi" }, done: true, done_reason: "stop", ...usage,
});

async function streamedUsage(usage: Record<string, unknown>) {
  const events: AdapterEvent[] = [];
  for await (const event of adapter().parseStream(ndjson([final(usage)]), createTestTranslatorBudget())) events.push(event);
  const done = events.at(-1);
  expect(done?.type).toBe("done");
  return (done as Extract<AdapterEvent, { type: "done" }>).usage;
}

describe("ollama-native cached prompt usage (#8101)", () => {
  test("streamed final record maps the cached subset without changing the input total", async () => {
    expect(await streamedUsage({ prompt_eval_count: 2000, prompt_eval_cached_count: 1500, eval_count: 100 }))
      .toEqual({ inputTokens: 2000, outputTokens: 100, cachedInputTokens: 1500, cacheReadInputTokens: 1500 });
  });

  test("buffered responses carry the same cached count", async () => {
    const events = await adapter().parseResponse!(ndjson([final({ prompt_eval_count: 11, prompt_eval_cached_count: 8, eval_count: 18 })]),
      createTestTranslatorBudget());
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 11, cachedInputTokens: 8, cacheReadInputTokens: 8 } });
  });

  test("an explicit zero stays a known zero", async () => {
    expect(await streamedUsage({ prompt_eval_count: 40, prompt_eval_cached_count: 0, eval_count: 2 }))
      .toEqual({ inputTokens: 40, outputTokens: 2, cachedInputTokens: 0, cacheReadInputTokens: 0 });
  });

  test.each([
    ["omitted", {}],
    ["negative", { prompt_eval_cached_count: -1 }],
    ["fractional", { prompt_eval_cached_count: 1.5 }],
    ["non-numeric", { prompt_eval_cached_count: "8" }],
    ["larger than the prompt", { prompt_eval_cached_count: 41 }],
  ])("%s cached count reports no cache field", async (_label, extra) => {
    expect(await streamedUsage({ prompt_eval_count: 40, eval_count: 2, ...extra })).toEqual({ inputTokens: 40, outputTokens: 2 });
  });

  test("a cached count without a prompt count is ignored", async () => {
    expect(await streamedUsage({ prompt_eval_cached_count: 5, eval_count: 2 })).toEqual({ inputTokens: 0, outputTokens: 2 });
  });
});

