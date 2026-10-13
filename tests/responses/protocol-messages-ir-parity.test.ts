/**
 * Antigravity direct lane: the Messages -> IR decoder is held to the bridge it replaces.
 *
 * For every body below, the request the core prepares on the direct lane (the settings-only body
 * parsed by `parseRequest`, plus `messagesConversationToIr` for the conversation) must equal what
 * `parseRequest(anthropicToResponsesTranslation(body).body)` builds on the bridge, field for field
 * except `_rawBody`, timestamps and the random reasoning item ids both sides mint. The native
 * reasoning replay map must match too, and bodies the bridge's conversation walk refuses must be
 * refused with the same message. If either side changes alone, this file fails.
 */
import { describe, expect, test } from "bun:test";
import { anthropicSettingsTranslation, anthropicToResponsesTranslation } from "../../src/claude/inbound";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import {
  messagesConversationToIr,
  messagesRouteEvidence,
  withDirectMessagesConversation,
} from "../../src/protocols/codecs/messages-ir";
import { featureEffectsForPath, PROTOCOL_FEATURES } from "../../src/protocols/features";
import { requestPathForLane } from "../../src/protocols/path";
import { parseRequest } from "../../src/responses/parser";
import { encodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { evidenceFromBody } from "../../src/routing/request-evidence";
import { planMessagesAntigravityDirect } from "../../src/server/messages-antigravity-direct";
import type { OcxClaudeCodeConfig, OcxConfig, OcxParsedRequest } from "../../src/types";

const MODEL = "google-antigravity/gemini-3.8-flash";
const IDENTITY = "You are a coding agent powered by the gpt-6. If asked which model you are, identify as gpt-6. "
  + "Do not claim to be a different model or to have a different creator.";
const PNG = "iVBORw0KGgo=";
const PDF = Buffer.from("%PDF-1.4 fixture").toString("base64");
const NUDGE = "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking, "
  + "consider using TaskCreate to add them. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.";
const SKILL_BUNDLE = `Base directory for this skill: /home/u/.claude/skills/claude-api\n${"x".repeat(12_000)}`;

type Body = Record<string, unknown>;

/** A JSON round trip, as the ingress reads bodies: keeps an own `__proto__` key. */
function clone(body: Body): Body {
  return JSON.parse(JSON.stringify(body)) as Body;
}

function comparable(parsed: OcxParsedRequest): unknown {
  const { _rawBody: _ignored, ...rest } = parsed;
  const json = JSON.stringify(rest, (key, value) => key === "timestamp" ? 0 : value);
  return JSON.parse(json.replace(/rs_[0-9a-f]{32}/g, "rs_ID"));
}

function viaBridge(body: Body, cc?: OcxClaudeCodeConfig): { parsed: OcxParsedRequest; replay: unknown } {
  const translation = anthropicToResponsesTranslation(clone(body), cc);
  return { parsed: parseRequest(translation.body), replay: [...translation.nativeReasoningReplay] };
}

function viaDirect(body: Body, cc?: OcxClaudeCodeConfig): { parsed: OcxParsedRequest; replay: unknown } {
  const source = clone(body);
  const budget = createTranslatorBudget();
  const settings = anthropicSettingsTranslation(source, cc);
  const decoded = messagesConversationToIr(source, cc, budget, settings.body.model as string);
  const parsed = withDirectMessagesConversation(
    parseRequest(settings.body),
    decoded,
    modelId => messagesConversationToIr(source, cc, budget, modelId),
  );
  return { parsed, replay: [...decoded.nativeReasoningReplay] };
}

const SIGNED = encodeReasoningEnvelope({ txt: "hidden reasoning" });
const NATIVE_OWN = encodeReasoningEnvelope({ nat: { enc: "native-blob-a", model: MODEL, tag: "tag-a", id: "rs_native_a" } });
const NATIVE_OTHER = encodeReasoningEnvelope({ nat: { enc: "native-blob-b", model: "other-model", tag: "tag-b" } });
const KIRO = encodeReasoningEnvelope({ krc: "kiro-blob" });

const CORPUS: Record<string, { body: Body; cc?: OcxClaudeCodeConfig }> = {
  "a single user string": {
    body: { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "hello" }] },
  },
  "system blocks, the billing line, identity naming and a mid-conversation system turn": {
    body: {
      model: MODEL,
      system: [
        { type: "text", text: `x-anthropic-billing-header: cc_version=1; cch=abc;\n${IDENTITY}` },
        { type: "text", text: "second block" },
      ],
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "system", content: [{ type: "text", text: IDENTITY }, { type: "text", text: "reminder" }] },
        { role: "system", content: "" },
        { role: "user", content: "u2" },
      ],
    },
  },
  "user media: text, images, an empty reference, documents of every source": {
    body: {
      model: MODEL,
      system: "plain system",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } },
          { type: "image", source: { type: "base64", data: PNG } },
          { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
          { type: "image", source: { type: "url", url: "" } },
          { type: "image", source: { type: "unknown" } },
          { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: PDF } },
          { type: "document", source: { type: "base64", data: PDF } },
          { type: "document", title: "remote", source: { type: "url", url: "https://example.com/a.pdf" } },
          { type: "document", source: { type: "text", data: "inline" } },
          { type: "unknown_block" },
        ],
      }],
    },
  },
  "a user turn of a lone empty-reference image": {
    body: { model: MODEL, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "" } }] }] },
  },
  "tool calls and every tool_result shape": {
    body: {
      model: MODEL,
      tools: [{ name: "lookup", description: "find", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [
          { type: "text", text: "Looking." },
          { type: "text", text: "" },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "a" } },
          { type: "tool_use", id: "toolu_2", name: "lookup", input: "not an object" },
          { type: "tool_use", id: "toolu_3", name: "lookup" },
          { type: "tool_use", id: "toolu_4", name: "unknown_tool", input: {} },
          { type: "tool_use", id: "toolu_5", name: "lookup", input: { nested: { deep: [1, 2] } } },
          { type: "tool_use", id: "toolu_6", name: "lookup", input: {} },
          { type: "tool_use", id: "toolu_7", name: "lookup", input: {} },
        ] },
        { role: "user", content: [
          { type: "text", text: "before results" },
          { type: "tool_result", tool_use_id: "toolu_1", content: "plain" },
          { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "boom" },
          { type: "tool_result", tool_use_id: "toolu_3", content: [
            { type: "text", text: "see" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
            { type: "document", title: "out.pdf", source: { type: "base64", data: PDF } },
          ] },
          { type: "tool_result", tool_use_id: "toolu_4", is_error: true, content: [] },
          { type: "tool_result", tool_use_id: "toolu_5", content: [
            { type: "text", text: "loaded" },
            { type: "tool_reference", tool_name: "Alpha" },
            { type: "tool_reference", tool_name: "Beta" },
            { type: "tool_reference", tool_name: "" },
          ] },
          { type: "tool_result", tool_use_id: "toolu_6", content: [{ type: "image", source: { type: "url", url: "" } }, { type: "text", text: "t" }] },
          { type: "tool_result", tool_use_id: "toolu_7" },
          { type: "text", text: "after results" },
        ] },
      ],
    },
  },
  "thinking: plain signatures, unsigned folding, redacted, hidden text and replay preservation": {
    body: {
      model: MODEL,
      thinking: { type: "enabled", budget_tokens: 8000 },
      messages: [
        { role: "user", content: "think" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "first unsigned", signature: "" },
          { type: "thinking", thinking: "second unsigned" },
          { type: "redacted_thinking", data: "opaque-redacted" },
          { type: "redacted_thinking", data: "" },
          { type: "thinking", thinking: "signed", signature: "gemini-thought-signature" },
          { type: "thinking", thinking: "", signature: "" },
          { type: "tool_use", id: "toolu_t", name: "act", input: {} },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t", content: "done" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "", signature: SIGNED }, { type: "text", text: "answer" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "dangling signed", signature: "sig-only" }] },
        { role: "user", content: "next" },
        { role: "assistant", content: [{ type: "thinking", thinking: "dangling unsigned" }] },
        { role: "user", content: "and again" },
      ],
    },
  },
  "native reasoning envelopes for this model and another, and a Kiro blob": {
    body: {
      model: MODEL,
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "own native", signature: NATIVE_OWN },
          { type: "thinking", thinking: "", signature: NATIVE_OWN },
          { type: "thinking", thinking: "other native", signature: NATIVE_OTHER },
          { type: "thinking", thinking: "", signature: NATIVE_OTHER },
          { type: "text", text: "a" },
        ] },
        { role: "assistant", content: [{ type: "thinking", thinking: "", signature: KIRO }] },
        { role: "user", content: "q2" },
      ],
    },
  },
  "reasoning after its call joins the call's turn": {
    body: {
      model: MODEL,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_late", name: "f", input: {} }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "late", signature: "late-sig" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_late", content: "r" }] },
      ],
    },
  },
  "blocked skill bundles are elided in results and in text": {
    body: {
      model: MODEL,
      messages: [
        { role: "user", content: "use the skill" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "claude-api" } }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_skill", content: "Launching skill: claude-api" },
          { type: "text", text: SKILL_BUNDLE },
        ] },
      ],
    },
  },
  "stabilizePromptCache relocates the footer and appends the notice": {
    cc: { stabilizePromptCache: true } as OcxClaudeCodeConfig,
    body: {
      model: MODEL,
      system: `Base prompt\n<total_tokens>1200 tokens left</total_tokens>\n${NUDGE}\n`,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig-before-notice" }] },
      ],
    },
  },
  "stabilizePromptCache with nothing to relocate": {
    cc: { stabilizePromptCache: true } as OcxClaudeCodeConfig,
    body: { model: MODEL, system: "steady", messages: [{ role: "user", content: "hi" }] },
  },
  "the tool catalog: strictness, callers, schemas, duplicates and dropped server tools": {
    body: {
      model: MODEL,
      tools: [
        { name: "strict_tool", description: "s", strict: true, input_schema: { type: "object", properties: {} } },
        { name: "callers", input_schema: { properties: { a: { type: "number" } } }, allowed_callers: ["direct", 3, "code_execution"] },
        { name: "strict_tool", description: "duplicate is dropped", input_schema: { type: "object" } },
        { type: "bash_20250124", name: "bash" },
        { type: "text_editor_20250124", name: "str_replace_editor" },
        { name: "no_schema" },
        { name: "", input_schema: { type: "object" } },
        "not a tool",
      ],
      tool_choice: { type: "tool", name: "strict_tool", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: "pick" }],
    },
  },
  "settings ride the Responses body unchanged": {
    body: {
      model: MODEL,
      stream: true,
      max_tokens: 512,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 5,
      stop_sequences: ["END", 3],
      metadata: { user_id: `{"device_id":"${"d".repeat(80)}","session_id":"s"}` },
      output_config: { effort: "high" },
      thinking: { type: "adaptive", display: "omitted" },
      tool_choice: { type: "any" },
      tools: [{ name: "t", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "fmt" }],
    },
  },
  "thinking disabled and a short user id": {
    body: { model: MODEL, thinking: { type: "disabled" }, metadata: { user_id: "short" }, tool_choice: { type: "none" }, messages: [{ role: "user", content: "x" }] },
  },
  "only a system prompt and an empty user turn": {
    body: { model: MODEL, system: "just instructions", messages: [{ role: "user", content: "" }] },
  },
  "tool parameters with an own __proto__ key": {
    body: JSON.parse(
      `{"model":"${MODEL}","messages":[{"role":"user","content":"x"}],`
      + `"tools":[{"name":"p","input_schema":{"type":"object","__proto__":{"x":1},"properties":{}}},`
      + `{"name":"q","input_schema":{"__proto__":{"y":2}}}]}`,
    ) as Body,
  },
};

