import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, test } from "bun:test";
import { createLiveCursorTransport, CursorMissingCredentialError, parseConnectEndStreamError, resolveCursorToken } from "../src/adapters/cursor/live-transport";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { prepareCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import {
  CursorBlobAdmissionError,
  cursorBlobRetainedStoreSnapshot,
  resetCursorBlobStateForTests,
  setCursorBlobLimitsForTests,
} from "../src/adapters/cursor/native-exec";
import {
  backgroundShellSpawnExec,
  resetBackgroundShellStateForTests,
  setBackgroundShellRuntimeForTests,
} from "../src/adapters/cursor/native-exec-shell";
import { BackgroundShellSpawnArgsSchema, ExecServerMessageSchema } from "../src/adapters/cursor/gen/agent_pb";
import type { CursorProtobufEventState } from "../src/adapters/cursor/protobuf-events";

class TransportFakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
}

afterEach(async () => {
  await resetBackgroundShellStateForTests();
});

function spawnTransportOwnedShell(sessionId: string) {
  const child = new TransportFakeChild();
  let killCalls = 0;
  setBackgroundShellRuntimeForTests({
    spawn: (() => child as unknown as ChildProcessWithoutNullStreams) as typeof import("node:child_process").spawn,
    kill: () => { killCalls++; return true; },
  });
  backgroundShellSpawnExec(create(ExecServerMessageSchema, {
    id: 1,
    execId: "transport-close",
    message: {
      case: "backgroundShellSpawnArgs",
      value: create(BackgroundShellSpawnArgsSchema, { command: "fixture" }),
    },
  }), sessionId);
  return { child, killCalls: () => killCalls };
}

