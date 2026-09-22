import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CURSOR_EXTERNAL_ROOT_BYTE_LIMIT, CURSOR_INVOCATION_ARGUMENTS_BYTE_LIMIT, encodeCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";
import { handleCursorNativeKv, storeCursorBlob } from "../../../src/adapters/cursor/native-exec";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationStateStructureSchema,
  ConversationTurnStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import type { OcxMessage } from "../../../src/types";

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  if (reply.message.case !== "kvClientMessage" || reply.message.value.message.case !== "getBlobResult") {
    throw new Error("expected getBlobResult");
  }
  return reply.message.value.message.value.blobData!;
}

function runRequest(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  return msg.message.case === "runRequest" ? msg.message.value : undefined;
}

/** Model-visible text of every root prompt blob, in wire order. */
function rootTexts(bytes: Uint8Array): string[] {
  return (runRequest(bytes)?.conversationState?.rootPromptMessagesJson ?? []).map(blobId => {
    const parsed = JSON.parse(new TextDecoder().decode(blobData(blobId))) as {
      content?: string | [{ text?: string }];
    };
    const content = parsed.content;
    if (typeof content === "string") return content;
    return content?.[0]?.text ?? "";
  });
}

/** Assistant text of every conversation-turn step, in wire order. */
function turnStepTexts(bytes: Uint8Array): string[] {
  const texts: string[] = [];
  for (const turnId of runRequest(bytes)?.conversationState?.turns ?? []) {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
    if (turn.turn.case !== "agentConversationTurn") continue;
    for (const stepId of turn.turn.value.steps) {
      const step = fromBinary(ConversationStepSchema, blobData(stepId));
      if (step.message.case === "assistantMessage") texts.push(step.message.value.text);
    }
  }
  return texts;
}

const CALL_ID = "call_echo_1";

function history(options: { resultCallId?: string } = {}): OcxMessage[] {
  return [
    { role: "user", content: "Run echo AAA.", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will run echo AAA." },
        { type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo AAA" } },
      ],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: options.resultCallId ?? CALL_ID,
      toolName: "exec_command",
      content: "AAA",
      isError: false,
      timestamp: 3,
    },
  ];
}

function encode(messages: OcxMessage[], modelId: string): Uint8Array {
  return encodeCursorRunRequest({
    modelId,
    conversationId: "c_pairing",
    system: [],
    messages: [],
    rawMessages: messages,
  });
}

/**
 * The checkpoint continuation path. `suffixStart` is how many leading messages the checkpoint
 * already covers, so only `rawMessages.slice(suffixStart)` is replayed onto the root prompt.
 *
 * The checkpoint must carry at least one root: an EMPTY ConversationStateStructure serializes to
 * zero bytes, which the encoder reads as "no checkpoint" and silently downgrades to full replay —
 * so a test seeded with an empty state would pass while exercising the wrong branch entirely.
 */
function encodeCheckpoint(messages: OcxMessage[], modelId: string, suffixStart: number): Uint8Array {
  // Stored for real so the decoder helper can read every root back, checkpoint-carried included.
  const seedRoot = storeCursorBlob(new TextEncoder().encode(JSON.stringify({
    role: "user",
    content: [{ type: "text", text: "covered by checkpoint" }],
  })));
  return encodeCursorRunRequest({
    modelId,
    conversationId: "c_pairing_ckpt",
    system: [],
    messages: [],
    rawMessages: messages,
    checkpointBytes: toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [seedRoot],
    })),
    continuationMode: "checkpoint",
    checkpointSuffixStart: suffixStart,
  });
}

function resultRoot(bytes: Uint8Array): string | undefined {
  return rootTexts(bytes).find(text => text.startsWith("[Tool Result]") || text.startsWith("[Tool Error]"));
}

/**
 * devlog 260829: a replayed tool result used to carry no record of the invocation that produced it,
 * so the model saw a `call_id` referring to nothing it could see. Live cursor/grok-4.6 turns then
 * re-ran commands that had already succeeded (exit 0) and narrated a phantom "was interrupted".
 *
 * The invocation is named INSIDE the result envelope rather than as a separate "[Tool Call]" entry:
 * the 363-B guard in cursor-tool-continuation.test.ts shows a standalone call marker gets
 * few-shot-mimicked, after which the model emits later tool calls as inert text. These assertions
 * decode the real wire payload, since roots are what Cursor builds the model prompt from.
 */
