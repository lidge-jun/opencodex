import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import { StepSessionPool } from "../../src/adapters/step-cli/session-pool";
import {
  StepCliSession,
  StepSessionError,
  type StepSessionDeps,
  type StepSessionEvent,
  type StepSessionOptions,
} from "../../src/adapters/step-cli/session";
import { encodeStepFrame, STEP_PROTOCOL_NAME, STEP_PROTOCOL_VERSION, type StepFrame } from "../../src/adapters/step-cli/stdio-frames";

const CAPABILITIES = ["streaming-input", "sdk-tools", "permission-callback", "hooks", "sessions"];

/**
 * A scripted `step --sdk-stdio` peer.
 *
 * It decodes what the adapter writes and answers from a script, which is the only way to assert the
 * turn loop — permission hand-off, tool capture, the held reverse request and the result that
 * releases it — without a real CLI, a real model call or a sleep.
 */
class FakeStep {
  readonly child: EventEmitter & {
    stdin: PassThrough & { writable: boolean };
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: string[];
    kill(signal?: string): boolean;
  };
  /** Every frame the adapter wrote, append-only, so assertions can inspect the whole conversation. */
  readonly written: StepFrame[] = [];
  /** Index of the next frame the scripted peer has not answered yet. */
  #scriptCursor = 0;
  #buffer = Buffer.alloc(0);
  /** When false the peer stays silent, so a test can drive the exchange by hand. */
  scripted = true;

  constructor() {
    const stdin = new PassThrough() as PassThrough & { writable: boolean };
    this.child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: [] as string[],
      kill(signal = "SIGTERM") {
        this.killed.push(signal);
        this.exitCode = 0;
        return true;
      },
    });
    stdin.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      while (this.#buffer.byteLength >= 4) {
        const length = this.#buffer.readUInt32BE(0);
        if (this.#buffer.byteLength < 4 + length) break;
        const payload = this.#buffer.subarray(4, 4 + length);
        this.#buffer = this.#buffer.subarray(4 + length);
        this.written.push(JSON.parse(payload.toString("utf8")) as StepFrame);
        if (this.scripted) this.#answer();
      }
    });
  }

  emit(frame: Record<string, unknown>): void {
    this.child.stdout.write(
      encodeStepFrame({ protocol: STEP_PROTOCOL_NAME, version: STEP_PROTOCOL_VERSION, ...frame } as StepFrame),
    );
  }

  /** Answer each newly written request once: initialize, query.start and query.input. */
  #answer(): void {
    while (this.#scriptCursor < this.written.length) {
      const frame = this.written[this.#scriptCursor++]!;
      if (frame.method === "initialize") {
        this.emit({
          kind: "response",
          id: `r_${frame.id}`,
          replyTo: frame.id,
          payload: { runtimeVersion: "step", selectedProtocol: 1, capabilities: CAPABILITIES, limits: {} },
        });
        continue;
      }
      if (frame.method === "query.start") {
        this.emit({
          kind: "response",
          id: `r_${frame.id}`,
          replyTo: frame.id,
          payload: { queryId: "q_1", sessionId: "sess_1" },
        });
        continue;
      }
      if (frame.method === "query.input") {
        this.emit({ kind: "response", id: `r_${frame.id}`, replyTo: frame.id, payload: { accepted: true } });
      }
    }
  }

  /** The adapter's response answering a reverse request this peer issued. */
  replyTo(id: string): StepFrame | undefined {
    return this.written.find(frame => frame.kind === "response" && frame.replyTo === id);
  }
}

function options(overrides: Partial<StepSessionOptions> = {}): StepSessionOptions {
  return {
    binary: "/bin/true",
    args: ["--sdk-stdio"],
    env: {},
    cwd: "/tmp",
    handshakeTimeoutMs: 500,
    requestTimeoutMs: 500,
    reverseRequestHoldMs: 500,
    idleTimeoutMs: 60_000,
    killGraceMs: 10,
    ...overrides,
  };
}

async function openSession(fake: FakeStep, deps: StepSessionDeps = {}) {
  const events: StepSessionEvent[] = [];
  const session = await StepCliSession.open(
    options(),
    { onEvent: event => events.push(event) },
    { spawn: () => fake.child, platform: "linux", ...deps },
  );
  return { session, events };
}