describe("Messages -> IR direct decode parity with the Responses bridge", () => {
  for (const [name, { body, cc }] of Object.entries(CORPUS)) {
    test(name, () => {
      const direct = viaDirect(body, cc);
      const bridge = viaBridge(body, cc);
      expect(comparable(direct.parsed)).toEqual(comparable(bridge.parsed));
      expect(direct.replay).toEqual(bridge.replay);
    });
  }

  test("the corpus reaches the cases it names", () => {
    const thinking = viaDirect(CORPUS["thinking: plain signatures, unsigned folding, redacted, hidden text and replay preservation"]!.body);
    const parts = thinking.parsed.context.messages.flatMap(message => message.role === "assistant" ? message.content : []);
    expect(parts.some(part => part.type === "thinking" && part.signature === "gemini-thought-signature")).toBe(true);
    expect(parts.some(part => part.type === "thinking" && part.redacted?.[0] === "opaque-redacted")).toBe(true);
    const native = viaDirect(CORPUS["native reasoning envelopes for this model and another, and a Kiro blob"]!.body);
    expect(native.replay).toEqual([["native-blob-a", "tag-a"]]);
    const skill = viaDirect(CORPUS["blocked skill bundles are elided in results and in text"]!.body);
    expect(JSON.stringify(skill.parsed.context)).toContain("elided for routed models");
    const stabilized = viaDirect(CORPUS["stabilizePromptCache relocates the footer and appends the notice"]!.body, { stabilizePromptCache: true } as OcxClaudeCodeConfig);
    expect(stabilized.parsed.context.systemPrompt).toEqual(["Base prompt"]);
    expect(stabilized.parsed.context.messages.at(-1)).toMatchObject({ role: "user", content: NUDGE });
  });

  test("the settings-only body is the bridge body without its conversation", () => {
    for (const { body, cc } of Object.values(CORPUS)) {
      const { input: _input, instructions: _instructions, tools: _tools, ...settings } = anthropicToResponsesTranslation(clone(body), cc).body;
      const direct = anthropicSettingsTranslation(clone(body), cc);
      expect(direct.body).toEqual({ ...settings, input: [] });
      expect(direct.cacheKeySource).toBe(anthropicToResponsesTranslation(clone(body), cc).cacheKeySource);
    }
  });

  test("routing evidence matches what the core reads from the bridge body", () => {
    for (const { body, cc } of Object.values(CORPUS)) {
      expect(messagesRouteEvidence(clone(body))).toEqual(evidenceFromBody(anthropicToResponsesTranslation(clone(body), cc).body));
    }
  });

  test("a model the core settled differently is decoded again for that model", () => {
    const body = CORPUS["system blocks, the billing line, identity naming and a mid-conversation system turn"]!.body;
    const budget = createTranslatorBudget();
    const decoded = messagesConversationToIr(clone(body), undefined, budget, MODEL);
    const renamed = { ...clone(body), model: "google-antigravity/other-model" };
    const base = parseRequest(anthropicSettingsTranslation(renamed).body);
    const parsed = withDirectMessagesConversation(base, decoded, modelId => messagesConversationToIr(renamed, undefined, budget, modelId));
    expect(comparable(parsed)).toEqual(comparable(viaBridge(renamed).parsed));
  });

  test("the decoder does not hand the caller's tool schema to the IR by reference", () => {
    const body = clone(CORPUS["tool calls and every tool_result shape"]!.body);
    const decoded = messagesConversationToIr(body, undefined, createTranslatorBudget(), MODEL);
    decoded.context.tools![0]!.parameters.mutated = true;
    expect(((body.tools as Body[])[0]!.input_schema as Body).mutated).toBeUndefined();
  });
});

