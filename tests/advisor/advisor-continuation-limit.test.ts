import { expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { createAdvisorGuard, MAX_ADVISOR_CONTINUATIONS_PER_REQUEST } from "../../src/server/responses/advisor-slot";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";

function repeatedCall(): AsyncIterable<AdapterEvent> {
  return (async function* () {
    yield { type: "tool_call_start", id: "repeat", name: "advisor" } as AdapterEvent;
    yield { type: "tool_call_delta", arguments: "{}" } as AdapterEvent;
    yield { type: "tool_call_end" } as AdapterEvent;
    yield { type: "done", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } as AdapterEvent;
  })();
}

test.each([true, false])("a worker that never stops calling advisor terminates with bounded spend (stream=%s)", async stream => {
  const parsed = parseRequest({ model: "worker", stream, input: "task", tools: [
    { type: "function", name: "advisor", description: "synthetic", parameters: {} },
    { type: "function", name: "shell", description: "real tool", parameters: {} },
  ], tool_choice: { type: "function", name: "advisor" } });
  let consultations = 0;
  const requests: OcxParsedRequest[] = [];
  const guard = createAdvisorGuard({
    consult: async () => { consultations++; return { ok: true, isError: false, content: "advice" }; },
    formatUnavailable: () => "consultation limit reached",
  });
  const collect = async () => {
    const events: AdapterEvent[] = [];
    for await (const event of guard({ parsed, firstEvents: repeatedCall(), continuation: next => {
      requests.push(next);
      // The fixture ignores removal and NEVER returns a normal answer.
      if (requests.length > MAX_ADVISOR_CONTINUATIONS_PER_REQUEST) throw new Error("unbounded worker redispatch");
      return repeatedCall();
    } })) events.push(event);
    return events;
  };
  const events = await collect();
  expect(consultations).toBe(3);
  expect(requests).toHaveLength(4);
  expect(requests[2]!.context.tools?.map(tool => tool.name)).toEqual(["shell"]);
  expect(requests[2]!.options.toolChoice).toBe("auto");
  expect(String(requests[3]!.context.messages.at(-1)?.content)).toContain("limit reached");
  expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "error", status: 502, errorType: "advisor_continuation_limit",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
  // Empty-completion retry reuses this guard: its allowance must not restart.
  const retry = await collect();
  expect(requests).toHaveLength(4);
  expect(consultations).toBe(3);
  expect(retry.at(-1)).toMatchObject({ type: "error", errorType: "advisor_continuation_limit" });
});
