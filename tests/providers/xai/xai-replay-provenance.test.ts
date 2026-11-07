import { expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../../src/adapters/openai-responses";
import { repairOrphanedInputItems, restoreBridgedWebSearchCalls } from "../../../src/adapters/openai-responses/tool-output-recovery";
import { injectXaiResponsesXSearch } from "../../../src/adapters/xai-web-search";
import { liftZedAdditionalTools } from "../../../src/adapters/zed-additional-tools";
import { currentTurnWireToolCatalogBody } from "../../../src/server/responses-undeclared-tool-guard";
import { hasItemProvenance, isHistoricalItem, tagHistoricalInputItems } from "../../../src/responses/item-provenance";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import { rememberBridgeSearchReplay } from "../../../src/responses/bridge-search-replay-cache";

const live = { type: "function", name: "live", parameters: { type: "object", properties: {} } };
const wrap = (tools: unknown[]) => ({ type: "additional_tools", tools });
const xai = { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1", xaiResponsesXSearch: true };
const task = { type: "function_call_output", id: "seed", name: "task", namespace: "agent", output: "old task" };

function build(seed: unknown) {
  return JSON.parse(withTestTranslatorBudget(createResponsesPassthroughAdapter({
    ...xai, requiresPairedResponsesToolResults: true,
  })).buildRequest({
    modelId: "grok-4.7", context: { messages: [] }, stream: false, options: {},
    _rawBody: { input: [seed, wrap([{ type: "web_search" }]), wrap([live])] }, _replayPrefixLen: 2,
  }, { headers: new Headers() }).body);
}

test("control: historical user seed does not reactivate historical hosted search", () => {
  expect(build({ type: "message", role: "user", content: "old task" }).tools).toEqual([live]);
});

test("external task-input replacement must not reactivate historical hosted search", () => {
  expect(build(task).tools).toEqual([live]);
});

for (const [name, seed, synthesize] of [
  ["external task", task, false],
  ["orphan output", { type: "function_call_output", call_id: "old", output: "result" }, false],
  ["synthetic output", { type: "function_call", call_id: "old", name: "lookup", arguments: "{}" }, true],
] as const) {
  test(`${name} replacement retains both historical and live provenance`, () => {
    for (const historical of [true, false]) {
      const tagged = tagHistoricalInputItems([{ type: "message" }, seed], historical ? 2 : 1);
      const body = repairOrphanedInputItems({ input: tagged }, false, synthesize) as { input: unknown[] };
      const replacement = body.input.at(-1);
      expect(hasItemProvenance(replacement)).toBe(true);
      expect(isHistoricalItem(replacement)).toBe(historical);
      expect(Object.getOwnPropertySymbols(seed)).toEqual([]);
    }
  });
}

test("xAI injection ignores historical web search after a live item moves ahead of it", () => {
  const [historical, current] = tagHistoricalInputItems([wrap([{ type: "web_search" }]), wrap([live])], 1);
  const body = { input: [current, historical] };
  expect(injectXaiResponsesXSearch(body, xai, 0)).toBe(body);
});

test("bridge restoration retains historical and live provenance on both restored items", () => {
  const scope = "xai-replay-provenance-fixture";
  rememberBridgeSearchReplay(scope, "ws_provenance", {
    callId: "search_provenance", name: "web_search", argumentsText: "{}", output: "fixture result",
  });
  for (const historical of [true, false]) {
    const input = tagHistoricalInputItems([
      { type: "message" }, { type: "web_search_call", id: "ws_provenance" },
    ], historical ? 2 : 1);
    const restored = restoreBridgedWebSearchCalls({ input }, scope) as { input: unknown[] };
    expect(restored.input).toHaveLength(3);
    for (const item of restored.input.slice(1)) {
      expect(hasItemProvenance(item)).toBe(true);
      expect(isHistoricalItem(item)).toBe(historical);
    }
  }
});

test("historical x_search cannot suppress injection for a current web-search wrapper", () => {
  const [historical, current] = tagHistoricalInputItems([
    wrap([{ type: "x_search" }]), wrap([{ type: "web_search" }]),
  ], 1);
  expect(injectXaiResponsesXSearch({ input: [current, historical] }, xai, 0))
    .toMatchObject({ tools: [{ type: "x_search" }] });
});

test("Zed promotion reads provenance after input reordering", () => {
  const [historical, current] = tagHistoricalInputItems([wrap([{ ...live, name: "retired" }]), wrap([live])], 1);
  const body: Record<string, unknown> = { input: [current, historical] };
  liftZedAdditionalTools(body, 0);
  expect(body.tools).toEqual([live]);
  expect(body.input).toEqual([]);
});

test("current-turn authorization reads provenance after input reordering", () => {
  const [historical, current] = tagHistoricalInputItems([wrap([{ type: "x_search" }]), wrap([live])], 1);
  expect(currentTurnWireToolCatalogBody({ input: [current, historical] }, 0))
    .toEqual({ input: [current] });
});
