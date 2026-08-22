import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import {
  AgentClientMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import type { OcxMessage } from "../src/types";

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  if (reply.message.case !== "kvClientMessage") throw new Error("not kv");
  const kv = reply.message.value;
  if (kv.message.case !== "getBlobResult") throw new Error("not blob result");
  return kv.message.value.blobData;
}

function decodeRoots(bytes: Uint8Array): unknown[] {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const roots = run?.conversationState?.rootPromptMessagesJson ?? [];
  return roots.map(id => JSON.parse(new TextDecoder().decode(blobData(id))));
}

describe("363-B: tool result reaches the model via rootPromptMessagesJson", () => {
  const rawMessages: OcxMessage[] = [
    { role: "user", content: "read a file", timestamp: 1 },
    {
      role: "assistant",
      model: "cursor/auto",
      timestamp: 2,
      content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
    },
    { role: "toolResult", toolCallId: "call_1", toolName: "read_file", toolNamespace: "mcp__fs", content: "FILE CONTENTS HERE", isError: false, timestamp: 3 },
  ];

  test("external-continuation tool result text is present in rootPromptMessagesJson, not only in turns[]", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: mcp__fs__read_file\nis_error: false\noutput:\nFILE CONTENTS HERE" }],
      rawMessages,
    });
    const roots = decodeRoots(bytes);
    const serialized = JSON.stringify(roots);
    // composer-2.5 still continues as userMessageAction, so the model prompt must carry the
    // tool result. Reference: danger-pi buildRootPromptMessagesJson.
    expect(serialized).toContain("FILE CONTENTS HERE");
    expect(serialized).toContain("call_1");
    // The prior user turn must also be replayed (not system-only).
    expect(serialized).toContain("read a file");
  });

  test("native resume models keep tool results on turns[], not as assistant-role root text", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "auto-intelligence",
      conversationId: "c-auto",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: mcp__fs__read_file\nis_error: false\noutput:\nFILE CONTENTS HERE" }],
      rawMessages,
    });
    const serialized = JSON.stringify(decodeRoots(bytes));
    expect(serialized).toContain("read a file");
    expect(serialized).not.toContain("[Tool Result]");
    expect(serialized).not.toContain("[tool_result]");
    expect(serialized).not.toContain("FILE CONTENTS HERE");
  });

  test("rootPromptMessagesJson still leads with the system prompt blob", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "x" }],
      rawMessages,
    });
    const roots = decodeRoots(bytes) as Array<{ role: string }>;
    expect(roots[0]?.role).toBe("system");
  });

  test("assistant tool CALL is NOT replayed as [Tool Call] text (model-prompt leak guard)", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: mcp__fs__read_file\nis_error: false\noutput:\nFILE CONTENTS HERE" }],
      rawMessages,
    });
    const serialized = JSON.stringify(decodeRoots(bytes));
    // Regression: a prior assistant tool call MUST NOT leak into the model-visible prompt as literal
    // "[Tool Call]" text. The model few-shot-mimics that marker and emits later parallel/mixed tool
    // calls as inert text instead of real tool frames (halting multi-tool continuations).
    expect(serialized).not.toContain("[Tool Call]");
    // composer-2.5 still needs the paired tool RESULT echo in the model-visible prompt.
    expect(serialized).toContain("FILE CONTENTS HERE");
    expect(serialized).toContain("call_1");
  });

  test("native resume models do not few-shot [Tool Result] as assistant chat", () => {
    const bytes = encodeCursorRunRequest({
      modelId: "composer-2.5-fast",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_1\nname: mcp__fs__read_file\nis_error: false\noutput:\nFILE CONTENTS HERE" }],
      rawMessages,
    });
    const serialized = JSON.stringify(decodeRoots(bytes));
    expect(serialized).not.toContain("[Tool Call]");
    expect(serialized).not.toContain("[Tool Result]");
    expect(serialized).not.toContain("[tool_result]");
    expect(serialized).toContain("read a file");
  });
});

import { create as createPb } from "@bufbuild/protobuf";
import { ExecServerMessageSchema, McpArgsSchema } from "../src/adapters/cursor/gen/agent_pb";
import { createCursorContextUsageTracker, createCursorProtobufEventState } from "../src/adapters/cursor/protobuf-events";
import { planMcpArgsHandling, finalizeAfterDrain } from "../src/adapters/cursor/live-transport";

