import { describe, expect, test } from "bun:test";
import { comboFailureCooldownScope, comboFailureDecision, isDefiniteContextOverflow } from "../../src/combos/failover";
import { classifyUpstreamCondition } from "../../src/lib/upstream-condition";

/**
 * A differential matrix for the shared context-overflow verdict.
 *
 * Two rules hold every case below, and a change is a regression if it breaks either:
 * a positive verdict needs an explicit overflow subject and predicate, and a negation that governs
 * that predicate turns it back into a non-overflow. The negated cases stay `false`; the deliberate
 * dev-era regressions are annotated where they exist.
 */

/** Wording that must fail over: the turn did not fit THIS model, a larger target may hold it. */
const OVERFLOW_WORDING = [
  // The phrases `dev` already matched as substrings, in the shapes it matched them.
  "Please reduce the length of the messages or completion.",
  "prompt is too long: 210000 tokens > 200000 maximum",
  "input is too long for requested model",
  "This model's maximum context length is 8192 tokens.",
  "The input exceeds the context window.",
  "context window exceeded",
  "context length exceeded",
  "maximum context window",
  "too many tokens",
  // A failing clause before a separate overflow clause; the earlier negation is not the verdict.
  "The request could not be completed, because of its size, maximum context length exceeded",
  "The model could not answer, because the prompt is large, the context window exceeded",
  "The turn did not complete, due to overflow, maximum context length exceeded",
  "The provider did not respond, after retrying, the context window exceeded",
  "There was no response, for reference, the context window exceeded",
  "Not a valid turn, per the log, the context window exceeded",
  "The request is not rate limited, in our view, the context window exceeded",
  "The request is not retryable, in this case, the context window exceeded",
  "The provider is not overloaded, we believe, the maximum context window was exceeded",
  "We could not answer, in this case, the maximum context length was exceeded",
  "The provider did not respond, as documented, the maximum context length was exceeded",
  "The turn did not complete, in our view, the context length exceeded",
  "We could not complete the request, in this case, the context window exceeded",
  "The model could not respond, maximum context length exceeded",
  "Not enough tokens remain, context window exceeded",
  // The generalized wording this verdict exists to accept.
  "The conversation has exceeded this model's context limit.",
  "The messages have exceeded the model's context window",
  "Devin rejected this turn and its history is at or past the model's context window. Compact the conversation or start a new session.",
  "Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (555817 tokens > 500000 tokens)",
  "The prompt is too long for the context window",
  "The input is too long for the selected model's context window",
  "The request is too long for the model's context limit",
  "The input is not malformed; the input exceeds the model's context limit.",
  "This input is beyond the context window for the selected model.",
  "The request has reached the model context length limit.",
  "The request has exceeded the maximum context length",
  "The prompt went past the context limit",
  "The history is over the context window",
  "The context window has been exceeded",
  "The context window has already been exceeded",
  "The context window has (already) been exceeded",
  "This model's context limit has been exceeded.",
  // A token count that shows the request crossed the limit outranks the modal rule wording.
  "Total tokens must not exceed the context window: 9000 > 8192",
  "Total tokens should not exceed the context window: 9000 > 8192",
  // A verdict in a second sentence survives a negated first sentence.
  "The input is not past the context limit. Maximum context length exceeded instead.",
];

/**
 * State wording that is an overflow only when the status speaks about the request. On a 5xx the
 * same words are read as service back-pressure and keep the target cooldown, as on `dev`.
 */
const REQUEST_STATE_WORDING = [
  "The model's context window is full.",
  "The context window is now full",
  "The context window is now completely full",
  "The context window is completely exhausted.",
  "The context window is at its limit.",
  // Request-local capacity plus a report of use stays a verdict; only service back-pressure does not.
  "The context window is full (8192 tokens used)",
  // A remedy after the clause is not availability framing, even when it names a cache or a retry.
  "The context window is exhausted; scale down the prompt",
  "The context window is exhausted; memory of this conversation must be compacted",
  "The context window is full. Remove older messages before retrying.",
  "The context window is full; consider enabling prompt caching",
  "The context window is full. Enable prompt caching to continue.",
  "The context window is at its limit. Compact the loaded conversation.",
  "The context window is full. The pool of remaining tokens is empty.",
  "The context window is full. The worker will reject this payload.",
  // Whitespace inside the predicate does not change which rule applies to it.
  "The context window is at  its  limit.",
  "The context window is at\tits\nlimit.",
];