describe("cursor replayed tool results name their invocation", () => {
  test("the result envelope names the tool and arguments that produced it", () => {
    const root = resultRoot(encode(history(), "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain(`call_id: ${CALL_ID}`);
    expect(root).toContain("invoked: exec_command with");
    expect(root).toContain("echo AAA");
  });

  test("no standalone [Tool Call] entry is ever emitted (363-B mimicry guard)", () => {
    for (const modelId of ["grok-4.6-high", "composer-2.5", "composer-2.5-fast"]) {
      const bytes = encode(history(), modelId);
      expect(rootTexts(bytes).some(text => text.includes("[Tool Call]"))).toBe(false);
      expect(turnStepTexts(bytes).some(text => text.includes("[Tool Call]"))).toBe(false);
    }
  });

  test("the invocation line also reaches the conversation-turn step", () => {
    const step = turnStepTexts(encode(history(), "grok-4.6-high"))
      .find(text => text.startsWith("[Tool Result]"));
    expect(step).toBeDefined();
    expect(step).toContain("invoked: exec_command with");
  });

  // composer-2.5 (non-fast) is a NATIVE wire model that still routes through the external
  // tool-continuation path (discovery.ts cursorNeedsExternalToolContinuation), so it echoes results
  // into root as text and needs the invocation named too. Gating on `externalModel` would have
  // skipped exactly this model (audit 001 F2).
  test("composer-2.5 root replay names the invocation too", () => {
    const root = resultRoot(encode(history(), "composer-2.5"));
    expect(root).toBeDefined();
    expect(root).toContain("invoked: exec_command with");
  });

  test("a result whose call id matches nothing is still replayed, without an invocation line", () => {
    const root = resultRoot(encode(history({ resultCallId: "call_other" }), "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain("call_id: call_other");
    expect(root).not.toContain("invoked:");
  });

  test("native composer replay keeps results off the root prompt entirely", () => {
    const bytes = encode(history(), "composer-2.5-fast");
    expect(rootTexts(bytes).some(text => text.startsWith("[Tool Result]"))).toBe(false);
    expect(rootTexts(bytes).some(text => text.includes("invoked:"))).toBe(false);
  });

  // A reused call id must not let a LATER command describe an EARLIER result: a confidently wrong
  // invocation line is worse than none, because nothing downstream can detect the mislabel.
  test("a call id claimed by two different invocations yields no invocation line", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "Run both.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo FIRST" } }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "FIRST", isError: false, timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo SECOND" } }],
        timestamp: 4,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "SECOND", isError: false, timestamp: 5 },
    ];
    const roots = rootTexts(encode(messages, "grok-4.6-high"));
    const results = roots.filter(text => text.startsWith("[Tool Result]"));
    expect(results.length).toBeGreaterThan(0);
    // Neither result may claim an invocation, and in particular none may name the wrong command.
    for (const result of results) expect(result).not.toContain("invoked:");
  });

  test("a call id repeated for the SAME invocation still names it", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "Run it twice.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo AAA" } }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "AAA", isError: false, timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo AAA" } }],
        timestamp: 4,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "AAA", isError: false, timestamp: 5 },
    ];
    const root = resultRoot(encode(messages, "grok-4.6-high"));
    expect(root).toContain("invoked: exec_command with");
  });

  test("unserializable arguments do not break request encoding", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const messages: OcxMessage[] = [
      { role: "user", content: "Run it.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: cyclic }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "ok", isError: false, timestamp: 3 },
    ];
    const root = resultRoot(encode(messages, "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain("[unserializable arguments]");
  });

  // REVIEW BLOCKER PROBE 1: a large legitimate argument must not push the actual output out of the
  // root byte budget. The invocation line is a convenience; the RESULT is the payload.
  test("PROBE a huge argument must not evict the result output from root replay", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "Write the file.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "write_file", arguments: { contents: "Z".repeat(600 * 1024) } }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "write_file", content: "SENTINEL_OUTPUT", isError: false, timestamp: 3 },
    ];
    const root = resultRoot(encode(messages, "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain("SENTINEL_OUTPUT");
  });

  // The cap is a budget for the RENDERED line, so the truncation marker must come out of it rather
  // than be appended on top of a full-size prefix.
  test("the truncated invocation line stays within the declared argument budget", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "Write the file.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "write_file", arguments: { contents: "Z".repeat(600 * 1024) } }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "write_file", content: "SENTINEL_OUTPUT", isError: false, timestamp: 3 },
    ];
    const root = resultRoot(encode(messages, "grok-4.6-high"));
    const line = root?.split("\n").find(text => text.startsWith("invoked: "));
    expect(line).toBeDefined();
    expect(line).toContain("…[arguments truncated]");
    const rendered = line!.slice("invoked: write_file with ".length);
    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(CURSOR_INVOCATION_ARGUMENTS_BYTE_LIMIT);
  });

  // REVIEW BLOCKER PROBE 2: namespace is part of tool identity. Two different tools sharing one
  // decoded id must be ambiguous, not silently labelled with the first namespace.
  test("PROBE namespaced collision must not name the wrong tool", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "Read both.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, namespace: "one", name: "read", arguments: { p: "a" } }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolNamespace: "one", toolName: "read", content: "A", isError: false, timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, namespace: "two", name: "read", arguments: { p: "a" } }],
        timestamp: 4,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolNamespace: "two", toolName: "read", content: "B", isError: false, timestamp: 5 },
    ];
    const roots = rootTexts(encode(messages, "grok-4.6-high"));
    const results = roots.filter(text => text.startsWith("[Tool Result]"));
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result).not.toContain("invoked:");
  });

  // REVIEW BLOCKER PROBE 3: distinct unserializable arguments both render as the same marker, so
  // the ambiguity check treats two different calls as identical and keeps the first. Same tool name
  // on both calls, so ONLY the argument comparison can distinguish them.
  test("PROBE distinct unserializable arguments must be treated as ambiguous", () => {
    const a: Record<string, unknown> = { tag: "A" };
    a.self = a;
    const b: Record<string, unknown> = { tag: "B" };
    b.self = b;
    const messages: OcxMessage[] = [
      { role: "user", content: "Run both.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: a }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "A", isError: false, timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: b }],
        timestamp: 4,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "B", isError: false, timestamp: 5 },
    ];
    const roots = rootTexts(encode(messages, "grok-4.6-high"));
    const results = roots.filter(text => text.startsWith("[Tool Result]"));
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result).not.toContain("invoked:");
  });
});