describe("StepCode session", () => {
  test("negotiates the protocol and rejects a runtime without sdk-tools", async () => {
    const fake = new FakeStep();
    const { session } = await openSession(fake);
    const response = await session.handshake();
    expect(response.payload).toMatchObject({ selectedProtocol: 1 });
    expect(session.sessionId).toBeUndefined();
    await session.close();

    const textOnly = new FakeStep();
    // Silent peer: the capability list under test has to be the one this test writes, not the script's.
    textOnly.scripted = false;
    const spawn = () => textOnly.child;
    // A runtime without sdk-tools answers text only while looking healthy, which must fail closed.
    const bare = await StepCliSession.open(
      options(),
      { onEvent: () => undefined },
      { spawn, platform: "linux" },
    );
    // Send the request first: a response that lands before its request is registered is dropped,
    // which is the ordering a real runtime never produces but a hand-driven peer easily does.
    const handshake = bare.handshake();
    textOnly.emit({
      kind: "response",
      id: "r_init",
      replyTo: "ocx_1",
      payload: { capabilities: ["streaming-input"] },
    });
    await expect(handshake).rejects.toThrow(/does not advertise sdk-tools/);
    await bare.close();
  });

  test("opens a query with the client's tools declared inline and permission handling enabled", async () => {
    const fake = new FakeStep();
    const { session } = await openSession(fake);
    await session.handshake();
    const { queryId, sessionId } = await session.startQuery({
      model: "step-3.7-flash",
      maxThinkingTokens: 4096,
      sdkTools: [{ serverName: "ocx", toolName: "shell", description: "d", inputSchema: { type: "object" } }],
      streamingInput: true,
    });
    expect(queryId).toBe("q_1");
    expect(sessionId).toBe("sess_1");
    expect(session.sessionId).toBe("sess_1");

    const start = fake.written.find(frame => frame.method === "query.start");
    expect(start?.payload).toMatchObject({
      streamingInput: true,
      options: { model: "step-3.7-flash", maxThinkingTokens: 4096, permissionMode: "default", hasPermissionCallback: true },
    });
    await session.close();
  });

  test("holds a permission request for the adapter to decide, then allows it", async () => {
    const fake = new FakeStep();
    const { session, events } = await openSession(fake);
    await session.handshake();
    const frame: StepFrame = {
      protocol: STEP_PROTOCOL_NAME,
      version: STEP_PROTOCOL_VERSION,
      kind: "request",
      id: "req_perm",
      method: "permission.request",
      payload: { toolName: "ocx__shell", input: { cmd: "ls" }, toolUseId: "perm_1", timeoutMs: 60_000 },
    };
    fake.emit(frame);
    await Bun.sleep(5);
    // The session never decides on its own: approval belongs to the client, so the request is
    // surfaced unanswered until the adapter chooses.
    expect(events.some(event => event.type === "reverse_request")).toBe(true);
    expect(fake.replyTo("req_perm")).toBeUndefined();

    session.allowPermission(frame);
    expect(fake.replyTo("req_perm")?.payload).toEqual({ behavior: "allow" });
    await session.close();
  });

  test("holds a tool call open and releases it exactly once with the client's result", async () => {
    const fake = new FakeStep();
    const { session } = await openSession(fake);
    await session.handshake();
    fake.emit({
      kind: "request",
      id: "req_tool",
      method: "sdk_tool.invoke",
      payload: { toolName: "ocx__shell", input: { cmd: "ls" }, toolUseId: "perm_2" },
    });
    await Bun.sleep(5);
    // Nothing is invented while the client runs the tool: the request is still unanswered.
    expect(fake.replyTo("req_tool")).toBeUndefined();
    expect(session.heldReverseRequests()).toHaveLength(1);

    const delivered = session.resolveHeldToolResult(
      { id: "req_tool", method: "sdk_tool.invoke" } as StepFrame,
      { content: [{ type: "text", text: "file.txt" }] },
    );
    expect(delivered).toBe(true);
    expect(fake.replyTo("req_tool")?.payload).toEqual({ content: [{ type: "text", text: "file.txt" }] });
    // A second delivery must not reach the model twice.
    expect(session.resolveHeldToolResult({ id: "req_tool", method: "sdk_tool.invoke" } as StepFrame, { content: [] })).toBe(false);
    await session.close();
  });

  test("reports a held tool result that arrived too late instead of continuing", async () => {
    const fake = new FakeStep();
    // Injected timers: the old version slept 560ms of wall clock and went flaky on a slow runner.
    const timers: Array<() => void> = [];
    const setTimer = ((fn: () => void) => {
      timers.push(fn);
      return 0 as never;
    }) as unknown as typeof setTimeout;
    const { session, events } = await openSession(fake, {
      setTimeout: setTimer,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });
    await session.handshake();
    fake.emit({ kind: "request", id: "req_tool", method: "sdk_tool.invoke", payload: { toolUseId: "t" } });
    await Bun.sleep(5);
    // StepCode's own window is two minutes; a result past it has to fail rather than resume a call the
    // model was already told was denied.
    for (const fire of timers.splice(0)) fire();
    await Bun.sleep(5);
    expect(session.resolveHeldToolResult({ id: "req_tool", method: "sdk_tool.invoke" } as StepFrame, { content: [] })).toBe(false);
    // Regression: the expiry was surfaced with no answer, so the runtime waited out its own window.
    const expiry = events.find(event => event.type === "reverse_request" && (event.frame.payload as { __expired?: boolean } | undefined)?.__expired === true);
    expect(expiry, "the peer must be told the hold expired so it can answer the runtime").toBeDefined();
    // `close()` also schedules through the injected timer, so release whatever it queued rather than
    // waiting on a clock this test has taken away.
    void session.close();
    for (const fire of timers.splice(0)) fire();
    await session.close();
  });

  test("surfaces runtime events and rejects a permission it cannot authorise", async () => {
    const fake = new FakeStep();
    const { session, events } = await openSession(fake);
    await session.handshake();
    fake.emit({ kind: "event", id: "evt_1", method: "query.message", sequence: 1, payload: { type: "status", status: "turn_complete" } });
    await Bun.sleep(5);
    expect(events.some(event => event.type === "event")).toBe(true);

    const unknown: StepFrame = {
      protocol: STEP_PROTOCOL_NAME,
      version: STEP_PROTOCOL_VERSION,
      kind: "request",
      id: "req_other",
      method: "some_future_method",
      payload: {},
    };
    fake.emit(unknown);
    await Bun.sleep(5);
    // An unrecognised reverse method still needs an answer rather than being left to expire inside
    // the model's context.
    session.denyPermission(unknown, "OpenCodex does not handle some_future_method.");
    expect((fake.replyTo("req_other")?.payload as { message?: string } | undefined)?.message).toMatch(/does not handle/);
    await session.close();
  });

  test("fails a pending request when the process exits", async () => {
    const fake = new FakeStep();
    fake.scripted = false;
    const { session } = await openSession(fake);
    const handshake = session.handshake();
    fake.child.exitCode = 1;
    fake.child.emit("close", 1, null);
    await expect(handshake).rejects.toBeInstanceOf(StepSessionError);
  });

  test("a spawn failure closes the session and announces the exit without leaving it writable", async () => {
    const fake = new FakeStep();
    fake.scripted = false;
    const { session } = await openSession(fake);
    let announced = 0;
    session.onExit(() => {
      announced += 1;
    });
    const failure = session.handshake();
    fake.child.emit("error", new Error("spawn ENOENT"));
    await expect(failure).rejects.toThrow();
    expect(session.closed).toBe(true);
    expect(announced).toBe(1);
  });

  test("terminates with SIGTERM then escalates, and announces the exit", async () => {
    const fake = new FakeStep();
    const { session } = await openSession(fake);
    let announced = 0;
    session.onExit(() => {
      announced += 1;
    });
    await session.close();
    expect(fake.child.killed[0]).toBe("SIGTERM");
    expect(announced).toBe(1);
    expect(session.closed).toBe(true);
  });
});

