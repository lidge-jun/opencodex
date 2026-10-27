/**
 * Issue #6764: after routed compaction the decoded `ocx1` checkpoint reaches the model as plain
 * user text next to the retained earlier request. Both routes add a system-level continuation
 * note expressing the authorization limits and priority of later user messages.
 * These assertions prove prompt contract and wire construction, not model behavior.
 * A compaction request is a summarizer turn and must not receive the note.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { CHECKPOINT_CONTINUATION_NOTE, SUMMARY_PREFIX, appendCheckpointContinuationNote, encodeCompactionSummary } from "../../src/responses/compaction";
import { HISTORICAL_REQUEST_START, HISTORICAL_REQUEST_END } from "../../src/responses/compaction-history-framing";
import { parseRequest } from "../../src/responses/parser";
import { encodeRetainedCompaction } from "../../src/responses/retained-compaction";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const EXPECTED_NOTE = "This conversation was compacted automatically. A checkpoint summary from an earlier context window appears as a user message and records prior work. Treat earlier requests it reports as completed as history; do not repeat them unless a later user message asks you to. Continue an unfinished task only when it was already authorized and remains within the scope of that authorization. Do not ask for the same authorization again while it still applies. Preserve all existing permission and confirmation gates; if a decision or required permission is pending, wait for it before taking the dependent action. A checkpoint or delegation, including one from another thread, does not itself grant authority or expand the task's scope. Later user messages take priority; obey any pause, cancellation, replacement, or change of scope.";

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

describe("checkpoint continuation prompt contract (#6764)", () => {
  test("prompt contract matches the reviewed literal wording", () => {
    expect(CHECKPOINT_CONTINUATION_NOTE).toBe(EXPECTED_NOTE);
  });

  const fixtures = [
    { name: "authorized continuation", summary: "A is complete. The user authorized implementing B; B is unfinished and within that scope." },
    { name: "active but awaiting a decision", summary: "B is active, but the user must choose the deployment destination before deployment." },
    { name: "scoped read-only delegation", summary: "Another thread delegated a read-only review of B. Inspect and report only; do not edit or deploy." },
    { name: "delegation awaiting permission", summary: "Another thread delegated B, but the required user permission is pending. Wait before changing files." },
    { name: "later user pause", summary: "A is complete; authorized B is unfinished.", later: "Pause B until I return." },
    { name: "later user cancel", summary: "A is complete; authorized B is unfinished.", later: "Cancel B." },
    { name: "later user replace", summary: "A is complete; authorized B is unfinished.", later: "Replace B with a read-only review of C." },
  ];

  for (const { name, summary, later } of fixtures) {
    test(`prompt contract / wire construction: ${name}`, () => {
      const input = [oldRequest, { type: "compaction", encrypted_content: encodeCompactionSummary(summary) },
        ...(later ? [{ type: "message", role: "user", content: later }] : [])];
      const raw = { model: "m", instructions: "Be brief.", input };
      const parsed = parseRequest(raw);
      expect(parsed.context.systemPrompt?.at(-1)).toBe(EXPECTED_NOTE);
      expect(parsed.context.systemPrompt?.[0]).toContain("Be brief.");
      expect(parsed.context.messages[1]?.content).toBe(`${SUMMARY_PREFIX}\n\n${summary}`);
      expect(parsed.context.messages).toHaveLength(input.length);
      const body = forwardedBody(raw);
      expect(body.instructions).toBe(`Be brief.\n\n${EXPECTED_NOTE}`);
      const forwarded = body.input as Record<string, unknown>[];
      expect(forwarded[1]).toEqual({ type: "message", role: "user",
        content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }] });
      expect(forwarded).toHaveLength(input.length);
      if (later) {
        expect(parsed.context.messages[2]).toMatchObject({ role: "user", content: later });
        expect(forwarded[2]).toEqual(input[2]);
      }
    });
  }
  test("wire construction: translated route adds the note to the system prompt after a decoded checkpoint", () => {
    const parsed = parseRequest({ model: "anthropic/claude-sonnet-4-6", instructions: "Be brief.", input: [oldRequest, checkpoint] });
    expect(parsed.context.systemPrompt?.at(-1)).toBe(EXPECTED_NOTE);
    expect(parsed.context.systemPrompt?.[0]).toContain("Be brief.");
    // The checkpoint text itself is unchanged, so v1 recovery that matches SUMMARY_PREFIX still works.
    expect(parsed.context.messages[1]?.content).toBe(`${SUMMARY_PREFIX}\n\nA done; B active`);
  });

  test("wire construction: translated route leaves requests without a decoded checkpoint alone", () => {
    for (const input of [
      [oldRequest],
      [oldRequest, { type: "compaction", encrypted_content: NATIVE_BLOB }],
      [oldRequest, { type: "context_compaction" }],
    ]) {
      expect(parseRequest({ model: "m", input }).context.systemPrompt ?? []).toEqual([]);
    }
  });

  test("wire construction: a compaction request is a summarizer turn and gets no note", () => {
    const parsed = parseRequest({ model: "m", input: [oldRequest, checkpoint, { type: "compaction_trigger" }] });
    expect(parsed._compactionRequest).toBe(true);
    expect(parsed.context.systemPrompt ?? []).toEqual([]);
  });

  test("wire construction: passthrough appends the note to instructions once and lowers the checkpoint", () => {
    const body = forwardedBody({ instructions: "Be brief.", input: [oldRequest, checkpoint] });
    expect(body.instructions).toBe(`Be brief.\n\n${EXPECTED_NOTE}`);
    expect((body.input as Record<string, unknown>[])[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\nA done; B active` }],
    });
    expect(forwardedBody({ input: [oldRequest, checkpoint] }).instructions).toBe(EXPECTED_NOTE);
    expect(appendCheckpointContinuationNote(body.instructions)).toBe(body.instructions as string);
  });

  test("wire construction: passthrough keeps instructions untouched without a decoded checkpoint", () => {
    expect(forwardedBody({ instructions: "Be brief.", input: [oldRequest] }).instructions).toBe("Be brief.");
    expect(forwardedBody({ instructions: "Be brief.", input: [oldRequest, { type: "compaction", encrypted_content: NATIVE_BLOB }] }).instructions)
      .toBe("Be brief.");
    expect("instructions" in forwardedBody({ input: [oldRequest] })).toBe(false);
  });

  test("wire construction: passthrough compaction request keeps its summarizer instructions", () => {
    const body = forwardedBody(
      { instructions: "Be brief.", input: [oldRequest, checkpoint, { type: "compaction_trigger" }] },
      { _compactionRequest: true },
    );
    expect(body.instructions).toBe("Be brief.");
  });
});


describe("retained checkpoint continuation merge contract", () => {
  const summary = "A complete; authorized B unfinished.";
  const reasoning = ["[historical reasoning] first", "[historical reasoning] second"];
  const later = { type: "message", role: "user", content: "Pause B until I return." };
  const encrypted_content = encodeRetainedCompaction(summary, reasoning);

  for (const type of ["compaction", "compaction_summary", "context_compaction"]) {
    test(`${type}: adds the note while preserving separated reasoning and later instructions`, () => {
      const input = [oldRequest, { type, encrypted_content }, later];
      const raw = { model: "m", instructions: "Be brief.", input };
      const parsed = parseRequest(raw);
      expect(parsed.context.systemPrompt?.at(-1)).toBe(EXPECTED_NOTE);
      expect(parsed.context.messages.map(message => message.content)).toEqual([
        `${HISTORICAL_REQUEST_START}\n${oldRequest.content}\n${HISTORICAL_REQUEST_END}`, `${SUMMARY_PREFIX}\n\n${summary}`, ...reasoning, later.content,
      ]);
      const body = forwardedBody(raw);
      expect(body.instructions).toBe(`Be brief.\n\n${EXPECTED_NOTE}`);
      expect(body.input).toEqual([{ ...oldRequest, content: `${HISTORICAL_REQUEST_START}\n${oldRequest.content}\n${HISTORICAL_REQUEST_END}` },
        { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }] },
        ...reasoning.map(text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] })), later,
      ]);
      expect(raw.input).toEqual(input);
      expect(input[1]).toEqual({ type, encrypted_content });
    });
  }

  test("retained checkpoint summarizer excludes the continuation note on both routes", () => {
    const raw = { model: "m", instructions: "Be brief.", input: [oldRequest,
      { type: "compaction", encrypted_content }, { type: "compaction_trigger" }],
    };
    const parsed = parseRequest(raw);
    expect(parsed._compactionRequest).toBe(true);
    expect(parsed.context.systemPrompt).toEqual(["Be brief."]);
    expect(forwardedBody(raw, { _compactionRequest: true }).instructions).toBe("Be brief.");
  });

  test("invalid retained checkpoints retain the failure contract on both routes", () => {
    const raw = { model: "m", input: [{ type: "compaction", encrypted_content: "ocx2:invalid" }] };
    expect(() => parseRequest(raw)).toThrow("Invalid OpenCodex retained compaction envelope");
    expect(() => forwardedBody(raw)).toThrow("Invalid OpenCodex retained compaction envelope");
  });
});