/**
 * Capacity and availability prose about the SERVICE. Failing over cools nothing here, because the
 * target is healthy and the request should retry against the same one.
 */
const SERVICE_BACKPRESSURE = [
  "The context window is full, retry later",
  "The context window is full, try again later",
  "The context window is full, please retry later",
  "Server busy: the context window is full",
  "Context window full during peak hours",
  "Context window full capacity reached",
  "The context window is full load",
  "Model context service is at capacity",
  "Model context service is at capacity, please retry later",
  "The model's context cache is full",
  "context window shards exhausted",
  "Context window full size is 128k tokens",
  "The context window is full-duplex capable",
  "The context window is full of cached tokens but fine",
  "The context window service is full, try again later",
  "Server overloaded: context window cache full, retry later",
  "Engine at capacity: context window shards exhausted, retry later",
  "Request queued at overloaded node, context window allocation unavailable",
  "The context window is exhausted, retry after the queue drains",
  "The context window is at its limit, please queue and retry",
  "Context window exhausted during peak hours",
  // Serving-stack resources and inflections outside the original vocabulary.
  "KV cache for the context window is exhausted",
  "The context window is exhausted on this GPU",
  "The context window is exhausted, retrying later",
  "The context window is at its limit, retried later",
  "The context window is exhausted because the cache is full",
  "The context window is full on every replica; workers are loading",
  "GPU memory for the context window is exhausted",
];

/** Negations, request-defect prose and quoted caller values: never an overflow. */
const NOT_AN_OVERFLOW = [
  // A negator that governs the predicate.
  "The messages never, as far as we can tell, exceeded the context length",
  "The input is not (per the tokenizer) beyond the context limit",
  "The input is not, per our checks, past the context window",
  "This request does not approach, let alone exceed, the context limit",
  "Your input does not, in fact, exceed the context window",
  "Your input does not actually exceed the context window",
  "Your input does not exceed the context window",
  "The input does not in fact exceed the context window",
  "The context window is not full",
  "The context window has not been exceeded",
  "The context window was never exceeded",
  // A bare "never" with no aside: the aside fold must not eat the negator inside the word.
  "The input never exceeded the context window",
  "The messages never exceeded the context limit",
  "The request must never exceed the context limit",
  "Input should never be past the context limit",
  "The prompt has never been beyond the context window",
  "Neither the prompt nor the context window was exceeded",
  "No context window overflow occurred",
  // A rule about the limit, not a report that this request crossed it.
  "The input must not exceed the model context window",
  "Prompt tokens can't exceed the context window",
  "Prompt tokens can not exceed the context window",
  "Prompt tokens cannot exceed the context window",
  "Requested tokens should not exceed maximum context length (8192)",
  // A trailing noun turns the predicate into something else.
  "Context limit exceeded expectations",
  "The context limit exceeded expectations for this release",
  "The request exceeded expectations",
  // Request-defect prose that names a context setting rather than overflowing it.
  "Input at messages[3] uses a context window override that this model does not support",
  "The request at line 3 sets an unsupported context length",
  "Batch request at index 2 has an invalid context window parameter",
  "The model context length is set to 8192",
  // A validation error that echoes the caller's own value.
  "Unsupported parameter: user",
  "Invalid 'tools[0].function.name': 'prompt is too long'",
  "Invalid value: 'prompt is too long'. Supported values are: 'none', 'auto', and 'required'.",
  "Invalid tool name: \u2018prompt is too long\u2019.",
  "Unsupported parameter: user; supplied value 'The conversation has exceeded this model's context limit.'",
  "Invalid tool name: 'the context window is full'",
  "Invalid schema for response_format 'answer': {'message': 'Please reduce the length of the messages or completion.'} is not of type 'array'",
  // A code beside an unrelated message is not evidence either.
  JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens.", code: "invalid_value", param: "tools[0].function.name" } }),
  JSON.stringify({ code: "invalid_value", param: "tools[0].function.name", error: "The conversation has exceeded this model's context limit." }),
  JSON.stringify({ error: { param: "tools[0].function.name", message: "customer's prompt is too long" } }),
  "1 validation error for ToolChoice\\nname\\n  String should match pattern '^[a-zA-Z0-9_-]+$' [type=string_pattern_mismatch, input_value='prompt is too long', input_type=str]",
];