/**
 * The live regression that survived the first fix. Once the invocation line shipped, the defect
 * still reproduced against merged `dev`: 12 duplicate command_execution items and 5 phantom
 * "interrupted" mentions. The passing runs had used full replay; the failing run used CHECKPOINT
 * continuation for 13 of its 14 requests.
 *
 * The checkpoint path replays only `rawMessages.slice(suffixStart)`, and it indexed calls from that
 * SAME slice. When the cut fell between an assistant tool call and its result — the normal case,
 * since the checkpoint is committed right after the call — the call sat before the cut and the index
 * was empty, so the result went out orphaned again. The fix indexes from the full history while
 * still replaying only the suffix.
 */
describe("cursor checkpoint continuation names the invocation from covered history", () => {
  test("a result whose call is BEFORE the checkpoint cut still names its invocation", () => {
    // suffixStart 2 puts the assistant tool call (index 1) inside the covered checkpoint and leaves
    // the suffix as just the tool result.
    const root = resultRoot(encodeCheckpoint(history(), "grok-4.6-high", 2));
    expect(root).toBeDefined();
    expect(root).toContain(`call_id: ${CALL_ID}`);
    expect(root).toContain("invoked: exec_command with");
    expect(root).toContain("echo AAA");
  });

  // The turn path needs the same full-history index. A turn only opens on a user message, so a
  // result-only suffix produces no turns at all (verified: turns=0) and cannot cover this; the
  // shape that does is a suffix carrying a later user message plus the result of a covered call.
  test("the invocation line also reaches the checkpoint suffix turn step", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "Run echo AAA.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo AAA" } }],
        timestamp: 2,
      },
      { role: "user", content: "and note this", timestamp: 3 },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "AAA", isError: false, timestamp: 4 },
    ];
    const step = turnStepTexts(encodeCheckpoint(messages, "grok-4.6-high", 2))
      .find(text => text.startsWith("[Tool Result]"));
    expect(step).toBeDefined();
    expect(step).toContain("invoked: exec_command with");
    expect(step).toContain("echo AAA");
  });

  // Naming a covered call must not drag the covered MESSAGES back into the replay: the checkpoint
  // already carries them, and re-appending them is the double-replay this path exists to avoid.
  test("covered history is not replayed a second time", () => {
    const roots = rootTexts(encodeCheckpoint(history(), "grok-4.6-high", 2));
    expect(roots.some(text => text.includes("Run echo AAA."))).toBe(false);
    expect(roots.some(text => text.includes("I will run echo AAA."))).toBe(false);
  });

  // Ambiguity resolution must also read the full history: a call id reused before the cut cannot be
  // labelled from the suffix alone, so a suffix-only index would confidently name the wrong command.
  test("an id reused in covered history yields no invocation line", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "Run both.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo FIRST" } }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "FIRST", isError: false, timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo SECOND" } }],
        timestamp: 4,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "SECOND", isError: false, timestamp: 5 },
    ];
    const root = resultRoot(encodeCheckpoint(messages, "grok-4.6-high", 4));
    expect(root).toBeDefined();
    expect(root).not.toContain("invoked:");
  });

  test("native composer keeps checkpoint results off the root prompt", () => {
    const roots = rootTexts(encodeCheckpoint(history(), "composer-2.5-fast", 2));
    expect(roots.some(text => text.startsWith("[Tool Result]"))).toBe(false);
    expect(roots.some(text => text.includes("invoked:"))).toBe(false);
  });

  /**
   * An EMPTY `knownCalls` map is a decided answer — "the full history contains no call that can be
   * named" — not a missing one, so it must be preserved rather than treated as absent.
   *
   * `toolCallsByCallId` deliberately DROPS an id that two different invocations claim. Here both
   * claims sit before the cut, so the full-history index rejects the id and returns nothing for it,
   * while the suffix alone sees only the second call. Falling back on an empty map (`size > 0`
   * instead of `??`) makes the result confidently claim `echo SECOND` when it actually came from
   * `echo FIRST` — a wrong label nothing downstream can detect, which is worse than no label.
   */
  test("an ambiguous id resolved from full history is not re-resolved from the suffix", () => {
    const messages: OcxMessage[] = [
      { role: "user", content: "Run both.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo FIRST" } }],
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo SECOND" } }],
        timestamp: 3,
      },
      { role: "user", content: "keep going", timestamp: 4 },
      // The result belongs to the FIRST invocation.
      { role: "toolResult", toolCallId: CALL_ID, toolName: "exec_command", content: "FIRST", isError: false, timestamp: 5 },
    ];
    // The cut leaves the second call inside the suffix, so a suffix-only index would find exactly
    // one unambiguous-looking candidate: the wrong one.
    const root = resultRoot(encodeCheckpoint(messages, "grok-4.6-high", 2));
    expect(root).toBeDefined();
    expect(root).not.toContain("invoked:");
    expect(root).not.toContain("echo SECOND");
  });
});

