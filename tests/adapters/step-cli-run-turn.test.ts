import { describe, expect, test } from "bun:test";

import {
  createStepCliAdapter,
  handleReverseRequest,
  handleRuntimeEvent,
  latestToolResult,
  projectToolResultContent,
} from "../../src/adapters/step-cli/adapter";
import type {
  StepConversationHost,
  StepConversationRef,
  StepConversationSession,
  StepHeldTool,
} from "../../src/adapters/step-cli/session-pool";
import {
  STEP_PROTOCOL_NAME,
  STEP_PROTOCOL_VERSION,
  type StepFrame,
} from "../../src/adapters/step-cli/stdio-frames";
import {
  didRunOptionalShutdownHooks,
  resetOptionalShutdownHooksForTests,
  runOptionalShutdownHooks,
} from "../../src/lib/optional-shutdown-hooks";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";

/**
 * A fake StepCode process.
 *
 * It exists so these tests drive the REAL `handleReverseRequest`, the REAL `handleRuntimeEvent` and
 * the REAL `runTurn`. The previous round's defects all lived in code the suite never executed, and a
 * mirror-based test would have passed just as happily over them — so nothing here reimplements the
 * behaviour under test.
 */
class FakeSession implements StepConversationSession {
  sessionId = "sess-1";
  closed = false;
  handshakeCount = 0;
  readonly allowed: string[] = [];
  readonly denied: Array<{ id: string; reason: string }> = [];
  readonly refused: Array<{ id: string; reason: string }> = [];
  readonly delivered: Array<{ id: string; result: unknown }> = [];
  readonly queries: Array<{ queryId: string; model?: string; sdkTools: unknown[] }> = [];
  readonly inputs: Array<{ queryId: string; text: string }> = [];
  readonly interrupts: string[] = [];
  readonly inputEnds: string[] = [];
  /** Frames the fake streams once a turn is under way, in order. */
  stream: StepFrame[] = [];
  #n = 0;

  /** Deliver a frame immediately, standing in for the CLI streaming it at this moment. */
  emitNow(frame: StepFrame): void {
    if (frame.kind === "request") handleReverseRequest(this, frame);
    else handleRuntimeEvent(this, frame);
  }

  async handshake(): Promise<StepFrame> {
    this.handshakeCount += 1;
    return {
      protocol: STEP_PROTOCOL_NAME,
      version: STEP_PROTOCOL_VERSION,
      kind: "response",
      id: "r",
      replyTo: "init",
      payload: {},
    };
  }

  async startQuery(options: { model?: string; sdkTools: unknown[] }): Promise<{ queryId: string; sessionId: string }> {
    this.#n += 1;
    const queryId = `q_${this.#n}`;
    this.queries.push({ queryId, model: options.model, sdkTools: options.sdkTools });
    this.#flush();
    return { queryId, sessionId: this.sessionId };
  }

  async sendInput(queryId: string, text: string): Promise<void> {
    this.inputs.push({ queryId, text });
    this.#flush();
  }

  async interrupt(queryId: string): Promise<void> {
    this.interrupts.push(queryId);
  }

  async endInput(queryId: string): Promise<void> {
    this.inputEnds.push(queryId);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  allowPermission(frame: StepFrame): void {
    this.allowed.push(frame.id);
  }

  denyPermission(frame: StepFrame, reason: string): void {
    this.denied.push({ id: frame.id, reason });
  }

  refuseToolCall(frame: StepFrame, reason: string): void {
    this.refused.push({ id: frame.id, reason });
  }

  resolveHeldToolResult(frame: StepFrame, result: unknown): boolean {
    this.delivered.push({ id: frame.id, result });
    this.#flush();
    return true;
  }

  /**
   * Stream the queued frames after the current stack unwinds.
   *
   * The adapter registers the turn around the dispatch that reaches here, so a synchronous delivery
   * would arrive before there is a turn to deliver to — a race a real subprocess never has.
   */
  #flush(): void {
    const queued = this.stream.splice(0, this.stream.length);
    if (queued.length === 0) return;
    setTimeout(() => {
      for (const f of queued) {
        // Dispatch the way the real session does: reverse requests go to the reverse handler, events
        // to the event handler. The DECISIONS under test stay in the real functions.
        if (f.kind === "request") handleReverseRequest(this, f);
        else handleRuntimeEvent(this, f);
      }
    }, 0);
  }
}

