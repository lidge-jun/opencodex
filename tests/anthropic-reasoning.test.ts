import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import { chatCompletionsToResponsesBody } from "../src/chat/inbound";
import { parseRequest } from "../src/responses/parser";
import { anthropicToResponsesBody } from "../src/claude/inbound";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;

function parsed(reasoning?: string, extraOpts: Record<string, unknown> = {}, modelId = "anthropic/claude-sonnet-4.5"): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    options: { ...(reasoning !== undefined ? { reasoning } : {}), ...extraOpts },
    context: { systemPrompt: ["sys"], messages: [{ role: "user", content: "hi" }] },
  } as unknown as OcxParsedRequest;
}

async function bodyOf(p: OcxParsedRequest, configuredProvider = provider): Promise<Record<string, unknown>> {
  const { body } = await createAnthropicAdapter(configuredProvider).buildRequest(p);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as Record<string, unknown>;
}

describe("anthropic extended-thinking gate", () => {
  test("reasoning 'none' does NOT enable thinking and preserves temperature/top_p", async () => {
    const b = await bodyOf(parsed("none", { temperature: 0.3, topP: 0.9 }));
    expect(b.thinking).toBeUndefined();
    expect(b.temperature).toBe(0.3);
    expect(b.top_p).toBe(0.9);
  });

  test("reasoning absent does NOT enable thinking and preserves sampling", async () => {
    const b = await bodyOf(parsed(undefined, { temperature: 0.5, topP: 0.8 }));
    expect(b.thinking).toBeUndefined();
    expect(b.temperature).toBe(0.5);
    expect(b.top_p).toBe(0.8);
  });

  test("modelDefaultReasoningEfforts supplies reasoning when caller omits it", async () => {
    const b = await bodyOf(parsed(undefined, { temperature: 0.5, topP: 0.8 }, "always-thinking-model"), {
      ...provider,
      modelDefaultReasoningEfforts: { "always-thinking-model": "high" },
    });
    const thinking = b.thinking as { type: string; budget_tokens: number } | undefined;
    expect(thinking?.type).toBe("enabled");
    expect(typeof thinking?.budget_tokens).toBe("number");
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
  });

  test("explicit reasoning overrides modelDefaultReasoningEfforts", async () => {
    const b = await bodyOf(parsed("low", {}, "always-thinking-model"), {
      ...provider,
      modelDefaultReasoningEfforts: { "always-thinking-model": "high" },
    });
    const thinking = b.thinking as { type: string; budget_tokens: number } | undefined;
    expect(thinking?.type).toBe("enabled");
    expect(thinking?.budget_tokens).toBe(4096);
  });

  test("reasoning 'high' enables thinking and drops sampling (extended-thinking rule)", async () => {
    const b = await bodyOf(parsed("high", { temperature: 0.3, topP: 0.9 }));
    const thinking = b.thinking as { type: string; budget_tokens: number } | undefined;
    expect(thinking?.type).toBe("enabled");
    expect(typeof thinking?.budget_tokens).toBe("number");
    expect(b.max_tokens as number).toBeGreaterThan(thinking!.budget_tokens);
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
  });

  test.each([
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-4-8[1m]",
    // Vendor ids may be capitalized and/or use a dotted minor; the family parser must
    // still classify them as adaptive or the legacy thinking.enabled wire shape goes
    // out to a model that rejects it with a 400 (Bedrock ValidationException).
    "Claude-Opus-4.8-joybuilder",
    "claude-opus-4.8-joybuilder",
    // The separator and the capitalization are independent axes, and the PR changed
    // both at once ([.-] plus the /i flag). Cover the whole 2x2 so a later regex edit
    // that repairs one axis while breaking the other cannot pass: dashed-capitalized
    // and dotted-lowercase are exactly the cells the original two cases leave open.
    "Claude-Opus-4-8",
    "Claude-Opus-4.8",
    "claude-opus-4.8",
    // A dotted SUFFIX after a dashed minor is not a dotted minor. Widening the tail to
    // (?![\d.]) to stop "4.20250514" also rejected "4-8.1", silently demoting an id the
    // old regex classified correctly — a regression inside the fix for the opposite bug.
    // The tail must reject a longer NUMBER, not any dot.
    "claude-opus-4-8.1",
  ])("adaptive-thinking model %s sends thinking.adaptive + output_config.effort", async (modelId) => {
    const b = await bodyOf(parsed("xhigh", { temperature: 0.3, topP: 0.9 }, modelId));
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(b.output_config).toEqual({ effort: "xhigh" });
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
  });

  test("adaptive-thinking model maps unsupported 'minimal' effort to 'low'", async () => {
    const b = await bodyOf(parsed("minimal", {}, "claude-fable-5"));
    expect(b.output_config).toEqual({ effort: "low" });
    expect(b.max_tokens).toBe(12_288);
  });

  test("forwards Responses JSON Schema output format to Anthropic", async () => {
    const schema = {
      type: "object",
      properties: { score: { type: "integer", minimum: 1, maximum: 10 } },
      required: ["score"],
      additionalProperties: false,
    };
    const b = await bodyOf(parseRequest({
      model: "claude-sonnet-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "score this" }] }],
      text: { format: { type: "json_schema", name: "score", schema, strict: true } },
    }));

    expect(b.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          ...schema,
          properties: {
            score: {
              type: "integer",
              description: "{minimum: 1, maximum: 10}",
            },
          },
        },
      },
    });
  });

  test("preserves root definitions used by a root JSON Schema reference", async () => {
    const schema = {
      $ref: "#/$defs/answer",
      $defs: {
        answer: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    };
    const b = await bodyOf(parseRequest({
      model: "claude-sonnet-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "answer this" }] }],
      text: { format: { type: "json_schema", name: "answer", schema } },
    }));

    expect(b.output_config).toEqual({
      format: { type: "json_schema", schema },
    });
  });

  test("merges JSON Schema output format with adaptive thinking effort", async () => {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    const b = await bodyOf(parseRequest({
      model: "claude-sonnet-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "summarize this" }] }],
      reasoning: { effort: "high" },
      text: { format: { type: "json_schema", name: "summary", schema, strict: true } },
    }));

    expect(b.output_config).toEqual({
      effort: "high",
      format: { type: "json_schema", schema },
    });
  });

  test("preserves unselected composition keywords as model guidance", async () => {
    const oneOf = [{ type: "number", minimum: 0 }];
    const allOf = [{ type: "string", minLength: 1 }];
    const b = await bodyOf(parseRequest({
      model: "claude-sonnet-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "answer this" }] }],
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            anyOf: [{ type: "boolean" }],
            oneOf,
            allOf,
          },
        },
      },
    }));

    expect(b.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          anyOf: [{ type: "boolean" }],
          description: `{oneOf: ${JSON.stringify(oneOf)}, allOf: ${JSON.stringify(allOf)}}`,
        },
      },
    });
  });

  test("translates Chat Completions JSON Schema output to Anthropic", async () => {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    const responsesBody = chatCompletionsToResponsesBody({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "summarize this" }],
      reasoning_effort: "high",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "summary",
          description: "One summary object.",
          schema,
          strict: true,
        },
      },
    });

    const b = await bodyOf(parseRequest(responsesBody));

    expect(b.output_config).toEqual({
      effort: "high",
      format: { type: "json_schema", schema },
    });
  });

  test("rejects a JSON Schema without a type or composition keyword", async () => {
    const request = parseRequest({
      model: "claude-sonnet-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "summarize this" }] }],
      text: { format: { type: "json_schema", name: "summary", schema: { description: "summary" } } },
    });

    await expect(bodyOf(request)).rejects.toThrow(
      "JSON schema must have a type defined if anyOf/oneOf/allOf are not used",
    );
  });

  test("adaptive-thinking model resizes max_tokens for high effort (issue #246)", async () => {
    const b = await bodyOf(parsed("max", {}, "claude-fable-5"));
    // Exact regression: effort=max budget is 32000; adaptive ceiling adds OUTPUT_HEADROOM (8192)
    // so max_tokens = 40192, genuinely above the reasoning budget at full effort.
    expect(b.max_tokens as number).toBe(40_192);
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(b.output_config).toEqual({ effort: "max" });
  });

  test("adaptive-thinking model preserves explicit maxOutputTokens (not raised)", async () => {
    const b = await bodyOf(parsed("low", { maxOutputTokens: 16000 }, "claude-fable-5"));
    // Explicit caller value must be used exactly; the adapter must not silently raise it.
    expect(b.max_tokens as number).toBe(16000);
  });

  test("adaptive-thinking model does not raise a small explicit maxOutputTokens", async () => {
    const b = await bodyOf(parsed("max", { maxOutputTokens: 4096 }, "claude-fable-5"));
    // Even if the floor would be 40192, explicit cost-capped callers must be respected.
    expect(b.max_tokens as number).toBe(4096);
  });

  test("adaptive-thinking model preserves explicit maxOutputTokens above the default ceiling", async () => {
    const b = await bodyOf(parsed("max", { maxOutputTokens: 64000 }, "claude-fable-5"));
    // Explicit caller values above 32k must not be silently capped.
    expect(b.max_tokens as number).toBe(64000);
  });

  test.each([
    ["high", 24_576],
    ["xhigh", 32_768],
    ["max", 40_192],
  ])("adaptive-thinking %s effort reserves visible-output headroom", async (effort, expected) => {
    const b = await bodyOf(parsed(effort, {}, "claude-fable-5"));
    expect(b.max_tokens).toBe(expected);
  });

  test("Anthropic streaming and JSON responses preserve max_tokens stop reasons", async () => {
    const adapter = createAnthropicAdapter(provider);
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8192}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const streamed = [];
    for await (const event of adapter.parseStream(new Response(sse))) streamed.push(event);
    expect(streamed.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });

    const json = await adapter.parseResponse(new Response(JSON.stringify({
      content: [], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 8192 },
    })));
    expect(json.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });
  });

  test.each([
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-6",
    "claude-opus-4-20250514",
    // Capitalized/dotted ids below the adaptive threshold must stay on the legacy
    // wire shape (guard against over-broad family parsing).
    "Claude-Opus-4.6-joybuilder",
    // The date-pinned guard is the reason the minor group is bounded to {1,2} with a
    // (?!\d) tail. A capitalized date-pinned id never matched the old lowercase regex
    // at all, so it reached this branch by failing to parse rather than by parsing
    // correctly — the same observable outcome for two opposite reasons. Now that /i
    // makes it parse, assert it still reads as minor 0 and stays legacy.
    "Claude-Opus-4-20250514",
  ])("budget-thinking model %s keeps thinking.enabled with budget_tokens", async (modelId) => {
    const b = await bodyOf(parsed("high", {}, modelId));
    const thinking = b.thinking as { type: string; budget_tokens: number } | undefined;
    expect(thinking?.type).toBe("enabled");
    expect(typeof thinking?.budget_tokens).toBe("number");
    expect(b.output_config).toBeUndefined();
  });

  // The adaptive-wire predicate shares the id parse with the #545 disable gate, so a
  // slash-carrying id must still pick the ADAPTIVE shape. Getting this wrong sends obsolete
  // manual `thinking.enabled` to a model that rejects it — a 400, not a silent truncation.
  test.each([
    "anthropic/claude-sonnet-5",
    "claude-sonnet-5/variant",
    "claude-opus-4-8/vendor-suffix",
  ])("adaptive-thinking model %s keeps the adaptive wire shape", async (modelId) => {
    const b = await bodyOf(parsed("high", {}, modelId));
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(b.output_config).toEqual({ effort: "high" });
  });

  test("adaptive-thinking model with reasoning 'none' sends no thinking config", async () => {
    const b = await bodyOf(parsed("none", { temperature: 0.3 }, "claude-fable-5"));
    expect(b.thinking).toBeUndefined();
    expect(b.output_config).toBeUndefined();
    expect(b.temperature).toBe(0.3);
  });

  // #545: Claude Desktop's Auto Mode classifier sends thinking:{type:"disabled"} with
  // max_tokens:64. Omitting the field lets a default-on model think anyway, and thinking
  // shares that 64-token budget — so generation stopped before the stop sequence and the
  // client retried. Say "disabled" out loud, but only where the vendor accepts it.
  test.each([
    "claude-sonnet-5",
    "claude-sonnet-5-20260101",
    "claude-sonnet-5[1m]",
    // A modelMap entry can point at a routed destination, which custom-provider routing
    // decodes back into a slash-carrying native id. An id-shape miss here is silent: the
    // request simply goes out without the disable and the model thinks anyway.
    "anthropic/claude-sonnet-5",
    "openrouter/anthropic/claude-sonnet-5",
    // The slash can also carry a vendor SUFFIX rather than a routing prefix, so the family
    // segment is not reliably first or last. Both directions are real routed shapes.
    "claude-sonnet-5/variant",
    // claudeFamilyVersion() has TWO callers through meetsFamilyMinimum():
    // usesAdaptiveThinking() and supportsExplicitThinkingDisable(). Every case above
    // reaches only the first one, so a capitalization regression in the parser would
    // silently drop the explicit disable while the adaptive matrix stayed green.
    // A missed disable is invisible in the wire shape: the request simply goes out
    // without the field and the model thinks anyway, on a 64-token budget it shares
    // with generation (#545).
    "Claude-Sonnet-5",
  ])("%s + reasoning 'none' sends an explicit thinking disable (#545)", async (modelId) => {
    const b = await bodyOf(parsed("none", { maxOutputTokens: 64, stopSequences: ["</block>"] }, modelId));
    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b.output_config).toBeUndefined();
    // The caller's own limits must survive untouched — they were never the defect.
    expect(b.max_tokens).toBe(64);
    expect(b.stop_sequences).toEqual(["</block>"]);
  });

  test("Sonnet 5 with reasoning OMITTED still omits thinking (#545)", async () => {
    // Absence is not a disable instruction: only an explicit "none" earns the explicit field.
    const b = await bodyOf(parsed(undefined, {}, "claude-sonnet-5"));
    expect(b.thinking).toBeUndefined();
  });

  test.each([
    "claude-fable-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "anthropic/claude-fable-5",
    "claude-fable-5/foo",
    "not-a-claude-model",
  ])("%s + 'none' sends NO explicit disable (#545 gate stays narrow)", async (modelId) => {
    // Fable always thinks and rejects an explicit disable; the Opus 4.7/4.8 adaptive wire
    // leaves thinking off when omitted. Widening the gate to every adaptive family would
    // trade a silent truncation for a 400.
    const b = await bodyOf(parsed("none", {}, modelId));
    expect(b.thinking).toBeUndefined();
  });

  test("drops reconstructed Responses reasoning signatures when switching into Anthropic", async () => {
    const b = await bodyOf(parseRequest({
      model: "anthropic/claude-sonnet-4.5",
      input: [
        {
          type: "reasoning",
          id: "rs_other_provider",
          summary: [],
          content: [{ type: "reasoning_text", text: "raw routed reasoning" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue on anthropic" }],
        },
      ],
      reasoning: { effort: "high" },
    }));
    const messages = b.messages as { role: string; content: unknown }[];

    expect(b.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(messages)).not.toContain("rs_other_provider");
    expect(JSON.stringify(messages)).not.toContain("signature");
    expect(messages).toEqual([{ role: "user", content: "continue on anthropic" }]);
  });
});

