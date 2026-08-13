import { jcsEqual } from "./jcs";
import { pointerExists, resolveJsonPointer } from "./json-pointer";
import type { AssertionResult, AssertionSpec, NormalizedObservation } from "./types";

const ID_GRAMMARS: Record<string, RegExp> = {
  responses_message: /^msg_[A-Za-z0-9_-]{1,128}$/,
  responses_reasoning: /^rs_[A-Za-z0-9_-]{1,128}$/,
  responses_call: /^call_[A-Za-z0-9_-]{1,128}$/,
  nonempty_128: /^[^\s]{1,128}$/,
};

export function evaluateAssertion(
  assertion: AssertionSpec,
  observation: NormalizedObservation,
): AssertionResult {
  const base: AssertionResult = {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed: false,
    observedSummary: "",
  };

  try {
    switch (assertion.operator) {
      case "http_status_equals":
        return evaluateEquals(assertion, observation, (obs) => obs.client.response.status);
      case "json_path_equals":
        return evaluateJsonPathEquals(assertion, observation);
      case "json_path_present":
        return evaluatePresence(assertion, observation, true);
      case "json_path_absent":
        return evaluatePresence(assertion, observation, false);
      case "sse_event_sequence":
        return evaluateEventSequence(assertion, observation);
      case "sse_event_count":
        return evaluateEventCount(assertion, observation);
      case "terminal_signal_equals":
        return evaluateEquals(assertion, observation, (obs) => obs.client.response.terminal);
      case "id_matches":
        return evaluateIdMatches(assertion, observation);
      case "id_stable_across_events":
        return evaluateIdStable(assertion, observation);
      case "id_correlates":
        return evaluateIdCorrelates(assertion, observation);
      case "tool_call_equals":
        return evaluateJsonPathEquals(assertion, observation);
      case "tool_result_correlates":
        return evaluateToolResultCorrelates(assertion, observation);
      case "normalized_text_equals":
        return evaluateEquals(assertion, observation, (obs) => obs.client.response.normalizedText);
      case "verifier_result_equals":
        return evaluateJsonPathEquals(assertion, observation);
      default:
        return {
          ...base,
          passed: false,
          observedSummary: `unknown operator ${assertion.operator}`,
          reason: "unknown_operator",
        };
    }
  } catch (error) {
    return {
      ...base,
      passed: false,
      observedSummary: String(error),
      reason: "evaluation_error",
    };
  }
}

function evaluateEquals(
  assertion: AssertionSpec,
  observation: NormalizedObservation,
  pick: (obs: NormalizedObservation) => unknown,
): AssertionResult {
  const observed = pick(observation);
  const passed = jcsEqual(observed, assertion.expected);
  return {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed,
    observedSummary: summarize(observed),
    reason: passed ? undefined : "value_mismatch",
  };
}

function evaluateJsonPathEquals(assertion: AssertionSpec, observation: NormalizedObservation): AssertionResult {
  const resolved = resolveJsonPointer(observation, assertion.selector);
  if (!resolved.ok) {
    return {
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: false,
      observedSummary: resolved.reason,
      reason: resolved.reason,
    };
  }
  const passed = jcsEqual(resolved.value, assertion.expected);
  return {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed,
    observedSummary: summarize(resolved.value),
    reason: passed ? undefined : "value_mismatch",
  };
}

function evaluatePresence(
  assertion: AssertionSpec,
  observation: NormalizedObservation,
  shouldExist: boolean,
): AssertionResult {
  const exists = pointerExists(observation, assertion.selector);
  const passed = shouldExist ? exists : !exists;
  return {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed,
    observedSummary: exists ? "present" : "absent",
    reason: passed ? undefined : shouldExist ? "selector_missing" : "selector_present",
  };
}

function evaluateEventSequence(assertion: AssertionSpec, observation: NormalizedObservation): AssertionResult {
  const events = observation.client.response.events.map((e) => e.event);
  const expected = assertion.expected as string[];
  const passed = Array.isArray(expected)
    && events.length === expected.length
    && events.every((e, i) => e === expected[i]);
  return {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed,
    observedSummary: summarize(events),
    reason: passed ? undefined : "event_sequence_mismatch",
  };
}

function evaluateEventCount(assertion: AssertionSpec, observation: NormalizedObservation): AssertionResult {
  const spec = assertion.expected as { event: string; count: number };
  const count = observation.client.response.events.filter((e) => e.event === spec.event).length;
  const passed = count === spec.count;
  return {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed,
    observedSummary: String(count),
    reason: passed ? undefined : "event_count_mismatch",
  };
}