/**
 * devlog 260829 060: the index that names an invocation had no ordering constraint, so it would name a
 * call that runs LATER in history than the result being labelled. Measured on the shipped tree, a
 * result whose own output was `EARLY-OUT` came out as
 * `invoked: exec_command with {"cmd":"echo LATER"}` — the mislabel the index's own comment calls worse
 * than no label, because nothing downstream can detect it.
 *
 * The bound compares positions in FULL-HISTORY space. That matters because two call sites replay less
 * than the whole history: the checkpoint path replays a suffix, and the turn builder starts at
 * `historyMessageStart`. The comparison position is therefore `knownCallsOffset + start + local`, and
 * dropping any term passes almost every test here — which is why the last case exists.
 */
describe("cursor invocation lookup is bounded by history position", () => {
  const FWD = "call_fwd";

  /** Result at index 1; the call claiming its id is at index 3. */
  function forwardHistory(): OcxMessage[] {
    return [
      { role: "user", content: "start", timestamp: 1 },
      { role: "toolResult", toolCallId: FWD, toolName: "exec_command", content: "EARLY-OUT", isError: false, timestamp: 2 },
      { role: "user", content: "next", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: FWD, name: "exec_command", arguments: { cmd: "echo LATER" } }],
        timestamp: 4,
      },
      { role: "user", content: "answer", timestamp: 5 },
    ];
  }

  test("a result whose call appears LATER in history gets no invocation line", () => {
    const root = resultRoot(encode(forwardHistory(), "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain("EARLY-OUT");
    expect(root).not.toContain("invoked:");
    expect(root).not.toContain("echo LATER");
  });

  test("the turn step is bounded too", () => {
    const step = turnStepTexts(encode(forwardHistory(), "grok-4.6-high"))
      .find(text => text.startsWith("[Tool Result]"));
    if (step) {
      expect(step).not.toContain("invoked:");
      expect(step).not.toContain("echo LATER");
    }
  });

  // The bound must not become a blanket refusal: without this, a lookup that returns nothing at all
  // would satisfy the case above and look correct.
  test("the ordinary call-then-result order is still named", () => {
    const root = resultRoot(encode(history(), "grok-4.6-high"));
    expect(root).toContain("invoked: exec_command with");
    expect(root).toContain("echo AAA");
  });

  test("a call before the checkpoint cut is still named on the root path", () => {
    const root = resultRoot(encodeCheckpoint(history(), "grok-4.6-high", 2));
    expect(root).toContain("invoked: exec_command with");
  });

  /**
   * The one case that needs all THREE offset terms. Audits r5, r6 and r7 each measured that a bound
   * computing `knownCallsOffset + local` — dropping `historyMessageStart` — passes every other
   * assertion in this file and the whole cursor suite, while emitting a live orphan here.
   *
   * It cannot be caught on the root path: `historyMessageStart` is an OUTPUT of `rootPromptMessages`,
   * assigned after the loop that would use it, so that loop always walks full-history `i` from zero and
   * the dropped term is identically zero there. Only `conversationTurns` carries a non-zero `start`.
   *
   * Both offsets must actually be non-zero for the case to bite, so the history forces a checkpoint cut
   * AND enough root pressure to prune, and the assertion is on the TURN step.
   */
  test("checkpoint plus root pruning still names the call on the turn path", () => {
    const CK = "call_ck3";
    // CURSOR_EXTERNAL_ROOT_BYTE_LIMIT is 512 KiB; this must exceed it to force any pruning, so
    // historyMessageStart lands above zero. A 400 KiB message left it at 0 and made the case toothless.
    const bulky = "Z".repeat(600 * 1024);
    const messages: OcxMessage[] = [
      { role: "user", content: "first", timestamp: 1 },
      // Pruned from the root, which is what pushes historyMessageStart above zero.
      { role: "user", content: bulky, timestamp: 2 },
      { role: "user", content: "carry on", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CK, name: "exec_command", arguments: { cmd: "echo COVERED" } }],
        timestamp: 4,
      },
      { role: "toolResult", toolCallId: CK, toolName: "exec_command", content: "COVERED-OUT", isError: false, timestamp: 5 },
      { role: "user", content: "answer", timestamp: 6 },
    ];
    // Derived rather than guessed: dropping `start` under-counts a walked message's position by
    // exactly `start`, so it flips the decision only when the call is INSIDE the slice and
    // (w_result - w_call) <= start. The call must therefore sit next to its result in the replayed
    // region, not in the covered region — three earlier fixtures put it in the covered region, where
    // the call's position is below the offset and the under-count can never cross it.
    const bytes = encodeCheckpoint(messages, "grok-4.6-high", 1);
    // Assert on the TURN step specifically. Pooling roots and turn steps together hid the mutation:
    // the root path has no historyMessageStart term to drop (it is an OUTPUT of rootPromptMessages,
    // assigned after the loop that would use it), so the root keeps naming the call and an
    // either-source assertion stays green. Only the turn step discriminates.
    const step = turnStepTexts(bytes).find(text => text.includes("COVERED-OUT"));
    expect(step).toBeDefined();
    expect(step).toContain("invoked: exec_command with");
    expect(step).toContain("echo COVERED");
  });
});