describe("Anthropic Messages stored-OAuth round trip", () => {
  test("Messages structured output survives the stored OAuth round trip", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const inbound = anthropicToResponsesBody({
      model: "claude-sonnet-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "Return JSON" }],
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema },
      },
    });

    const body = await bodyOf(parseRequest(inbound), {
      ...provider,
      authMode: "oauth",
    });

    expect(body.output_config).toEqual({
      effort: "high",
      format: { type: "json_schema", schema },
    });
  });
});

describe("Claude Desktop classifier round trip (#545)", () => {
  test("thinking:disabled survives inbound translation to the outbound Anthropic body", async () => {
    // The reporter's exact shape: a permission classifier with a 64-token budget that must
    // close its XML tag. Before the fix, "disabled" was dropped at the inbound hop and the
    // outbound request omitted `thinking` entirely, so Sonnet 5 thought anyway and spent the
    // budget before emitting </block>. Claude Code then retried, up to five times.
    const inbound = anthropicToResponsesBody({
      model: "claude-sonnet-5",
      max_tokens: 64,
      stop_sequences: ["</block>"],
      thinking: { type: "disabled" },
      system: "decide whether this tool call is allowed",
      messages: [{ role: "user", content: "<request>ls</request>" }],
    });

    const body = await bodyOf(parseRequest(inbound));

    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(64);
    expect(body.stop_sequences).toEqual(["</block>"]);
  });
});

