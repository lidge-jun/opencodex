import type { CaseRecord } from "./types";

/** Deliberately broken variants proving the harness rejects known defects. */
export const NEGATIVE_CONTROL_FIXTURES: Array<{
  id: string;
  defect: string;
  mutate: (caseRecord: CaseRecord) => CaseRecord;
}> = [
  {
    id: "negative.malformed-sse",
    defect: "malformed SSE JSON",
    mutate: (c) => ({
      ...c,
      id: "negative.malformed-sse",
      assertions: [
        { id: "events", operator: "sse_event_sequence", selector: "/client/response/events", expected: ["response.completed"], required: true },
        { id: "terminal", operator: "terminal_signal_equals", selector: "/client/response/terminal", expected: "completed", required: true },
      ],
      fixture: {
        ...c.fixture,
        bytesUtf8: "data: {not-json}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      },
    }),
  },
  {
    id: "negative.missing-terminal",
    defect: "missing terminal event",
    mutate: (c) => ({
      ...c,
      id: "negative.missing-terminal",
      assertions: [{ id: "terminal", operator: "terminal_signal_equals", selector: "/client/response/terminal", expected: "completed", required: true }],
      fixture: {
        ...c.fixture,
        bytesUtf8: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"A\"}\n\n",
      },
    }),
  },
  {
    id: "negative.corrupted-tool-id",
    defect: "corrupted tool IDs",
    mutate: (c) => ({
      ...c,
      id: "negative.corrupted-tool-id",
      assertions: [{ id: "alpha", operator: "tool_call_equals", selector: "/client/response/toolCalls/0", expected: { id: "call_a", name: "alpha", arguments: { x: 1 }, kind: "function", ordinal: 0 }, required: true }],
      fixture: {
        ...c.fixture,
        bytesUtf8: "data:{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"WRONG\",\"function\":{\"name\":\"alpha\",\"arguments\":\"{\\\"x\\\":1}\"}}]}}]}\n\ndata:{\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\ndata:[DONE]\n\n",
      },
    }),
  },
  {
    id: "negative.tool-result-order",
    defect: "invalid tool-result correlation after chat-history repair",
    mutate: (c) => ({
      ...c,
      id: "negative.tool-result-order",
      // Chat history hardening closes the unmatched call with a synthetic result, then
      // re-emits the orphan result behind a synthetic assistant call. Inspect the actual
      // supplied result at the end of that repaired pair rather than the synthetic close,
      // otherwise the negative control accidentally validates the repair and passes.
      assertions: [{ id: "result", operator: "tool_result_correlates", selector: "/upstream/requests", expected: { call: "/client/response/toolCalls/0/id", result: "/upstream/requests/1/json/messages/3/tool_call_id" }, required: true }],
      fixture: {
        ...c.fixture,
        bytesUtf8: JSON.stringify({
          tools: [{ name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
          upstreamToolCall: { id: "call_fixture", name: "lookup", arguments: "{\"q\":\"x\"}" },
          toolResult: { toolCallId: "wrong_id", content: "RESULT" },
        }),
      },
    }),
  },
  {
    id: "negative.truncated-tool-args",
    defect: "truncated tool arguments",
    mutate: (c) => ({
      ...c,
      id: "negative.truncated-tool-args",
      assertions: [{ id: "alpha", operator: "tool_call_equals", selector: "/client/response/toolCalls/0", expected: { id: "call_a", name: "alpha", arguments: { x: 1 }, kind: "function", ordinal: 0 }, required: true }],
      fixture: {
        ...c.fixture,
        bytesUtf8: `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "alpha", arguments: "{\"x\":" } }] } }] })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      },
    }),
  },
  {
    id: "negative.parallel-tool-fragments",
    defect: "duplicate parallel-tool fragments",
    mutate: (c) => ({
      ...c,
      id: "negative.parallel-tool-fragments",
      assertions: [{ id: "order", operator: "json_path_equals", selector: "/verifiers/nonoverlap_order", expected: ["call_a", "call_b"], required: true }],
      fixture: {
        ...c.fixture,
        bytesUtf8: "data:{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"a\",\"arguments\":\"{}\"}},{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"a\",\"arguments\":\"{}\"}}]}}]}\n\ndata:{\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\ndata:[DONE]\n\n",
      },
    }),
  },
  {
    id: "negative.custom-tool-failure",
    defect: "custom/freeform tool translation failure",
    mutate: (c) => ({
      ...c,
      id: "negative.custom-tool-failure",
      assertions: [{ id: "call", operator: "tool_call_equals", selector: "/client/response/toolCalls/0", expected: { id: "call_patch", name: "apply_patch", arguments: "*** Begin Patch\n*** End Patch\n", kind: "custom", ordinal: 0 }, required: true }],
      fixture: {
        ...c.fixture,
        bytesUtf8: JSON.stringify({
          tool: { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" } },
          call: { id: "call_patch", name: "apply_patch", input: "WRONG PATCH" },
          output: { call_id: "call_patch", output: "Done" },
        }),
      },
    }),
  },
  {
    id: "negative.continuation-semantics",
    defect: "invalid continuation semantics",
    mutate: (c) => ({
      ...c,
      id: "negative.continuation-semantics",
      assertions: [{ id: "order", operator: "json_path_equals", selector: "/verifiers/call_result_order", expected: "pass", required: true }],
      fixture: {
        ...c.fixture,
        bytesUtf8: JSON.stringify({
          turn1: { output: [{ type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "{}" }] },
          turn2: { input: [{ type: "function_call_output", call_id: "wrong_call", output: "RESULT" }] },
        }),
      },
    }),
  },
];

export function baseCaseForNegativeControl(controlId: string, cases: CaseRecord[]): CaseRecord | undefined {
  switch (controlId) {
    case "negative.malformed-sse":
    case "negative.missing-terminal":
      return cases.find((c) => c.id === "responses-core.protocol.sse-framing");
    case "negative.corrupted-tool-id":
    case "negative.truncated-tool-args":
      return cases.find((c) => c.id === "chat-core.protocol.stream-assembly");
    case "negative.tool-result-order":
      return cases.find((c) => c.id === "tools-core.protocol.function-round-trip");
    case "negative.parallel-tool-fragments":
      return cases.find((c) => c.id === "tools-core.protocol.parallel-correlation");
    case "negative.custom-tool-failure":
      return cases.find((c) => c.id === "tools-core.protocol.custom-freeform-round-trip");
    case "negative.continuation-semantics":
      return cases.find((c) => c.id === "codex-core.protocol.tool-continuation");
    default:
      return undefined;
  }
}

export function buildNegativeControls(cases: CaseRecord[]): CaseRecord[] {
  const built: CaseRecord[] = [];
  for (const control of NEGATIVE_CONTROL_FIXTURES) {
    const base = baseCaseForNegativeControl(control.id, cases);
    if (!base) continue;
    const cloned = structuredClone(base);
    delete cloned.expectedFailure;
    built.push(control.mutate(cloned));
  }
  return built;
}