function requestFrame(id: string, method: string, payload: Record<string, unknown> = {}): StepFrame {
  return { protocol: STEP_PROTOCOL_NAME, version: STEP_PROTOCOL_VERSION, kind: "request", id, method, payload };
}

function eventFrame(payload: Record<string, unknown>): StepFrame {
  return {
    protocol: STEP_PROTOCOL_NAME,
    version: STEP_PROTOCOL_VERSION,
    kind: "event",
    id: "evt",
    method: "query.message",
    sequence: 1,
    payload,
  };
}

const TURN_COMPLETE = eventFrame({ type: "status", status: "turn_complete" });

/** The pool bookkeeping the adapter uses, so the tests exercise `rememberHeldTool`/`takeHeldTool`. */
function host(session: FakeSession): StepConversationHost & { ref: StepConversationRef } {
  const ref: StepConversationRef = { handle: "conv-1", sessionId: "sess-1" };
  const held = new Map<string, StepHeldTool>();
  return {
    ref,
    get: () => session,
    open: async () => session,
    nextRef: () => ({ handle: "conv-next", sessionId: "" }),
    rememberHeldTool: (target, value) => {
      held.set(target.handle, value);
    },
    takeHeldTool: target => {
      const value = held.get(target.handle);
      held.delete(target.handle);
      return value;
    },
    closeAll: async () => {},
  };
}

function provider() {
  return {
    adapter: "step-cli",
    baseUrl: "https://api.stepfun.com/step_plan",
    authMode: "key",
  } as never;
}

const THREAD_META = { headers: new Headers({ "thread-id": "conv-1" }) } as never;

function parsed(messages: unknown[]): OcxParsedRequest {
  return {
    modelId: "step-5-preview",
    context: {
      messages,
      tools: [{ name: "shell", description: "run", parameters: { type: "object" } }],
    },
    options: {},
  } as unknown as OcxParsedRequest;
}

const USER_ASK = [{ role: "user", content: "run it", timestamp: 0 }];

describe("StepCode reverse requests are always answered", () => {
  test("a permission request with no turn is still allowed", () => {
    const session = new FakeSession();
    handleReverseRequest(session, requestFrame("p1", "permission.request"));
    expect(session.allowed).toEqual(["p1"]);
  });

  test("a tool call with no turn is refused, never dropped", () => {
    // Regression: every branch used to `return` when no turn was registered, so the runtime waited out
    // its own window with no answer and no diagnostic.
    const session = new FakeSession();
    handleReverseRequest(session, requestFrame("t1", "sdk_tool.invoke", { serverName: "ocx", toolName: "shell" }));
    expect(session.refused.map(entry => entry.id)).toEqual(["t1"]);
    expect(session.refused[0]?.reason).toMatch(/not expecting a tool call/i);
  });

  test("an unknown reverse method is denied rather than ignored", () => {
    const session = new FakeSession();
    handleReverseRequest(session, requestFrame("x1", "some.future.method"));
    expect(session.denied.map(entry => entry.id)).toEqual(["x1"]);
  });

  test("an expired hold is refused and never re-dispatched", () => {
    const session = new FakeSession();
    handleReverseRequest(session, requestFrame("t2", "sdk_tool.invoke", { __expired: true }));
    expect(session.refused.map(entry => entry.id)).toEqual(["t2"]);
    // The client already received this call, so a second dispatch for the same id would duplicate it.
    expect(session.allowed).toEqual([]);
    expect(session.denied).toEqual([]);
  });
});