describe("Messages -> IR direct decode refuses what the bridge refuses", () => {
  const INVALID: Record<string, Body> = {
    "a message that is not an object": { model: MODEL, messages: ["hi"] },
    "an unsupported role": { model: MODEL, messages: [{ role: "tool", content: "x" }] },
    "a tool_result without an id": { model: MODEL, messages: [{ role: "user", content: [{ type: "tool_result", content: "x" }] }] },
    "a tool_use without a name": { model: MODEL, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t" }] }] },
    "a file-backed image": { model: MODEL, messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "f" } }] }] },
    "a file-backed image in a tool result": { model: MODEL, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "file", file_id: "f" } }] }] }] },
    "a malformed proxy envelope": { model: MODEL, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "ocxr1:not-base64-json" }] }] },
    "a proxy envelope carrying an Anthropic signature": {
      model: MODEL,
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: encodeReasoningEnvelope({ sig: "s" }) }] }],
    },
    "no messages": { model: MODEL, messages: [] },
    "no model": { messages: [{ role: "user", content: "x" }] },
  };
  for (const [name, body] of Object.entries(INVALID)) {
    test(name, () => {
      let bridgeMessage: string | undefined;
      try { anthropicToResponsesTranslation(clone(body)); } catch (err) { bridgeMessage = (err as Error).message; }
      expect(bridgeMessage).toBeDefined();
      expect(() => messagesConversationToIr(clone(body), undefined, createTranslatorBudget(), MODEL)).toThrow(bridgeMessage!);
    });
  }
});