/**
 * #4516: the 2 KiB invocation-argument cap is charged while the envelope is still being built, so
 * it cost a call 2 KiB even when nearly the whole 512 KiB envelope went unused. A 4.6 KiB
 * successful write_file lost its argument tail inside a 6 KiB replay, and because the result text
 * does not repeat the argument, the model could no longer see what it had just written.
 *
 * The cap stays — it is what stops a 600 KiB argument from evicting the output it describes — but a
 * second pass now refunds leftover aggregate bytes to clipped invocation lines, newest result
 * first, without evicting or shrinking any root. These tests pin the refund: full restoration when
 * the envelope is idle, a no-op below the cap, coverage of the native composer-2.5 path the gate
 * exists for, verbatim handling of String.replace patterns inside arguments, and a hard stop at
 * the envelope boundary.
 *
 * One thing to know about the two 600 KiB tests above ("PROBE a huge argument must not evict the
 * result output from root replay" and "the truncated invocation line stays within the declared
 * argument budget"): the refund leaves them alone because restoring a 600 KiB argument costs more
 * than the whole envelope, so `cost > spare` is always true there. That is a size-dependent skip,
 * not a rule that the line stays clipped — an argument over the cap but well under the envelope IS
 * restored, which is the entire point of this block. Anyone shrinking those fixtures to speed them
 * up would silently convert them into tests of the refund instead of tests of the cap.
 */