describe("StepCode runTurn, two turns through one conversation", () => {
  test("turn 1 declares the client's tools and ends the turn on a captured call", async () => {
    const session = new FakeSession();
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });
    const events: AdapterEvent[] = [];
    // The CLI asks permission, calls the tool, and waits for the result: the call is held, so the turn
    // ends with the client's `tool_call` rather than waiting for the model to finish.
    session.stream = [
      requestFrame("perm-1", "permission.request", { toolName: "ocx__shell", toolUseId: "perm-1" }),
      requestFrame("tool-1", "sdk_tool.invoke", {
        serverName: "ocx",
        toolName: "shell",
        input: { cmd: "echo LIVE_BRIDGE_OK" },
        toolUseId: "call-9",
      }),
    ];
    await adapter.runTurn!(parsed(USER_ASK), THREAD_META, event => events.push(event));

    expect(session.queries[0]?.sdkTools).toEqual([
      expect.objectContaining({ serverName: "ocx", toolName: "shell", description: "run" }),
    ]);
    expect(session.queries[0]?.model).toBe("step-5-preview");
    expect(session.allowed).toEqual(["perm-1"]);
    // The client regains tool ownership: the call is reported, and nothing is executed in StepCode.
    const kinds = events.map(event => event.type);
    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_end");
    expect(events.find(event => event.type === "done")).toMatchObject({ stopReason: "tool_use" });
    expect(session.delivered).toHaveLength(0);
  });

  test("turn 2 with the matching result continues the same query", async () => {
    const session = new FakeSession();
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });

    session.stream = [
      requestFrame("perm-1", "permission.request", { toolName: "ocx__shell", toolUseId: "perm-1" }),
      requestFrame("tool-1", "sdk_tool.invoke", {
        serverName: "ocx",
        toolName: "shell",
        input: { cmd: "echo LIVE_BRIDGE_OK" },
        toolUseId: "call-9",
      }),
    ];
    await adapter.runTurn!(parsed(USER_ASK), THREAD_META, () => {});

    const second: AdapterEvent[] = [];
    session.stream = [
      eventFrame({ type: "stream_event", event: { delta: { type: "text_delta", text: "Output: OK" } } }),
      TURN_COMPLETE,
    ];
    await adapter.runTurn!(
      parsed([
        ...USER_ASK,
        { role: "toolResult", toolCallId: "call-9", toolName: "shell", content: "LIVE_BRIDGE_OK", isError: false, timestamp: 1 },
      ]),
      THREAD_META,
      event => second.push(event),
    );

    // The result is delivered to the HELD call, and the model continues in the same query: no second
    // query, no interrupt, and the user's question is not re-prompted.
    expect((session.delivered[0]?.result as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "LIVE_BRIDGE_OK",
    );
    expect(session.queries).toHaveLength(1);
    expect(session.interrupts).toEqual([]);
    expect(session.inputs).toHaveLength(1);
    expect(second.map(event => event.type)).toContain("text_delta");
    expect(second.find(event => event.type === "done")).toMatchObject({ stopReason: "stop" });
  });

  test("turn 2 that does NOT answer the held call refuses it and keeps the user's message", async () => {
    // Regression: the code set `continuedQuery = true` whenever a held call existed, so a client that
    // sent a new user message instead of the result had that message swallowed and its request
    // answered with `step_cli_turn_abandoned`.
    const session = new FakeSession();
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });
    session.stream = [
      requestFrame("perm-1", "permission.request", { toolName: "ocx__shell", toolUseId: "perm-1" }),
      requestFrame("tool-1", "sdk_tool.invoke", {
        serverName: "ocx",
        toolName: "shell",
        input: { cmd: "echo LIVE_BRIDGE_OK" },
        toolUseId: "call-9",
      }),
    ];
    await adapter.runTurn!(parsed(USER_ASK), THREAD_META, () => {});

    const second: AdapterEvent[] = [];
    session.stream = [TURN_COMPLETE];
    await adapter.runTurn!(
      parsed([
        ...USER_ASK,
        { role: "toolResult", toolCallId: "call-SOMEONE-ELSE", toolName: "shell", content: "stale", isError: false, timestamp: 1 },
        { role: "user", content: "actually do this instead", timestamp: 2 },
      ]),
      THREAD_META,
      event => second.push(event),
    );

    // Released as a refusal rather than somebody else's result.
    expect((session.delivered[0]?.result as { isError?: boolean }).isError).toBe(true);
    // The abandoned query is interrupted so a new one can start, and the user's text still goes out.
    expect(session.interrupts).toEqual(["q_1"]);
    expect(session.queries).toHaveLength(2);
    expect(session.inputs.at(-1)?.text).toContain("actually do this instead");
  });

  test("an identity-less request is not routed onto the conversation host's own handle", async () => {
    const session = new FakeSession();
    const conversation = host(session);
    const adapter = createStepCliAdapter(provider(), { openSession: conversation });
    session.stream = [TURN_COMPLETE];
    await adapter.runTurn!(
      parsed(USER_ASK),
      { headers: new Headers() } as never,
      () => {},
    );
    // Regression: a request with no identity used to resolve to the shared string "default", so every
    // such client shared one StepCode process. It now gets a private conversation.
    expect(conversation.ref.handle).toBe("conv-1");
    expect(session.queries).toHaveLength(1);
  });
});

