import { describe, expect, spyOn, test } from "bun:test";
import {
  createCursorAdapter as createCursorAdapterProduction,
  cursorExecDeniedMessage,
} from "../../../src/adapters/cursor";
import {
  clearCursorIncompleteToolRemint,
  clearCursorIncompleteToolRemintForTests,
  clearCursorOverflowRemintForTests,
  clearCursorThreadContinuityForTests,
  CURSOR_INCOMPLETE_TOOL_REMINT_MAX_ENTRIES,
  cursorIncompleteToolRemintScopeKey,
  cursorIncompleteToolRemintCountForTests,
  cursorOverflowRemintScopeKey,
  lookupCursorThreadConversation,
  markCursorOverflowSurfaced,
  recordCursorIncompleteToolRemint,
  recordCursorOverflowRemint,
  rememberCursorThreadConversation,
  shouldSkipCursorOverflowRemint,
} from "../../../src/adapters/cursor/thread-continuity";
import {
  clearCursorCheckpointsForTests,
  commitCursorCheckpoint,
  getCursorCheckpoint,
} from "../../../src/adapters/cursor/checkpoint-store";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import type { CursorClientMessage, CursorRunRequest, CursorServerMessage } from "../../../src/adapters/cursor/types";
import type { CursorTransportFactoryInput } from "../../../src/adapters/cursor/transport";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import { CURSOR_INCOMPLETE_TOOL_CALL_MESSAGE_PREFIX, CursorRootEnvelopeLimitError } from "../../../src/adapters/cursor/cursor-errors";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../../../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../../../src/lib/debug-settings";
import { encodeCursorCallId, resetCursorCallIdProvenanceForTests } from "../../../src/adapters/cursor/call-id";
import { handleCursorNativeKv, resetCursorBlobStateForTests } from "../../../src/adapters/cursor/native-exec";
import { CURSOR_MISSING_TOOL_RESULT, encodeCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";

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

  // #1527: the envelope rejection is raised locally while building the request, so it surfaces
  // through the same terminal catch as a transport fault. Review found the class was flattened to
  // a bare message there, losing the stable code a caller needs to tell "this conversation cannot
  // be sent" from a transient upstream error — and the message carried a doubled prefix.
  test("a local envelope rejection surfaces as a typed 400, not a bare message", async () => {
    // Raised from the transport seam because that is where it actually originates: encoding
    // happens inside the live transport (`prepareCursorRunRequest` in live-transport.ts), which a
    // mock replaces, so a mocked run can never reach the guard itself. What is under test here is
    // the adapter's terminal catch, not the guard — the guard has its own tests in
    // tests/providers/cursor/cursor-blob.test.ts.
    const adapter = createCursorAdapter(provider, {
      createTransport: () => ({
        async *run(): AsyncGenerator<CursorServerMessage> {
          throw new CursorRootEnvelopeLimitError(194, 600_000, 192, 524_288);
        },
        writeClient() {},
      }),
    });
    const events: AdapterEvent[] = [];

    await adapter.runTurn?.(
      {
        ...parsed,
        modelId: "cursor/gpt-5.6-sol-xhigh",
        context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      },
      { headers: new Headers() },
      event => events.push(event),
    );

    const error = events.find(event => event.type === "error");
    expect(error).toBeDefined();
    expect(error).toMatchObject({
      status: 400,
      errorType: "invalid_request_error",
      code: "cursor_root_envelope_limit",
      retryable: false,
    });
    // One prefix, not two.
    const message = String((error as { message?: unknown }).message ?? "");
    expect(message.match(/Cursor invalid request/g)?.length).toBe(1);
    // And the operator-facing numbers survive the boundary.
    expect(message).toContain("194");
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

  test("forced-fresh recovery remembers a Cursor-only Desktop owner", async () => {
    clearCursorThreadContinuityForTests();
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

    const owner = "app:desktop-recovery-owner";
    const identityScope = "acct-desktop-recovery";
    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "first turn", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "ack" }], timestamp: 2 },
          { role: "user", content: "second turn", timestamp: 3 },
        ],
      },
      stream: false,
      options: { reasoning: "xhigh" },
      _cursorClientThreadId: owner,
      _cursorConversationId: "cursor_stale_desktop",
      _cursorIdentityScope: identityScope,
    };

    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});

    expect(attempts).toBe(2);
    expect(seen[1]).not.toBe(seen[0]);
    expect(lookupCursorThreadConversation(owner, identityScope)).toBe(seen[1]);
    clearCursorThreadContinuityForTests();
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
const LARGE_OVERFLOW_CONTENT = "word ".repeat(100_000);