describe("feature effects on the Messages direct path", () => {
  test("every Messages feature meets the same disposition as on the bridge path", () => {
    const direct = featureEffectsForPath("messages", requestPathForLane("messages", "direct", "other"), PROTOCOL_FEATURES);
    const bridge = featureEffectsForPath("messages", requestPathForLane("messages", "bridge", "other"), PROTOCOL_FEATURES);
    expect(direct).toEqual(bridge);
  });
});


describe("an abandoned direct plan hands its translator budget back", () => {
  const config = {
    port: 0,
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "google",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        authMode: "oauth",
        googleMode: "cloud-code-assist",
        project: "fixture-project",
        models: ["gemini-3.8-flash"],
      },
    },
  } as OcxConfig;
  const charged = (signature: string): Body => ({
    model: MODEL,
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "t", signature: "plain-signature-".repeat(64) },
        { type: "thinking", thinking: "t", signature },
      ] },
      { role: "user", content: "x" },
    ],
  });

  test("a malformed envelope the bridge retries leaves the budget as it found it", () => {
    const budget = createTranslatorBudget();
    const before = budget.snapshot().currentBytes;
    expect(planMessagesAntigravityDirect(clone(charged("ocxr1:not-base64-json")), undefined, config, budget)).toBeUndefined();
    expect(budget.snapshot().currentBytes).toBe(before);
  });

  test("a plan the ingress leaves releases what its decode retained", () => {
    const budget = createTranslatorBudget();
    const before = budget.snapshot().currentBytes;
    const plan = planMessagesAntigravityDirect(clone(charged("second-signature")), undefined, config, budget);
    expect(plan).toBeDefined();
    expect(budget.snapshot().currentBytes).toBeGreaterThan(before);
    plan!.releaseDecodeCharges();
    expect(budget.snapshot().currentBytes).toBe(before);
  });
});
