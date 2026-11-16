import { expect, test } from "bun:test";
import { checkHostedChatCompletion, checkHostedRecoveryIteration, type CompletionCase } from "../helpers/hosted-chat-completion";

const cases: CompletionCase[] = [
  { name: "plain-plan-again", search: false, frames: ["plan", "plan"], sends: 2, final: "response.failed", errorCode: "terminal_continuation_failed" },
  { name: "plain-plan-to-tool", search: false, frames: ["plan", "tool"], sends: 2 },
  { name: "plan-to-tool", frames: ["plan", "tool"], sends: 2 },
  { name: "plan-to-answer", frames: ["plan", "Cannot proceed: the file is missing."], sends: 2 },
  { name: "plan-again", frames: ["plan", "plan"], sends: 2, final: "response.failed", errorCode: "terminal_continuation_failed" },
  { name: "guard-off", guard: false, frames: ["plan"], sends: 1 },
  { name: "requested-plan", input: "Provide a plan for fixing it.", frames: ["plan"], sends: 1 },
  { name: "waiting-for-user", frames: ["Which file should I change?"], sends: 1 },
  { name: "no-tools", noTools: true, frames: ["plan"], sends: 1 },
  { name: "refusal", frames: ["refusal"], sends: 1, final: "response.incomplete" },
  { name: "truncated", frames: ["truncated"], sends: 1, final: "response.incomplete" },
  { name: "search-then-plan", frames: ["search", "plan", "tool"], sends: 3, searches: 1 },
];

for (const row of cases) {
  for (const stream of [true, false]) {
    test(`${row.name} (stream=${stream})`, () => checkHostedChatCompletion({ guard: true, ...row }, stream));
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
      terminalContinuationGuard: true,
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


test("a tools-disabled forced-answer announcement does not trigger continuation", async () => {
  const result = await checkHostedRecoveryIteration(["search", "", "plan", "plan"]);
  expect(result.seen).toHaveLength(3);
  expect(result.searches).toBe(1);
  expect(result.seen[2]!.context.tools).toEqual([]);
  expect(result.seen[2]!.options.toolChoice).toBe("none");
  expect(result.text).toContain('"type":"response.completed"');
  expect(result.text).not.toContain("terminal_continuation_failed");
});