function evaluateIdMatches(assertion: AssertionSpec, observation: NormalizedObservation): AssertionResult {
  const resolved = resolveJsonPointer(observation, assertion.selector);
  if (!resolved.ok) {
    return {
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: false,
      observedSummary: resolved.reason,
      reason: resolved.reason,
    };
  }
  const grammar = ID_GRAMMARS[String(assertion.expected)];
  const value = typeof resolved.value === "string" ? resolved.value : "";
  const passed = grammar ? grammar.test(value) : false;
  return {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed,
    observedSummary: value,
    reason: passed ? undefined : "id_grammar_mismatch",
  };
}

function evaluateIdStable(assertion: AssertionSpec, observation: NormalizedObservation): AssertionResult {
  const pointers = assertion.expected;
  if (!Array.isArray(pointers) || pointers.length < 2 || !pointers.every((p) => typeof p === "string")) {
    return {
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: false,
      observedSummary: "expected at least two pointers",
      reason: "invalid_expected",
    };
  }
  const values: string[] = [];
  for (const pointer of pointers) {
    const resolved = resolveJsonPointer(observation, pointer);
    if (!resolved.ok) {
      return {
        id: assertion.id,
        operator: assertion.operator,
        required: assertion.required,
        passed: false,
        observedSummary: resolved.reason,
        reason: resolved.reason,
      };
    }
    if (typeof resolved.value !== "string") {
      return {
        id: assertion.id,
        operator: assertion.operator,
        required: assertion.required,
        passed: false,
        observedSummary: "identifier must be a string",
        reason: "selector_type_mismatch",
      };
    }
    values.push(resolved.value);
  }
  const passed = values.every((v) => v === values[0]);
  return {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed,
    observedSummary: summarize(values),
    reason: passed ? undefined : "id_not_stable",
  };
}

function correlatedIds(left: unknown, right: unknown): boolean {
  return typeof left === "string"
    && typeof right === "string"
    && left.length > 0
    && right.length > 0
    && left === right;
}

function evaluateIdCorrelates(assertion: AssertionSpec, observation: NormalizedObservation): AssertionResult {
  const pointers = assertion.expected;
  if (!Array.isArray(pointers) || pointers.length !== 2 || !pointers.every((p) => typeof p === "string")) {
    return {
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: false,
      observedSummary: "expected two pointers",
      reason: "invalid_expected",
    };
  }
  const left = resolveJsonPointer(observation, pointers[0]);
  const right = resolveJsonPointer(observation, pointers[1]);
  if (!left.ok || !right.ok) {
    return {
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: false,
      observedSummary: left.ok ? (right as { reason: string }).reason : (left as { reason: string }).reason,
      reason: "selector_missing",
    };
  }
  const passed = correlatedIds(left.value, right.value);
  return {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed,
    observedSummary: `${summarize(left.value)} vs ${summarize(right.value)}`,
    reason: passed ? undefined : "id_correlation_mismatch",
  };
}

function evaluateToolResultCorrelates(assertion: AssertionSpec, observation: NormalizedObservation): AssertionResult {
  const spec = assertion.expected as { call?: unknown; result?: unknown };
  if (!spec || typeof spec.call !== "string" || typeof spec.result !== "string") {
    return {
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: false,
      observedSummary: "expected call/result pointers",
      reason: "invalid_expected",
    };
  }
  const call = resolveJsonPointer(observation, spec.call);
  const result = resolveJsonPointer(observation, spec.result);
  if (!call.ok || !result.ok) {
    return {
      id: assertion.id,
      operator: assertion.operator,
      required: assertion.required,
      passed: false,
      observedSummary: call.ok ? (result as { reason: string }).reason : (call as { reason: string }).reason,
      reason: "selector_missing",
    };
  }
  const passed = correlatedIds(call.value, result.value);
  return {
    id: assertion.id,
    operator: assertion.operator,
    required: assertion.required,
    passed,
    observedSummary: `${summarize(call.value)} -> ${summarize(result.value)}`,
    reason: passed ? undefined : "tool_result_correlation_mismatch",
  };
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value.length > 120 ? value.slice(0, 120) + "…" : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 200 ? text.slice(0, 200) + "…" : text;
  } catch {
    return String(value);
  }
}

export function evaluateAssertions(
  assertions: AssertionSpec[],
  observation: NormalizedObservation,
): AssertionResult[] {
  return assertions.map((a) => evaluateAssertion(a, observation));
}