function bareOverflowError(): Error {
  return Object.assign(
    new Error("Cursor context limit exceeded: Cursor Connect error resource_exhausted: Error"),
    { code: "resource_exhausted" },
  );
}

function overflowTurnBody(threadId?: string): OcxParsedRequest {
  return {
    modelId: "cursor/auto",
    context: { messages: [{ role: "user", content: LARGE_OVERFLOW_CONTENT, timestamp: 1 }] },
    stream: false,
    options: {},
    _cursorIdentityScope: "acct-overflow-remint",
    ...(threadId ? { _clientThreadId: threadId } : { _cursorConversationId: "cursor_overflow_base" }),
  };
}

describe("Cursor overflow conversation remint", () => {
  test("first bare overflow surfaces without reminting the conversation id", async () => {
    clearCursorOverflowRemintForTests();
    let attempts = 0;
    const seen: string[] = [];
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          attempts += 1;
          seen.push(request.conversationId);
          throw bareOverflowError();
        },
        writeClient() {},
      }),
    });

    const body = overflowTurnBody("overflow-surface-first");
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(1);
    expect(seen).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("Cursor context limit exceeded"),
    });
  });

  test("second overflow remints and persists thread override", async () => {
    clearCursorOverflowRemintForTests();
    clearCursorThreadContinuityForTests();
    let attempts = 0;
    const seen: string[] = [];
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          attempts += 1;
          seen.push(request.conversationId);
          if (attempts === 1) {
            throw bareOverflowError();
          }
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
      rekeyContextUsage: () => {},
    });

    const threadId = "overflow-remint-thread";
    const body = overflowTurnBody(threadId);

    const surfaceEvents: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => surfaceEvents.push(event));
    expect(attempts).toBe(1);
    expect(surfaceEvents.some(event => event.type === "error")).toBe(true);

    seen.length = 0;
    attempts = 0;
    const remintEvents: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => remintEvents.push(event));

    expect(attempts).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    expect(remintEvents.some(event => event.type === "done")).toBe(true);
    expect(lookupCursorThreadConversation(threadId, "acct-overflow-remint")).toBe(seen[1]);
    expect(body._cursorConversationId).toBe(seen[1]);
  });

  test("fourth overflow skips remint after surface-first and three remints", async () => {
    clearCursorOverflowRemintForTests();
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          throw bareOverflowError();
        },
        writeClient() {},
      }),
    });

    const body = overflowTurnBody("overflow-cap-skip");
    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});
    expect(attempts).toBe(1);

    attempts = 0;
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(4);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("Cursor context limit exceeded"),
    });
  });

  test("quota-cue resource_exhausted does not remint and surfaces as rate limit", async () => {
    clearCursorOverflowRemintForTests();
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          throw Object.assign(
            new Error("Cursor rate limit exceeded: resource_exhausted: too many requests"),
            { code: "resource_exhausted" },
          );
        },
        writeClient() {},
      }),
    });

    const body = overflowTurnBody("overflow-quota-cue");
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("Cursor rate limit exceeded"),
    });
  });

  test("does not overflow-remint on tool-result resumes", async () => {
    clearCursorOverflowRemintForTests();
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          throw bareOverflowError();
        },
        writeClient() {},
      }),
    });

    const body: OcxParsedRequest = {
      modelId: "cursor/auto",
      context: {
        messages: [
          { role: "user", content: LARGE_OVERFLOW_CONTENT, timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/auto",
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
      _cursorConversationId: "cursor_overflow_tool",
      _clientThreadId: "overflow-tool-result",
      _cursorIdentityScope: "acct-overflow-remint",
    };

    await adapter.runTurn?.(overflowTurnBody("overflow-tool-result"), { headers: new Headers() }, () => {});
    attempts = 0;
    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});
    expect(attempts).toBe(1);
  });

  test("does not overflow-remint compaction turns", async () => {
    clearCursorOverflowRemintForTests();
    let attempts = 0;
    const seen: string[] = [];
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          attempts += 1;
          seen.push(request.conversationId);
          throw bareOverflowError();
        },
        writeClient() {},
      }),
    });

    const body = overflowTurnBody("overflow-compaction");
    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});
    attempts = 0;
    seen.length = 0;
    body._compactionRequest = true;
    body._cursorIsolateConversation = true;
    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});

    expect(attempts).toBe(1);
    expect(seen).toHaveLength(1);
  });

  test("isolated non-compaction helpers preserve parent remint allowance and checkpoint", async () => {
    clearCursorOverflowRemintForTests();
    clearCursorThreadContinuityForTests();
    clearCursorCheckpointsForTests();
    let attempts = 0;
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          throw bareOverflowError();
        },
        writeClient() {},
      }),
    });
    try {
      const owner = "overflow-isolated-helper";
      await adapter.runTurn?.(overflowTurnBody(owner), { headers: new Headers() }, () => {});
      expect(attempts).toBe(1);
      const parentRef = commitCursorCheckpoint({
        conversationId: "cursor_parent_overflow",
        identityScope: "acct-overflow-remint",
        modelId: "default",
        checkpointBytes: toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
          pendingToolCalls: ["overflow-isolation-fixture"],
        })),
        coveredMessageCount: 1,
      });
      expect(parentRef).toBeDefined();
      const helper = overflowTurnBody(owner);
      helper._cursorIsolateConversation = true;
      helper._cursorConversationId = "cursor_parent_overflow";
      helper._providerContinuation = {
        cursor: { conversationId: "cursor_parent_overflow", checkpointUsable: true, checkpointRef: parentRef },
      };
      expect(helper._compactionRequest).toBeUndefined();
      attempts = 0;
      const events: AdapterEvent[] = [];
      await adapter.runTurn?.(helper, { headers: new Headers() }, event => events.push(event));
      expect(attempts).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("Cursor context limit exceeded") });
      expect(getCursorCheckpoint(parentRef)?.ref).toBe(parentRef);
      expect(lookupCursorThreadConversation(owner, "acct-overflow-remint")).toBeUndefined();

      attempts = 0;
      await adapter.runTurn?.(overflowTurnBody(owner), { headers: new Headers() }, () => {});
      expect(attempts).toBe(4);
    } finally {
      clearCursorOverflowRemintForTests();
      clearCursorThreadContinuityForTests();
      clearCursorCheckpointsForTests();
    }
  });

  test("does not overflow-remint after non-heartbeat output was emitted", async () => {
    clearCursorOverflowRemintForTests();
    let attempts = 0;
    let emitPartial = false;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          if (emitPartial) yield { type: "text", text: "partial" } satisfies CursorServerMessage;
          throw bareOverflowError();
        },
        writeClient() {},
      }),
    });

    const body = overflowTurnBody("overflow-after-output");
    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});
    attempts = 0;
    emitPartial = true;
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(1);
    expect(events.some(event => event.type === "text_delta")).toBe(true);
    expect(events.some(event => event.type === "error")).toBe(true);
  });
});