describe("cursor spare envelope budget restores clipped invocation arguments", () => {
  function writeFileHistory(args: Record<string, unknown>): OcxMessage[] {
    return [
      { role: "user", content: "Write the file.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "write_file", arguments: args }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "write_file", content: "SENTINEL_OUTPUT", isError: false, timestamp: 3 },
    ];
  }

  function invokedLine(root: string | undefined): string | undefined {
    return root?.split("\n").find(text => text.startsWith("invoked: "));
  }

  test("an oversized argument is restored in full when the envelope is idle", () => {
    const args = { contents: "A".repeat(4600) };
    const root = resultRoot(encode(writeFileHistory(args), "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain("SENTINEL_OUTPUT");
    const line = invokedLine(root);
    expect(line).toBeDefined();
    expect(line).not.toContain("…[arguments truncated]");
    expect(line).toContain(JSON.stringify(args));
  });

  test("an impossible restoration serializes its arguments only once in the refund pass", () => {
    let serializations = 0;
    const args = {
      toJSON() {
        serializations++;
        return { contents: "A".repeat(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT + 1) };
      },
    };
    // The refund pass must not allocate a full-size byte buffer while deciding whether the
    // restoration fits. encode() calls with a string longer than the envelope mean someone
    // reintroduced the unbounded fullBytes measurement this change removed.
    let oversizedEncodes = 0;
    const originalEncode = TextEncoder.prototype.encode;
    TextEncoder.prototype.encode = function (input?: string) {
      if (typeof input === "string" && input.length > CURSOR_EXTERNAL_ROOT_BYTE_LIMIT) oversizedEncodes++;
      return originalEncode.call(this, input);
    };
    let line: string | undefined;
    try {
      line = invokedLine(resultRoot(encode(writeFileHistory(args), "grok-4.6-high")));
    } finally {
      TextEncoder.prototype.encode = originalEncode;
    }
    expect(line).toEndWith("…[arguments truncated]");
    // Indexing and initial rendering account for three calls; the refund pass adds exactly one and
    // must reuse that serialization instead of calling the rendering helper for a fifth copy.
    expect(serializations).toBe(4);
    expect(oversizedEncodes).toBe(0);
  });

  // The refund pass must be a no-op below the cap: a line that was never clipped has nothing to
  // restore, and rewriting it would only risk drift from the admission-time rendering.
  test("an under-cap argument is unchanged", () => {
    const args = { contents: "A".repeat(64) };
    const root = resultRoot(encode(writeFileHistory(args), "grok-4.6-high"));
    expect(invokedLine(root)).toBe("invoked: write_file with " + JSON.stringify(args));
  });

  // composer-2.5 is a NATIVE wire model (isCursorExternalWireModel is false) that still routes
  // through the external tool-continuation path, so it echoes results into roots and accumulates
  // the same clipped lines. This is the case the echoToolResultInRoot gate exists for: a gate
  // written as externalModel would leave the one native model with clipped lines capped.
  test("native composer-2.5 root replay is restored too", () => {
    const args = { contents: "A".repeat(4600) };
    const root = resultRoot(encode(writeFileHistory(args), "composer-2.5"));
    expect(root).toBeDefined();
    const line = invokedLine(root);
    expect(line).toBeDefined();
    expect(line).not.toContain("…[arguments truncated]");
    expect(line).toContain(JSON.stringify(args));
  });

  // Serialized arguments routinely contain $&, $', $` and $1. The widening must use the callback
  // form of String.prototype.replace: the string form expands those sequences into the surrounding
  // match and writes corrupted arguments into the root.
  test("replacement patterns inside arguments are not expanded", () => {
    const args = { contents: "$&$'`$1" + "B".repeat(4600) };
    const root = resultRoot(encode(writeFileHistory(args), "grok-4.6-high"));
    expect(invokedLine(root)).toContain(JSON.stringify(args));
  });

  // The refund is bounded by the envelope's own leftover bytes, newest result first: when the spare
  // cannot cover every clipped line, the pass must stop mid-set rather than overrun the limit, and
  // the result the model most likely still needs — the one it just produced — is restored first.
  test("restoration stops at the envelope and prefers the newest result", () => {
    const messages: OcxMessage[] = [];
    for (let n = 0; n < 60; n++) {
      messages.push(
        { role: "user", content: "round " + n, timestamp: n * 3 + 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_" + n, name: "write_file", arguments: { path: "/f" + n, contents: "C".repeat(16 * 1024) } }],
          timestamp: n * 3 + 2,
        },
        { role: "toolResult", toolCallId: "call_" + n, toolName: "write_file", content: "OUT_" + n, isError: false, timestamp: n * 3 + 3 },
      );
    }
    const bytes = encode(messages, "grok-4.6-high");
    const blobIds = runRequest(bytes)?.conversationState?.rootPromptMessagesJson ?? [];
    const total = blobIds.reduce((sum, blobId) => sum + blobData(blobId).byteLength, 0);
    expect(total).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);

    const results = rootTexts(bytes).filter(text => text.startsWith("[Tool Result]"));
    const newest = results.find(text => text.includes("OUT_59"));
    expect(newest).toBeDefined();
    expect(invokedLine(newest)).toBeDefined();
    expect(invokedLine(newest)).not.toContain("…[arguments truncated]");
    const stillClipped = results.filter(text => invokedLine(text)?.includes("…[arguments truncated]"));
    expect(stillClipped.length).toBeGreaterThan(0);
  });

  // An adversarial counter-read of this change found the real defect here: pushDeduped built the
  // collapsed root's wire payload from the marked text but stored the UNMARKED text in `entry.text`,
  // so anything that rebuilt a root from `text` silently deleted the "produced N times in a row"
  // note — the restoration pass below, and truncation before it. That note is the repetition
  // breaker's per-entry half, so losing it re-primes the self-reinforcing loop the breaker exists to
  // end. Restoring the arguments and keeping the note are both required.
  test("a collapsed repeat run keeps its run note while its arguments are restored", () => {
    const args = { contents: "A".repeat(4600) };
    const messages: OcxMessage[] = [
      { role: "user", content: "Write the file.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "write_file", arguments: args }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "write_file", content: "SAME_OUTPUT", isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "write_file", content: "SAME_OUTPUT", isError: false, timestamp: 4 },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "write_file", content: "SAME_OUTPUT", isError: false, timestamp: 5 },
    ];
    const results = rootTexts(encode(messages, "grok-4.6-high")).filter(text => text.startsWith("[Tool Result]"));
    expect(results).toHaveLength(1);
    const collapsed = results[0]!;
    expect(collapsed).toContain("[note: this exact output was produced 3 times in a row]");
    const line = invokedLine(collapsed);
    expect(line).not.toContain("…[arguments truncated]");
    expect(line).toContain(JSON.stringify(args));
  });

  // The boundary case the 4,600-byte fixture cannot see: an argument only ~70 bytes over the cap.
  // An off-by-one in the cost arithmetic (`cost > spare` vs `>=`) or in the newline-anchored
  // clipped-line search is invisible when thousands of spare bytes surround the decision — it only
  // shows up when the clip is a handful of bytes and the widened line must match exactly.
  test("a just-over-cap argument is preserved complete", () => {
    const args = { contents: "A".repeat(2100) };
    const root = resultRoot(encode(writeFileHistory(args), "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).toContain("SENTINEL_OUTPUT");
    expect(root).not.toContain("…[arguments truncated]");
    expect(invokedLine(root)).toBe("invoked: write_file with " + JSON.stringify(args));
  });

  // Two claims, and they are not equally general — worth saying plainly, because the weaker one
  // reads like the stronger one.
  //
  // No result may be evicted to pay for a wider invocation line. That is a real invariant of the
  // pass, which only ever replaces a root with a widened copy of itself, so all sixty outputs must
  // survive regardless of sizes.
  //
  // The contiguous-suffix claim is weaker. The pass walks newest-first but skips an unaffordable
  // line with a continue rather than a break, so with UNEVEN costs a cheaper older line can still
  // be filled in after a dearer newer one was passed over — non-contiguously, and legitimately.
  // This fixture gives every round the same argument size, so the costs are uniform and the
  // restored set has to be the newest contiguous suffix. What that buys is a direction check: flip
  // the walk to oldest-first and the restored set becomes a PREFIX, which this assertion catches
  // (verified by mutation). Do not read it as a guarantee of contiguity under mixed sizes, and do
  // not vary the argument size in this fixture without replacing the assertion.
  test("restoration never evicts an older result and stops at a contiguous boundary", () => {
    const messages: OcxMessage[] = [];
    for (let n = 0; n < 60; n++) {
      messages.push(
        { role: "user", content: "round " + n, timestamp: n * 3 + 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_" + n, name: "write_file", arguments: { path: "/f" + n, contents: "C".repeat(16 * 1024) } }],
          timestamp: n * 3 + 2,
        },
        { role: "toolResult", toolCallId: "call_" + n, toolName: "write_file", content: "OUT_" + n, isError: false, timestamp: n * 3 + 3 },
      );
    }
    // Wire order, oldest to newest — the order the model reads them, and the order the suffix
    // property is stated in.
    const results = rootTexts(encode(messages, "grok-4.6-high")).filter(text => text.startsWith("[Tool Result]"));
    for (let n = 0; n < 60; n++) {
      expect(results.some(text => text.includes("OUT_" + n))).toBe(true);
    }
    const clipped = results.map(text => invokedLine(text)?.includes("…[arguments truncated]") === true);
    // Exactly one clipped -> restored transition, and never the reverse: under uniform costs a
    // newest-first walk can only produce clipped-then-restored in wire order.
    let transitions = 0;
    for (let i = 1; i < clipped.length; i++) {
      if (clipped[i - 1] === true && clipped[i] === false) transitions++;
      expect(clipped[i - 1] === false && clipped[i] === true).toBe(false);
    }
    expect(transitions).toBe(1);
    // Both sides non-empty: an all-restored or all-clipped run would make the boundary assertion
    // vacuous.
    expect(clipped.some(Boolean)).toBe(true);
    expect(clipped.every(Boolean)).toBe(false);
  });

  // On the checkpoint path only the result is replayed — its call sits inside the covered prefix,
  // so the pass resolves it with callBefore(replayedCalls, callId, knownCallsOffset + messageIndex).
  // Drop the knownCallsOffset term and callBefore compares a full-history call position against a
  // slice-local index, returns undefined for the covered call, and the line stays clipped. Only a
  // checkpoint fixture catches that: on the full-replay path the term is identically zero.
  test("a checkpoint-covered call keeps its argument tail in the suffix", () => {
    const args = { contents: "A".repeat(2100) };
    const messages: OcxMessage[] = [
      { role: "user", content: "Write the file.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: CALL_ID, name: "write_file", arguments: args }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: CALL_ID, toolName: "write_file", content: "SENTINEL_OUTPUT", isError: false, timestamp: 3 },
    ];
    const root = resultRoot(encodeCheckpoint(messages, "grok-4.6-high", 2));
    expect(root).toBeDefined();
    const line = invokedLine(root);
    expect(line).toBeDefined();
    expect(line).not.toContain("…[arguments truncated]");
    expect(line).toContain(JSON.stringify(args));
  });

  // "한" is three UTF-8 bytes, so 700 of them put the 2 KiB cap boundary inside a character. When
  // the spare budget cannot cover the whole line, truncateUtf8 walks back to a character boundary —
  // a naive byte slice would leave U+FFFD in the stored text. The equality half alone would not say
  // WHICH failure occurred, so the replacement character is asserted absent explicitly. Here the
  // envelope is idle and the full argument survives the round trip intact.
  test("a multi-byte argument survives the round trip intact", () => {
    const args = { contents: "한".repeat(700) };
    const root = resultRoot(encode(writeFileHistory(args), "grok-4.6-high"));
    expect(root).toBeDefined();
    expect(root).not.toContain("\uFFFD");
    expect(invokedLine(root)).toContain(JSON.stringify(args));
  });

  // The outputElided skip, pinned at a configuration the test finds for itself. The guard is load
  // bearing, and an earlier pass at this very test asserted the opposite — that elision always cuts
  // the invocation line too, so the guard could never decide anything. A sweep of single-result
  // fixtures agreed, and it was wrong: it never landed in the share window where the claim fails.
  //
  // The reachable route is not truncation on its own. A truncated root undershoots its own budget by
  // about 28 bytes, nowhere near a restoration's cost. What pays is initiator recovery: a ~519.7 KiB
  // system prompt leaves roughly 4.6 KiB of history budget, the equal-share pass cuts each of two
  // trailing results to ~2.3 KiB — far enough to lose "output:" but not the clipped invocation line —
  // and recovery then drops the older elided sibling so the user turn fits. Those freed bytes become
  // spare, and the surviving elided root holds a clipped line the pass could now afford.
  //
  // That window is only ~24 bytes wide, so it moves when any envelope header changes length: pinning
  // one literal system size made this test pass on a two-character call id and fail on a twelve-
  // character one. It therefore searches for the window instead, and fails loudly if no size in the
  // range produces one — which is the signal that the route closed and the guard needs re-examining,
  // not a licence to delete the assertion.
  //
  // Remove the outputElided term from the pass's guard and the located root comes back widened, with
  // the full 3,000-byte argument in a root that shows the model no output at all. Verified by
  // mutation.
  test("the skip refuses to widen an elided root even when spare would pay", () => {
    const args = { contents: "A".repeat(3000) };
    const full = JSON.stringify(args);
    const probe = (systemBytes: number) => {
      const messages: OcxMessage[] = [
        { role: "user", content: "U".repeat(200), timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c0", name: "write_file", arguments: args }],
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "c0", toolName: "write_file", content: "OUT_0_" + "Y".repeat(20000), isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "write_file", arguments: args }],
          timestamp: 4,
        },
        { role: "toolResult", toolCallId: "c1", toolName: "write_file", content: "OUT_1_" + "Y".repeat(20000), isError: false, timestamp: 5 },
      ];
      const bytes = encodeCursorRunRequest({
        modelId: "grok-4.6-high",
        conversationId: "c_elide_" + systemBytes,
        system: ["S".repeat(systemBytes)],
        messages: [],
        rawMessages: messages,
      });
      const root = resultRoot(bytes);
      const blobIds = runRequest(bytes)?.conversationState?.rootPromptMessagesJson ?? [];
      const used = blobIds.reduce((sum, blobId) => sum + blobData(blobId).byteLength, 0);
      return { root, spare: CURSOR_EXTERNAL_ROOT_BYTE_LIMIT - used };
    };
    // The window: "output:" gone, but the clipped invocation line still whole, and enough envelope
    // left over to have paid the ~968-byte widening. That last term is what makes this a test of the
    // skip rather than of the budget.
    let located: { root: string | undefined; spare: number } | undefined;
    for (let systemBytes = 519600; systemBytes <= 519800 && !located; systemBytes += 2) {
      const candidate = probe(systemBytes);
      if (candidate.root === undefined) continue;
      if (candidate.root.includes("\noutput:\n")) continue;
      if (invokedLine(candidate.root)?.endsWith("…[arguments truncated]") !== true) continue;
      if (candidate.spare <= 1024) continue;
      located = candidate;
    }
    expect(located).toBeDefined();
    // The pass declined to widen it, even though the bytes were there.
    expect(located!.root).not.toContain(full);
  });
});
