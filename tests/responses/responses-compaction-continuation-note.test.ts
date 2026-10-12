/**
 * Issue #6764: after routed compaction the decoded `ocx1` checkpoint reaches the model as plain
 * user text next to the retained earlier request. Both routes add a system-level continuation
 * note and close the most recent checkpoint with an end marker, so a request the checkpoint
 * reports as completed is not picked again over the active task.
 *
 * These are prompt-contract and wire-construction tests. They do not establish how a model
 * behaves; that was measured separately against live Claude models. A compaction request is a
 * summarizer turn and must not receive the note or the marker.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import {
  CHECKPOINT_CONTINUATION_NOTE,
  CHECKPOINT_END_MARKER,
  SUMMARY_PREFIX,
  appendCheckpointContinuationNote,
  encodeCompactionSummary,
} from "../../src/responses/compaction";
import { parseRequest } from "../../src/responses/parser";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const checkpoint = { type: "compaction", encrypted_content: encodeCompactionSummary("A done; B active") };
const olderCheckpoint = { type: "compaction", encrypted_content: encodeCompactionSummary("older state") };
const oldRequest = { type: "message", role: "user", content: "check example.txt" };
const NATIVE_BLOB = "gAAAAB-native-opaque-blob";
const CHECKPOINT_TEXT = `${SUMMARY_PREFIX}\n\nA done; B active`;

const provider = { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1", authMode: "key" as const, apiKey: "xai-test" };

function forwardedBody(rawBody: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const request = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider)).buildRequest({
    modelId: "grok-4.6",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: "grok-4.6", store: false, ...rawBody },
    ...extra,
  }, { headers: new Headers({ authorization: "Bearer token" }) });
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("checkpoint continuation note contract (#6764)", () => {
  // Prompt-contract assertions: the wording keeps the authorization limits and the later-user priority.
  test("the note limits continuation to authorized work and keeps permission gates", () => {
    expect(CHECKPOINT_CONTINUATION_NOTE).toContain("already authorized and still in scope");
    expect(CHECKPOINT_CONTINUATION_NOTE).toContain("do not grant new authority");
    expect(CHECKPOINT_CONTINUATION_NOTE).toContain("keep existing permission and confirmation gates");
    expect(CHECKPOINT_CONTINUATION_NOTE).toContain("a decision or approval is still pending");
    expect(CHECKPOINT_CONTINUATION_NOTE).toContain("pauses, cancels or replaces the task, follow it");
    expect(CHECKPOINT_END_MARKER).not.toContain("authorized");
  });
});

describe("checkpoint continuation on the translated route (#6764)", () => {
  test("adds the note and ends only the most recent checkpoint with the marker", () => {
    const parsed = parseRequest({
      model: "anthropic/claude-sonnet-4-6",
      instructions: "Be brief.",
      input: [oldRequest, olderCheckpoint, checkpoint],
    });
    expect(parsed.context.systemPrompt?.at(-1)).toBe(CHECKPOINT_CONTINUATION_NOTE);
    expect(parsed.context.systemPrompt?.[0]).toContain("Be brief.");
    const [, older, latest] = parsed.context.messages;
    expect(older?.content).toBe(`${SUMMARY_PREFIX}\n\nolder state`);
    expect(latest?.content).toBe(CHECKPOINT_TEXT + CHECKPOINT_END_MARKER);
    // SUMMARY_PREFIX stays the exact start of the text, as the v1 recovery paths require.
    expect(String(latest?.content).startsWith(SUMMARY_PREFIX + "\n")).toBe(true);
  });

  test("leaves requests without a decoded checkpoint alone", () => {
    for (const input of [
      [oldRequest],
      [oldRequest, { type: "compaction", encrypted_content: NATIVE_BLOB }],
      [oldRequest, { type: "context_compaction" }],
    ]) {
      expect(parseRequest({ model: "m", input }).context.systemPrompt ?? []).toEqual([]);
    }
  });

  test("a compaction request is a summarizer turn: no note, no marker", () => {
    const parsed = parseRequest({ model: "m", input: [oldRequest, checkpoint, { type: "compaction_trigger" }] });
    expect(parsed._compactionRequest).toBe(true);
    expect(parsed.context.systemPrompt ?? []).toEqual([]);
    expect(parsed.context.messages[1]?.content).toBe(CHECKPOINT_TEXT);
  });

  test("openai-chat sends the existing instructions, the note and the marked checkpoint", () => {
    const parsed = parseRequest({ model: "m", instructions: "Be brief.", input: [oldRequest, checkpoint] });
    const request = withTestTranslatorBudget(createOpenAIChatAdapter({
      adapter: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      authMode: "key",
      apiKey: "k",
    })).buildRequest({ ...parsed, modelId: "m" }, { headers: new Headers() });
    const messages = (JSON.parse(request.body) as { messages: { role: string; content: unknown }[] }).messages;
    const system = messages.filter(m => m.role === "system" || m.role === "developer").map(m => JSON.stringify(m.content)).join("\n");
    expect(system).toContain("Be brief.");
    expect(system).toContain("This conversation was compacted automatically.");
    expect(JSON.stringify(messages.at(-1)?.content)).toContain("[End of checkpoint.");
  });

  test("anthropic sends the existing instructions, the note and the marked checkpoint", async () => {
    const parsed = parseRequest({ model: "m", instructions: "Be brief.", input: [oldRequest, checkpoint] });
    const request = await withTestTranslatorBudget(createAnthropicAdapter({
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "key",
      apiKey: "k",
    })).buildRequest({ ...parsed, modelId: "claude-sonnet-4-6" }, { headers: new Headers() });
    const body = JSON.parse(request.body) as { system: unknown; messages: { content: unknown }[] };
    const system = JSON.stringify(body.system);
    expect(system).toContain("Be brief.");
    expect(system).toContain("This conversation was compacted automatically.");
    expect(JSON.stringify(body.messages.at(-1)?.content)).toContain("[End of checkpoint.");
  });
});

describe("checkpoint continuation on Responses passthrough (#6764)", () => {
  test("appends the note once and marks only the most recent checkpoint", () => {
    const body = forwardedBody({ instructions: "Be brief.", input: [oldRequest, olderCheckpoint, checkpoint] });
    expect(body.instructions).toBe(`Be brief.\n\n${CHECKPOINT_CONTINUATION_NOTE}`);
    const input = body.input as { content: { text: string }[] }[];
    expect(input[1]?.content[0]?.text).toBe(`${SUMMARY_PREFIX}\n\nolder state`);
    expect(input[2]?.content[0]?.text).toBe(CHECKPOINT_TEXT + CHECKPOINT_END_MARKER);
    expect(forwardedBody({ input: [oldRequest, checkpoint] }).instructions).toBe(CHECKPOINT_CONTINUATION_NOTE);
    expect(appendCheckpointContinuationNote(body.instructions)).toBe(body.instructions as string);
  });

  test("keeps instructions and input untouched without a decoded checkpoint", () => {
    expect(forwardedBody({ instructions: "Be brief.", input: [oldRequest] }).instructions).toBe("Be brief.");
    const native = forwardedBody({ instructions: "Be brief.", input: [oldRequest, { type: "compaction", encrypted_content: NATIVE_BLOB }] });
    expect(native.instructions).toBe("Be brief.");
    expect(JSON.stringify(native.input)).not.toContain("[End of checkpoint.");
    expect("instructions" in forwardedBody({ input: [oldRequest] })).toBe(false);
  });

  test("a compaction request keeps its summarizer instructions and an unmarked checkpoint", () => {
    const body = forwardedBody(
      { instructions: "Be brief.", input: [oldRequest, checkpoint, { type: "compaction_trigger" }] },
      { _compactionRequest: true },
    );
    expect(body.instructions).toBe("Be brief.");
    expect(JSON.stringify(body.input)).not.toContain("[End of checkpoint.");
  });
});