describe("Cursor overflow accounting across requests", () => {
  for (const ownerField of ["_clientThreadId", "_cursorClientThreadId"] as const) {
    test(`${ownerField} retains the cap across successful remints`, async () => {
      clearCursorOverflowRemintForTests();
      clearCursorThreadContinuityForTests();
      let attempts = 0;
      let failNext = true;
      const seen: string[] = [];
      const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
        createTransport: () => ({
          async *run(request) {
            attempts++;
            seen.push(request.conversationId);
            if (failNext) { failNext = false; throw bareOverflowError(); }
            yield { type: "done" } satisfies CursorServerMessage;
          },
          writeClient() {},
        }),
        rekeyContextUsage: () => {},
      });
      const body = () => {
        const parsed = overflowTurnBody();
        parsed._cursorConversationId = undefined;
        parsed[ownerField] = `cross-request-${ownerField}`;
        return parsed;
      };
      await adapter.runTurn?.(body(), { headers: new Headers() }, () => {});
      expect(attempts).toBe(1);
      for (let remint = 0; remint < 3; remint++) {
        failNext = true;
        const before = attempts;
        const priorConversation = seen[seen.length - 1];
        const events: AdapterEvent[] = [];
        await adapter.runTurn?.(body(), { headers: new Headers() }, event => events.push(event));
        expect(attempts - before).toBe(2);
        expect(seen[seen.length - 2]).toBe(priorConversation);
        expect(seen[seen.length - 1]).not.toBe(seen[seen.length - 2]);
        expect(events.some(event => event.type === "done")).toBe(true);
      }
      failNext = true;
      const before = attempts;
      const events: AdapterEvent[] = [];
      await adapter.runTurn?.(body(), { headers: new Headers() }, event => events.push(event));
      expect(attempts - before).toBe(1);
      expect(events.some(event => event.type === "error")).toBe(true);
    });
  }
  test("conversation-only clients never gain an automatic remint allowance", async () => {
    clearCursorOverflowRemintForTests();
    let attempts = 0;
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
      createTransport: () => ({
        async *run() { attempts++; throw bareOverflowError(); },
        writeClient() {},
      }),
    });
    for (let turn = 0; turn < 3; turn++) {
      const events: AdapterEvent[] = [];
      await adapter.runTurn?.(overflowTurnBody(), { headers: new Headers() }, event => events.push(event));
      expect(attempts).toBe(turn + 1);
      expect(events.some(event => event.type === "error")).toBe(true);
    }
  });
});