describe("StepCode query lifecycle", () => {
  test("a completed turn ends the query's input so the next turn can start", async () => {
    // StepCode's `#maybeFinish` refuses to finish a query whose input has not ended, so without this the
    // runtime's single query slot is never released and the NEXT query.start fails with SESSION_BUSY.
    // Measured on the real CLI before the fix: a second turn on the same conversation failed.
    const session = new FakeSession();
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });
    session.stream = [eventFrame({ type: "stream_event", event: { delta: { type: "text_delta", text: "hi" } } }), TURN_COMPLETE];
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(
      parsed([{ role: "user", content: "first", timestamp: 0 }]),
      THREAD_META,
      event => events.push(event),
    );
    expect(events.find(event => event.type === "done")).toMatchObject({ stopReason: "stop" });
    await Bun.sleep(5);
    expect(session.inputEnds).toEqual(["q_1"]);
  });

  test("a captured tool call keeps its query open for the result", async () => {
    // The opposite requirement: ending the input here would let the runtime finish the query before the
    // client's tool result arrives, and the model would never see it.
    const session = new FakeSession();
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });
    session.stream = [
      requestFrame("perm-1", "permission.request", { toolName: "ocx__shell", toolUseId: "perm-1" }),
      requestFrame("tool-1", "sdk_tool.invoke", {
        serverName: "ocx",
        toolName: "shell",
        input: { cmd: "echo ok" },
        toolUseId: "call-9",
      }),
    ];
    await adapter.runTurn!(
      parsed([{ role: "user", content: "first", timestamp: 0 }]),
      THREAD_META,
      () => {},
    );
    await Bun.sleep(5);
    expect(session.inputEnds).toEqual([]);
  });

  test("two text turns on one conversation both run", async () => {
    // The plain multi-turn text conversation is what the missing input_end broke; it is not a tool path.
    const session = new FakeSession();
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });
    session.stream = [
      eventFrame({ type: "stream_event", event: { delta: { type: "text_delta", text: "one" } } }),
      TURN_COMPLETE,
    ];
    await adapter.runTurn!(parsed([{ role: "user", content: "first", timestamp: 0 }]), THREAD_META, () => {});
    session.stream = [
      eventFrame({ type: "stream_event", event: { delta: { type: "text_delta", text: "two" } } }),
      TURN_COMPLETE,
    ];
    const second: AdapterEvent[] = [];
    await adapter.runTurn!(
      parsed([
        { role: "user", content: "first", timestamp: 0 },
        { role: "assistant", content: "one", timestamp: 1 },
        { role: "user", content: "second", timestamp: 2 },
      ]),
      THREAD_META,
      event => second.push(event),
    );
    expect(session.queries).toHaveLength(2);
    expect(second.some(event => event.type === "done")).toBe(true);
    expect(second.some(event => event.type === "error")).toBe(false);
  });
});

