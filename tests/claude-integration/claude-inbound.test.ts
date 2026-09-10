import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AnthropicRequestError as LeafAnthropicRequestError } from "../../src/claude/inbound-records";
import { repoPath } from "../helpers/repo-root";
import { AnthropicRequestError, anthropicToResponsesBody, anthropicToResponsesTranslation, effortForThinkingBudget, extractOcxEffortDirective, resolveInboundModel } from "../../src/claude/inbound";
import { parseRequest } from "../../src/responses/parser";
import { responsesRequestSchema } from "../../src/responses/schema";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import type { OcxProviderConfig } from "../../src/types";

// The translator returns an untyped wire body. These aliases name just the fields the
// system-message cases assert on, so the assertions read as a contract instead of a cast.
type TranslatedInputItem = {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};
type TranslatedBody = {
  instructions?: string;
  prompt_cache_key?: string;
  input: TranslatedInputItem[];
};

function translatedBody(raw: Record<string, unknown>): TranslatedBody {
  return anthropicToResponsesBody(raw) as TranslatedBody;
}

// Full Claude Code-shaped request: system array, tool cycle, image, thinking, options.
function claudeCodeRequest(): Record<string, unknown> {
  return {
    model: "gemini/gemini-3-pro",
    max_tokens: 8192,
    stream: true,
    system: [
      { type: "text", text: "You are Claude Code." },
      { type: "text", text: "Prefer terse answers." },
    ],
    messages: [
      { role: "user", content: "read the README" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should read it", signature: "sig123" },
          { type: "text", text: "Reading it now." },
          { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/README.md" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "# hello" }] },
          { type: "text", text: "now summarize" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aWc=" } },
        ],
      },
    ],
    tools: [
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    thinking: { type: "enabled", budget_tokens: 10000 },
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    stop_sequences: ["STOP"],
    metadata: { user_id: "user-abc" },
  };
}

describe("claude inbound translation", () => {
  test("full Claude Code request passes the real responses schema AND parseRequest", () => {
    const body = anthropicToResponsesBody(claudeCodeRequest());
    // The hard gate: the translated body must be accepted by the real request pipeline.
    expect(() => responsesRequestSchema.parse(body)).not.toThrow();
    expect(() => parseRequest(body)).not.toThrow();
  });

  test("content/tool/option mapping round-trips", () => {
    const body = anthropicToResponsesBody(claudeCodeRequest()) as Record<string, any>;
    expect(body.model).toBe("gemini/gemini-3-pro");
    expect(body.instructions).toBe("You are Claude Code.\n\nPrefer terse answers.");
    expect(body.max_output_tokens).toBe(8192);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBeUndefined(); // documented drop
    expect(body.stop).toEqual(["STOP"]);
    expect(body.user).toBe("user-abc");
    // Stable per-session cache-affinity key derived from metadata.user_id (devlog 090)
    expect(body.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toBe("auto");
    expect(body.reasoning).toEqual({ summary: "auto", effort: "medium" });

    const tools = body.tools as Record<string, any>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      type: "function", name: "Read", description: "Read a file",
      parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
      strict: false,
    });
    expect(tools[1]).toEqual({ type: "web_search" });

    const input = body.input as Record<string, any>[];
    // user text, reasoning, assistant text, function_call, function_call_output, user tail
    expect(input.map(i => i.type ?? i.role)).toEqual(["message", "reasoning", "message", "function_call", "function_call_output", "message"]);
    expect(input[2].content).toEqual([{ type: "output_text", text: "Reading it now." }]);
    expect(input[3]).toMatchObject({ call_id: "toolu_01", name: "Read", arguments: JSON.stringify({ file_path: "/README.md" }) });
    expect(input[4]).toMatchObject({ call_id: "toolu_01", output: [{ type: "input_text", text: "# hello" }] });
    const tail = input[5].content as Record<string, any>[];
    expect(tail[0]).toEqual({ type: "input_text", text: "now summarize" });
    expect(tail[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,aWc=" });
  });

  for (const carrier of ["user", "tool_result"] as const) {
    test(`${carrier} file-backed images throw the fixed AnthropicRequestError without file IDs`, () => {
      const image = { type: "image", source: { type: "file", file_id: "file_private_image_030" } };
      const request = {
        model: "m", max_tokens: 10,
        messages: carrier === "user"
          ? [{ role: "user", content: [image] }]
          : [
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [image] }] },
          ],
      };
      let error: unknown;
      try {
        anthropicToResponsesBody(request);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AnthropicRequestError);
      expect(error).toHaveProperty(
        "message",
        "File-backed images require native Anthropic passthrough; use base64 or URL images on translated routes.",
      );
      expect(String(error)).not.toContain(image.source.file_id);
    });

    test(`${carrier} base64 and URL images preserve their translated content`, () => {
      const content = [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aWc=" } },
        { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
      ];
      const body = anthropicToResponsesBody({
        model: "m", max_tokens: 10,
        messages: carrier === "user"
          ? [{ role: "user", content }]
          : [
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
          ],
      });
      const images = [
        { type: "input_image", image_url: "data:image/png;base64,aWc=" },
        { type: "input_image", image_url: "https://example.com/image.png" },
      ];
      expect(body.input).toEqual(carrier === "user"
        ? [{ type: "message", role: "user", content: images }]
        : [
          { type: "function_call", call_id: "t1", name: "Read", arguments: "{}" },
          { type: "function_call_output", call_id: "t1", output: images },
        ]);
    });

    test(`${carrier} file-backed documents retain attachment markers without rejection`, () => {
      const content = [
        { type: "document", source: { type: "file", file_id: "file_document_030" }, title: "report.pdf" },
      ];
      const body = anthropicToResponsesBody({
        model: "m", max_tokens: 10,
        messages: carrier === "user"
          ? [{ role: "user", content }]
          : [
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
          ],
      });
      const marker = [{ type: "input_text", text: "[document: report.pdf]" }];
      expect(body.input).toEqual(carrier === "user"
        ? [{ type: "message", role: "user", content: marker }]
        : [
          { type: "function_call", call_id: "t1", name: "Read", arguments: "{}" },
          { type: "function_call_output", call_id: "t1", output: marker },
        ]);
    });
  }

  test("file-backed image-shaped tool arguments remain opaque JSON without rejection", () => {
    const body = anthropicToResponsesBody({
      model: "m", max_tokens: 10,
      messages: [{
        role: "assistant",
        content: [{
          type: "tool_use", id: "t1", name: "Read",
          input: { image: { type: "image", source: { type: "file", file_id: "file_argument_030" } } },
        }],
      }],
    });
    expect(body.input).toEqual([{
      type: "function_call", call_id: "t1", name: "Read",
      arguments: '{"image":{"type":"image","source":{"type":"file","file_id":"file_argument_030"}}}',
    }]);
  });

  test("thinking variants", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    expect((anthropicToResponsesBody({ ...base, thinking: { type: "adaptive" } }) as any).reasoning).toEqual({ summary: "auto" });
    // "disabled" and omitted must NOT collapse to the same state: for a model that thinks by
    // default, omission means thinking is ON and shares the caller's max_tokens (#545).
    expect((anthropicToResponsesBody({ ...base, thinking: { type: "disabled" } }) as any).reasoning).toEqual({ effort: "none" }); // justified: sibling assertions in this test use the same cast
    expect((anthropicToResponsesBody(base) as any).reasoning).toBeUndefined();
    expect(effortForThinkingBudget(1024)).toBe("low");
    expect(effortForThinkingBudget(8192)).toBe("medium");
    expect(effortForThinkingBudget(30000)).toBe("high");
  });

  test("adaptive /effort wire: output_config.effort maps to reasoning.effort (devlog 080)", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const reasoningOf = (body: unknown) => (body as { reasoning?: Record<string, unknown> }).reasoning;
    // Real claude 2.1.207 capture: thinking adaptive + output_config effort
    expect(reasoningOf(anthropicToResponsesBody({
      ...base,
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "high" },
    }))).toEqual({ summary: "auto", effort: "high" });
    // effort passes through the whole known ladder
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(reasoningOf(anthropicToResponsesBody({
        ...base, thinking: { type: "adaptive" }, output_config: { effort },
      }))).toEqual({ summary: "auto", effort });
    }
    // output_config alone (adaptive-default models may omit thinking) still carries effort
    expect(reasoningOf(anthropicToResponsesBody({
      ...base, output_config: { effort: "medium" },
    }))).toEqual({ summary: "auto", effort: "medium" });
    // output_config wins over a legacy budget when both appear
    expect(reasoningOf(anthropicToResponsesBody({
      ...base,
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { effort: "xhigh" },
    }))).toEqual({ summary: "auto", effort: "xhigh" });
    // disabled thinking suppresses effort entirely (subagent wire, claude-code#65863).
    // Still suppressed — "high" never reaches the wire — but now stated explicitly as the
    // "none" disable sentinel instead of by absence, so a default-on model is told to stop
    // rather than left to think anyway (#545).
    expect(reasoningOf(anthropicToResponsesBody({
      ...base, thinking: { type: "disabled" }, output_config: { effort: "high" },
    }))).toEqual({ effort: "none" });
    // unknown effort strings are dropped so downstream defaults win
    expect(reasoningOf(anthropicToResponsesBody({
      ...base, thinking: { type: "adaptive" }, output_config: { effort: "turbo" },
    }))).toEqual({ summary: "auto" });
  });

  test("structured output maps output_config.format to text.format", () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const body = anthropicToResponsesBody({
      model: "claude-sonnet-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "Return JSON" }],
      output_config: { format: { type: "json_schema", schema } },
    });

    expect(body.text).toEqual({ format: { type: "json_schema", name: "response", schema } });
    expect(parseRequest(body).options.textFormat).toEqual({ type: "json_schema", name: "response", schema });
  });

  test("structured output rejects unsupported schemas and preserves root references", () => {
    const base = {
      model: "claude-sonnet-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "Return JSON" }],
    };
    const invalid = anthropicToResponsesBody({
      ...base,
      output_config: {
        format: { type: "json_schema", schema: { description: "answer" } },
      },
    });
    const refSchema = {
      $defs: { answer: { type: "object", properties: { value: { type: "string" } } } },
      $ref: "#/$defs/answer",
    };
    const referenced = anthropicToResponsesBody({
      ...base,
      output_config: { format: { type: "json_schema", schema: refSchema } },
    });

    expect(invalid.text).toBeUndefined();
    expect(referenced.text).toEqual({
      format: { type: "json_schema", name: "response", schema: refSchema },
    });
  });

  test("tool_choice any/tool/none", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "any" } }) as any).tool_choice).toBe("required");
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "none" } }) as any).tool_choice).toBe("none");
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "tool", name: "Read" } }) as any).tool_choice)
      .toEqual({ type: "function", name: "Read" });
  });

  test("forced Claude WebSearch stays a hosted Responses tool choice", () => {
    const body = anthropicToResponsesBody({
      model: "gpt-5.6-luna",
      max_tokens: 10,
      messages: [{ role: "user", content: "search" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "tool", name: "web_search" },
      thinking: { type: "disabled" },
    }) as Record<string, unknown>;

    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toEqual({ type: "web_search" });
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(() => responsesRequestSchema.parse(body)).not.toThrow();
    expect(() => parseRequest(body)).not.toThrow();
  });

  // Claude Code sends role:"system" entries in `messages`. They used to be folded into
  // `instructions` alongside the top-level system field; now each one becomes a
  // chronological role:"developer" input item, so `instructions` belongs to the
  // top-level Anthropic `system` field alone and the prompt head stops moving
  // mid-conversation.
  test("in-messages system role becomes a chronological developer item, never a system item", () => {
    const body = translatedBody({
      model: "m", max_tokens: 10,
      system: "top-level",
      messages: [
        { role: "system", content: "be terse" },
        { role: "system", content: [{ type: "text", text: "block form" }] },
        { role: "user", content: "hi" },
      ],
    });
    // Only the top-level system reaches instructions now.
    expect(body.instructions).toBe("top-level");
    // Still no system message items in input — the native ChatGPT backend 400s on them.
    expect(body.input.every(item => item.role !== "system")).toBe(true);
    expect(body.input.map(item => item.role)).toEqual(["developer", "developer", "user"]);
    expect(body.input[0]?.content).toEqual([{ type: "input_text", text: "be terse" }]);
    expect(body.input[1]?.content).toEqual([{ type: "input_text", text: "block form" }]);
    expect(() => responsesRequestSchema.parse(body)).not.toThrow();
    expect(() => parseRequest(body)).not.toThrow();
  });

  // #4148: a client that injects a fresh reminder each turn used to rewrite the prompt
  // head every time, which invalidates the upstream KV prefix and — with no
  // metadata.user_id — rotated the Desktop prompt_cache_key fallback along with it.
  test("a mid-conversation system message leaves the cache prefix and cache key alone", () => {
    const turn = (messages: unknown[]) =>
      translatedBody({ model: "m", max_tokens: 10, system: "S", messages });

    const turn1 = turn([
      { role: "user", content: "u1" },
      { role: "system", content: "r1" },
    ]);
    const turn2 = turn([
      { role: "user", content: "u1" },
      { role: "system", content: "r1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "system", content: "r2" },
    ]);

    // The prompt head is the whole point: identical across turns, and equal to the
    // top-level system field on its own.
    expect(turn1.instructions).toBe("S");
    expect(turn2.instructions).toBe("S");

    expect(turn1.input.map(item => item.role)).toEqual(["user", "developer"]);
    expect(turn2.input.map(item => item.role))
      .toEqual(["user", "developer", "assistant", "user", "developer"]);
    expect(turn2.input.map(item => item.content?.[0]?.text))
      .toEqual(["u1", "r1", "a1", "u2", "r2"]);
    expect(turn2.input.every(item => item.role !== "system")).toBe(true);

    // Turn 1's items are still a prefix of turn 2's, which is what the KV cache matches on.
    expect(turn2.input.slice(0, 2)).toEqual(turn1.input);

    // No metadata.user_id, so the Desktop cohort fallback applies. It hashes the
    // post-translation system text, which no longer absorbs the injected reminders.
    expect(turn1.prompt_cache_key).toBeDefined();
    expect(turn2.prompt_cache_key).toBe(turn1.prompt_cache_key);

    for (const body of [turn1, turn2]) {
      expect(() => responsesRequestSchema.parse(body)).not.toThrow();
      expect(() => parseRequest(body)).not.toThrow();
    }
  });

  test("tool_result is_error and string content", () => {
    const body = anthropicToResponsesBody({
      model: "m", max_tokens: 10,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
      ],
    }) as any;
    expect(body.input[1].output).toBe("[tool error] boom");
    expect(() => parseRequest(body)).not.toThrow();
  });

  test("tool_result document blocks surface the attachment marker", () => {
    const body = anthropicToResponsesBody({
      model: "m", max_tokens: 10,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result", tool_use_id: "t1",
            content: [
              { type: "text", text: "3 pages" },
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: "aWc=" }, title: "report.pdf" },
            ],
          }],
        },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result", tool_use_id: "t2",
            content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "aWc=" } }],
          }],
        },
      ],
    }) as any;
    expect(body.input[1].output).toEqual([
      { type: "input_text", text: "3 pages" },
      { type: "input_text", text: "[document: report.pdf]" },
    ]);
    // An untitled document still leaves a marker rather than the empty output that
    // read as "the tool returned nothing".
    expect(body.input[3].output).toEqual([{ type: "input_text", text: "[document]" }]);
    expect(() => parseRequest(body)).not.toThrow();
  });

  test("modelMap: exact, date-stripped, passthrough", () => {
    const cc = { modelMap: { "claude-sonnet-4-5": "gemini/gemini-3-flash", "claude-opus-4": "xai/grok-4" } };
    expect(resolveInboundModel("claude-sonnet-4-5", cc)).toBe("gemini/gemini-3-flash");
    expect(resolveInboundModel("claude-opus-4-20250514", cc)).toBe("xai/grok-4");
    expect(resolveInboundModel("gpt-5.5", cc)).toBe("gpt-5.5");
    expect(resolveInboundModel("anything", undefined)).toBe("anything");
  });

  test("Claude Code Auto Mode classifier routing uses only operator-declared targets (#1697)", () => {
    // A bare classifier check carries no provider, so without this it falls through to
    // defaultProvider -- which may not speak Anthropic at all. What it must NOT do is pick a
    // provider nobody chose.

    // 1. Explicit classifierModel is used.
    const ccExplicit = { model: "RelayA/claude-fable-5", classifierModel: "RelayB/claude-opus-5" };
    expect(resolveInboundModel("claude-opus-5", ccExplicit)).toBe("RelayB/claude-opus-5");
    expect(resolveInboundModel("claude-opus-5-20250514", ccExplicit)).toBe("RelayB/claude-opus-5");

    // 2. modelMap outranks it: an explicit per-model mapping is the operator's most specific say.
    const ccWithModelMap = {
      model: "RelayA/claude-fable-5",
      classifierModel: "RelayB/claude-opus-5",
      modelMap: { "claude-opus-5": "Custom/my-opus-5" },
    };
    expect(resolveInboundModel("claude-opus-5", ccWithModelMap)).toBe("Custom/my-opus-5");

    // 3. Ordered fallbacks are used when no classifierModel is set.
    const ccWithFallbacks = { classifierFallbacks: ["RelayC/claude-opus-5", "RelayD/claude-opus-5"] };
    expect(resolveInboundModel("claude-opus-5", ccWithFallbacks)).toBe("RelayC/claude-opus-5");

    // 4. NO affinity inferred from cc.model. That value is the injected/default config slot, not
    // the provider the live session actually selected, so it goes stale the moment the user
    // changes the model picker -- and acting on it would silently move a classifier turn onto a
    // provider with its own privacy and billing consequences.
    expect(resolveInboundModel("claude-opus-5", { model: "RelayA/claude-fable-5" })).toBe("claude-opus-5");
    expect(resolveInboundModel("claude-opus-5", { model: "claude-ocx-RelayA--claude-fable-5" })).toBe("claude-opus-5");
    expect(resolveInboundModel("claude-opus-5", { model: "native/claude-opus-5" })).toBe("claude-opus-5");

    // 5. Malformed operator config is ignored rather than half-applied.
    expect(resolveInboundModel("claude-opus-5", { classifierModel: "   " })).toBe("claude-opus-5");
    expect(resolveInboundModel("claude-opus-5", { classifierFallbacks: [] })).toBe("claude-opus-5");

    // 6. A non-classifier model is untouched by any of this.
    expect(resolveInboundModel("claude-fable-5", ccExplicit)).toBe("claude-fable-5");
  });

  test("error cases: no model, empty messages, bad role, bad tool_result", () => {
    expect(() => anthropicToResponsesBody({ max_tokens: 1, messages: [{ role: "user", content: "x" }] })).toThrow(AnthropicRequestError);
    expect(() => anthropicToResponsesBody({ model: "m", max_tokens: 1, messages: [] })).toThrow(AnthropicRequestError);
    // system role is ACCEPTED (real Claude Code sends it); truly unknown roles still 400.
    expect(() => anthropicToResponsesBody({ model: "m", max_tokens: 1, messages: [{ role: "system", content: "x" }] })).not.toThrow();
    expect(() => anthropicToResponsesBody({ model: "m", max_tokens: 1, messages: [{ role: "tool", content: "x" }] })).toThrow(AnthropicRequestError);
    expect(() => anthropicToResponsesBody({
      model: "m", max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "tool_result" }] }],
    })).toThrow(AnthropicRequestError);
    expect(() => anthropicToResponsesBody("nope")).toThrow(AnthropicRequestError);
  });
});