const INCOMPLETE_TOOL_ERROR =
  `${CURSOR_INCOMPLETE_TOOL_CALL_MESSAGE_PREFIX} call_abc. Arguments may be truncated; the call was not committed.`;

describe("Cursor incomplete-tool conversation remint", () => {
  test("native Composer unpaired tool calls replay with a missing-result placeholder", () => {
    resetCursorBlobStateForTests();
    resetCursorCallIdProvenanceForTests();
    const blobData = (blobId: Uint8Array): Uint8Array => {
      const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
        id: 1,
        message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
      })));
      if (reply.message.case !== "kvClientMessage") return new Uint8Array();
      const kv = reply.message.value;
      return kv.message.case === "getBlobResult" ? kv.message.value.blobData : new Uint8Array();
    };
    try {
      const local = encodeCursorCallId("ocxc1e_");
      const bytes = encodeCursorRunRequest({
        modelId: "composer-2.5",
        conversationId: "c1",
        system: ["You are helpful."],
        messages: [{ role: "user", content: "continue anyway" }],
        rawMessages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/auto",
            timestamp: 2,
            content: [{ type: "toolCall", id: local, name: "read_file", arguments: { path: "a.txt" } }],
          },
          { role: "user", content: "continue anyway", timestamp: 3 },
        ],
      });
      const msg = fromBinary(AgentClientMessageSchema, bytes);
      const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
      const turnIds = run?.conversationState?.turns ?? [];
      expect(turnIds).toHaveLength(1);
      const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnIds[0]!));
      expect(turn.turn.case).toBe("agentConversationTurn");
      const step = fromBinary(ConversationStepSchema, blobData(turn.turn.value.steps[0]!));
      expect(step.message.case).toBe("toolCall");
      const tool = step.message.value.tool;
      expect(tool.case).toBe("mcpToolCall");
      if (tool.case === "mcpToolCall" && tool.value.result?.result.case === "success") {
        expect(tool.value.args?.toolCallId).toBe("ocxc1e_");
        expect(tool.value.result.result.value.isError).toBe(true);
        const content = tool.value.result.result.value.content[0]?.content;
        expect(content?.case).toBe("text");
        if (content?.case === "text") expect(content.value.text).toBe(CURSOR_MISSING_TOOL_RESULT);
      }
    } finally {
      resetCursorBlobStateForTests();
    }
  });

  test("remints after a streamed incomplete-tool error and persists the thread override", async () => {
    clearCursorIncompleteToolRemintForTests();
    clearCursorThreadContinuityForTests();
    let attempts = 0;
    const seen: string[] = [];
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          attempts += 1;
          seen.push(request.conversationId);
          if (attempts === 1) {
            yield { type: "error", message: INCOMPLETE_TOOL_ERROR } satisfies CursorServerMessage;
            return;
          }
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
      rekeyContextUsage: () => {},
    });

    const threadId = "incomplete-tool-remint-thread";
    const body: OcxParsedRequest = {
      modelId: "cursor/grok-4.6",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      stream: false,
      options: {},
      _cursorIdentityScope: "acct-incomplete-tool-remint",
      _clientThreadId: threadId,
    };

    const firstEvents: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => firstEvents.push(event));

    expect(attempts).toBe(1);
    expect(firstEvents).toEqual([
      { type: "error", message: INCOMPLETE_TOOL_ERROR },
    ]);
    expect(body._cursorConversationId).toBeDefined();
    expect(body._cursorConversationId).not.toBe(seen[0]);
    expect(lookupCursorThreadConversation(threadId, "acct-incomplete-tool-remint")).toBe(body._cursorConversationId);

    const secondEvents: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => secondEvents.push(event));

    expect(attempts).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(body._cursorConversationId);
    expect(seen[1]).not.toBe(seen[0]);
    expect(secondEvents.some(event => event.type === "done")).toBe(true);
  });

  test("compaction storage isolation preserves the stable thread override without relying on the isolate flag", async () => {
    clearCursorIncompleteToolRemintForTests();
    clearCursorThreadContinuityForTests();
    const owner = "incomplete-tool-compaction";
    const identityScope = "acct-incomplete-tool-remint";
    const stableConversation = "cursor_parent_stable";
    rememberCursorThreadConversation(owner, stableConversation, identityScope);
    const seen: string[] = [];
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
      createTransport: () => ({
        async *run(request) {
          seen.push(request.conversationId);
          yield { type: "error", message: INCOMPLETE_TOOL_ERROR } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });
    const compaction: OcxParsedRequest = {
      modelId: "cursor/grok-4.6",
      context: { messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
      stream: false,
      options: {},
      _compactionRequest: true,
      _cursorConversationId: "cursor_compaction_turn",
      _cursorIdentityScope: identityScope,
      _clientThreadId: owner,
    };

    await adapter.runTurn?.(compaction, { headers: new Headers() }, () => {});

    expect(compaction._cursorIsolateConversation).toBeUndefined();
    expect(seen).toEqual(["cursor_compaction_turn"]);
    expect(compaction._cursorConversationId).toBe("cursor_compaction_turn");
    expect(lookupCursorThreadConversation(owner, identityScope)).toBe(stableConversation);
  });

  test("the fourth incomplete-tool truncation keeps the conversation and records exhaustion", async () => {
    clearCursorIncompleteToolRemintForTests();
    clearCursorThreadContinuityForTests();
    resetDebugLogBufferForTests();
    setDebugSettings({ debug: true });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
      createTransport: () => ({
        async *run(request) {
          seen.push(request.conversationId);
          yield { type: "error", message: INCOMPLETE_TOOL_ERROR } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
      rekeyContextUsage: () => {},
    });
    const owner = "incomplete-tool-cap";
    const body: OcxParsedRequest = {
      modelId: "cursor/grok-4.6",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      stream: false,
      options: {},
      _cursorIdentityScope: "acct-incomplete-tool-remint",
      _clientThreadId: owner,
    };

    try {
      for (let truncation = 0; truncation < 3; truncation++) {
        await adapter.runTurn?.(body, { headers: new Headers() }, () => {});
        expect(body._cursorConversationId).not.toBe(seen.at(-1));
      }
      const retainedConversation = body._cursorConversationId;
      await adapter.runTurn?.(body, { headers: new Headers() }, () => {});

      expect(seen).toHaveLength(4);
      expect(seen.at(-1)).toBe(retainedConversation);
      expect(body._cursorConversationId).toBe(retainedConversation);
      expect(lookupCursorThreadConversation(owner, "acct-incomplete-tool-remint")).toBe(retainedConversation);
      expect(getDebugLogEntries().some(entry => entry.line.includes("[ocx:cursor:incomplete-tool-remint-exhausted]"))).toBe(true);
    } finally {
      consoleError.mockRestore();
      resetDebugSettingsForTests();
      resetDebugLogBufferForTests();
      clearCursorIncompleteToolRemintForTests();
      clearCursorThreadContinuityForTests();
    }
  });

  test("a clean completed turn replenishes the incomplete-tool remint budget", async () => {
    clearCursorIncompleteToolRemintForTests();
    clearCursorThreadContinuityForTests();
    let incomplete = true;
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
      createTransport: () => ({
        async *run() {
          if (incomplete) {
            yield { type: "error", message: INCOMPLETE_TOOL_ERROR } satisfies CursorServerMessage;
          } else {
            yield { type: "done" } satisfies CursorServerMessage;
          }
        },
        writeClient() {},
      }),
      rekeyContextUsage: () => {},
    });
    const body: OcxParsedRequest = {
      modelId: "cursor/grok-4.6",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      stream: false,
      options: {},
      _cursorIdentityScope: "acct-incomplete-tool-remint",
      _clientThreadId: "incomplete-tool-clean-reset",
    };

    for (let truncation = 0; truncation < 3; truncation++) {
      await adapter.runTurn?.(body, { headers: new Headers() }, () => {});
    }
    incomplete = false;
    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});
    incomplete = true;
    const beforeRecoveredTruncation = body._cursorConversationId;
    await adapter.runTurn?.(body, { headers: new Headers() }, () => {});

    expect(body._cursorConversationId).not.toBe(beforeRecoveredTruncation);
  });

  test("incomplete-tool and overflow remint budgets do not consume or replenish each other", () => {
    clearCursorIncompleteToolRemintForTests();
    clearCursorOverflowRemintForTests();
    const incompleteScope = cursorIncompleteToolRemintScopeKey("independent-remint-budgets", "acct-remint-budget");
    const overflowScope = cursorOverflowRemintScopeKey("independent-remint-budgets", "acct-remint-budget");
    expect(incompleteScope).toBe(overflowScope);
    if (!incompleteScope || !overflowScope) throw new Error("stable thread owner must produce remint scopes");

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(recordCursorIncompleteToolRemint(incompleteScope)).toBe(true);
    }
    expect(recordCursorIncompleteToolRemint(incompleteScope)).toBe(false);
    expect(shouldSkipCursorOverflowRemint(overflowScope)).toBe(false);
    markCursorOverflowSurfaced(overflowScope);
    expect(recordCursorOverflowRemint(overflowScope)).toBe(true);

    clearCursorIncompleteToolRemintForTests();
    clearCursorOverflowRemintForTests();
    markCursorOverflowSurfaced(overflowScope);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(recordCursorOverflowRemint(overflowScope)).toBe(true);
    }
    expect(shouldSkipCursorOverflowRemint(overflowScope)).toBe(true);
    expect(recordCursorIncompleteToolRemint(incompleteScope)).toBe(true);
    clearCursorIncompleteToolRemint(incompleteScope);
    expect(shouldSkipCursorOverflowRemint(overflowScope)).toBe(true);
  });

  test("bounds incomplete-tool remint state to the shared entry cap", () => {
    clearCursorIncompleteToolRemintForTests();
    for (let index = 0; index < CURSOR_INCOMPLETE_TOOL_REMINT_MAX_ENTRIES + 20; index++) {
      const scope = cursorIncompleteToolRemintScopeKey(`incomplete-retention-${index}`, "acct-remint-budget");
      if (!scope) throw new Error("stable thread owner must produce an incomplete-tool scope");
      expect(recordCursorIncompleteToolRemint(scope)).toBe(true);
    }
    expect(cursorIncompleteToolRemintCountForTests()).toBe(CURSOR_INCOMPLETE_TOOL_REMINT_MAX_ENTRIES);
    clearCursorIncompleteToolRemintForTests();
  });

  test("isolated helpers do not remint or park a throwaway id on the parent thread", async () => {
    clearCursorIncompleteToolRemintForTests();
    clearCursorThreadContinuityForTests();
    clearCursorCheckpointsForTests();
    const seen: string[] = [];
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, {
      createTransport: () => ({
        async *run(request) {
          seen.push(request.conversationId);
          yield { type: "error", message: INCOMPLETE_TOOL_ERROR } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });

    try {
      const owner = "incomplete-tool-isolated-helper";
      const parentRef = commitCursorCheckpoint({
        conversationId: "cursor_parent_incomplete",
        identityScope: "acct-incomplete-tool-remint",
        modelId: "default",
        checkpointBytes: toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
          pendingToolCalls: ["incomplete-isolation-fixture"],
        })),
        coveredMessageCount: 1,
      });
      expect(parentRef).toBeDefined();

      const helper: OcxParsedRequest = {
        modelId: "cursor/grok-4.6",
        context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        stream: false,
        options: {},
        _cursorIsolateConversation: true,
        _cursorConversationId: "cursor_parent_incomplete",
        _cursorIdentityScope: "acct-incomplete-tool-remint",
        _clientThreadId: owner,
        _providerContinuation: {
          cursor: { conversationId: "cursor_parent_incomplete", checkpointUsable: true, checkpointRef: parentRef },
        },
      };
      const events: AdapterEvent[] = [];
      await adapter.runTurn?.(helper, { headers: new Headers() }, event => events.push(event));

      expect(seen).toHaveLength(1);
      expect(events).toEqual([{ type: "error", message: INCOMPLETE_TOOL_ERROR }]);
      expect(helper._cursorConversationId).toBe(seen[0]);
      expect(getCursorCheckpoint(parentRef)?.ref).toBe(parentRef);
      expect(lookupCursorThreadConversation(owner, "acct-incomplete-tool-remint")).toBeUndefined();
    } finally {
      clearCursorThreadContinuityForTests();
      clearCursorCheckpointsForTests();
    }
  });
});