describe("StepCode concurrent turns on one conversation", () => {
  test("two overlapping turns are serialised instead of corrupting each other", async () => {
    // Measured against the real CLI before the fix: two concurrent requests on one `thread-id` both
    // failed — one with SESSION_NOT_FOUND, the other with step_cli_session_closed — because this
    // proxy's turn state is keyed by the single process StepCode serves one query from.
    const session = new FakeSession();
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });
    session.stream = [];
    const firstEvents: AdapterEvent[] = [];
    const first = adapter.runTurn!(parsed(USER_ASK), THREAD_META, event => firstEvents.push(event));

    // Let the first turn take the conversation, then overlap a second request on it.
    await Bun.sleep(10);
    expect(session.queries).toHaveLength(1);

    const secondEvents: AdapterEvent[] = [];
    session.stream = [TURN_COMPLETE];
    const second = adapter.runTurn!(
      parsed([{ role: "user", content: "second", timestamp: 9 }]),
      THREAD_META,
      event => secondEvents.push(event),
    );

    // While the first turn still owns the conversation, the second must not have started a query.
    await Bun.sleep(10);
    expect(session.queries).toHaveLength(1);

    // Release the first; the second then runs on the same conversation.
    session.emitNow(TURN_COMPLETE);
    await Promise.all([first, second]);

    expect(firstEvents.some(event => event.type === "done")).toBe(true);
    expect(secondEvents.some(event => event.type === "done")).toBe(true);
    // Neither turn ended in a failure event, which is what the pre-fix run produced twice.
    expect(firstEvents.some(event => event.type === "error")).toBe(false);
    expect(secondEvents.some(event => event.type === "error")).toBe(false);
    expect(session.queries).toHaveLength(2);
  });

  test("sequential turns on one conversation are not serialised against each other needlessly", async () => {
    // Regression guard on the lock itself: the common Codex flow is one request at a time, and the
    // second turn must deliver a held result without waiting behind anything.
    const session = new FakeSession();
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });
    session.stream = [
      requestFrame("perm-1", "permission.request", { toolName: "ocx__shell", toolUseId: "perm-1" }),
      requestFrame("tool-1", "sdk_tool.invoke", {
        serverName: "ocx",
        toolName: "shell",
        input: { cmd: "echo ok" },
        toolUseId: "call-9",
      }),
    ];
    // Awaited deliberately: the fake drains `stream` when it flushes, so queuing the next turn's
    // frames before this one has settled would hand them to the wrong turn.
    await adapter.runTurn!(parsed(USER_ASK), THREAD_META, () => {});
    session.stream = [TURN_COMPLETE];
    const second = adapter.runTurn!(
      parsed([
        ...USER_ASK,
        { role: "toolResult", toolCallId: "call-9", toolName: "shell", content: "ok", isError: false, timestamp: 1 },
      ]),
      THREAD_META,
      () => {},
    );
    await second;
    expect(session.queries).toHaveLength(1);
  });
});

describe("StepCode query start retries", () => {
  test("a busy runtime is retried rather than failing the turn", async () => {
    // Measured on the real CLI: a turn settles when the CLI reports `turn_complete`, which can precede
    // the runtime freeing its single query slot, so the next request failed with SESSION_BUSY.
    const session = new FakeSession();
    let attempts = 0;
    const original = session.startQuery.bind(session);
    session.startQuery = async options => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("the runtime serves one query at a time");
      }
      return original(options);
    };
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });
    session.stream = [TURN_COMPLETE];
    await adapter.runTurn!(
      parsed([{ role: "user", content: "hello", timestamp: 0 }]),
      THREAD_META,
      () => {},
    );
    expect(attempts).toBe(3);
    expect(session.inputs).toHaveLength(1);
  });

  test("a non-busy failure is not retried", async () => {
    const session = new FakeSession();
    let attempts = 0;
    session.startQuery = async () => {
      attempts += 1;
      throw new Error("handshake refused: some other problem");
    };
    const adapter = createStepCliAdapter(provider(), { openSession: host(session) });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(
      parsed([{ role: "user", content: "hello", timestamp: 0 }]),
      THREAD_META,
      event => events.push(event),
    );
    expect(attempts).toBe(1);
    expect(events.some(event => event.type === "error")).toBe(true);
  });
});

