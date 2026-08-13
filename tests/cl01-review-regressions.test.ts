import { expect, test } from "bun:test";
import { nonstreamObservationJson, runScenario } from "../src/lab/conformance/executor";
import { loadCaseAuthority } from "../src/lab/conformance/manifest";
import { emptyObservation, finalizeObservation } from "../src/lab/conformance/observation";
import type { CaseRecord, NormalizedEvent } from "../src/lab/conformance/types";

test("duplicate event tool-call ids stay rejected instead of falling back to JSON", () => {
  const observation = emptyObservation();
  const events: NormalizedEvent[] = [
    {
      event: "response.output_item.done",
      ordinal: 0,
      data: { item: { type: "function_call", call_id: "dup", name: "a", arguments: "{}" } },
    },
    {
      event: "response.output_item.done",
      ordinal: 1,
      data: { item: { type: "function_call", call_id: "dup", name: "b", arguments: "{}" } },
    },
  ];
  finalizeObservation(observation, events, {
    output: [{ type: "function_call", call_id: "fallback", name: "c", arguments: "{}" }],
  });

  expect(observation.client.response.toolCalls).toEqual([]);
  expect(observation.verifiers.duplicate_tool_call_ids).toBe(true);
});

test("call/result-order verifier accepts multiple correlated pairs", async () => {
  const authority = loadCaseAuthority();
  const base = authority.cases.find((c) => c.id === "codex-core.protocol.tool-continuation")!;
  const fixture = {
    turn1: {
      output: [
        { type: "function_call", id: "fc_a", call_id: "call_a", name: "a", arguments: "{}" },
        { type: "function_call", id: "fc_b", call_id: "call_b", name: "b", arguments: "{}" },
      ],
    },
    turn2: {
      input: [
        { type: "function_call_output", call_id: "call_a", output: "A" },
        { type: "function_call_output", call_id: "call_b", output: "B" },
      ],
    },
  };
  const scenario: CaseRecord = {
    ...structuredClone(base),
    fixture: { ...base.fixture, bytesUtf8: JSON.stringify(fixture) },
    assertions: [{
      id: "order",
      operator: "json_path_equals",
      selector: "/verifiers/call_result_order",
      expected: "pass",
      required: true,
    }],
  };

  const result = await runScenario(scenario);
  expect(result.passed).toBe(true);
});

test("expected-failure controls with no assertion ids fail as malformed manifests", async () => {
  const authority = loadCaseAuthority();
  const base = authority.cases.find((c) => c.id === "vision-core.protocol.modality-gate")!;
  const scenario: CaseRecord = {
    ...structuredClone(base),
    expectedFailure: { ...base.expectedFailure!, assertionIds: [] },
  };

  const result = await runScenario(scenario);
  expect(result.passed).toBe(false);
  expect(result.classification).toBe("harness_failure");
  expect(result.diagnostics.join(" ")).toContain("lists no assertionIds");
});

test("nonstream observation falls back to fixture JSON when parser emits no events", () => {
  const fixture = {
    id: "chatcmpl_fixture",
    choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  };
  expect(nonstreamObservationJson([], fixture)).toBe(fixture);
});
