/**
 * Forward-mode replay keeps the prior fail-closed behavior for orphaned tool CALLS.
 *
 * The stateless-wire repair (tests/responses-stateless-dangling-call-repair.test.ts)
 * synthesizes placeholder outputs only when statelessResponses is true. A forward-auth
 * provider (ChatGPT backend replay) must NOT synthesize: dangling calls stay exactly as
 * the client sent them so the strict upstream decides, mirroring the pre-fix contract.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward" as const,
};

function buildInput(input: unknown[]): unknown[] {
  const adapter = createResponsesPassthroughAdapter(provider);
  const request = adapter.buildRequest({
    modelId: "gpt-5.5",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: "gpt-5.5", input },
  }, { headers: new Headers({ authorization: "Bearer caller-secret" }) });
  return (JSON.parse(request.body) as { input: unknown[] }).input;
}

describe("forward-mode replay keeps fail-closed behavior (no synthesized outputs)", () => {
  test("a dangling function_call is forwarded unchanged on forward-mode replay", () => {
    const input = [
      { type: "function_call", id: "fc_fwd", call_id: "call_fwd", name: "write_stdin", arguments: "{}" },
    ];
    const built = buildInput(input);
    expect(built).toEqual(input);
  });

  test("a dangling custom_tool_call is forwarded unchanged on forward-mode replay", () => {
    const input = [
      { type: "custom_tool_call", id: "ctc_fwd", call_id: "call_ct_fwd", name: "custom_probe", input: "{}" },
    ];
    const built = buildInput(input);
    expect(built).toEqual(input);
  });

  test("forward auth with statelessResponses still does not synthesize (fail-closed guard)", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...provider,
      statelessResponses: true,
    });
    const input = [
      { type: "function_call", id: "fc_fwd_stateless", call_id: "call_fwd_stateless", name: "write_stdin", arguments: "{}" },
    ];
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input },
    }, { headers: new Headers({ authorization: "Bearer caller-secret" }) });
    const built = (JSON.parse(request.body) as { input: unknown[] }).input;
    // Stateless upstreams strip item ids, but the guard must not synthesize an output.
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ type: "function_call", call_id: "call_fwd_stateless" });
    expect(JSON.stringify(request.body)).not.toContain("no tool result was recorded");
  });
});