describe("StepCode tool-catalog ceiling", () => {
  test("an oversized catalog names the count and the shared ceiling", async () => {
    // Measured against a real Codex 0.162.0 client: 1749 declared tools / 2.5 MB, because Codex
    // flattens every MCP server's tools into the function catalog. The shared CLI-family ceiling is
    // 128 tools, the same bound `qoder`, `codebuddy` and `claude-cli` enforce — so the message has to
    // say "too many, and this is the family limit", not just "invalid".
    const many = Array.from({ length: 200 }, (_, index) => ({
      name: `tool_${index}`,
      description: "x",
      parameters: { type: "object" },
    }));
    const adapter = createStepCliAdapter(provider(), { openSession: host(new FakeSession()) });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(
      {
        modelId: "step-5-preview",
        context: { messages: [{ role: "user", content: "go", timestamp: 0 }], tools: many },
        options: {},
      } as unknown as OcxParsedRequest,
      THREAD_META,
      event => events.push(event),
    );
    const error = events.find(event => event.type === "error") as { message?: string } | undefined;
    expect(error?.message).toMatch(/declares 200 tools/);
    expect(error?.message).toMatch(/128-tool ceiling/);
    expect(error?.message).toMatch(/CLI-backed provider shares/);
  });
});

describe("StepCode session teardown on proxy shutdown", () => {
  test("a stopped proxy closes the StepCode processes it still owns", async () => {
    // The sibling CLI routes kill their child in a per-request `finally` and cannot outlive a turn.
    // This route keeps a process for a whole conversation, so without a shutdown hook a stopped proxy
    // leaves an orphaned `step` holding the user's subscription session — measured on this machine
    // before the hook existed.
    resetOptionalShutdownHooksForTests();
    const session = new FakeSession();
    const adapter = createStepCliAdapter(provider(), {
      openSession: undefined,
      spawn: () => ({ ...session, kill: () => true, exitCode: null, signalCode: null }) as never,
      which: () => "/bin/true",
    });
    session.stream = [TURN_COMPLETE];
    // No injected pool this time, so the real pool factory runs and registers the hook.
    await adapter.runTurn!(
      parsed([{ role: "user", content: "hello", timestamp: 0 }]),
      THREAD_META,
      () => {},
    );
    expect(didRunOptionalShutdownHooks()).toBe(false);
    runOptionalShutdownHooks();
    expect(didRunOptionalShutdownHooks()).toBe(true);
    resetOptionalShutdownHooksForTests();
  });
});

describe("StepCode tool-result content projection", () => {
  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("text passes through unchanged", () => {
    expect(projectToolResultContent("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  test("an inline image is forwarded as base64 with its media type", () => {
    // Codex's `view_image` returns an image part. StepCode's SDK tool takes
    // `{type:"image", data, mimeType}`, so a `data:` URL has to be split rather than inlined as text.
    expect(projectToolResultContent([{ type: "image", imageUrl: PNG }])).toEqual([
      {
        type: "image",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        mimeType: "image/png",
      },
    ]);
  });

  test("text and an image travel together in order", () => {
    expect(
      projectToolResultContent([{ type: "text", text: "before" }, { type: "image", imageUrl: PNG }]),
    ).toEqual([
      { type: "text", text: "before" },
      { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", mimeType: "image/png" },
    ]);
  });

  test("a remote image becomes an actionable note instead of vanishing", () => {
    // StepCode cannot fetch a URL, and dropping it would leave the model believing the tool returned
    // nothing at all — the same misleading-empty-result failure as a mismatched call.
    const blocks = projectToolResultContent([{ type: "image", imageUrl: "https://example.invalid/a.png" }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect(String(blocks[0]?.text)).toMatch(/could not be inlined/);
  });

  test("a result with no readable part says so rather than looking empty", () => {
    expect(projectToolResultContent([{ type: "video", videoUrl: "https://example.invalid/v" }])).toEqual([
      { type: "text", text: "a video result part was dropped" },
    ]);
    expect(projectToolResultContent([])).toEqual([
      { type: "text", text: "the tool returned no readable content" },
    ]);
  });
});
