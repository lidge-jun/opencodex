import { expect, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { isComboTargetInCooldown } from "../../src/combos";
import { comboFailureCooldownScope, comboFailureDecision, isDefiniteContextOverflow } from "../../src/combos/failover";

interface ComboHarness<Server> {
  serve(handler: () => Response | Promise<Response>): Server;
  baseUrl(server: Server): string;
  chatSuccess(text: string, model?: string): Response;
  chatStream(text: string): Response;
  provider(adapter: string, url: string, apiKey: string, extra?: Partial<OcxProviderConfig>): OcxProviderConfig;
  comboConfig(providers: OcxConfig["providers"]): OcxConfig;
  post(config: OcxConfig, raw?: Record<string, unknown>): Promise<Response>;
  collectSse(response: Response): Promise<unknown[]>;
}

const OVERFLOW_PROSE =
  "Please reduce the length of the messages or completion.";
/** A Python SDK exception, serialized by a relay, around a parameter validation record. */
const SDK_VALIDATION = `Error code: 400 - {'error': {'message': "Invalid 'tools[0].function.name': 'prompt is too long'. Expected a string that matches the pattern.", 'type': 'invalid_request_error', 'param': 'tools[0].function.name', 'code': 'invalid_value'}}`;
const BUDGET_OVERFLOW = "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (8000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.";

function sse(frames: Array<[string, Record<string, unknown>]>): Response {
  const body = frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Register under the caller's isolated homes, mock state and server cleanup hooks. */
export function registerComboContextOverflowCases<Server>({
  serve, baseUrl, chatSuccess, chatStream, provider, comboConfig, post, collectSse,
}: ComboHarness<Server>): void {
  for (const message of [
    "Please reduce the length of the messages or completion.",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "input is too long for requested model",
    "This model's maximum context length is 8192 tokens; you're over it. Please reduce the length of the messages.",
    // A relay that serializes a Python SDK exception quotes the provider verdict inside a dict repr.
    "Error code: 400 - {'error': {'message': \"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.\", 'type': 'invalid_request_error', 'param': 'messages', 'code': 'context_length_exceeded'}}",
    JSON.stringify({ error: { message: "Please reduce the length of the messages or completion." } }),
    JSON.stringify({ code: "invalid-argument", error: "Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (555817 tokens > 500000 tokens)" }),
    "The conversation has exceeded this model's context limit.",
    "The input is not malformed; the input exceeds the model's context limit.",
    "This input is beyond the context window for the selected model.",
    "The request has reached the model context length limit.",
    "Total tokens must not exceed the context window: 9000 > 8192",
    "Total tokens should not exceed the context window: 9000 > 8192",
    "This is not a timeout: the model's context window is full",
    "Request was not accepted because its history is at or past the model's context limit",
    // Devin's opaque context-window refusal: emitted as a structured event with code context_length_exceeded.
    "Devin rejected this turn and its history is at or past the model's context window. Compact the conversation or start a new session.",
    // A failing clause before a separate overflow clause must not cancel the verdict.
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
    "The context window is full (8192 tokens used)",
    "The input is not past the context limit. Maximum context length exceeded instead.",
    "The context window has (already) been exceeded",
  ]) {
    test(`context-length 400 advances once without cooling: ${message}`, async () => {
      const hits: string[] = [];
      const capped = serve(() => {
        hits.push("a");
        return Response.json({ error: { type: "invalid_request_error", message } }, { status: 400 });
      });
      const backup = serve(() => { hits.push("b"); return chatSuccess("larger window"); });
      const config = comboConfig({
        a: provider("openai-chat", baseUrl(capped), "key-a"),
        b: provider("openai-chat", baseUrl(backup), "key-b"),
      });
      const response = await post(config);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("larger window");
      expect(hits).toEqual(["a", "b"]);
      for (const [comboId, combo] of Object.entries(config.combos ?? {})) {
        for (const target of combo.targets) expect(isComboTargetInCooldown(comboId, target)).toBe(false);
      }
    });
  }

  for (const status of [404, 429, 503]) {
    test(`exhaustion retains a context-length refusal before a later ${status}`, async () => {
      const hits: string[] = [];
      const capped = serve(() => {
        hits.push("a");
        return Response.json({ error: {
          type: "invalid_request_error", code: "context_length_exceeded", message: "too many tokens",
        } }, { status: 400 });
      });
      const backup = serve(() => {
        hits.push("b");
        return Response.json({ error: { message: "target unavailable" } }, { status });
      });
      const response = await post(comboConfig({
        a: provider("openai-chat", baseUrl(capped), "key-a"),
        b: provider("openai-chat", baseUrl(backup), "key-b"),
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "context_length_exceeded" } });
      expect(hits).toEqual(["a", "b"]);
    });
  }

  for (const body of [
    JSON.stringify({ error: { code: "context_length_exceeded", message: "Unsupported parameter: user" } }),
    JSON.stringify({ error: { message: "Please reduce the length of the tool name" } }),
    JSON.stringify({ error: { message: "Invalid JSON", note: "Please reduce the length of the messages or completion" } }),
    '{"error":{"message":"Please reduce the length of the messages or completion"',
    // Parameter validation that merely quotes a context phrase as the caller's own value.
    JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_value", param: "tools[0].function.name",
      message: "Invalid 'tools[0].function.name': 'prompt is too long'. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'." } }),
    JSON.stringify({ error: { message: 'Invalid value for "user": "maximum context length" is not allowed.' } }),
    "The model's context cache is full",
    "The context window is full of cached tokens but fine",
    "Context window full size is 128k tokens",
    "The context window is full-duplex capable",
    // Service back-pressure mentions the window but not this turn's size.
    "The context window is full, retry later",
    "The context window is full, try again later",
    "The context window is full, please retry later",
    "Server busy: the context window is full",
    "Context window full during peak hours",
    "Context window full capacity reached",
    "The context window is full load",
    "Model context service is at capacity",
    "context window shards exhausted",
    "The context window is exhausted, retry after the queue drains",
    "The context window is at its limit, please queue and retry",
    "Context window exhausted during peak hours",
    // A trailing noun turns the predicate into something else.
    "Context limit exceeded expectations",
    // A parenthetical between the negator and its predicate does not end the clause.
    "The messages never, as far as we can tell, exceeded the context length",
    "The input is not (per the tokenizer) beyond the context limit",
    "The input is not, per our checks, past the context window",
    "This request does not approach, let alone exceed, the context limit",
    "Your input does not, in fact, exceed the context window",
    // "full" followed by another word describes something else.
    "Context window full capacity reached",
    "The context window is full load",
    "Context window full during peak hours",
    "Model context service is at capacity, please retry later",
    "The model's context window is not full; the request is invalid",
    "The input must not exceed the model context window",
    "Prompt tokens can't exceed the context window",
    "Prompt tokens can not exceed the context window",
    "Requested tokens should not exceed maximum context length (8192)",
    "Your input does not exceed the context window",
    "Your input does not actually exceed the context window",
    "Unsupported parameter: user; supplied value 'The conversation has exceeded this model's context limit.'",
    JSON.stringify({ error: { code: "invalid_value", param: "tools[0].function.name" },
      last_error: "The conversation has exceeded this model's context limit." }),
    JSON.stringify({ code: "invalid_value", param: "tools[0].function.name",
      response: { error: "The conversation has exceeded this model's context limit." } }),
    JSON.stringify({ code: "invalid_value", param: "tools[0].function.name",
      error: "The conversation has exceeded this model's context limit." }),
    JSON.stringify({ response: { code: "invalid_value", param: "tools[0].function.name" },
      last_error: "The conversation has exceeded this model's context limit." }),
    JSON.stringify({ response: { code: "invalid_value", param: "tools[0].function.name",
      error: "The conversation has exceeded this model's context limit." } }),
    JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_value", param: "tools[0].function.name",
      message: "Invalid 'tools[0].function.name': 'customer's prompt is too long'. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'." } }),
    JSON.stringify({ error: { param: "tools[0].function.name", message: "customer's prompt is too long" } }),
    JSON.stringify({ error: { type: "invalid_request_error", param: "tools[0].function.name", message: "The conversation has exceeded this model's context limit." } }),
    "Invalid 'tools[0].function.name': 'customer\\'s prompt is too long'.",
    SDK_VALIDATION,
    JSON.stringify({ error: { type: "invalid_request_error", message: SDK_VALIDATION } }),
    "Invalid tool name: \u2018prompt is too long\u2019.",
    "Invalid tool name: 'prompt is too long",
    "Invalid schema for response_format 'answer': {'message': 'Please reduce the length of the messages or completion.'} is not of type 'array'",
    "Unsupported content part: {'message': 'prompt is too long: 1 tokens > 0 maximum'}",
    "Error code: 400 - {'request': {'message': 'Please reduce the length of the messages or completion.'}, 'error': {'message': 'Unsupported tool choice', 'type': 'invalid_request_error'}}",
    "Error code: 400 - {'error': {'message': 'prompt is too long: 210000 tokens > 200000 maximum'}}",
    "Invalid value: 'prompt is too long'. Supported values are: 'none', 'auto', and 'required'.",
    "Invalid value at 'tool_config.function_calling_config.mode' (type.googleapis.com/google.ai.generativelanguage.v1beta.FunctionCallingConfig.Mode), \"prompt is too long\"",
    "1 validation error for ToolChoice\\nname\\n  String should match pattern '^[a-zA-Z0-9_-]+$' [type=string_pattern_mismatch, input_value='prompt is too long', input_type=str]",
  ]) {
    test(`ordinary or malformed 400 stays fatal: ${body}`, async () => {
      let backupHits = 0;
      const invalid = serve(() => new Response(body, { status: 400 }));
      const backup = serve(() => { backupHits += 1; return chatSuccess("must not run"); });
      const response = await post(comboConfig({
        a: provider("openai-chat", baseUrl(invalid), "key-a"),
        b: provider("openai-chat", baseUrl(backup), "key-b"),
      }));
      expect(response.status).toBe(400);
      const text = await response.text();
      // The retained combo context refusal must never relabel a parameter validation failure.
      if (body.includes("invalid_value")) expect(text).not.toContain("context_length_exceeded");
      expect(backupHits).toBe(0);
    });
  }

  for (const param of ["max_tokens", "max_completion_tokens", "max_output_tokens", "input_tokens", "input_text"]) {
    test(`context refusal naming the ${param} budget still advances`, async () => {
      const hits: string[] = [];
      const capped = serve(() => {
        hits.push("a");
        return Response.json({ error: { type: "invalid_request_error", code: "context_length_exceeded", param, message: BUDGET_OVERFLOW } }, { status: 400 });
      });
      const backup = serve(() => { hits.push("b"); return chatSuccess("larger window"); });
      const response = await post(comboConfig({
        a: provider("openai-chat", baseUrl(capped), "key-a"),
        b: provider("openai-chat", baseUrl(backup), "key-b"),
      }));
      expect(response.status).toBe(200);
      expect(hits).toEqual(["a", "b"]);
    });
  }

  test("the shared detector accepts SDK-wrapped verdicts and refuses parameter validation", () => {
    // Sidecar loops classify their own provider failures through this same detector.
    expect(isDefiniteContextOverflow(400, "Error code: 400 - {'error': {'message': \"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.\", 'type': 'invalid_request_error', 'param': 'messages', 'code': 'context_length_exceeded'}}")).toBe(true);
    expect(isDefiniteContextOverflow(400, JSON.stringify({ error: { param: "messages", code: "context_length_exceeded",
      message: "This model's maximum context length is 8192 tokens." } }))).toBe(true);
    for (const message of [
      "The conversation has exceeded this model's context limit.",
      "The input is not malformed; the input exceeds the model's context limit.",
      "Request was not accepted because the input exceeds the context window.",
      "No tokens remain and the model's context window is full.",
      // A comma ends the clause, so an earlier negation does not cancel the verdict (dev matched these).
      "The model could not respond, maximum context length exceeded",
      "We could not generate a response, the conversation exceeds the context window",
      "No compression applied (maximum context length exceeded)",
      "The context window is now full.",
      "The context window is completely exhausted.",
      "The context window is at its limit.",
      "The context window has already been exceeded",
      "The context window has (already) been exceeded",
      "The context window is now completely full",
      "The context window is full (8192 tokens used)",
      "It is not a timeout! The model's context window is full.",
      "It is not a timeout?\nThe model's context window is full.",
      "This is not a timeout: the model's context window is full.",
      "Request was not accepted because its history is at or past the model's context limit.",
      "This input is beyond the context window for the selected model.",
      "The request has reached the model context length limit.",
      "The model's context window is full.",
      "This model's context limit has been exceeded.",
      "Total tokens must not exceed the context window: 9000 > 8192",
      "Total tokens should not exceed the context window: 9000 > 8192",
      "Devin rejected this turn and its history is at or past the model's context window. Compact the conversation or start a new session.",
    ]) {
      expect(isDefiniteContextOverflow(400, message)).toBe(true);
      expect(isDefiniteContextOverflow(400, JSON.stringify({ error: { message } }))).toBe(true);
    }
    // String-valued `error` envelopes use the bounded leaf fallback.
    expect(isDefiniteContextOverflow(400, JSON.stringify({ error: "This model's maximum context length is 8192 tokens." }))).toBe(true);
    expect(isDefiniteContextOverflow(400, JSON.stringify({ error: "Please reduce the length of the messages or completion." }))).toBe(true);
    expect(isDefiniteContextOverflow(400, JSON.stringify({ error: "Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (555817 tokens > 500000 tokens)" }))).toBe(true);
    expect(isDefiniteContextOverflow(400, JSON.stringify({ error: "Invalid 'tools[0].function.name': 'prompt is too long'" }))).toBe(false);
    for (const serverOverload of [
      "Model context service is at capacity, please retry later",
      "Server overloaded: context window cache full, retry later",
      "The context window service is full, try again later",
      "Engine at capacity: context window shards exhausted, retry later",
      "Request queued at overloaded node, context window allocation unavailable",
    ]) {
      expect(isDefiniteContextOverflow(503, serverOverload)).toBe(false);
      expect(comboFailureCooldownScope(503, serverOverload)).toBe("target");
    }
    for (const invalidRequest of [
      "Input at messages[3] uses a context window override that this model does not support",
      "The request at line 3 sets an unsupported context length",
      "Batch request at index 2 has an invalid context window parameter",
    ]) {
      expect(isDefiniteContextOverflow(400, invalidRequest)).toBe(false);
      expect(comboFailureDecision(400, invalidRequest)).toBe("stop");
    }
    for (const echo of [
      "The model's context cache is full",
      "The context window is full, retry later",
      "The context window is full, try again later",
      "The context window is full, please retry later",
      "Server busy: the context window is full",
      "Context window full during peak hours",
      "Context window full capacity reached",
      "The context window is full load",
      "Model context service is at capacity",
      "context window shards exhausted",
      "The context window is exhausted, retry after the queue drains",
      "The context window is at its limit, please queue and retry",
      "Context window exhausted during peak hours",
      "Context limit exceeded expectations",
      "The messages never, as far as we can tell, exceeded the context length",
      "The input is not (per the tokenizer) beyond the context limit",
      "The input is not, per our checks, past the context window",
      "This request does not approach, let alone exceed, the context limit",
      "Model context service is at capacity, please retry later",
      "Server overloaded: context window cache full, retry later",
      "The context window service is full, try again later",
      "Engine at capacity: context window shards exhausted, retry later",
      "Request queued at overloaded node, context window allocation unavailable",
      "Input at messages[3] uses a context window override that this model does not support",
      "The request at line 3 sets an unsupported context length",
      "Batch request at index 2 has an invalid context window parameter",
      "The input must not exceed the model context window",
      "Prompt tokens can't exceed the context window",
      "Prompt tokens can not exceed the context window",
      "Requested tokens should not exceed maximum context length (8192)",
      JSON.stringify({ error: { code: "invalid_value", message: "customer's prompt is too long" } }),
      JSON.stringify({ error: { param: "tools[0].function.name", message: "prompt is too long" } }),
      "Invalid 'tools[0].function.name': 'customer's prompt is too long'.",
      'Invalid value for "user": "maximum context length" is not allowed.',
      "Unsupported parameter: user; supplied value 'The conversation has exceeded this model's context limit.'",
      "The model's context window is not full; the request is invalid",
      "The input does not exceed the allowed limit; the context window is available.",
      "Your input does not exceed the context window",
      "Your input does not actually exceed the context window",
      "The input does not in fact exceed the context window",
      JSON.stringify({ error: { code: "invalid_value", param: "tools[0].function.name" },
        last_error: "The conversation has exceeded this model's context limit." }),
      JSON.stringify({ code: "invalid_value", param: "tools[0].function.name",
        response: { error: "The conversation has exceeded this model's context limit." } }),
      JSON.stringify({ code: "invalid_value", param: "tools[0].function.name",
        error: "The conversation has exceeded this model's context limit." }),
      JSON.stringify({ response: { code: "invalid_value", param: "tools[0].function.name" },
        last_error: "The conversation has exceeded this model's context limit." }),
      JSON.stringify({ code: "invalid_value", param: "tools[0].function.name",
        error: { message: "The conversation has exceeded this model's context limit." } }),
      SDK_VALIDATION,
      "Invalid tool name: \u2018prompt is too long\u2019.",
      "Invalid tool name: 'prompt is too long",
      "Invalid schema for response_format 'answer': {'message': 'Please reduce the length of the messages or completion.'} is not of type 'array'",
      "Unsupported content part: {'message': 'prompt is too long: 1 tokens > 0 maximum'}",
      "Error code: 400 - {'request': {'message': 'Please reduce the length of the messages or completion.'}, 'error': {'message': 'Unsupported tool choice', 'type': 'invalid_request_error'}}",
      "Error code: 400 - {'error': {'message': 'prompt is too long: 210000 tokens > 200000 maximum'}}",
      "Invalid value: 'prompt is too long'. Supported values are: 'none', 'auto', and 'required'.",
      "Invalid value at 'tool_config.function_calling_config.mode' (type.googleapis.com/google.ai.generativelanguage.v1beta.FunctionCallingConfig.Mode), \"prompt is too long\"",
      "1 validation error for ToolChoice\\nname\\n  String should match pattern '^[a-zA-Z0-9_-]+$' [type=string_pattern_mismatch, input_value='prompt is too long', input_type=str]",
    ]) expect(isDefiniteContextOverflow(400, echo)).toBe(false);
    for (const param of ["max_tokens", "input_tokens"]) {
      expect(isDefiniteContextOverflow(400, JSON.stringify({ error: { code: "context_length_exceeded", param, message: BUDGET_OVERFLOW } }))).toBe(true);
    }
  });

  test("context overflow advances while exhausted retryable targets return the sanitized last status", async () => {
    let backupHits = 0;
    const context = serve(() => Response.json(
      { error: { code: "context_length_exceeded", message: "too many tokens" } },
      { status: 400 },
    ));
    const larger = serve(() => {
      backupHits += 1;
      return chatSuccess("larger context fallback");
    });
    const advanced = await post(comboConfig({
      a: provider("openai-chat", baseUrl(context), "key-a"),
      b: provider("openai-chat", baseUrl(larger), "key-b"),
    }));
    expect(advanced.status).toBe(200);
    expect(backupHits).toBe(1);
    expect(await advanced.text()).toContain("larger context fallback");

    const order: string[] = [];
    const first = serve(() => {
      order.push("a");
      return new Response("secret sk-a-should-redact", { status: 503 });
    });
    const last = serve(() => {
      order.push("b");
      return Response.json({ error: { message: "missing model" } }, { status: 404 });
    });
    const exhausted = await post(comboConfig({
      a: provider("openai-chat", baseUrl(first), "key-a"),
      b: provider("openai-chat", baseUrl(last), "key-b"),
    }));
    expect(exhausted.status).toBe(404);
    expect(order).toEqual(["a", "b"]);
    expect(await exhausted.text()).not.toContain("sk-a-should-redact");
  });

  test("zero-output context overflow 502 hops to a healthy combo target", async () => {
    let backupHits = 0;
    const capped = serve(() => sse([
      ["response.created", { type: "response.created", response: { id: "resp_context", status: "in_progress" } }],
      ["response.failed", { type: "response.failed", response: {
        id: "resp_context",
        status: "failed",
        error: { type: "server_error", code: "upstream_server_error", message: OVERFLOW_PROSE },
      } }],
    ]));
    const backup = serve(() => {
      backupHits += 1;
      return chatStream("larger context backup");
    });
    const response = await post(comboConfig({
      a: provider("openai-responses", baseUrl(capped), "key-a"),
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    }), { stream: true });
    expect(response.status).toBe(200);
    expect(backupHits).toBe(1);
    expect(JSON.stringify(await collectSse(response))).toContain("larger context backup");
  });

  test("context overflow after committed output never replays on another target", async () => {
    // The boundary the hop verdict depends on. Once any text or tool call has reached the
    // client, the stream preflight commits the child and the failure never becomes a combo
    // classification at all -- so the same context prose that hops above must not hop here.
    let backupHits = 0;
    const committed = serve(() => sse([
      ["response.created", { type: "response.created", response: { id: "resp_committed", status: "in_progress" } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: {
        id: "msg_committed", type: "message", role: "assistant", status: "in_progress", content: [],
      } }],
      ["response.output_text.delta", {
        type: "response.output_text.delta", item_id: "msg_committed", output_index: 0, content_index: 0,
        delta: "already visible",
      }],
      ["response.failed", { type: "response.failed", response: {
        id: "resp_committed",
        status: "failed",
        error: { type: "server_error", code: "upstream_server_error", message: OVERFLOW_PROSE },
      } }],
    ]));
    const backup = serve(() => {
      backupHits += 1;
      return chatStream("must not run");
    });
    const response = await post(comboConfig({
      a: provider("openai-responses", baseUrl(committed), "key-a"),
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    }), { stream: true });
    expect(response.status).toBe(200);
    const frames = JSON.stringify(await collectSse(response));
    expect(backupHits).toBe(0);
    expect(frames).toContain("already visible");
    expect(frames).not.toContain("must not run");
  });
}