function execMcpArgs(opts: { provider?: string; toolName?: string; toolCallId?: string; args?: Record<string, Uint8Array> }) {
  return createPb(ExecServerMessageSchema, {
    id: 7,
    execId: "exec-test",
    message: {
      case: "mcpArgs",
      value: createPb(McpArgsSchema, {
        name: opts.toolName ?? "mcp__fs__read_file",
        toolName: opts.toolName ?? "mcp__fs__read_file",
        toolCallId: opts.toolCallId ?? "call_1",
        providerIdentifier: opts.provider ?? "opencodex-responses",
        ...(opts.args ? { args: opts.args } : {}),
      }),
    },
  });
}

describe("363-A: turn-1 termination for Responses client tool via exec mcpArgs", () => {
  test("Responses client mcpArgs surfaces the tool call then emits a terminal done (no stall, no native fallthrough)", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"] });
    const plan = planMcpArgsHandling(execMcpArgs({ args: { path: new TextEncoder().encode(JSON.stringify("a.txt")) } }), state);

    // The Responses provider OWNS this exec: it must NOT fall through to native MCP exec (which would
    // send Cursor a bogus "bridge suspension not implemented" mcpResult error).
    expect(plan.handledByResponsesBridge).toBe(true);
    // It surfaces the tool call to Codex...
    const types = plan.events.map(e => e.type);
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_end");
    // ...but it must NOT synchronously end turn 1. A sibling client tool call may still be announced
    // in a LATER receive chunk (toolCallStarted after this exec); finalizing now would truncate it.
    // Instead the plan flags finalize-when-drained and the transport arms a revocable grace timer.
    expect(types).not.toContain("done");
    expect(types).not.toContain("error");
    expect(plan.cancelCursorRun).toBe(false);
    expect(plan.finalizeWhenDrained).toBe(true);
    expect(plan.writeMcpResult).toBeUndefined();
    // When the grace window elapses with the call set still drained, finalize emits exactly one done.
    const finalized = finalizeAfterDrain(state);
    expect(finalized.map(e => e.type)).toEqual(["done"]);
  });

  test("unified Desktop exec is surfaced as a Responses client tool instead of native-exec fallback", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["exec"] });
    const plan = planMcpArgsHandling(execMcpArgs({
      toolName: "exec",
      toolCallId: "call_exec",
      args: { cmd: new TextEncoder().encode(JSON.stringify("pwd")) },
    }), state);

    expect(plan.handledByResponsesBridge).toBe(true);
    expect(plan.events).toEqual([
      { type: "tool_call_start", id: "call_exec", name: "exec" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "tool_call_end", id: "call_exec" },
    ]);
    expect(plan.writeMcpResult).toBeUndefined();
    expect(plan.finalizeWhenDrained).toBe(true);
  });

  test("no-checkpoint client-tool finalize carries forward the last known active context usage", () => {
    const tracker = createCursorContextUsageTracker();
    tracker.record("cursor_conv_1", 183_336);
    const state = createCursorProtobufEventState({
      clientToolNames: ["mcp__fs__read_file"],
      contextUsage: tracker.controlsForConversation("cursor_conv_1"),
    });
    state.usage.outputTokens = 109;

    expect(finalizeAfterDrain(state)).toEqual([
      { type: "done", usage: { inputTokens: 183_227, outputTokens: 109, totalTokens: 183_336, estimated: true } },
    ]);
  });

  test("non-Responses mcpArgs is left to native exec (not handled by the bridge)", () => {
    const state = createCursorProtobufEventState();
    const plan = planMcpArgsHandling(execMcpArgs({ provider: "real-mcp-server" }), state);
    expect(plan.handledByResponsesBridge).toBe(false);
    expect(plan.events).toEqual([]);
    expect(plan.cancelCursorRun).toBe(false);
  });

  test("a duplicate Responses mcpArgs (already surfaced via interactionUpdate) still ends turn 1 without native fallthrough", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["mcp__fs__read_file"] });
    state.completedToolCalls.add("call_1"); // interaction_update already surfaced + completed it
    const plan = planMcpArgsHandling(execMcpArgs({ args: { path: new TextEncoder().encode(JSON.stringify("a.txt")) } }), state);
    // Must NOT fall through to native-exec even though the mapper yields no fresh tool events.
    expect(plan.handledByResponsesBridge).toBe(true);
    expect(plan.writeMcpResult).toBeUndefined();
    // The mapper yields no fresh events, but the call set is already drained, so the plan flags
    // finalize-when-drained (the transport's grace timer ends the turn) rather than falling through.
    expect(plan.cancelCursorRun).toBe(false);
    expect(plan.finalizeWhenDrained).toBe(true);
    expect(finalizeAfterDrain(state).map(e => e.type)).toEqual(["done"]);
  });

  test("parallel: an open sibling tool call defers turn-1 termination (no done, no cancel, no truncation error)", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["echo_a", "echo_b"] });
    // Two parallel calls were started/streamed via interactionUpdate; neither has been committed yet.
    state.openToolCalls.set("call_a", { name: "echo_a", args: "" });
    state.openToolCalls.set("call_b", { name: "echo_b", args: "" });
    state.startedClientToolCalls = 2;

    // call_a's exec args arrive first. We commit call_a but call_b is still open -> must NOT finalize.
    const planA = planMcpArgsHandling(
      execMcpArgs({ toolName: "echo_a", toolCallId: "call_a", args: { text: new TextEncoder().encode(JSON.stringify("A")) } }),
      state,
    );
    expect(planA.handledByResponsesBridge).toBe(true);
    const typesA = planA.events.map(e => e.type);
    expect(typesA).toContain("tool_call_start");
    expect(typesA).toContain("tool_call_end");
    expect(typesA).not.toContain("done");
    expect(typesA).not.toContain("error");
    expect(planA.cancelCursorRun).toBe(false);
    expect(planA.finalizeWhenDrained).toBe(false);
    expect(state.openToolCalls.has("call_b")).toBe(true);

    const planB = planMcpArgsHandling(
      execMcpArgs({ toolName: "echo_b", toolCallId: "call_b", args: { text: new TextEncoder().encode(JSON.stringify("B")) } }),
      state,
    );
    const typesB = planB.events.map(e => e.type);
    expect(typesB).toContain("tool_call_end");
    expect(typesB).not.toContain("done");
    expect(typesB).not.toContain("error");
    expect(planB.cancelCursorRun).toBe(false);
    expect(planB.finalizeWhenDrained).toBe(true);
    expect(state.openToolCalls.size).toBe(0);
    expect(finalizeAfterDrain(state).map(e => e.type)).toEqual(["done"]);
  });

  test("hidden parallel sibling: a late-announced call revokes a pending finalize (no premature done)", () => {
    const state = createCursorProtobufEventState({ clientToolNames: ["echo_a", "echo_b"] });
    // Only call_a is known so far (its start + exec arrive in the same receive chunk).
    state.openToolCalls.set("call_a", { name: "echo_a", args: "" });
    state.startedClientToolCalls = 1;
    const planA = planMcpArgsHandling(
      execMcpArgs({ toolName: "echo_a", toolCallId: "call_a", args: { text: new TextEncoder().encode(JSON.stringify("A")) } }),
      state,
    );
    // call_a drains the known set, so the plan flags finalize-when-drained (timer armed by transport).
    expect(planA.finalizeWhenDrained).toBe(true);
    expect(planA.cancelCursorRun).toBe(false);
    expect(planA.events.map(e => e.type)).not.toContain("done");

    // BEFORE the grace timer fires, Cursor announces a sibling (call_b) in a later chunk.
    state.openToolCalls.set("call_b", { name: "echo_b", args: "" });
    state.startedClientToolCalls = 2;

    // The pending finalize must be revoked: re-checking the drain guard now yields NO done (call_b open).
    expect(finalizeAfterDrain(state)).toEqual([]);
    expect(state.terminated).not.toBe(true);

    // call_b's exec arrives and drains the set again; only now does finalize emit a single done.
    const planB = planMcpArgsHandling(
      execMcpArgs({ toolName: "echo_b", toolCallId: "call_b", args: { text: new TextEncoder().encode(JSON.stringify("B")) } }),
      state,
    );
    expect(planB.finalizeWhenDrained).toBe(true);
    expect(finalizeAfterDrain(state).map(e => e.type)).toEqual(["done"]);
  });
});