describe("provider default reasoning effort (#2494)", () => {
  const withDefault = (model: string, effort: string) => ({
    ...(provider as unknown as Record<string, unknown>),
    modelDefaultReasoningEfforts: { [model]: effort },
  } as unknown as OcxProviderConfig);

  test("a configured default applies when the caller omits reasoning", async () => {
    const model = "anthropic/claude-sonnet-4.5";
    const b = await bodyOf(parsed(undefined, {}, model), withDefault(model, "high"));
    expect((b.thinking as { type?: string } | undefined)?.type).toBe("enabled");
    expect((b.thinking as { budget_tokens?: number }).budget_tokens).toBe(16384);
  });

  test("an explicit caller effort still wins over the configured default", async () => {
    const model = "anthropic/claude-sonnet-4.5";
    const b = await bodyOf(parsed("none", {}, model), withDefault(model, "high"));
    expect(b.thinking).toBeUndefined();
  });

  // The sentinel means "send no reasoning field". Treating it as an effort put
  // output_config.effort: "__omit__" on the wire for adaptive models and turned
  // budget thinking ON for the rest — the opposite of the request.
  test("the __omit__ sentinel never becomes an effort value", async () => {
    const adaptive = "anthropic/claude-fable-5";
    const a = await bodyOf(parsed(undefined, {}, adaptive), withDefault(adaptive, "__omit__"));
    expect(a.output_config).toBeUndefined();
    expect(a.thinking).toBeUndefined();

    const budget = "anthropic/claude-sonnet-4.5";
    const b = await bodyOf(parsed(undefined, {}, budget), withDefault(budget, "__omit__"));
    expect(b.thinking).toBeUndefined();
  });

  test("a blank default is ignored rather than treated as an effort", async () => {
    const model = "anthropic/claude-sonnet-4.5";
    const b = await bodyOf(parsed(undefined, {}, model), withDefault(model, "   "));
    expect(b.thinking).toBeUndefined();
  });
});
