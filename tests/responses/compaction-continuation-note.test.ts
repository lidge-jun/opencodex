/**
 * Issue #6764: after routed compaction the decoded `ocx1` checkpoint reaches the model as plain
 * user text next to the retained earlier request. Both routes add a system-level continuation
 * note so a request the checkpoint reports as completed is not picked again over the active task.
 * A compaction request is a summarizer turn and must not receive the note.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { CHECKPOINT_CONTINUATION_NOTE, SUMMARY_PREFIX, appendCheckpointContinuationNote, encodeCompactionSummary } from "../../src/responses/compaction";
import { parseRequest } from "../../src/responses/parser";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const checkpoint = { type: "compaction", encrypted_content: encodeCompactionSummary("A done; B active") };
const oldRequest = { type: "message", role: "user", content: "check example.txt" };
const NATIVE_BLOB = "gAAAAB-native-opaque-blob";

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

describe("checkpoint continuation note (#6764)", () => {
  test("translated route adds the note to the system prompt after a decoded checkpoint", () => {
    const parsed = parseRequest({ model: "anthropic/claude-sonnet-4-6", instructions: "Be brief.", input: [oldRequest, checkpoint] });
    expect(parsed.context.systemPrompt?.at(-1)).toBe(CHECKPOINT_CONTINUATION_NOTE);
    expect(parsed.context.systemPrompt?.[0]).toContain("Be brief.");
    // The checkpoint text itself is unchanged, so v1 recovery that matches SUMMARY_PREFIX still works.
    expect(parsed.context.messages[1]?.content).toBe(`${SUMMARY_PREFIX}\n\nA done; B active`);
  });

  test("translated route leaves requests without a decoded checkpoint alone", () => {
    for (const input of [
      [oldRequest],
      [oldRequest, { type: "compaction", encrypted_content: NATIVE_BLOB }],
      [oldRequest, { type: "context_compaction" }],
    ]) {
      expect(parseRequest({ model: "m", input }).context.systemPrompt ?? []).toEqual([]);
    }
  });

  test("a compaction request is a summarizer turn and gets no note", () => {
    const parsed = parseRequest({ model: "m", input: [oldRequest, checkpoint, { type: "compaction_trigger" }] });
    expect(parsed._compactionRequest).toBe(true);
    expect(parsed.context.systemPrompt ?? []).toEqual([]);
  });

  test("passthrough appends the note to instructions once and lowers the checkpoint", () => {
    const body = forwardedBody({ instructions: "Be brief.", input: [oldRequest, checkpoint] });
    expect(body.instructions).toBe(`Be brief.\n\n${CHECKPOINT_CONTINUATION_NOTE}`);
    expect((body.input as Record<string, unknown>[])[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\nA done; B active` }],
    });
    expect(forwardedBody({ input: [oldRequest, checkpoint] }).instructions).toBe(CHECKPOINT_CONTINUATION_NOTE);
    expect(appendCheckpointContinuationNote(body.instructions)).toBe(body.instructions as string);
  });

  test("passthrough keeps instructions untouched without a decoded checkpoint", () => {
    expect(forwardedBody({ instructions: "Be brief.", input: [oldRequest] }).instructions).toBe("Be brief.");
    expect(forwardedBody({ instructions: "Be brief.", input: [oldRequest, { type: "compaction", encrypted_content: NATIVE_BLOB }] }).instructions)
      .toBe("Be brief.");
    expect("instructions" in forwardedBody({ input: [oldRequest] })).toBe(false);
  });

  test("passthrough compaction request keeps its summarizer instructions", () => {
    const body = forwardedBody(
      { instructions: "Be brief.", input: [oldRequest, checkpoint, { type: "compaction_trigger" }] },
      { _compactionRequest: true },
    );
    expect(body.instructions).toBe("Be brief.");
  });
});
