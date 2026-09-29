import { describe, expect, spyOn, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { protectGlmSummaryBudget } from "../../../src/adapters/openai-chat/summary-budget";
import { chatCompletionsToResponsesBody } from "../../../src/chat/inbound";
import { concreteComboRequestBody } from "../../../src/combos/request";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";

const model = "glm-5.3-flash";
const provider: OcxProviderConfig = {
  adapter: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4",
  reasoningEfforts: ["low", "medium", "high", "max"],
};
// Aside's emergency checkpoint: a summary instruction plus the transcript it summarizes (#5465).
const transcript = `<conversation>${"User: implement the feature and keep the tests green.\n".repeat(60)}</conversation>`;
const messages = [
  { role: "system", content: "You are a context-summarization assistant. Produce a checkpoint." },
  { role: "user", content: transcript },
];
function bodies(overrides: Record<string, unknown> = {}, config = provider) {
  const raw = { model, messages, max_tokens: 512, reasoning_effort: "max", ...overrides };
  const parsed = parseRequest(chatCompletionsToResponsesBody(raw));
  return [
    JSON.parse(createOpenAIChatAdapter(config).buildRequest(parsed).body),
    JSON.parse(buildOpenAIChatPassthroughRequest(config, raw, String(raw.model), false).body),
  ];
}

describe("GLM tiny standalone summary compatibility", () => {
  test.each([1, 512, 819, 1024])("raises cap %i and lowers effort on both Chat paths", cap => {
    for (const body of bodies({ max_tokens: cap })) {
      expect(body.max_tokens).toBe(8192);
      expect(body.reasoning_effort).toBe("low");
      expect(body.messages).toEqual(messages);
    }
  });
  test("final adapter wins after successive combo force overrides", () => {
    let raw = chatCompletionsToResponsesBody({ model, messages, max_tokens: 819, reasoning_effort: "high" });
    for (const target of [{ provider: "proxy", model: "inner" }, { provider: "zai", model }]) {
      raw = concreteComboRequestBody(raw, target, "max", provider.reasoningEfforts, "strict", "force");
    }
    const parsed = parseRequest(raw);
    parsed.modelId = model;
    expect(parsed.options.reasoning).toBe("max");
    const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body);
    expect(body.max_tokens).toBe(8192);
    expect(body.reasoning_effort).toBe("low");
    expect(parsed.options.maxOutputTokens).toBe(819);
    expect(parsed.options.reasoning).toBe("max");
  });
  test.each([0, -1, 1025, 4096, undefined])("preserves cap outside the mitigation: %s", cap => {
    for (const body of bodies({ max_tokens: cap })) {
      expect(body.max_tokens).toBe(cap);
      expect(body.reasoning_effort).toBe("max");
    }
  });
  test("does not change other models, ordinary prompts, tools, or ongoing conversations", () => {
    for (const overrides of [
      { model: "glm-5.3" }, { model: "glm-5.3-flashx" }, { model: "gpt-5" },
      { messages: [{ role: "system", content: "Be helpful." }, { role: "user", content: "Summarize this article." }] },
      { messages: [...messages, { role: "assistant", content: "Previous checkpoint" }] },
      { tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }] },
    ]) for (const body of bodies(overrides)) {
      expect(body.max_tokens).toBe(512);
      expect(body.reasoning_effort).toBe("max");
    }
  });
});

describe("GLM summary mitigation stays inside its boundary (#5953 review)", () => {
  const untouched = (body: Record<string, unknown>, effort = "max") => {
    expect(body.max_tokens).toBe(512);
    expect(body.reasoning_effort).toBe(effort);
  };
  test("another gateway serving the same model id is left alone", () => {
    for (const baseUrl of ["https://example.com/v1", "https://evilz.ai/api/v4", "not a url"]) {
      for (const body of bodies({}, { ...provider, baseUrl })) untouched(body);
    }
  });
  test("a summarization system prompt with an ordinary short user message is not a checkpoint", () => {
    const probe = [messages[0], { role: "user", content: "Hello" }];
    for (const body of bodies({ messages: probe })) untouched(body);
  });
  test("a checkpoint transcript under the minimum length is not rewritten", () => {
    const short = [messages[0], { role: "user", content: "<conversation>User: hi.</conversation>" }];
    for (const body of bodies({ messages: short })) untouched(body);
  });
  /** The only patterns detection may scan the transcript with: the two fixed tags. */
  const FIXED_TAG_SCANS = ["<conversation>", "<\\/conversation>"];
  /** Runs detection while counting scans/copies targeted at the transcript — deterministic, unlike a wall-clock bound. */
  const detectWithProbe = (userContent: string) => {
    const scans: string[] = [];
    const copies: string[] = [];
    const origExec = RegExp.prototype.exec;
    const execProbe = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, str: string) {
      if (str === userContent) scans.push(this.source);
      return origExec.call(this, str);
    });
    const copyProbes = (["toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase"] as const).map(name => {
      const orig = String.prototype[name];
      return spyOn(String.prototype, name).mockImplementation(function (this: unknown) {
        if (String(this) === userContent) copies.push(name);
        return orig.call(this as string);
      });
    });
    try {
      const result = protectGlmSummaryBudget({
        model, max_tokens: 512,
        messages: [messages[0], { role: "user", content: userContent }],
      }, provider.baseUrl, "max");
      // A call count cannot bound work inside one scan — pinning every transcript scan to a
      // fixed tag is what fails the original greedy `[\s\S]*` pass, not the count alone.
      for (const source of scans) expect(FIXED_TAG_SCANS).toContain(source);
      return { result, scans, copies };
    } finally {
      execProbe.mockRestore();
      for (const probe of copyProbes) probe.mockRestore();
    }
  };
  test("rejects many unmatched conversation openings with a bounded number of transcript scans", () => {
    const { result, scans, copies } = detectWithProbe("<conversation>".repeat(32_000));
    expect(result).toBeFalse();
    expect(scans.length).toBeLessThanOrEqual(2);
    expect(copies).toEqual([]);
  });
  test("detects an uppercase checkpoint in place, without a transcript-sized normalized copy", () => {
    const transcript = `<CONVERSATION>${"LOREM IPSUM DOLOR SIT AMET.\n".repeat(200)}</CONVERSATION>`;
    const { result, scans, copies } = detectWithProbe(transcript);
    expect(result).toBeTrue();
    expect(scans.length).toBeLessThanOrEqual(2);
    expect(copies).toEqual([]);
  });
  test.each(["low", "medium"])("an effective %s effort is not overridden", effort => {
    for (const body of bodies({ reasoning_effort: effort })) untouched(body, effort);
  });
  test("each cap field is judged on its own", () => {
    const [, mixedLarge] = bodies({ max_tokens: 512, max_completion_tokens: 2048 });
    expect(mixedLarge.max_tokens).toBe(8192);
    expect(mixedLarge.max_completion_tokens).toBe(2048);
    const [, mixedSmall] = bodies({ max_tokens: 4096, max_completion_tokens: 512 });
    expect(mixedSmall.max_tokens).toBe(4096);
    expect(mixedSmall.max_completion_tokens).toBe(8192);
  });
});