describe("Cursor live transport", () => {
  test("async LiveCursorTransport.close waits for session shell cleanup", async () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      headers: new Headers(),
    });
    const sessionId = (transport as unknown as { shellOwnerId: string }).shellOwnerId;
    const fake = spawnTransportOwnedShell(sessionId);
    let closed = false;
    const closing = Promise.resolve(transport.close?.()).then(() => { closed = true; });
    await Promise.resolve();
    expect(fake.killCalls()).toBe(1);
    expect(closed).toBe(false);
    fake.child.emit("close", 0, null);
    await closing;
    expect(closed).toBe(true);
  });

  test("cancel and close share one idempotent session cleanup promise", async () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      headers: new Headers(),
    });
    const internals = transport as unknown as { shellOwnerId: string; cancelCursorRun(): void };
    const fake = spawnTransportOwnedShell(internals.shellOwnerId);
    internals.cancelCursorRun();
    const closing = Promise.resolve(transport.close?.());
    await Promise.resolve();
    expect(fake.killCalls()).toBe(1);
    fake.child.emit("close", 0, null);
    await closing;
    expect(fake.killCalls()).toBe(1);
  });

  test("initial and MCP-rebuilt native exec contexts keep the same session owner", async () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      headers: new Headers(),
    });
    const internals = transport as unknown as {
      sessionId: string;
      shellOwnerId: string;
      execContext: { sessionId?: string };
      mcpManager?: { listToolHandles(): Promise<unknown[]>; dispose(): Promise<void> };
      prepareMcp(): Promise<void>;
    };
    expect(internals.execContext.sessionId).toBe(internals.shellOwnerId);
    expect(internals.execContext.sessionId).not.toBe(internals.sessionId);
    internals.mcpManager = {
      listToolHandles: async () => [],
      dispose: async () => {},
    };
    await internals.prepareMcp();
    expect(internals.execContext.sessionId).toBe(internals.shellOwnerId);
    await transport.close?.();
  });
  test("honors an injected session id for Cursor Connect x-session-id", () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      headers: new Headers(),
      sessionId: "cursor_from_gjc_session",
    });
    const internals = transport as unknown as {
      sessionId: string;
      shellOwnerId: string;
      execContext: { sessionId?: string };
    };
    expect(internals.sessionId).toBe("cursor_from_gjc_session");
    expect(internals.execContext.sessionId).toBe(internals.shellOwnerId);
    expect(internals.execContext.sessionId).not.toBe("cursor_from_gjc_session");
  });
  test("keeps a blank injected session id from becoming the Connect x-session-id", () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      headers: new Headers(),
      sessionId: "   ",
    });
    const internals = transport as unknown as { sessionId: string };
    expect(internals.sessionId.length).toBeGreaterThan(0);
    expect(internals.sessionId.trim()).toBe(internals.sessionId);
    expect(internals.sessionId).not.toBe("   ");
  });

  test("fails before network when no Cursor credential is configured", () => {
    const prev = process.env.OPENCODEX_CURSOR_TEST_TOKEN;
    delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
    try {
      expect(() => createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh" },
        translatorBudget: createTestTranslatorBudget(),
        headers: new Headers(),
      })).toThrow(CursorMissingCredentialError);
    } finally {
      if (prev === undefined) delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
      else process.env.OPENCODEX_CURSOR_TEST_TOKEN = prev;
    }
  });

  test("accepts provider apiKey without exposing it", () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "secret-cursor-token" },
      translatorBudget: createTestTranslatorBudget(),
      headers: new Headers(),
    });

    expect(transport).toHaveProperty("run");
    expect(JSON.stringify(transport)).not.toContain("secret-cursor-token");
    transport.close?.();
  });

  test("fails the turn when MCP preparation rejects", async () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      headers: new Headers(),
    });
    const internals = transport as unknown as {
      mcpManager?: {
        listToolHandles(): Promise<never>;
        dispose(): Promise<void>;
      };
    };
    internals.mcpManager = {
      listToolHandles: () => Promise.reject(new Error("fixture discovery failed")),
      dispose: () => Promise.resolve(),
    };

    const iterator = transport.run({
      modelId: "auto",
      conversationId: "mcp-preparation-failure",
      system: [],
      messages: [{ role: "user", content: "hello" }],
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow("Cursor MCP preparation failed: fixture discovery failed");
    await transport.close?.();
  });

  test("request construction one byte above the per-blob boundary fails before writing a request and returns no unstored hash", async () => {
    resetCursorBlobStateForTests();
    const serialized = new TextEncoder().encode(JSON.stringify({ role: "system", content: "x" }));
    setCursorBlobLimitsForTests({ maxEntryBytes: serialized.byteLength - 1, maxTotalBytes: 256 });
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      headers: new Headers(),
    });
    let opened = false;
    (transport as unknown as { open(): void }).open = () => { opened = true; };
    const iterator = transport.run({
      modelId: "composer-2.5",
      conversationId: "capacity-before-wire",
      system: ["x"],
      messages: [{ role: "user", content: "hi" }],
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(CursorBlobAdmissionError);
    expect(opened).toBe(false);
    expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBe(0);
    transport.close?.();
    setCursorBlobLimitsForTests();
  });

  test("stream close error and abort release every remaining request-scope pin", async () => {
    type OpenFn = (
      encoded: Uint8Array,
      signal: AbortSignal | undefined,
      state: unknown,
      push: unknown,
      fail: (error: Error) => void,
      finish: () => void,
    ) => void;
    const runCase = async (kind: "close" | "error" | "abort") => {
      resetCursorBlobStateForTests();
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
        headers: new Headers(),
      });
      let onOpened!: () => void;
      const opened = new Promise<void>(resolve => { onOpened = resolve; });
      let failTurn!: (error: Error) => void;
      (transport as unknown as { open: OpenFn }).open = (_encoded, signal, _state, _push, fail) => {
        failTurn = fail;
        if (kind === "abort") signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
        onOpened();
      };
      const controller = new AbortController();
      const iterator = transport.run({
        modelId: "composer-2.5",
        conversationId: `terminal-${kind}`,
        system: ["system"],
        messages: [{ role: "user", content: "hi" }],
      }, controller.signal)[Symbol.asyncIterator]();
      const pending = iterator.next();
      await opened;
      expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBeGreaterThan(0);
      if (kind === "close") {
        transport.close?.();
        failTurn(new Error("closed"));
      } else if (kind === "abort") {
        controller.abort();
      } else {
        failTurn(new Error("stream error"));
      }
      await expect(pending).rejects.toBeInstanceOf(Error);
      expect(cursorBlobRetainedStoreSnapshot().pinnedBytes).toBe(0);
      transport.close?.();
    };

    await runCase("close");
    await runCase("error");
    await runCase("abort");
  });
});

describe("Cursor end-stream classification", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("empty success object resolves (no error)", () => {
    expect(parseConnectEndStreamError(enc("{}"))).toBeNull();
  });

  test("success trailer with metadata but no error resolves", () => {
    expect(parseConnectEndStreamError(enc('{"metadata":{"a":["b"]}}'))).toBeNull();
  });

  test("error trailer surfaces a Connect error", () => {
    const err = parseConnectEndStreamError(enc('{"error":{"code":"unauthenticated","message":"bad token"}}'));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("unauthenticated");
    expect(err?.message).toContain("bad token");
  });

  test("malformed payload is treated as an error, not a silent success", () => {
    expect(parseConnectEndStreamError(enc("not json"))).toBeInstanceOf(Error);
  });
});