describe("prompt cache key provenance (devlog 130 B3)", () => {
  const messages = [{ role: "user", content: "hi" }];

  test("metadata.user_id wins: key derived from it, source=metadata", () => {
    const { body, cacheKeySource } = anthropicToResponsesTranslation({
      model: "m", max_tokens: 1, messages,
      system: "be nice",
      metadata: { user_id: "user-abc" },
    });
    expect(cacheKeySource).toBe("metadata");
    expect(body.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
  });

  test("no metadata + system present: fallback key from system hash, source=system", () => {
    const a = anthropicToResponsesTranslation({ model: "m", max_tokens: 1, messages, system: "be nice" });
    const b = anthropicToResponsesTranslation({ model: "m", max_tokens: 1, messages, system: "be nice" });
    const c = anthropicToResponsesTranslation({ model: "m", max_tokens: 1, messages, system: "be terse" });
    expect(a.cacheKeySource).toBe("system");
    expect(a.body.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
    // Stable per system prompt, distinct across different system prompts.
    expect(a.body.prompt_cache_key).toBe(b.body.prompt_cache_key as string);
    expect(a.body.prompt_cache_key).not.toBe(c.body.prompt_cache_key as string);
  });

  test("no metadata + no system: no key at all, source=null", () => {
    const { body, cacheKeySource } = anthropicToResponsesTranslation({ model: "m", max_tokens: 1, messages });
    expect(cacheKeySource).toBeNull();
    expect(body.prompt_cache_key).toBeUndefined();
  });

  test("cacheKeySource never leaks into the serialized wire body", () => {
    const { body } = anthropicToResponsesTranslation({ model: "m", max_tokens: 1, messages, system: "be nice" });
    const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    for (const key of Object.keys(wire)) {
      expect(key.toLowerCase()).not.toContain("cachekeysource");
    }
  });

  test("cache cohort key: model and full tool schemas participate, wire order preserved (devlog 260712 B4)", () => {
    const tool = (desc: string) => ({ name: "Read", description: desc, input_schema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } });
    const base = { max_tokens: 1, messages, system: "be nice" };
    const k = (body: Record<string, unknown>) => anthropicToResponsesTranslation(body).body.prompt_cache_key as string;
    // model differs -> cohort differs.
    expect(k({ ...base, model: "m1" })).not.toBe(k({ ...base, model: "m2" }));
    // same name, different schema/description -> cohort differs (audit R1#4).
    expect(k({ ...base, model: "m", tools: [tool("v1")] })).not.toBe(k({ ...base, model: "m", tools: [tool("v2")] }));
    // identical schema with different key ORDER -> same cohort (audit R2#5).
    const orderedA = { name: "Read", description: "d", input_schema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } };
    const orderedB = { name: "Read", input_schema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" }, description: "d" };
    expect(k({ ...base, model: "m", tools: [orderedA] })).toBe(k({ ...base, model: "m", tools: [orderedB] }));
    // different WIRE ORDER of the tool array -> different cohort (Pro review: the key
    // must correspond to the actual outbound prefix, so array order participates).
    const t1 = { name: "A", description: "a", input_schema: { type: "object" } };
    const t2 = { name: "B", description: "b", input_schema: { type: "object" } };
    expect(k({ ...base, model: "m", tools: [t1, t2] })).not.toBe(k({ ...base, model: "m", tools: [t2, t1] }));
  });

  test("[1m] strip works for both alias families before decode", () => {
    // Legacy claude-ocx-* (pure decode, no registry needed).
    expect(resolveInboundModel("claude-ocx-cursor--gpt-5.6-luna[1m]")).toBe("cursor/gpt-5.6-luna");
  });
});

describe("bundled-skill elision for routed models (devlog 260712 060)", () => {
  const BIG = "ANTHROPIC DOC BUNDLE ".repeat(500);
  function requestWithSkill(skillName: string, cc?: { blockedSkills?: string[] }) {
    return {
      body: anthropicToResponsesTranslation({
        model: "gemini/gemini-3-pro",
        max_tokens: 100,
        messages: [
          { role: "user", content: "load it" },
          { role: "assistant", content: [{ type: "tool_use", id: "call_skill_1", name: "Skill", input: { command: skillName } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_skill_1", content: [{ type: "text", text: BIG }] }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call_other", name: "Bash", input: { command: "ls" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_other", content: [{ type: "text", text: "file.txt" }] }] },
        ],
      }, cc as never).body,
    };
  }
  function outputFor(body: Record<string, unknown>, callId: string): unknown {
    const items = body.input as Array<Record<string, unknown>>;
    return items.find(i => i.type === "function_call_output" && i.call_id === callId)?.output;
  }

  test("claude-api result body is stubbed by default; pairing and other tools intact", () => {
    const { body } = requestWithSkill("claude-api");
    const skillOut = outputFor(body, "call_skill_1");
    expect(typeof skillOut).toBe("string");
    expect(String(skillOut)).toContain("elided");
    expect(String(skillOut).length).toBeLessThan(500);
    // Non-blocked tool result untouched; the translated body still parses.
    const bashOut = outputFor(body, "call_other") as Array<Record<string, unknown>>;
    expect(bashOut[0]?.text).toBe("file.txt");
    expect(() => parseRequest(body)).not.toThrow();
  });

  test("non-blocked skills keep their content; empty blockedSkills disables the default", () => {
    const { body } = requestWithSkill("pdf-tools");
    const out = outputFor(body, "call_skill_1") as Array<Record<string, unknown>>;
    expect(out[0]?.text).toBe(BIG);
    const { body: off } = requestWithSkill("claude-api", { blockedSkills: [] });
    const offOut = outputFor(off, "call_skill_1") as Array<Record<string, unknown>>;
    expect(offOut[0]?.text).toBe(BIG);
  });

  test("custom blocklist matches case-insensitively inside the Skill input", () => {
    const { body } = requestWithSkill("My-Custom-Skill", { blockedSkills: [" MY-CUSTOM-SKILL "] });
    expect(String(outputFor(body, "call_skill_1"))).toContain("elided");
  });

  // Live-capture carrier (2.1.207): the bundle rides a sibling TEXT block whose first
  // line is "Base directory for this skill: <dir>/<name>" — not the tool_result.
  function requestWithSkillTextBlock(skillDirName: string, textLen: number, cc?: { blockedSkills?: string[] }, baseDir?: string) {
    const dir = baseDir ?? `/private/tmp/claude-501/bundled-skills/2.1.207/abc/${skillDirName}`;
    const bundle = `Base directory for this skill: ${dir}\n\n` + "DOCS ".repeat(Math.ceil(textLen / 5));
    return anthropicToResponsesTranslation({
      model: "gemini/gemini-3-pro",
      max_tokens: 100,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_s", name: "Skill", input: { skill: skillDirName, args: "" } }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_s", content: [{ type: "text", text: `Launching skill: ${skillDirName}` }] },
          { type: "text", text: bundle },
        ] },
      ],
    }, cc as never).body;
  }
  function userTexts(body: Record<string, unknown>): string[] {
    const items = body.input as Array<Record<string, unknown>>;
    return items.filter(i => i.type === "message" && i.role === "user")
      .flatMap(i => (i.content as Array<Record<string, unknown>>).map(c => String(c.text ?? "")));
  }

  test("text-block bundle carrier is stubbed for blocked skills (live 2.1.207 shape)", () => {
    const texts = userTexts(requestWithSkillTextBlock("claude-api", 500_000));
    expect(texts.some(t => t.includes("elided") && t.includes("claude-api"))).toBe(true);
    expect(texts.every(t => t.length < 10_000)).toBe(true);
  });

  test("text-block carrier: non-blocked skill and small payloads pass through", () => {
    const kept = userTexts(requestWithSkillTextBlock("pdf-tools", 500_000));
    expect(kept.some(t => t.length > 400_000)).toBe(true);
    const small = userTexts(requestWithSkillTextBlock("claude-api", 2_000));
    expect(small.some(t => t.startsWith("Base directory"))).toBe(true);
    const off = userTexts(requestWithSkillTextBlock("claude-api", 500_000, { blockedSkills: [] }));
    expect(off.some(t => t.length > 400_000)).toBe(true);
  });

  test("text-block carrier: Windows backslash base dir is elided (live incident 2026-07-15)", () => {
    const texts = userTexts(requestWithSkillTextBlock("claude-api", 500_000, undefined,
      "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\bundled-skills\\claude-api"));
    expect(texts.some(t => t.includes("elided") && t.includes("claude-api"))).toBe(true);
    expect(texts.every(t => t.length < 10_000)).toBe(true);
  });

  test("text-block carrier: mixed separators and UNC paths are elided", () => {
    const mixed = userTexts(requestWithSkillTextBlock("claude-api", 500_000, undefined,
      "C:\\Users\\u\\skills/2.1.207\\claude-api"));
    expect(mixed.some(t => t.includes("elided"))).toBe(true);
    const unc = userTexts(requestWithSkillTextBlock("claude-api", 500_000, undefined,
      "\\\\server\\share\\skills\\claude-api"));
    expect(unc.some(t => t.includes("elided"))).toBe(true);
  });

  test("text-block carrier: drive-relative dir (no separator) stays pass-through", () => {
    const texts = userTexts(requestWithSkillTextBlock("claude-api", 500_000, undefined, "C:claude-api"));
    expect(texts.some(t => t.length > 400_000)).toBe(true);
  });
});

describe("ocx-route directive (devlog 072)", () => {
  const { extractOcxRouteDirective } = require("../../src/claude/inbound") as typeof import("../../src/claude/inbound");

  test("extracts from string and block-array system; first directive wins", () => {
    expect(extractOcxRouteDirective({ system: "intro\n<!-- ocx-route: claude-ocx-native--gpt-5.6-sol[1m] -->\nrest" }))
      .toBe("claude-ocx-native--gpt-5.6-sol[1m]");
    expect(extractOcxRouteDirective({
      system: [
        { type: "text", text: "You are a delegated worker" },
        { type: "text", text: "<!-- ocx-route: gemini/gemini-3-pro --> and <!-- ocx-route: other -->" },
      ],
    })).toBe("gemini/gemini-3-pro");
  });

  test("extracts only supported generated-agent effort values", () => {
    expect(extractOcxEffortDirective({ system: "<!-- ocx-effort: max -->" })).toBe("max");
    expect(extractOcxEffortDirective({
      system: [{ type: "text", text: "<!-- ocx-effort: xhigh -->" }],
    })).toBe("xhigh");
    expect(extractOcxEffortDirective({ system: "<!-- ocx-effort: ultra -->" })).toBeNull();
  });

  test("absent or malformed directives return null", () => {
    expect(extractOcxRouteDirective({ system: "no directive here" })).toBeNull();
    expect(extractOcxRouteDirective({ system: [{ type: "text", text: "<!-- ocx-route: -->" }] })).toBeNull();
    expect(extractOcxRouteDirective({})).toBeNull();
    expect(extractOcxRouteDirective(null)).toBeNull();
    expect(extractOcxEffortDirective(null)).toBeNull();
  });
});

test("inbound leaves preserve the tool_choice error identity and avoid facade back-edges", () => {
  const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
  expect(() => anthropicToResponsesBody({ ...base, tool_choice: { type: "tool" } }))
    .toThrow(AnthropicRequestError);
  expect(AnthropicRequestError).toBe(LeafAnthropicRequestError);
  for (const leaf of ["inbound-records.ts", "inbound-model-options.ts", "inbound-content-options.ts"]) {
    expect(readFileSync(repoPath("src", "claude", leaf), "utf8"))
      .not.toMatch(/from\s+["']\.\/inbound["']/);
  }
});


/**
 * #3922: Anthropic enables strict tool use by setting strict: true, while Responses
 * reads an omitted strict as permission to normalize the schema into strict mode.
 * Translating without the field therefore made every optional input_schema parameter
 * behave as required upstream, so a call that omitted one failed. The translated tool
 * now carries the source intent, and the value has to survive to the serialized wire
 * body rather than only to the translator's return.
 */
describe("#3922 translated tools carry the source strict intent", () => {
  const schema = {
    type: "object",
    properties: {
      prompt: { type: "string" },
      isolation: { type: "string", enum: ["worktree", "remote"] },
      options: { type: "object", properties: { enabled: { type: "boolean" } } },
    },
    required: ["prompt"],
    additionalProperties: false,
  };
  const request = (tool: Record<string, unknown>) => ({
    model: "openai/gpt-5.6-luna",
    max_tokens: 32,
    messages: [{ role: "user", content: "Run a local agent." }],
    tools: [tool],
  });
  const agent = (extra: Record<string, unknown> = {}) => ({
    name: "Agent", description: "Run an agent", input_schema: schema, ...extra,
  });
  const translatedTool = (tool: Record<string, unknown>) =>
    (anthropicToResponsesBody(request(tool)).tools as Record<string, unknown>[])[0]!;

  test("an omitted strict becomes an explicit false instead of an implicit strict request", () => {
    expect(translatedTool(agent()).strict).toBe(false);
  });

  test("an explicit strict survives in both directions", () => {
    expect(translatedTool(agent({ strict: true })).strict).toBe(true);
    expect(translatedTool(agent({ strict: false })).strict).toBe(false);
  });

  test("a non-boolean strict cannot opt the tool into strict mode", () => {
    expect(translatedTool(agent({ strict: "true" })).strict).toBe(false);
  });

  test("the source input_schema is forwarded unchanged", () => {
    for (const extra of [{}, { strict: true }, { strict: false }]) {
      const tool = agent(extra);
      // Compare against a detached copy: the expected value must not be the very
      // object under test, or an in-place mutation would move both sides together.
      const expectedSchema = structuredClone(tool.input_schema);
      expect(translatedTool(tool).parameters).toEqual(expectedSchema);
      expect(tool.input_schema).toEqual(expectedSchema);
    }
  });

  test("hosted web_search gains no strict field", () => {
    const body = anthropicToResponsesBody(request({ type: "web_search_20250305", name: "web_search" }));
    expect((body.tools as Record<string, unknown>[])[0]).toEqual({ type: "web_search" });
  });

  test("strict intent and schema survive into the serialized Responses body", async () => {
    // parsed._rawBody is the translator's own object, so reading it back proves
    // nothing about the wire. Build the actual outbound request instead.
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      authMode: "key",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
    } as OcxProviderConfig));

    for (const [tool, expected] of [
      [agent(), false],
      [agent({ strict: true }), true],
      [agent({ strict: false }), false],
    ] as const) {
      const expectedSchema = structuredClone(tool.input_schema);
      const parsed = parseRequest({ ...anthropicToResponsesBody(request(tool)), model: "gpt-5.6-luna" });
      expect(parsed.context.tools?.[0]?.strict).toBe(expected);

      const outbound = await adapter.buildRequest(parsed);
      try {
        const wire = JSON.parse(String(outbound.body)) as { tools: { strict?: boolean; parameters?: unknown }[] };
        expect(wire.tools).toHaveLength(1);
        expect(wire.tools[0]?.strict).toBe(expected);
        expect(wire.tools[0]?.parameters).toEqual(expectedSchema);
        expect(tool.input_schema).toEqual(expectedSchema);
      } finally {
        outbound.releaseBodyObservation?.();
      }
    }
  });
});
