import { describe, expect, test } from "bun:test";
import {
  createCursorAdapter as createCursorAdapterProduction,
  cursorExecDeniedMessage,
} from "../src/adapters/cursor";
import {
  clearCursorThreadContinuityForTests,
  lookupCursorThreadConversation,
} from "../src/adapters/cursor/thread-continuity";
import {
  clearCursorCheckpointsForTests,
  commitCursorCheckpoint,
  getCursorCheckpoint,
} from "../src/adapters/cursor/checkpoint-store";
import { create, toBinary } from "@bufbuild/protobuf";
import { ConversationStateStructureSchema } from "../src/adapters/cursor/gen/agent_pb";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import type { CursorClientMessage, CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";
import type { CursorTransportFactoryInput } from "../src/adapters/cursor/transport";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createCursorAdapter = (...args: Parameters<typeof createCursorAdapterProduction>) =>
  withTestTranslatorBudget(createCursorAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "cursor",
  baseUrl: "https://api2.cursor.sh",
};

const parsed: OcxParsedRequest = {
  modelId: "cursor/auto",
  context: { messages: [] },
  stream: false,
  options: {},
};

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("Cursor adapter live transport", () => {
  test("runTurn emits a missing-token error before live network", async () => {
    const adapter = createCursorAdapter(provider);
    const events: AdapterEvent[] = [];

    await adapter.runTurn?.(parsed, { headers: new Headers() }, event => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("no Cursor access token is configured"),
    });
  });

  test("pre-aborted runTurn emits an abort error", async () => {
    const adapter = createCursorAdapter(provider);
    const events: AdapterEvent[] = [];
    const abort = new AbortController();
    abort.abort("test");

    await adapter.runTurn?.(parsed, { headers: new Headers(), abortSignal: abort.signal }, event => events.push(event));

    expect(events).toEqual([{ type: "error", message: "Cursor turn was aborted before start." }]);
  });

  test("runTurn maps mocked Cursor transport messages into AdapterEvents", async () => {
    const requests: CursorRunRequest[] = [];
    const writes: CursorClientMessage[] = [];
    const adapter = createCursorAdapter(provider, {
      createTransport: () => ({
        async *run(request) {
          requests.push(request);
          yield { type: "thinking", thinking: "검토 중" } satisfies CursorServerMessage;
          yield { type: "text", text: "안녕하세요" } satisfies CursorServerMessage;
          yield { type: "done", usage: { inputTokens: 3, outputTokens: 5 } } satisfies CursorServerMessage;
        },
        writeClient(message) {
          writes.push(message);
        },
      }),
    });
    const events: AdapterEvent[] = [];

    await adapter.runTurn?.(
      { ...parsed, modelId: "cursor/auto", context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] } },
      { headers: new Headers() },
      event => events.push(event),
    );

    expect(requests[0]?.modelId).toBe("default");
    expect(requests[0]?.routingLevel).toBeUndefined();
    expect(writes).toEqual([]);
    expect(events[0]).toEqual({ type: "thinking_delta", thinking: "검토 중" });
    expect(events[1]).toEqual({ type: "text_delta", text: "안녕하세요" });
    expect(events[2]).toMatchObject({ type: "done", usage: { inputTokens: 3, outputTokens: 5 } });
  });

  test("runTurn forwards the router-prepared provider fetch to the live transport", async () => {
    const inputs: CursorTransportFactoryInput[] = [];
    const pacedFetch = (async () => new Response()) as typeof fetch;
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
      createTransport(input) {
        inputs.push(input);
        return {
          async *run() { yield { type: "done" } satisfies CursorServerMessage; },
          writeClient() {},
        };
      },
    });

    await adapter.runTurn?.(
      { ...parsed, context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] } },
      { headers: new Headers(), providerFetch: pacedFetch },
      () => {},
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.fetch).toBe(pacedFetch);
  });

  test("runTurn preserves explicit Cursor Router optimization levels", async () => {
    const requests: CursorRunRequest[] = [];
    const adapter = createCursorAdapter(provider, {
      createTransport: () => ({
        async *run(request) {
          requests.push(request);
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });

    await adapter.runTurn?.(
      { ...parsed, modelId: "cursor/auto-intelligence" },
      { headers: new Headers() },
      () => {},
    );

    expect(requests[0]).toMatchObject({ modelId: "default", routingLevel: "intelligence" });
  });

  test("runTurn sanitizes unexpected transport errors", async () => {
    const adapter = createCursorAdapter(provider, {
      createTransport: () => ({
        async *run() {
          throw new Error("gRPC error 16: Bearer secret-token-123 authorization=secret-token-123");
        },
        writeClient() {},
      }),
    });
    const events: AdapterEvent[] = [];

    await adapter.runTurn?.(parsed, { headers: new Headers() }, event => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("gRPC error 16: Bearer [REDACTED] authorization=[REDACTED]"),
    });
    expect(JSON.stringify(events).includes("secret-token-123")).toBe(false);
  });

  test("derives distinct thread conversation ids per Cursor credential", async () => {
    const ids: string[] = [];
    const scopes: Array<string | undefined> = [];
    for (const apiKey of ["cursor-token-a", "cursor-token-b"]) {
      const adapter = createCursorAdapter({ ...provider, apiKey }, {
        createTransport: () => ({
          async *run(request) {
            ids.push(request.conversationId);
            yield { type: "done" } satisfies CursorServerMessage;
          },
          writeClient() {},
        }),
      });
      const body: OcxParsedRequest = {
        modelId: "cursor/auto",
        context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
        stream: false,
        options: {},
        _clientThreadId: `cred-scope-thread`,
      };
      await adapter.runTurn?.(body, { headers: new Headers() }, () => {});
      scopes.push(body._cursorIdentityScope);
    }
    expect(scopes[0]).toBeTruthy();
    expect(scopes[1]).toBeTruthy();
    expect(scopes[0]).not.toBe(scopes[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
  test("passes conversationId as Connect sessionId and isolates helper turns", async () => {
    const captured: CursorTransportFactoryInput[] = [];
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
      createTransport(input) {
        captured.push(input);
        return {
          async *run() {
            yield { type: "done" } satisfies CursorServerMessage;
          },
          writeClient() {},
        };
      },
    });

    const parent: OcxParsedRequest = {
      modelId: "cursor/auto",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      stream: false,
      options: {},
      _clientThreadId: "parent-thread-session-id",
    };
    await adapter.runTurn?.(parent, { headers: new Headers() }, () => {});
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sessionId).toBeTruthy();
    expect(captured[0]?.sessionId).toBe(parent._cursorConversationId);

    const helper: OcxParsedRequest = {
      modelId: "cursor/auto",
      context: { messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
      stream: false,
      options: {},
      _clientThreadId: "parent-thread-session-id",
      _cursorConversationId: parent._cursorConversationId,
      _cursorIsolateConversation: true,
    };
    await adapter.runTurn?.(helper, { headers: new Headers() }, () => {});
    expect(captured).toHaveLength(2);
    expect(captured[1]?.sessionId).toBeTruthy();
    expect(captured[1]?.sessionId).not.toBe(captured[0]?.sessionId);
    expect(captured[1]?.sessionId).toBe(helper._cursorConversationId);
  });

  test("parseStream reports that the fetch path is disabled", async () => {
    const adapter = createCursorAdapter(provider);

    expect(await collect(adapter.parseStream(new Response()))).toEqual([
      {
        type: "error",
        message: "Cursor adapter uses runTurn; the fetch/parseStream path is disabled.",
      },
    ]);
  });

  test("legacy mock exec message names the unavailable case", () => {
    expect(cursorExecDeniedMessage("shellArgs")).toContain("shellArgs");
    expect(cursorExecDeniedMessage("shellArgs")).toContain("legacy mock transport cannot execute");
  });

  test("does not retry external tool-result invalid_argument with a fresh conversation id", async () => {
    const seen: string[] = [];
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          attempts += 1;
          seen.push(request.conversationId);
          throw Object.assign(
            new Error("Cursor invalid request: Cursor Connect error invalid_argument: Error"),
            { code: "invalid_argument" },
          );
        },
        writeClient() {},
      }),
    });

    const events: AdapterEvent[] = [];
    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/gpt-5.6-sol",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: { reasoning: "xhigh" },
      _cursorConversationId: "cursor_corrupt",
    };

    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(1);
    expect(seen).toEqual(["cursor_corrupt"]);
    expect(body._cursorConversationId).toBe("cursor_corrupt");
    expect(events.filter(event => event.type === "error")).toHaveLength(1);
  });

  test("retries external-model invalid_argument on plain-user continuations too", async () => {
    const seen: string[] = [];
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          attempts += 1;
          seen.push(request.conversationId);
          if (attempts === 1) {
            throw Object.assign(
              new Error("Cursor invalid request: Cursor Connect error invalid_argument: Error"),
              { code: "invalid_argument" },
            );
          }
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });

    const events: AdapterEvent[] = [];
    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "first turn", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/gpt-5.6-sol",
            timestamp: 2,
            content: [{ type: "text", text: "ack" }],
          },
          { role: "user", content: "second turn", timestamp: 3 },
        ],
      },
      stream: false,
      options: { reasoning: "xhigh" },
      _cursorConversationId: "cursor_stale",
    };

    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(2);
    expect(seen[0]).toBe("cursor_stale");
    expect(seen[1]).not.toBe("cursor_stale");
    expect(body._cursorConversationId).toBe(seen[1]);
    expect(events.filter(event => event.type === "error")).toHaveLength(0);
  });

  test("forced-fresh recovery keeps the new checkpoint instead of deleting it", async () => {
    clearCursorCheckpointsForTests();
    const parentBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["parent-stale"],
    }));
    const parentRef = commitCursorCheckpoint({
      conversationId: "cursor_stale",
      identityScope: "acct-fresh",
      modelId: "gpt-5.6-sol",
      checkpointBytes: parentBytes,
    });
    expect(parentRef).toBeDefined();
    const recoveredBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["recovered"],
    }));
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(
              new Error("Cursor invalid request: Cursor Connect error invalid_argument: Error"),
              { code: "invalid_argument" },
            );
          }
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
        capturedConversationCheckpoint() {
          return attempts === 1 ? undefined : recoveredBytes;
        },
      }),
    });
    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "retry me", timestamp: 1 }] },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_stale",
      _cursorIdentityScope: "acct-fresh",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stale", checkpointUsable: true, checkpointRef: parentRef },
      },
    };
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    expect(attempts).toBe(2);
    expect(getCursorCheckpoint(parentRef)).toBeUndefined();
    const done = events.find(event => event.type === "done");
    const newRef = done && done.type === "done" ? done.providerState?.cursor?.checkpointRef : undefined;
    expect(newRef).toBeDefined();
    expect(newRef).not.toBe(parentRef);
    expect(getCursorCheckpoint(newRef)?.conversationId).toBe(body._cursorConversationId);
    clearCursorCheckpointsForTests();
  });

  test("does not replay invalid_argument after a local side effect", async () => {
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          yield { type: "local_side_effect" } satisfies CursorServerMessage;
          throw Object.assign(
            new Error("Cursor invalid request: Cursor Connect error invalid_argument: Error"),
            { code: "invalid_argument" },
          );
        },
        writeClient() {},
      }),
    });

    const events: AdapterEvent[] = [];
    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "run a command", timestamp: 1 }] },
      stream: false,
      options: { reasoning: "xhigh" },
      _cursorConversationId: "cursor_side_effect",
    };

    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(1);
    expect(events.some(event => event.type === "error")).toBe(true);
  });

  test("same-id tool continuation does not rekey context usage", async () => {
    const rekeyCalls: Array<[string, string]> = [];
    const seen: string[] = [];
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          seen.push(request.conversationId);
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
      rekeyContextUsage: (from, to) => rekeyCalls.push([from, to]),
    });

    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/gpt-5.6-sol",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_prior",
    };

    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("cursor_prior");
    expect(rekeyCalls).toEqual([]);
    expect(body._cursorConversationId).toBe("cursor_prior");
  });

  test("isolated helper turns do not rekey parent context usage", async () => {
    const rekeyCalls: Array<[string, string]> = [];
    const seen: string[] = [];
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          seen.push(request.conversationId);
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
      rekeyContextUsage: (from, to) => rekeyCalls.push([from, to]),
    });

    const body: OcxParsedRequest = {
      modelId: "cursor/auto",
      context: { messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
      stream: false,
      options: {},
      _clientThreadId: "parent-thread-isolate-rekey",
      _cursorConversationId: "cursor_parent_real",
      _cursorIsolateConversation: true,
    };

    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe("cursor_parent_real");
    expect(seen[0]?.startsWith("cursor_")).toBe(true);
    expect(rekeyCalls).toEqual([]);
  });

  test("isolated invalid_argument recovery does not remember under the parent thread", async () => {
    clearCursorThreadContinuityForTests();
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(
              new Error("Cursor invalid request: Cursor Connect error invalid_argument: Error"),
              { code: "invalid_argument" },
            );
          }
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });

    const threadId = "parent-thread-isolate-remember";
    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "helper ask", timestamp: 1 }] },
      stream: false,
      options: { reasoning: "xhigh" },
      _clientThreadId: threadId,
      _cursorConversationId: "cursor_parent_real",
      _cursorIsolateConversation: true,
      _cursorIdentityScope: "acct-isolate-test",
    };

    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});

    expect(attempts).toBe(2);
    expect(lookupCursorThreadConversation(threadId, "acct-isolate-test")).toBeUndefined();
  });

  test("does not replay invalid_argument after non-heartbeat output was already emitted", async () => {
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          yield { type: "text", text: "partial output" } satisfies CursorServerMessage;
          throw Object.assign(
            new Error("Cursor invalid request: Cursor Connect error invalid_argument: Error"),
            { code: "invalid_argument" },
          );
        },
        writeClient() {},
      }),
    });

    const events: AdapterEvent[] = [];
    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/gpt-5.6-sol",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: { reasoning: "xhigh" },
      _cursorConversationId: "cursor_corrupt",
    };

    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(1);
    expect(events.some(event => event.type === "text_delta")).toBe(true);
    expect(events.some(event => event.type === "error")).toBe(true);
  });

  test("attaches a committed checkpoint ref on done so stream persist can reuse it", async () => {
    clearCursorCheckpointsForTests();
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["stream-fixture"],
    }));
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          yield { type: "text", text: "remembered" } satisfies CursorServerMessage;
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
        },
        writeClient() {},
        capturedConversationCheckpoint() {
          return checkpointBytes;
        },
      }),
    });

    const events: AdapterEvent[] = [];
    const body: OcxParsedRequest = {
      ...parsed,
      modelId: "cursor/grok-4.6",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      _cursorConversationId: "cursor_stream_persist",
      _cursorIdentityScope: "acct-stream",
    };
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    const done = events.find(event => event.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("expected done");
    expect(done.providerState?.cursor?.checkpointRef).toBeDefined();
    expect(done.providerState?.cursor?.checkpointUsable).toBe(true);
    expect(getCursorCheckpoint(done.providerState?.cursor?.checkpointRef)?.conversationId).toBe("cursor_stream_persist");
    expect(body._providerContinuation?.cursor?.checkpointRef).toBe(done.providerState?.cursor?.checkpointRef);
    clearCursorCheckpointsForTests();
  });

  test("isolated helper turns do not inherit or invalidate a parent checkpoint ref", async () => {
    clearCursorCheckpointsForTests();
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["isolate-fixture"],
    }));
    const parentRef = commitCursorCheckpoint({
      conversationId: "cursor_parent_real",
      identityScope: "acct-isolate-test",
      modelId: "default",
      checkpointBytes,
      coveredMessageCount: 1,
    });
    expect(parentRef).toBeDefined();

    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });
    const body: OcxParsedRequest = {
      modelId: "cursor/auto",
      context: { messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_parent_real",
      _cursorIsolateConversation: true,
      _cursorIdentityScope: "acct-isolate-test",
      _providerContinuation: {
        cursor: { conversationId: "cursor_parent_real", checkpointUsable: true, checkpointRef: parentRef },
      },
    };
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(getCursorCheckpoint(parentRef)?.ref).toBe(parentRef);
    expect(body._providerContinuation?.cursor?.checkpointRef).toBeUndefined();
    const done = events.find(event => event.type === "done");
    expect(done && done.type === "done" ? done.providerState?.cursor?.checkpointRef : undefined).toBeUndefined();
    clearCursorCheckpointsForTests();
  });
});
