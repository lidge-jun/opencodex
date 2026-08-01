import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { clientToolFinalizeGraceMsForRequest, createLiveCursorTransport } from "../src/adapters/cursor/live-transport";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { createCursorProtobufEventState } from "../src/adapters/cursor/protobuf-events";
import type { CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";
import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  McpArgsSchema,
  McpToolCallSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
  InteractionUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";

const PROVIDER = "opencodex-responses";

function startedFrame(callId: string, toolName: string) {
  const toolCall = create(ToolCallSchema, {
    tool: {
      case: "mcpToolCall",
      value: create(McpToolCallSchema, {
        args: create(McpArgsSchema, { name: toolName, toolName, toolCallId: callId, providerIdentifier: PROVIDER }),
      }),
    },
  });
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "toolCallStarted", value: create(ToolCallStartedUpdateSchema, { callId, modelCallId: callId, toolCall }) },
      }),
    },
  });
}

function execFrame(id: number, callId: string, toolName: string, argText: string) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id,
        execId: `exec-${callId}`,
        message: {
          case: "mcpArgs",
          value: create(McpArgsSchema, {
            name: toolName,
            toolName,
            toolCallId: callId,
            providerIdentifier: PROVIDER,
            args: { text: new TextEncoder().encode(JSON.stringify(argText)) },
          }),
        },
      }),
    },
  });
}

interface Harness {
  feed(frame: ReturnType<typeof startedFrame>): Promise<void>;
  events: CursorServerMessage[];
  closeCodes: number[];
  cancelled(): boolean;
}

function makeHarness(graceMs: number, clientToolNames: string[]): Harness {
  const transport = createLiveCursorTransport({
    provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
    translatorBudget: createTestTranslatorBudget(),
    headers: new Headers(),
    clientToolFinalizeGraceMs: graceMs,
  }) as unknown as {
    stream: unknown;
    handleServerMessage: (m: unknown, s: unknown, p: (e: CursorServerMessage) => void) => Promise<void>;
  };
  const events: CursorServerMessage[] = [];
  const closeCodes: number[] = [];
  // Fake h2 stream: records RST_STREAM close codes; never touches the network.
  transport.stream = {
    close: (code?: number) => { closeCodes.push(code ?? 0); },
    destroy: () => {},
    write: () => true,
    closed: false,
    destroyed: false,
  };
  const state = createCursorProtobufEventState({ clientToolNames });
  const push = (e: CursorServerMessage) => { events.push(e); };
  return {
    feed: (frame) => transport.handleServerMessage(frame, state, push),
    events,
    closeCodes,
    cancelled: () => closeCodes.length > 0,
  };
}

const NGHTTP2_CANCEL = 8;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function requestForGrace(content: string, rawTailRole?: "toolResult"): CursorRunRequest {
  return {
    modelId: "composer-2.5",
    conversationId: "c1",
    system: ["You are helpful."],
    messages: [{ role: "user", content }],
    rawMessages: rawTailRole === "toolResult"
      ? [
          { role: "user", content, timestamp: 1 },
          { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: "ok", isError: false, timestamp: 2 },
        ]
      : undefined,
    tools: [{ name: "exec_command", description: "Run", parameters: {} }],
  };
}

describe("client-tool finalize grace selection", () => {
  test("keeps ordinary single-tool turns on the base grace", () => {
    expect(clientToolFinalizeGraceMsForRequest(requestForGrace("Run: echo hi"), 50)).toBe(50);
  });

  test("expands grace only for generic tool-count prompts", () => {
    expect(clientToolFinalizeGraceMsForRequest(requestForGrace("아무 tool 10개 써봐"), 50)).toBe(1250);
    expect(clientToolFinalizeGraceMsForRequest(requestForGrace("Use any 50 tools"), 50)).toBe(1800);
  });

  test("does not carry expanded grace into tool-result continuations", () => {
    expect(clientToolFinalizeGraceMsForRequest(requestForGrace("아무 tool 10개 써봐", "toolResult"), 50)).toBe(50);
  });
});

describe("transport finalize race (hidden parallel sibling)", () => {
  test("single client tool: grace timer fires once, emits done, cancels with RST_STREAM CANCEL", async () => {
    const h = makeHarness(20, ["echo_a"]);
    await h.feed(startedFrame("call_a", "echo_a"));
    await h.feed(execFrame(1, "call_a", "echo_a", "A"));
    // Before the grace window elapses the turn must NOT be finalized.
    expect(h.events.map(e => e.type)).not.toContain("done");
    expect(h.cancelled()).toBe(false);
    await sleep(60);
    const types = h.events.map(e => e.type);
    expect(types.filter(t => t === "done")).toHaveLength(1);
    expect(h.closeCodes).toEqual([NGHTTP2_CANCEL]);
  });

  test("hidden sibling announced after first drain revokes the premature finalize", async () => {
    const h = makeHarness(40, ["echo_a", "echo_b"]);
    // call_a fully arrives (start + exec) in the first chunk; the known set drains -> finalize armed.
    await h.feed(startedFrame("call_a", "echo_a"));
    await h.feed(execFrame(1, "call_a", "echo_a", "A"));
    // call_b's start lands in a LATER chunk, still inside the grace window: must revoke the finalize.
    await sleep(15);
    await h.feed(startedFrame("call_b", "echo_b"));
    await sleep(40);
    // The premature finalize was revoked: no done yet, run still open, call_b still tracked.
    expect(h.events.map(e => e.type)).not.toContain("done");
    expect(h.cancelled()).toBe(false);
    // call_b's exec drains the set again; only now does the turn finalize, exactly once.
    await h.feed(execFrame(2, "call_b", "echo_b", "B"));
    await sleep(60);
    expect(h.events.map(e => e.type).filter(t => t === "done")).toHaveLength(1);
    expect(h.closeCodes).toEqual([NGHTTP2_CANCEL]);
    const ends = h.events.filter(e => e.type === "tool_call_end").length;
    expect(ends).toBe(2);
  });
});
