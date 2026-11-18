import { expect, test } from "bun:test";
import { checkHostedChatCompletion, checkHostedRecoveryIteration, type CompletionCase } from "../helpers/hosted-chat-completion";

const cases: CompletionCase[] = [
  { name: "plain-empty", search: false, frames: ["", ""], sends: 2, final: "response.failed", errorCode: "empty_completion_retry_failed" },
  { name: "search-empty", frames: ["", ""], sends: 2, final: "response.failed", errorCode: "empty_completion_retry_failed" },
  { name: "empty-recovers", frames: ["", "Fixed."], sends: 2, identicalRetry: true },
  { name: "reasoning-only", frames: ["thinking", "thinking"], sends: 2, final: "response.failed", errorCode: "empty_completion_retry_failed" },
  { name: "whitespace-only", frames: ["   ", "Fixed."], sends: 2 },
  { name: "empty-off", empty: false, frames: [""], sends: 1 },
  { name: "environment-off", envOff: true, frames: [""], sends: 1 },
  { name: "normal-answer", frames: ["The answer is 42."], sends: 1 },
  { name: "real-tool", frames: ["tool"], sends: 1 },
  { name: "refusal", frames: ["refusal"], sends: 1, final: "response.incomplete" },
  { name: "truncated", frames: ["truncated"], sends: 1, final: "response.incomplete" },
  { name: "search-then-empty", frames: ["search", "", "Fixed after search."], sends: 3, searches: 1 },
  { name: "search-then-empty-twice", frames: ["search", "", ""], sends: 3, searches: 1, final: "response.failed", errorCode: "empty_completion_retry_failed" },
  // Repeat placeholders for a failed query do not count as searches, so they can use every ordinary
  // iteration (maxSearches + 3). An empty completion in the last one must still get its retry, and
  // the opt-in must not lend ordinary iterations the slot reserved for that retry.
  { name: "failed-search-last-iteration-then-empty", searchFails: true,
    frames: ["search", "search", "search", "search", "search", "", "Fixed."], sends: 7, searches: 1 },
  { name: "failed-search-repeats-keep-ordinary-cap", searchFails: true,
    frames: ["search", "search", "search", "search", "search", "search", "", "Fixed."], sends: 6, searches: 1,
    final: "response.failed" },
];

for (const row of cases) {
  for (const stream of [true, false]) {
    test(`${row.name} (stream=${stream})`, () => checkHostedChatCompletion({ empty: true, ...row }, stream));
  }
}

test("Chat recovery opt-in does not expand another adapter's search iteration cap", async () => {
  const { runWithWebSearch } = await import("../../src/web-search/loop");
  const { buildWebSearchTool } = await import("../../src/web-search/synthetic-tool");
  const { createTestTranslatorBudget } = await import("../helpers/translator-budget");
  const { strict: assert } = await import("node:assert");
  const originalFetch = globalThis.fetch;
  let sends = 0;
  try {
    globalThis.fetch = async () => Response.json({ results: [] });
    const response = await runWithWebSearch({
      emptyCompletionRetry: true,
      parsed: { modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] } },
      adapter: {
        name: "fixture",
        buildRequest() {
          sends++;
          return { url: "https://fixture.invalid", method: "POST", headers: {}, body: "{}" };
        },
        fetchResponse: async () => new Response("wire"),
        async *parseStream() {
          yield { type: "tool_call_start", id: "fixture-search-" + sends, name: "web_search" };
          yield { type: "tool_call_delta", arguments: '{"query":"fixture"}' };
          yield { type: "tool_call_end" };
          yield { type: "done" };
        },
      },
      backend: "exa", exaApiKey: "synthetic-not-a-key", hostedTool: { type: "web_search" },
      settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    });
    const result = await response.text();
    assert.equal(sends, 4, "non-Chat retains the existing maxSearches + 3 cap");
    assert.ok(result.includes("web-search loop exceeded its iteration cap"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("live reasoning is delivered once without an empty-completion resend", async () => {
  const result = await checkHostedRecoveryIteration(["thinking", "Fixed."], true);
  expect(result.seen).toHaveLength(1);
  expect(result.text.split("\n").filter(line => line.includes('"type":"response.reasoning_summary_text.delta"')
    && line.includes("Checking the fixture."))).toHaveLength(1);
  expect(result.text).toContain('"type":"response.completed"');
});

test("an empty forced answer retains its tools-disabled recovery", async () => {
  const result = await checkHostedRecoveryIteration(["search", "", "Fixed."]);
  expect(result.seen).toHaveLength(3);
  expect(result.searches).toBe(1);
  expect(result.seen[2]!.context.tools).toEqual([]);
  expect(result.seen[2]!.options.toolChoice).toBe("none");
  expect(result.text).toContain('"type":"response.completed"');
});
