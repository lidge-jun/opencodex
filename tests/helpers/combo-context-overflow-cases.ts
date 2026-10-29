import { expect, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { isComboTargetInCooldown } from "../../src/combos";
import { isDefiniteContextOverflow } from "../../src/combos/failover";

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
    JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_value", param: "tools[0].function.name",
      message: "Invalid 'tools[0].function.name': 'customer's prompt is too long'. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'." } }),
    JSON.stringify({ error: { param: "tools[0].function.name", message: "customer's prompt is too long" } }),
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
    for (const echo of [
      JSON.stringify({ error: { code: "invalid_value", message: "customer's prompt is too long" } }),
      JSON.stringify({ error: { param: "tools[0].function.name", message: "prompt is too long" } }),
      "Invalid 'tools[0].function.name': 'customer's prompt is too long'.",
      'Invalid value for "user": "maximum context length" is not allowed.',
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

