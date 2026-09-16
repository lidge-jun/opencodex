import { describe, expect, test } from "bun:test";
import { createCursorAdapter as createCursorAdapterProduction } from "../../../src/adapters/cursor";
import { clearCursorCheckpointsForTests, cursorCheckpointShape, getCursorCheckpoint } from "../../../src/adapters/cursor/checkpoint-store";
import { create, toBinary } from "@bufbuild/protobuf";
import { ConversationStateStructureSchema } from "../../../src/adapters/cursor/gen/agent_pb";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import type { CursorServerMessage } from "../../../src/adapters/cursor/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createCursorAdapter = (...args: Parameters<typeof createCursorAdapterProduction>) =>
  withTestTranslatorBudget(createCursorAdapterProduction(...args));

const provider: OcxProviderConfig = { adapter: "cursor", baseUrl: "https://api2.cursor.sh" };

const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
  pendingToolCalls: ["suspended-fixture"],
}));

/** Transport that emits a client tool call, exposing checkpoint bytes only after it. */
function toolSuspendedTransport() {
  let capturable: Uint8Array | undefined;
  return {
    async *run() {
      yield { type: "tool_call_start", id: "call_x", name: "get_weather" } satisfies CursorServerMessage;
      yield { type: "tool_call_delta", arguments: "{}" } satisfies CursorServerMessage;
      capturable = checkpointBytes;
      yield { type: "tool_call_end" } satisfies CursorServerMessage;
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
    },
    writeClient() {},
    capturedConversationCheckpoint() {
      return capturable;
    },
  };
}

function body(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    stream: false,
    options: {},
    _cursorConversationId: "cursor_tool_suspend",
    _cursorIdentityScope: "acct-suspend",
  } as OcxParsedRequest;
}

describe("tool-suspended checkpoint commit (devlog 260826 050)", () => {
  test("external model commits a tool-suspended checkpoint with checkpointUsable=false", async () => {
    clearCursorCheckpointsForTests();
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: toolSuspendedTransport });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body("cursor/grok-4.6"), { headers: new Headers() }, event => events.push(event));
    const done = events.find(event => event.type === "done");
    if (done?.type !== "done") throw new Error("expected done");
    expect(done.providerState?.cursor?.checkpointRef).toBeDefined();
    expect(done.providerState?.cursor?.checkpointUsable).toBe(false);
    expect(getCursorCheckpoint(done.providerState?.cursor?.checkpointRef)).toBeDefined();
    clearCursorCheckpointsForTests();
  });

  test("native composer model still refuses the tool-suspended commit", async () => {
    clearCursorCheckpointsForTests();
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: toolSuspendedTransport });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body("cursor/composer-2.5"), { headers: new Headers() }, event => events.push(event));
    const done = events.find(event => event.type === "done");
    if (done?.type !== "done") throw new Error("expected done");
    expect(done.providerState?.cursor?.checkpointRef).toBeUndefined();
    clearCursorCheckpointsForTests();
  });

  test("checkpoint captured before the tool call is still refused (ordering guard)", async () => {
    clearCursorCheckpointsForTests();
    const transport = {
      async *run() {
        yield { type: "tool_call_start", id: "call_y", name: "get_weather" } satisfies CursorServerMessage;
        yield { type: "tool_call_delta", arguments: "{}" } satisfies CursorServerMessage;
        yield { type: "tool_call_end" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
      capturedConversationCheckpoint() {
        // Bytes available from the very first poll — pre-tool capture.
        return checkpointBytes;
      },
    };
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: () => transport });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body("cursor/grok-4.6"), { headers: new Headers() }, event => events.push(event));
    const done = events.find(event => event.type === "done");
    if (done?.type !== "done") throw new Error("expected done");
    expect(done.providerState?.cursor?.checkpointRef).toBeUndefined();
    clearCursorCheckpointsForTests();
  });
});

describe("checkpoint shape (#4245 coverage question)", () => {
  test("reports counts, and pendingToolCalls is what distinguishes coverage from arrival", () => {
    // A snapshot that knows about a suspended call.
    expect(cursorCheckpointShape(checkpointBytes)).toEqual({
      turns: 0,
      turnsOld: 0,
      rootPromptMessages: 0,
      todos: 0,
      pendingToolCalls: 1,
    });

    // The same structure with nothing pending: byte length alone cannot tell these apart,
    // which is exactly why capturedBytes was not enough to settle the native-gate question.
    const noPending = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      turns: [new Uint8Array([1, 2, 3])],
    }));
    expect(cursorCheckpointShape(noPending)).toEqual({
      turns: 1,
      turnsOld: 0,
      rootPromptMessages: 0,
      todos: 0,
      pendingToolCalls: 0,
    });
  });

  test("fails closed on absent, empty, and undecodable bytes", () => {
    expect(cursorCheckpointShape(undefined)).toBeUndefined();
    expect(cursorCheckpointShape(new Uint8Array())).toBeUndefined();
    // Protobuf cannot parse this; a diagnostic must never throw into the request path.
    expect(cursorCheckpointShape(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBeUndefined();
  });
});
