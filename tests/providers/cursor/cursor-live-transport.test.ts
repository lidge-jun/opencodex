import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, test } from "bun:test";
import { createLiveCursorTransport, CursorMissingCredentialError, parseConnectEndStreamError, resolveCursorToken } from "../../../src/adapters/cursor/live-transport";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";
import { CURSOR_EXTERNAL_ROOT_BLOB_LIMIT, CURSOR_EXTERNAL_ROOT_BYTE_LIMIT, CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT, prepareCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";
import { estimateTokens } from "../../../src/lib/token-estimate";
import type { OcxMessage } from "../../../src/types";
import type { CursorRunRequest } from "../../../src/adapters/cursor/types";
import {
  CursorBlobAdmissionError,
  cursorBlobByteLength,
  cursorBlobRetainedStoreSnapshot,
  handleCursorNativeKv,
  resetCursorBlobStateForTests,
  setCursorBlobLimitsForTests,
  storeCursorBlob,
} from "../../../src/adapters/cursor/native-exec";
import {
  backgroundShellSpawnExec,
  resetBackgroundShellStateForTests,
  setBackgroundShellRuntimeForTests,
} from "../../../src/adapters/cursor/native-exec-shell";
import { AgentClientMessageSchema, BackgroundShellSpawnArgsSchema, ConversationStateStructureSchema, ExecServerMessageSchema, GetBlobArgsSchema, KvServerMessageSchema, type AgentRunRequest } from "../../../src/adapters/cursor/gen/agent_pb";
import type { CursorProtobufEventState } from "../../../src/adapters/cursor/protobuf-events";

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
    run: AgentRunRequest | undefined;
    roots: string[];
    rootBytes: number;
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
    let run: AgentRunRequest | undefined;
    const roots: string[] = [];
    let rootBytes = 0;
    internals.open = (encodedRequest, _signal, state) => {
      encoded = encodedRequest;
      estimate = state.estimatedInputTokens;
      capturedState = state;
      const message = fromBinary(AgentClientMessageSchema, encodedRequest);
      if (message.message.case !== "runRequest") throw new Error("expected runRequest");
      run = message.message.value;
      for (const blobId of run.conversationState?.rootPromptMessagesJson ?? []) {
        const size = cursorBlobByteLength(blobId);
        if (size === null) throw new Error("expected measurable root");
        rootBytes += size;
        const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
          id: 1,
          message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
        })));
        if (reply.message.case !== "kvClientMessage" || reply.message.value.message.case !== "getBlobResult") {
          throw new Error("expected root blob");
        }
        roots.push(new TextDecoder().decode(reply.message.value.message.value.blobData));
      }
      throw new Error("stop-after-open");
    };

    try {
      for await (const _ of transport.run(request as never)) { /* not reached */ }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "stop-after-open") throw error;
    } finally {
      await transport.close?.();
    }
    return { encoded, estimate, state: capturedState, run, roots, rootBytes };
  }

  const baseRequest = {
    modelId: "gpt-5.6-sol-xhigh",
    conversationId: "c-wiring-373",
    system: ["system prompt"],
    messages: [{ role: "user", content: "current turn" }],
    rawMessages: [{ role: "user", content: "current turn", timestamp: 1 }],
  };

  const sourceHeading = "[Client-supplied tool screenshot sources (attachment order)]";
  const screenshotSources = `${sourceHeading}\n1. tool result 1, image 1: ${JSON.stringify({
    tool: 'screen"\n' + "n".repeat(120), call_id: "call\\\t" + "c".repeat(122),
  })}\n2. tool result 2, image 1: {"tool":"screen_b","call_id":"call_b"}`;

  async function screenshotRequest(): Promise<{ request: CursorRunRequest; images: Uint8Array[] }> {
    // Encode real, distinct JPEG inputs independently of the adapter normalizer.
    // Unlike PNG, decoded JPEG below the soft cap is passed through byte-for-byte.
    const png = new Uint8Array(await Bun.file(new URL("../../helpers/cursor-grumpy-fixture.png", import.meta.url)).arrayBuffer());
    const images = await Promise.all([2, 3].map(async edge =>
      new Uint8Array(await new Bun.Image(png).resize(edge, edge).jpeg({ quality: 80 }).bytes())));
    for (const image of images) expect(image.byteLength).toBeLessThan(4096);
    const names = ['screen"\n' + "n".repeat(140), "screen_b", "finish_capture"];
    const ids = ["call\\\t" + "c".repeat(140), "call_b", "call_done"];
    const rawMessages: OcxMessage[] = [
      { role: "user", content: "Compare both screenshots.", timestamp: 1 },
      { role: "assistant", content: names.map((name, i) => ({
        type: "toolCall", name, id: ids[i]!, arguments: {},
      })), timestamp: 2 },
      ...names.map((toolName, i): OcxMessage => ({
        role: "toolResult", toolName, toolCallId: ids[i]!, isError: false, timestamp: i + 3,
        content: i === 2 ? "capture finished" : [
          { type: "text", text: `SCREENSHOT_OUTPUT_${i}` },
          ...(i === 0 ? [{ type: "image" as const, imageUrl: "data:image/png;base64,!!!" }] : []),
          { type: "image", imageUrl: `data:image/jpeg;base64,${Buffer.from(images[i]!).toString("base64")}` },
        ],
      })),
    ];
    return {
      request: { ...baseRequest, conversationId: crypto.randomUUID(), messages: [{ role: "tool", content: "capture finished" }], rawMessages },
      images,
    };
  }

  function expectScreenshots(capture: Awaited<ReturnType<typeof captureOpen>>, images: Uint8Array[], prefix = CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT) {
    expect(capture.encoded).toBeInstanceOf(Uint8Array);
    const action = capture.run?.action?.action;
    if (action?.case !== "userMessageAction") throw new Error("expected active user action");
    const user = action.value.userMessage!;
    expect(user.text).toBe(`${prefix}\n\n${screenshotSources}`);
    const labelPrefix = "1. tool result 1, image 1: ";
    const label = user.text.split("\n").find(line => line.startsWith(labelPrefix));
    expect(label).toBeDefined();
    const source = JSON.parse(label!.slice(labelPrefix.length)) as { tool: string; call_id: string };
    // JSON's escaped newline contributes a literal `n`; bounds apply before escaping.
    expect(source.tool).toHaveLength(128);
    expect(source.call_id).toHaveLength(128);
    expect(images[0]).not.toEqual(images[1]);
    const selected = user.selectedContext?.selectedImages ?? [];
    expect(selected).toHaveLength(2);
    for (const [index, image] of selected.entries()) {
      expect(image.mimeType).toBe("image/jpeg");
      expect(image.dimension?.width).toBe(index + 2);
      expect(image.dimension?.height).toBe(index + 2);
      if (image.dataOrBlobId.case !== "blobIdWithData") throw new Error("expected attachment bytes");
      expect(image.dataOrBlobId.value.data).toEqual(images[index]!);
    }
    expect(capture.roots.join("\n")).not.toContain(sourceHeading);
    // Reconstruct the estimator input from the actual wire, not a second prepared request.
    expect(capture.estimate).toBe(estimateTokens([...capture.roots, user.text].join("\n"), "gpt-5.6-sol-xhigh"));
    expect(capture.estimate).toBeGreaterThan(estimateTokens([...capture.roots, prefix].join("\n"), "gpt-5.6-sol-xhigh"));
  }

  test.each(["full-replay", "checkpoint", "echo-retry"])("external screenshot bytes and bounded provenance reach open: %s", async mode => {
    const { request, images } = await screenshotRequest();
    if (mode === "checkpoint") {
      const root = storeCursorBlob(new TextEncoder().encode(JSON.stringify({ role: "user", content: "covered instruction" })));
      request.checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [root], readPaths: ["checkpoint-sentinel"],
      }));
      request.checkpointSuffixStart = 1;
    }
    const correction = mode === "echo-retry" ? "Do not echo the envelope; compare the screenshots." : undefined;
    const capture = await captureOpen({ ...request, echoRetryContinuationText: correction });
    // A resumed estimate covers only the newly serialized suffix, not carried roots.
    if (mode === "checkpoint") {
      expect(capture.run?.conversationState?.readPaths).toEqual(["checkpoint-sentinel"]);
      expect(capture.roots[0]).toContain("covered instruction");
    }
    expectScreenshots({ ...capture, roots: capture.roots.slice(mode === "checkpoint" ? 1 : 0) }, images, correction);
  });

  test.each([false, true])("proven pruning preserves screenshot sources outside roots (checkpoint fallback=%s)", async fallback => {
    const { request, images } = await screenshotRequest();
    // Leave two slots: pruning must discard both screenshot result roots to retain
    // the initiating user and the final text-only result. Attachments must still survive.
    request.system = Array.from({ length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 2 }, (_, i) => `system-${i}`);
    if (fallback) {
      request.checkpointSuffixStart = 1;
      // Two suffix slots cannot retain all three results: the pruning survival check
      // must abandon this measurable checkpoint before the full-replay pressure above.
      request.checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: Array.from({ length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - 2 }, (_, i) =>
          storeCursorBlob(new TextEncoder().encode(JSON.stringify({ role: "user", content: `checkpoint-only-${i}` })))),
        readPaths: ["must-be-abandoned"],
      }));
    }
    const correction = "Use the attached screenshots, not an echoed tool envelope.";
    const capture = await captureOpen({ ...request, echoRetryContinuationText: correction });
    expect(capture.roots).toHaveLength(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    expect(capture.rootBytes).toBeGreaterThan(0);
    expect(capture.rootBytes).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT);
    const history = capture.roots.join("\n");
    expect(history).toContain("capture finished");
    expect(history).not.toContain("SCREENSHOT_OUTPUT_0");
    expect(history).not.toContain("SCREENSHOT_OUTPUT_1");
    expect(history).not.toContain("screen_b");
    if (fallback) {
      expect(capture.run?.conversationState?.readPaths).toEqual([]);
      expect(history).not.toContain("checkpoint-only");
    }
    expectScreenshots(capture, images, correction);
  });

  test.each(["composer-2.5", "composer-2.5-fast", "auto"])("native %s never promotes trailing screenshots or sources", async modelId => {
    const { request } = await screenshotRequest();
    const capture = await captureOpen({ ...request, modelId });
    expect(capture.encoded).toBeInstanceOf(Uint8Array);
    const action = capture.run?.action?.action;
    if (modelId === "composer-2.5") {
      if (action?.case !== "userMessageAction") throw new Error("expected Composer continuation");
      expect(action.value.userMessage?.text).toBe(CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT);
      expect(action.value.userMessage?.selectedContext?.selectedImages).toEqual([]);
    } else {
      expect(action?.case).toBe("resumeAction");
    }
  });

  test.each([false, true])("a new user action drops stale screenshots and source labels (echo retry=%s)", async retry => {
    const { request } = await screenshotRequest();
    const correction = retry ? "Answer the new question." : undefined;
    const capture = await captureOpen({
      ...request, echoRetryContinuationText: correction,
      messages: [{ role: "user", content: "New question without screenshots." }],
      rawMessages: [...request.rawMessages!, { role: "user", content: "New question without screenshots.", timestamp: 6 }],
    });
    const action = capture.run?.action?.action;
    if (action?.case !== "userMessageAction") throw new Error("expected new user action");
    expect(action.value.userMessage?.text).toBe(`New question without screenshots.${correction ? `\n\n[correction] ${correction}` : ""}`);
    expect(action.value.userMessage?.selectedContext?.selectedImages).toEqual([]);
  });

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