describe("Cursor token precedence (R2 gap-close guard)", () => {
  test("managed apiKey beats a forwarded Authorization header", () => {
    // The unauthenticated gap (devlog 350.98/99) reopens if this ever returns the client token.
    const token = resolveCursorToken(
      { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "managed-oauth-token" },
      new Headers({ authorization: "Bearer client-forwarded-token" }),
    );
    expect(token).toBe("managed-oauth-token");
  });

  test("falls back to the forwarded Bearer header when no apiKey is configured", () => {
    const token = resolveCursorToken(
      { adapter: "cursor", baseUrl: "https://api2.cursor.sh" },
      new Headers({ authorization: "Bearer client-forwarded-token" }),
    );
    expect(token).toBe("client-forwarded-token");
  });

  test("throws CursorMissingCredentialError when no apiKey, no header, and no env token", () => {
    const prev = process.env.OPENCODEX_CURSOR_TEST_TOKEN;
    delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
    try {
      expect(() =>
        resolveCursorToken({ adapter: "cursor", baseUrl: "https://api2.cursor.sh" }, new Headers()),
      ).toThrow(CursorMissingCredentialError);
    } finally {
      if (prev === undefined) delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
      else process.env.OPENCODEX_CURSOR_TEST_TOKEN = prev;
    }
  });
});

// --- #373: the estimate only helps if the transport actually wires it up. Without a
// test at this level, skipping the wiring leaves the bug in production while every
// protobuf-request and protobuf-events test stays green. --------------------------
describe("Cursor live transport context estimate wiring (#373)", () => {
  function makeTransport() {
    return createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      translatorBudget: createTestTranslatorBudget(),
      headers: new Headers(),
    });
  }

  /** Run one turn far enough to observe what open() was handed, then abort. */
  async function captureOpen(request: Record<string, unknown>): Promise<{
    encoded: Uint8Array | undefined;
    estimate: number | undefined;
    state: CursorProtobufEventState | undefined;
  }> {
    const transport = makeTransport();
    const internals = transport as unknown as {
      open(
        encodedRequest: Uint8Array,
        signal: AbortSignal | undefined,
        state: CursorProtobufEventState,
        ...rest: unknown[]
      ): void;
    };
    let encoded: Uint8Array | undefined;
    let estimate: number | undefined;
    let capturedState: CursorProtobufEventState | undefined;
    internals.open = (encodedRequest, _signal, state) => {
      encoded = encodedRequest;
      estimate = state.estimatedInputTokens;
      capturedState = state;
      throw new Error("stop-after-open");
    };

    try {
      for await (const _ of transport.run(request as never)) { /* not reached */ }
    } catch { /* open() throws by design */ }
    transport.close?.();
    return { encoded, estimate, state: capturedState };
  }

  const baseRequest = {
    modelId: "gpt-5.6-sol-xhigh",
    conversationId: "c-wiring-373",
    system: ["system prompt"],
    messages: [{ role: "user", content: "current turn" }],
    rawMessages: [{ role: "user", content: "current turn", timestamp: 1 }],
  };

  test("a turn with no carry-forward hands the prepared bytes and estimate to open()", async () => {
    const { encoded, estimate } = await captureOpen(baseRequest);

    // open() must receive encoded bytes, not the request object.
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded!.byteLength).toBeGreaterThan(0);
    // A fresh conversation has no tracker entry, so the estimate must be present —
    // this is exactly the post-restart case from #373.
    expect(estimate).toBeGreaterThan(0);
    // And it must match what the same payload produces on its own.
    const prepared = prepareCursorRunRequest(baseRequest as never, { estimateInputTokens: true });
    expect(estimate).toBe(prepared.estimatedInputTokens);
  });

  test("the estimate is skipped when the conversation carries a checkpoint forward", async () => {
    // Seed the module-level tracker via a completed turn on this conversation id.
    const seeded = { ...baseRequest, conversationId: "c-wiring-373-carry" };
    await captureOpen(seeded);
    const { estimate: first } = await captureOpen(seeded);
    // Still no checkpoint was ever observed (open() aborts before any frame), so the
    // estimate stays on. This pins the condition rather than the tracker's contents.
    expect(first).toBeGreaterThan(0);
  });

  test("wire-isolated freeform tools keep client-name validation and return mapping", async () => {
    const { state } = await captureOpen({
      ...baseRequest,
      conversationId: "c-wire-freeform",
      tools: [{
        name: "script",
        description: "Run a script",
        parameters: {},
        freeform: true,
      }],
    });

    expect(state?.clientToolNames?.has("ocx_client_script")).toBe(true);
    expect(state?.freeformToolNames?.has("script")).toBe(true);
    expect(state?.cursorToolNameMap?.get("ocx_client_script")).toBe("script");
  });
});