const REQUEST_STATUSES = [400, 413, 422] as const;
const SERVER_STATUSES = [500, 502, 503, 529] as const;

function occurrences(text: string): string[] {
  return [text, JSON.stringify({ error: { message: text } })];
}

describe("isDefiniteContextOverflow", () => {
  test("accepts overflow wording on every status that speaks about the request", () => {
    for (const message of OVERFLOW_WORDING) {
      for (const status of [...REQUEST_STATUSES, ...SERVER_STATUSES]) {
        expect(isDefiniteContextOverflow(status, message), `${status}: ${message}`).toBe(true);
      }
    }
  });

  test("state wording is an overflow on a request status and back-pressure on a 5xx", () => {
    for (const message of REQUEST_STATE_WORDING) {
      for (const status of REQUEST_STATUSES) {
        expect(isDefiniteContextOverflow(status, message), `${status}: ${message}`).toBe(true);
      }
      for (const status of SERVER_STATUSES) {
        expect(isDefiniteContextOverflow(status, message), `${status}: ${message}`).toBe(false);
        expect(comboFailureCooldownScope(status, message), `${status}: ${message}`).toBe("target");
      }
    }
  });

  test("accepts the same verdict inside a structured and a string-valued envelope", () => {
    for (const message of OVERFLOW_WORDING) {
      expect(isDefiniteContextOverflow(400, JSON.stringify({ error: { message } })), message).toBe(true);
      expect(isDefiniteContextOverflow(400, JSON.stringify({ error: message })), message).toBe(true);
      expect(isDefiniteContextOverflow(400, JSON.stringify({ error: { type: "invalid_request_error", message } })), message).toBe(true);
    }
  });

  test("refuses service back-pressure and never cools the target for it", () => {
    for (const message of SERVICE_BACKPRESSURE) {
      for (const occurrence of occurrences(message)) {
        expect(isDefiniteContextOverflow(400, occurrence), occurrence).toBe(false);
        expect(isDefiniteContextOverflow(503, occurrence), occurrence).toBe(false);
        expect(comboFailureCooldownScope(503, occurrence), occurrence).toBe("target");
      }
    }
  });

  test("refuses negations, limit-only rules and quoted caller values", () => {
    for (const message of NOT_AN_OVERFLOW) {
      expect(isDefiniteContextOverflow(400, message), message).toBe(false);
      expect(comboFailureDecision(400, message), message).toBe("stop");
    }
  });

  test("401/403/429 reject a request-shaped body that only quotes context prose", () => {
    for (const message of OVERFLOW_WORDING) {
      for (const status of [401, 403, 429]) {
        expect(isDefiniteContextOverflow(status, message), `${status}: ${message}`).toBe(false);
      }
    }
  });

  test("the dashboard condition agrees with the failover verdict", () => {
    for (const message of OVERFLOW_WORDING) {
      expect(classifyUpstreamCondition({ status: 400, message }), message).toBe("context_overflow");
    }
    for (const message of SERVICE_BACKPRESSURE) {
      expect(classifyUpstreamCondition({ status: 400, message }), message).toBe("request_rejected");
    }
    for (const message of NOT_AN_OVERFLOW) {
      const condition = classifyUpstreamCondition({ status: 400, message });
      expect(condition, message).not.toBe("context_overflow");
    }
  });
});
