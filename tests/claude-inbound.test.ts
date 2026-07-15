import { describe, expect, test } from "bun:test";
import { AnthropicRequestError, anthropicToResponsesBody, anthropicToResponsesTranslation, effortForThinkingBudget, resolveInboundModel } from "../src/claude/inbound";
import { parseRequest } from "../src/responses/parser";
import { responsesRequestSchema } from "../src/responses/schema";

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
    });
    expect(tools[1]).toEqual({ type: "web_search" });

    const input = body.input as Record<string, any>[];
    // user text, assistant text (thinking dropped), function_call, function_call_output, user tail
    expect(input.map(i => i.type ?? i.role)).toEqual(["message", "message", "function_call", "function_call_output", "message"]);
    expect(input[1].content).toEqual([{ type: "output_text", text: "Reading it now." }]);
    expect(input[2]).toMatchObject({ call_id: "toolu_01", name: "Read", arguments: JSON.stringify({ file_path: "/README.md" }) });
    expect(input[3]).toMatchObject({ call_id: "toolu_01", output: [{ type: "input_text", text: "# hello" }] });
    const tail = input[4].content as Record<string, any>[];
    expect(tail[0]).toEqual({ type: "input_text", text: "now summarize" });
    expect(tail[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,aWc=" });
  });

  test("thinking variants", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    expect((anthropicToResponsesBody({ ...base, thinking: { type: "adaptive" } }) as any).reasoning).toEqual({ summary: "auto" });
    expect((anthropicToResponsesBody({ ...base, thinking: { type: "disabled" } }) as any).reasoning).toBeUndefined();
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
    // disabled thinking suppresses effort entirely (subagent wire, claude-code#65863)
    expect(reasoningOf(anthropicToResponsesBody({
      ...base, thinking: { type: "disabled" }, output_config: { effort: "high" },
    }))).toBeUndefined();
    // unknown effort strings are dropped so downstream defaults win
    expect(reasoningOf(anthropicToResponsesBody({
      ...base, thinking: { type: "adaptive" }, output_config: { effort: "turbo" },
    }))).toEqual({ summary: "auto" });
  });

  test("tool_choice any/tool/none", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "any" } }) as any).tool_choice).toBe("required");
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "none" } }) as any).tool_choice).toBe("none");
    expect((anthropicToResponsesBody({ ...base, tool_choice: { type: "tool", name: "Read" } }) as any).tool_choice)
      .toEqual({ type: "function", name: "Read" });
  });

  test("system role messages fold into instructions (real Claude Code sends them; native backend rejects system items)", () => {
    const body = anthropicToResponsesBody({
      model: "m", max_tokens: 10,
      system: "top-level",
      messages: [
        { role: "system", content: "be terse" },
        { role: "system", content: [{ type: "text", text: "block form" }] },
        { role: "user", content: "hi" },
      ],
    }) as any;
    expect(body.instructions).toBe("top-level\n\nbe terse\n\nblock form");
    // No system message items in input — native ChatGPT backend 400s on them.
    expect((body.input as any[]).every(item => item.role !== "system")).toBe(true);
    expect(body.input).toHaveLength(1);
    expect(body.input[0].role).toBe("user");
    expect(() => responsesRequestSchema.parse(body)).not.toThrow();
    expect(() => parseRequest(body)).not.toThrow();
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

  test("modelMap: exact, date-stripped, passthrough", () => {
    const cc = { modelMap: { "claude-sonnet-4-5": "gemini/gemini-3-flash", "claude-opus-4": "xai/grok-4" } };
    expect(resolveInboundModel("claude-sonnet-4-5", cc)).toBe("gemini/gemini-3-flash");
    expect(resolveInboundModel("claude-opus-4-20250514", cc)).toBe("xai/grok-4");
    expect(resolveInboundModel("gpt-5.5", cc)).toBe("gpt-5.5");
    expect(resolveInboundModel("anything", undefined)).toBe("anything");
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
    const { body } = requestWithSkill("My-Custom-Skill", { blockedSkills: ["my-custom-skill"] });
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
  const { extractOcxRouteDirective } = require("../src/claude/inbound") as typeof import("../src/claude/inbound");

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

  test("absent or malformed directives return null", () => {
    expect(extractOcxRouteDirective({ system: "no directive here" })).toBeNull();
    expect(extractOcxRouteDirective({ system: [{ type: "text", text: "<!-- ocx-route: -->" }] })).toBeNull();
    expect(extractOcxRouteDirective({})).toBeNull();
    expect(extractOcxRouteDirective(null)).toBeNull();
  });
});
