import { describe, expect, spyOn, test } from "bun:test";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import type { SidecarPlan } from "../../src/web-search";
import { runTurnWebSearchLoop } from "../../src/web-search/run-turn-loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const parsed: OcxParsedRequest = {
  modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [] },
};
const plan: SidecarPlan = {
  backend: "exa", hostedTool: { type: "web_search" }, maxSearches: 3,
  settings: { model: "fixture", reasoning: "low", timeoutMs: 100 },
  routedModelStallTimeoutMs: 100, stallTimeoutSec: 1, streamRoutedModelOutput: false,
};
async function* stream(events: AdapterEvent[]) { yield* events; }
async function collect(source: AsyncIterable<AdapterEvent>) {
  const result: AdapterEvent[] = [];
  for await (const e of source) result.push(e);
  return result.filter(e => e.type !== "heartbeat");
}
const done: AdapterEvent = { type: "done" };
const answer: AdapterEvent[] = [{ type: "text_delta", text: "answer" }, done];
const search: AdapterEvent[] = [
  { type: "tool_call_start", id: "s1", name: "web_search" },
  { type: "tool_call_delta", arguments: '{"query":"fixture"}' },
  { type: "tool_call_end" },
];

describe("runTurn search recovery", () => {
  test("complete search survives a truncated done", async () => {
    let calls = 0;
    const out = await collect(runTurnWebSearchLoop(stream([...search, { type: "done", stopReason: "max_tokens" }]), {
      parsed, plan, dispatch: () => { calls++; return stream(answer); },
    }));
    expect(calls).toBe(1);
    expect(out.at(-2)).toEqual(answer[0]);
  });

  test("truncation without search passes through without retry", async () => {
    const terminal: AdapterEvent = { type: "done", stopReason: "max_tokens" };
    expect(await collect(runTurnWebSearchLoop(stream([answer[0], terminal]), {
      parsed, plan, dispatch: () => { throw new Error("unexpected dispatch"); },
    }))).toEqual([answer[0], terminal]);
  });

  test("cancellation during the first query prevents remaining queries and calls", async () => {
    const controller = new AbortController();
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort();
      return Response.json({ results: [] });
    });
    try {
      const calls: AdapterEvent[] = [search[0], { type: "tool_call_delta", arguments: '{"queries":["one","two"]}' },
        { type: "tool_call_end" }, { type: "tool_call_start", id: "s2", name: "web_search" }, ...search.slice(1), done];
      const out = await collect(runTurnWebSearchLoop(stream(calls), {
        parsed, plan, exaApiKey: "fixture", abortSignal: controller.signal,
        dispatch: () => { throw new Error("unexpected dispatch"); },
      }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(out.filter(e => e.type === "web_search_call_begin")).toHaveLength(1);
      expect(out.filter(e => e.type === "web_search_call_end")).toHaveLength(1);
    } finally { fetchMock.mockRestore(); }
  });

  test("replay history admission failure stops before redispatch and releases budget", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 1000 });
    const out = await collect(runTurnWebSearchLoop(stream([{ type: "text_delta", text: "x".repeat(600) }, ...search, done]), {
      parsed, plan, translatorBudget: budget, dispatch: () => { throw new Error("unexpected dispatch"); },
    }));
    expect(out.at(-1)).toMatchObject({ type: "error", code: "translation_buffer_limit" });
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("cancelled search closes once and never begins another call", async () => {
    const controller = new AbortController();
    const second: AdapterEvent[] = [{ type: "tool_call_start", id: "s2", name: "web_search" }, ...search.slice(1)];
    const output: AdapterEvent[] = [];
    for await (const event of runTurnWebSearchLoop(stream([...search, ...second, done]), {
      parsed, plan, abortSignal: controller.signal, dispatch: () => { throw new Error("unexpected dispatch"); },
    })) {
      output.push(event);
      if (event.type === "web_search_call_begin") controller.abort();
    }
    expect(output.filter(e => e.type === "web_search_call_begin")).toHaveLength(1);
    expect(output.filter(e => e.type === "web_search_call_end")).toEqual([
      { type: "web_search_call_end", id: "s1", queries: ["fixture"], status: "failed" },
    ]);
  });

  test("live output precedes the terminal and is not replayed", async () => {
    let resumed = false;
    async function* first() { yield answer[0]; resumed = true; yield done; }
    const iterator = runTurnWebSearchLoop(first(), {
      parsed, plan: { ...plan, streamRoutedModelOutput: true }, dispatch: () => stream([]),
    });
    expect((await iterator.next()).value).toEqual(answer[0]);
    expect(resumed).toBe(false);
    expect(await collect(iterator)).toEqual([done]);
  });

  test("live leading reasoning closes at tools and synthetic calls remain private", async () => {
    const leading: AdapterEvent = { type: "thinking_delta", thinking: "look up" };
    const out = await collect(runTurnWebSearchLoop(stream([leading, ...search, { type: "text_delta", text: "hidden" }, done]), {
      parsed, plan: { ...plan, streamRoutedModelOutput: true }, dispatch: () => stream(answer),
    }));
    expect(out.filter(e => e.type === "thinking_delta")).toEqual([leading]);
    expect(out.filter(e => e.type === "text_delta")).toEqual([answer[0]]);
    expect(out.some(e => e.type.startsWith("tool_call"))).toBe(false);
  });

  test("buffer overflow is bounded and preserves another owner's lease", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 200 });
    budget.chargeRetained(17, { kind: "retained_collectors" });
    let consumed = 0;
    async function* first() {
      for (let i = 0; i < 100; i++) { consumed++; yield { type: "text_delta" as const, text: "x".repeat(50) }; }
      yield done;
    }
    const out = await collect(runTurnWebSearchLoop(first(), {
      parsed, plan, translatorBudget: budget, dispatch: () => { throw new Error("unexpected dispatch"); },
    }));
    expect(out.at(-1)).toMatchObject({ type: "error", status: 502, code: "translation_buffer_limit" });
    expect(consumed).toBeLessThan(100);
    expect(budget.snapshot().currentBytes).toBe(17);
  });

  test.each(["success", "error", "abort", "return"])("buffer budget releases on %s", async mode => {
    const budget = createTestTranslatorBudget();
    const controller = new AbortController();
    const iterator = runTurnWebSearchLoop(stream([answer[0], mode === "error" ? { type: "error", message: "bad" } : done]), {
      parsed, plan, translatorBudget: budget, abortSignal: controller.signal, dispatch: () => stream([]),
    });
    await iterator.next();
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    if (mode === "abort") controller.abort();
    if (mode === "return") await iterator.return(undefined);
    else await collect(iterator);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("search replay history remains charged between iterations and releases", async () => {
    const budget = createTestTranslatorBudget();
    let chargedAtDispatch = 0;
    await collect(runTurnWebSearchLoop(stream([...search, done]), {
      parsed, plan, translatorBudget: budget, dispatch: () => {
        chargedAtDispatch = budget.snapshot().currentBytes;
        return stream(answer);
      },
    }));
    expect(chargedAtDispatch).toBeGreaterThan(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  });
  test.each<AdapterEvent>([{ type: "heartbeat" }, { type: "thinking_delta", thinking: "working" },
    { type: "text_delta", text: "working" }])("passes progress before consuming the next upstream event: %j", async event => {
    let resumed = false;
    async function* first() { yield event; resumed = true; yield done; }
    const iterator = runTurnWebSearchLoop(first(), { parsed, plan, dispatch: () => stream([]) });
    expect((await iterator.next()).value).toEqual({ type: "heartbeat" });
    expect(resumed).toBe(false);
    await iterator.return(undefined);
  });

  test("search followed by an error preserves the error and never dispatches", async () => {
    let calls = 0;
    const failure: AdapterEvent = { type: "error", status: 429, message: "limited" };
    const out = await collect(runTurnWebSearchLoop(stream([...search, failure]), {
      parsed, plan, dispatch: () => { calls++; return stream(answer); },
    }));
    expect(out).toEqual([failure]);
    expect(calls).toBe(0);
  });

  test.each([search, [...search, done, done], [...search, done, { type: "text_delta", text: "late" } as AdapterEvent]])(
    "rejects invalid terminals before executing search", async events => {
      let calls = 0;
      const out = await collect(runTurnWebSearchLoop(stream(events), {
        parsed, plan, dispatch: () => { calls++; return stream(answer); },
      }));
      expect(out.at(-1)?.type).toBe("error");
      expect(calls).toBe(0);
    });

  test("opt-in empty retry preserves tools and is bounded", async () => {
    const attempts: OcxParsedRequest[] = [];
    const out = await collect(runTurnWebSearchLoop(stream([done]), {
      parsed, plan, emptyCompletionRetry: true,
      dispatch: request => { attempts.push(request); return stream([done]); },
    }));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].context.tools?.some(t => t.webSearch)).toBe(true);
    expect(out.at(-1)).toMatchObject({ type: "error", code: "empty_completion_retry_failed" });
  });

  test("empty retry after search keeps gathered history", async () => {
    const attempts: OcxParsedRequest[] = [];
    const out = await collect(runTurnWebSearchLoop(stream([...search, done]), {
      parsed, plan, emptyCompletionRetry: true,
      dispatch: request => { attempts.push(request); return stream(attempts.length === 1 ? [done] : answer); },
    }));
    expect(attempts).toHaveLength(2);
    expect(attempts[1].context.messages).toEqual(attempts[0].context.messages);
    expect(attempts[1].context.messages.some(m => m.role === "toolResult")).toBe(true);
    expect(out.at(-2)).toEqual(answer[0]);
  });

  test("disabled empty retry leaves an empty completion unchanged", async () => {
    let calls = 0;
    expect(await collect(runTurnWebSearchLoop(stream([done]), {
      parsed, plan, dispatch: () => { calls++; return stream(answer); },
    }))).toEqual([done]);
    expect(calls).toBe(0);
  });

  test("forced-answer recovery removes tools and preserves results", async () => {
    const attempts: OcxParsedRequest[] = [];
    await collect(runTurnWebSearchLoop(stream([...search, done]), {
      parsed, plan: { ...plan, maxSearches: 1 },
      dispatch: request => { attempts.push(request); return stream(attempts.length === 1 ? [done] : answer); },
    }));
    expect(attempts).toHaveLength(2);
    expect(attempts[1].options.toolChoice).toBe("none");
    expect(attempts[1].context.tools).toEqual([]);
    expect(attempts[1].context.messages.some(m => m.role === "toolResult")).toBe(true);
  });

  test("real tools pass through without model redispatch", async () => {
    const events: AdapterEvent[] = [{ type: "tool_call_start", id: "r", name: "shell" },
      { type: "tool_call_delta", arguments: "{}" }, { type: "tool_call_end" }, done];
    expect(await collect(runTurnWebSearchLoop(stream(events), {
      parsed, plan, dispatch: () => { throw new Error("unexpected dispatch"); },
    }))).toEqual(events);
  });

  test("cancellation stops before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await collect(runTurnWebSearchLoop(stream(search), {
      parsed, plan, abortSignal: controller.signal,
      dispatch: () => { throw new Error("unexpected dispatch"); },
    }));
    expect(out.at(-1)?.type).toBe("error");
  });
});