describe("StepCode session pool", () => {
  function fakeChild(): FakeStep["child"] {
    return new FakeStep().child;
  }

  const options = () => ({
    binary: "/bin/true",
    args: ["--sdk-stdio"],
    env: {},
    cwd: "/tmp",
    handshakeTimeoutMs: 500,
    requestTimeoutMs: 500,
    reverseRequestHoldMs: 500,
    idleTimeoutMs: 60_000,
    killGraceMs: 10,
  });

  test("two concurrent opens of one conversation share a single process", async () => {
    // Regression: `open` was async with no in-flight coalescing, so a Codex retry (or two clients on one
    // handle) spawned two processes, the second `#entries.set` orphaned the first, and the orphan's
    // held tool call could never be released.
    const child = fakeChild();
    const pool = new StepSessionPool(
      { openCodexHome: "/tmp", idleTimeoutMs: 60_000, buildOptions: options },
      { onEvent: () => undefined },
      { spawn: () => child, platform: "linux" as NodeJS.Platform },
    );
    const ref = { handle: "same", sessionId: "" };
    const [a, b] = await Promise.all([pool.open(ref), pool.open(ref)]);
    expect(a).toBe(b);
    expect(pool.size).toBe(1);
    await pool.closeAll();
  });

  test("sequential opens of one conversation reuse the same process", async () => {
    const child = fakeChild();
    const pool = new StepSessionPool(
      { openCodexHome: "/tmp", idleTimeoutMs: 60_000, buildOptions: options },
      { onEvent: () => undefined },
      { spawn: () => child, platform: "linux" as NodeJS.Platform },
    );
    const ref = { handle: "same", sessionId: "" };
    expect(await pool.open(ref)).toBe(await pool.open(ref));
    expect(pool.size).toBe(1);
    await pool.closeAll();
  });

  test("the held tool is remembered with the call it belongs to, and consumed once", async () => {
    // Regression: only the frame id was stored, so a client that returned results for several calls
    // had them matched by POSITION instead of by call id.
    const child = fakeChild();
    const pool = new StepSessionPool(
      { openCodexHome: "/tmp", idleTimeoutMs: 60_000, buildOptions: options },
      { onEvent: () => undefined },
      { spawn: () => child, platform: "linux" as NodeJS.Platform },
    );
    const ref = { handle: "conv", sessionId: "" };
    await pool.open(ref);
    pool.rememberHeldTool(ref, { frameId: "frame-1", callId: "call-9", queryId: "q_1", catalogKey: "catalog" });
    expect(pool.takeHeldTool(ref)).toEqual({ frameId: "frame-1", callId: "call-9", queryId: "q_1", catalogKey: "catalog" });
    expect(pool.takeHeldTool(ref)).toBeUndefined();
    await pool.closeAll();
  });
});
