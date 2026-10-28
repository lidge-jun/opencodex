import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { commandInvocation } from "../../lib/win-exec";
import { killWindowsProcessTree } from "../coding-agent/process-tree";
import type { WhichFn } from "../coding-agent/profile";
import { buildStepCliEnv } from "./env";
import {
  findStepCliBinary,
  stepCliSessionDir,
  STEP_CLI_PROFILE,
  type StepCliProfile,
} from "./profiles";
import {
  encodeStepFrame,
  stepErrorResponse,
  stepRequest,
  stepResponse,
  StepFrameDecoder,
  StepProtocolViolation,
  STEP_MAX_FRAME_BYTES,
  STEP_PROTOCOL_VERSION,
  type StepFrame,
} from "./stdio-frames";

export type StepSpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * Capabilities this route cannot work without.
 *
 * Without `sdk-tools` the runtime answers text only while looking healthy, which is the one failure
 * this provider must never present as success: the client would conclude the model simply chose not
 * to call its tools, and a routed coding session would silently degrade into a chat.
 */
const REQUIRED_CAPABILITIES = ["streaming-input", "sdk-tools"] as const;
const CLEANUP_ATTEMPTS = 2;

export interface StepSessionDeps {
  spawn?: StepSpawnFn;
  which?: WhichFn;
  /** Injectable timer primitives so tests never sleep. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  now?: () => number;
  /** Test seam for Windows command-shim invocation. */
  platform?: NodeJS.Platform;
  killWindowsProcessTree?: (pid: number) => void;
}

export interface StepSessionOptions {
  binary: string;
  args: readonly string[];
  env: Record<string, string>;
  /** Working directory; the session directory is created beneath it. */
  cwd: string;
  /** Wall-clock ceiling for `initialize`, in ms. */
  handshakeTimeoutMs: number;
  /** Ceiling on a request the runtime has not answered, in ms. */
  requestTimeoutMs: number;
  /**
   * Ceiling on a reverse request this peer holds.
   *
   * StepCode's own `SDK_TOOL_TIMEOUT_MS` is 120s and answering late produces a `permission_denied`
   * message inside the model's context rather than a transport error. Bounding the hold shorter than
   * that turns a too-slow tool into a clean failed turn instead of a session the model believes was
   * denied.
   */
  reverseRequestHoldMs: number;
  /** Reap a session with no activity for this long, in ms. */
  idleTimeoutMs: number;
  /** SIGTERM-to-SIGKILL window, in ms. */
  killGraceMs: number;
}

/** A request awaiting an answer from the runtime. */
interface PendingRequest {
  readonly method: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (frame: StepFrame) => void;
  readonly reject: (error: Error) => void;
  answered: boolean;
}

/** A reverse request the runtime is waiting on this peer to answer. */
interface HeldReverseRequest {
  readonly method: string;
  readonly frame: StepFrame;
  readonly timer: ReturnType<typeof setTimeout>;
  answered: boolean;
}

/** A transport-level failure, as opposed to a model or CLI failure reported in-band. */
export class StepSessionError extends Error {
  readonly code: string;

  constructor(message: string, code = "step_cli_session_failed") {
    super(message);
    this.name = "StepSessionError";
    this.code = code;
  }
}

/**
 * What the adapter needs to hear while a session is live.
 *
 * Every event carries the session that produced it: the handler is shared across every conversation,
 * so the origin is the only way to route a frame to the turn that is waiting for it.
 */
export type StepSessionEvent =
  | { type: "event"; frame: StepFrame; session: StepCliSession }
  | { type: "reverse_request"; frame: StepFrame; session: StepCliSession };

export interface StepSessionHandlers {
  onEvent(event: StepSessionEvent): void;
}

/**
 * One long-lived `step --sdk-stdio` process, keyed by client conversation.
 *
 * StepCode carries conversation context only in process memory: `query.input` reduces every message
 * to plain text and images (`readQueryInput`), so an assistant turn, a declared tool call and its
 * result cannot be replayed through the wire. The session therefore has to outlive one proxied
 * request, and the client keeps it alive by echoing back the `providerState` this class mints —
 * the same mechanism Kiro uses for `conversationId`.
 *
 * That constraint is also why a captured tool call is held open rather than answered here. The
 * client executes the tool and reports it on its next request; delivering that result to this
 * reverse request is how it reaches the model, inside the query the model is already running.
 */
export class StepCliSession {
  readonly #options: StepSessionOptions;
  readonly #deps: StepSessionDeps;
  readonly #handlers: StepSessionHandlers;
  readonly #decoder = new StepFrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #held = new Map<string, HeldReverseRequest>();
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  readonly #now: () => number;
  readonly #platform: NodeJS.Platform;
  readonly #killGraceMs: number;

  #child: ChildProcess | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #cleanupComplete = false;
  readonly #cleanupListeners = new Set<(cleanup: Promise<void>) => void>();
  #handshake: Promise<StepFrame> | undefined;
  #sessionId: string | undefined;
  #lastActivityAt: number;
  #requestSeq = 0;
  #stderrTail = "";
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #exitListeners = new Set<() => void>();

  /**
   * Register a callback fired once the owned process cleanup is confirmed.
   *
   * The pool needs this to drop a conversation whose process died: a restart would come back with no
   * memory of the tool results the client already delivered, and those are not recoverable from the
   * transcript this route cannot replay.
   */
  onExit(listener: () => void): () => void {
    if (this.#cleanupComplete) {
      listener();
      return () => undefined;
    }
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  /** Observe cleanup even when it is initiated by an adapter or a session timer. */
  onCleanup(listener: (cleanup: Promise<void>) => void): void {
    if (this.#closePromise) listener(this.#closePromise);
    else this.#cleanupListeners.add(listener);
  }

  #announceExit(): void {
    if (this.#exitListeners.size === 0) return;
    const listeners = [...this.#exitListeners];
    this.#exitListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // An owner's bookkeeping must never keep a dead session from being reported.
      }
    }
  }

  private constructor(options: StepSessionOptions, deps: StepSessionDeps, handlers: StepSessionHandlers) {
    this.#options = options;
    this.#deps = deps;
    this.#handlers = handlers;
    this.#setTimer = deps.setTimeout ?? setTimeout;
    this.#clearTimer = deps.clearTimeout ?? clearTimeout;
    this.#now = deps.now ?? Date.now;
    this.#platform = deps.platform ?? process.platform;
    this.#killGraceMs = options.killGraceMs;
    this.#lastActivityAt = this.#now();
  }

  static async open(
    options: StepSessionOptions,
    handlers: StepSessionHandlers,
    deps: StepSessionDeps = {},
  ): Promise<StepCliSession> {
    const session = new StepCliSession(options, deps, handlers);
    await session.#start();
    return session;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Bounded stderr tail, for diagnostics. Never logged wholesale. */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /** Milliseconds since the last frame in either direction. */
  idleMs(): number {
    return this.#now() - this.#lastActivityAt;
  }

  #touch(): void {
    this.#lastActivityAt = this.#now();
  }

  #nextId(): string {
    this.#requestSeq += 1;
    return `ocx_${this.#requestSeq}`;
  }

  async #start(): Promise<void> {
    const invocation = commandInvocation(this.#options.binary, this.#options.args, this.#platform);
    await mkdir(this.#options.cwd, { recursive: true }).catch(() => undefined);
    const spawn = this.#deps.spawn ?? nodeSpawn;
    const child = spawn(invocation.file, invocation.args, {
      ...invocation.options,
      env: this.#options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: this.#platform !== "win32",
      cwd: this.#options.cwd,
    });
    this.#child = child;

    // stderr must be drained continuously: an unread pipe fills and blocks the child mid-turn. Only a
    // bounded tail is retained, and it is never logged as content.
    //
    // `setEncoding("utf8")` rather than decoding each chunk: StepCode prints CJK diagnostics (未登录),
    // and a multibyte character split across two chunks would decode to U+FFFD on both halves, so the
    // not-signed-in detection that matches on that text would stop firing.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#touch();
      this.#stderrTail = (this.#stderrTail + chunk).slice(-2000);
    });
    child.stdout?.on("data", (chunk: Buffer) => this.#absorbStdout(chunk));
    child.on("error", error => {
      // A spawn failure such as ENOENT can emit `error` without a following `close`, so the sweep has to
      // be stopped here too or it lingers on a session that no longer exists.
      this.#stopIdleSweep();
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
      if (child.pid === undefined) this.#child = undefined;
      void this.close();
    });
    child.on("close", () => {
      this.#failAll(new StepSessionError("StepCode exited before the turn settled."));
      this.#stopIdleSweep();
      void this.close();
    });
    this.#installIdleSweep();
  }

  #absorbStdout(chunk: Buffer): void {
    this.#touch();
    let frames: StepFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      // The runtime answers a frame it cannot parse with silence, so writing on into it would hang the
      // client for the whole request timeout. Fail every waiter and tear the process down instead.
      this.#failAll(error instanceof StepProtocolViolation ? error : new Error(String(error)));
      void this.close();
      return;
    }
    for (const frame of frames) this.#route(frame);
  }

  #route(frame: StepFrame): void {
    if (frame.kind === "response") {
      const replyTo = frame.replyTo;
      if (!replyTo) return;
      const pending = this.#pending.get(replyTo);
      if (!pending) return;
      this.#pending.delete(replyTo);
      this.#settle(pending, frame);
      return;
    }
    if (frame.kind === "request") {
      this.#holdReverse(frame);
      return;
    }
    this.#handlers.onEvent({ type: "event", frame, session: this });
  }

  #holdReverse(frame: StepFrame): void {
    const timer = this.#setTimer(() => {
      if (!this.#held.delete(frame.id)) return;
      // The expiry is surfaced so the peer can answer the runtime. Without an answer here StepCode
      // waits out its own 120s window, and a later turn registered for this session would see the same
      // frame again and re-emit the tool call the client already received.
      this.#handlers.onEvent({
        type: "reverse_request",
        frame: { ...frame, payload: { ...(frame.payload as object ?? {}), __expired: true } } as StepFrame,
        session: this,
      });
    }, this.#options.reverseRequestHoldMs);
    this.#held.set(frame.id, {
      method: frame.method ?? "unknown",
      frame,
      timer,
      answered: false,
    });
    this.#handlers.onEvent({ type: "reverse_request", frame, session: this });
  }

  #settle(pending: PendingRequest, frame: StepFrame): void {
    if (pending.answered) return;
    pending.answered = true;
    this.#clearTimer(pending.timer as never);
    if (frame.error) {
      pending.reject(new StepSessionError(frame.error.message, frame.error.code));
      return;
    }
    pending.resolve(frame);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.answered) continue;
      pending.answered = true;
      this.#clearTimer(pending.timer as never);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #write(frame: StepFrame): void {
    const stdin = this.#child?.stdin;
    if (this.#closed || !stdin?.writable) {
      throw new StepSessionError("StepCode session is not writable.");
    }
    stdin.write(encodeStepFrame(frame, STEP_MAX_FRAME_BYTES));
  }

  #send(id: string, method: string, payload?: unknown, timeoutMs?: number): Promise<StepFrame> {
    if (this.#closed) return Promise.reject(new StepSessionError("StepCode session is closed."));
    let pending!: PendingRequest;
    const timer = this.#setTimer(() => {
      if (this.#pending.delete(id)) pending.reject(new StepSessionError(`StepCode did not answer ${method} in time.`));
    }, timeoutMs ?? this.#options.requestTimeoutMs);
    const promise = new Promise<StepFrame>((resolve, reject) => {
      pending = { method, timer, resolve, reject, answered: false };
    });
    this.#pending.set(id, pending);
    try {
      this.#write(stepRequest(id, method, payload));
    } catch (error) {
      this.#pending.delete(id);
      this.#clearTimer(timer as never);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  #respondOk(replyTo: string, payload: unknown): void {
    try {
      this.#write(stepResponse(replyTo, payload));
    } catch {
      // A peer that has gone away cannot be told; the session is already failing closed.
    }
  }

  #respondError(replyTo: string, code: string, message: string): void {
    try {
      this.#write(stepErrorResponse(replyTo, code, message));
    } catch {
      /* see #respondOk */
    }
  }

  /**
   * Negotiate the protocol and verify this route can actually keep tool ownership.
   */
  async handshake(): Promise<StepFrame> {
    this.#handshake ??= this.#negotiate();
    return this.#handshake;
  }

  async #negotiate(): Promise<StepFrame> {
    const response = await this.#send(
      this.#nextId(),
      "initialize",
      { protocolRange: { min: STEP_PROTOCOL_VERSION, max: STEP_PROTOCOL_VERSION } },
      this.#options.handshakeTimeoutMs,
    );
    const payload = (response.payload ?? {}) as Record<string, unknown>;
    const capabilities = Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((value): value is string => typeof value === "string")
      : [];
    const missing = REQUIRED_CAPABILITIES.filter(capability => !capabilities.includes(capability));
    if (missing.length > 0) {
      throw new StepSessionError(
        `This StepCode build does not advertise ${missing.join(", ")}, so it cannot keep tool ownership for a proxied turn.`,
        "step_cli_capability_missing",
      );
    }
    return response;
  }

  /**
   * Open one query and return its ids.
   *
   * `hasPermissionCallback` is what disables StepCode's fail-closed default: without it an
   * approval-requiring tool is blocked and the run terminated before this peer is ever consulted.
   * `permissionMode` is sent explicitly for the same reason — the CLI otherwise starts in
   * "Full Access (auto-resume)".
   */
  async startQuery(options: {
    model: string | undefined;
    maxThinkingTokens: number | undefined;
    sdkTools: readonly unknown[];
    streamingInput: boolean;
  }): Promise<{ queryId: string; sessionId: string }> {
    const response = await this.#send(this.#nextId(), "query.start", {
      streamingInput: options.streamingInput,
      options: {
        ...(options.model ? { model: options.model } : {}),
        ...(typeof options.maxThinkingTokens === "number"
          ? { maxThinkingTokens: options.maxThinkingTokens }
          : {}),
        permissionMode: "default",
        hasPermissionCallback: true,
        includePartialMessages: true,
        sdkTools: options.sdkTools,
      },
    });
    const payload = (response.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.sessionId === "string") this.#sessionId = payload.sessionId;
    const queryId = typeof payload.queryId === "string" ? payload.queryId : undefined;
    if (!queryId) throw new StepSessionError("query.start returned no queryId.", "step_cli_protocol_violation");
    return { queryId, sessionId: this.#sessionId ?? "" };
  }

  /**
   * Queue one user message.
   *
   * Only text and images survive this hop, which is exactly why the session must outlive a request
   * instead of being rebuilt from a replayed transcript.
   */
  async sendInput(queryId: string, text: string): Promise<void> {
    await this.#send(this.#nextId(), "query.input", {
      queryId,
      message: { type: "user", message: { role: "user", content: [{ type: "text", text }] } },
    });
  }

  /** Answer a permission already checked against the owning turn and catalog. */
  allowPermission(frame: StepFrame): void {
    this.#respondOk(frame.id, { behavior: "allow" });
    this.#releaseReverse(frame.id);
  }

  /**
   * Refuse a tool call with a reason the model can act on.
   *
   * A tool result frame carrying only `{message}` is not a refusal: StepCode reads `payload.content`
   * and renders an absent content list as an EMPTY result, which the model reports as a tool that ran
   * and produced nothing. Only an `error` envelope throws inside the SDK tool wrapper.
   */
  refuseToolCall(frame: StepFrame, reason: string): void {
    this.#respondError(frame.id, "TOOL_NOT_AVAILABLE", reason);
    this.#releaseReverse(frame.id);
  }

  #releaseReverse(id: string): void {
    const held = this.#held.get(id);
    if (held) {
      held.answered = true;
      this.#clearTimer(held.timer as never);
      this.#held.delete(id);
    }
  }

  /** Refuse a `permission.request` with a reason the model can act on. */
  denyPermission(frame: StepFrame, reason: string): void {
    this.#respondOk(frame.id, { message: reason });
    this.#releaseReverse(frame.id);
  }

  /**
   * Deliver a client-executed tool result to the call this session is holding open.
   *
   * Returns false when nothing is held for that frame — the runtime's own timer already fired, or
   * the session was reaped — so the caller reports a too-slow tool instead of continuing against a
   * call the model has already been told was denied.
   */
  resolveHeldToolResult(frame: StepFrame, result: { content: readonly unknown[]; isError?: boolean }): boolean {
    const held = this.#held.get(frame.id);
    if (!held || held.answered || held.method !== "sdk_tool.invoke") return false;
    held.answered = true;
    this.#clearTimer(held.timer as never);
    this.#held.delete(frame.id);
    this.#respondOk(frame.id, {
      content: result.content,
      ...(result.isError === true ? { isError: true } : {}),
    });
    this.#touch();
    return true;
  }

  /** Reverse requests still waiting on this peer, in arrival order. */
  heldReverseRequests(): StepFrame[] {
    return [...this.#held.values()].filter(entry => !entry.answered).map(entry => entry.frame);
  }

  /**
   * Close this query's input stream with `query.input_end`.
   *
   * Not optional housekeeping: StepCode's `#maybeFinish` refuses to finish a query whose input has
   * not ended, so without this the runtime's single query slot is never released and the NEXT
   * `query.start` on the same process fails with SESSION_BUSY. A multi-turn text conversation would
   * therefore work for exactly one turn.
   *
   * Deliberately not sent when a tool call was captured: that query is still owed the client's tool
   * result, and ending its input would let the runtime finish it before the model continues.
   */
  async endInput(queryId: string): Promise<void> {
    if (this.#closed) return;
    await this.#send(this.#nextId(), "query.input_end", { queryId }, this.#options.requestTimeoutMs);
  }

  /** StepCode's `query.interrupt`, used when the client aborts a turn mid-flight. */
  async interrupt(queryId: string): Promise<void> {
    if (this.#closed) return;
    await this.#send(this.#nextId(), "query.interrupt", { queryId });
  }

  #installIdleSweep(): void {
    const interval = Math.max(1_000, Math.min(this.#options.idleTimeoutMs, 60_000));
    const sweep = (): void => {
      if (this.#closed) return;
      if (this.idleMs() >= this.#options.idleTimeoutMs) {
        void this.close();
        return;
      }
      this.#idleTimer = this.#setTimer(sweep, interval);
    };
    this.#idleTimer = this.#setTimer(sweep, interval);
  }

  #stopIdleSweep(): void {
    if (!this.#idleTimer) return;
    this.#clearTimer(this.#idleTimer as never);
    this.#idleTimer = undefined;
  }

  /**
   * Reap the owned process tree before releasing this session. Concurrent callers share cleanup.
   */
  close(code = 0): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#stopIdleSweep();
    const child = this.#child;
    this.#failAll(new StepSessionError(`StepCode session closed (${code}).`));
    for (const held of this.#held.values()) this.#clearTimer(held.timer as never);
    this.#held.clear();
    // Publish the receipt before termination can emit close or notify pool bookkeeping.
    const receipt = Promise.withResolvers<void>();
    this.#closePromise = receipt.promise;
    for (const listener of this.#cleanupListeners) listener(this.#closePromise);
    this.#cleanupListeners.clear();
    // Timer/protocol-initiated closes have no awaiting caller. Keep the rejection in the cached
    // receipt for close()/pool shutdown, while observing it here to avoid an unhandled rejection.
    void this.#closePromise.catch(() => {});
    const terminate = async (): Promise<void> => {
      const failures: unknown[] = [];
      if (child) {
        for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
          try { await this.#terminate(child); break; }
          catch (error) {
            failures.push(error);
            if (attempt + 1 === CLEANUP_ATTEMPTS) {
              throw Object.assign(new StepSessionError(
                "StepCode process cleanup failed; conversation handle is quarantined.", "step_cli_cleanup_failed",
              ), { cause: new AggregateError(failures, "StepCode tree termination attempts failed.") });
            }
          }
        }
      }
      this.#cleanupComplete = true;
      this.#announceExit();
    };
    // Start synchronously, as before: injected timers and child event handlers can observe the
    // first termination attempt immediately, without racing publication of the shared receipt.
    void terminate().then(receipt.resolve, receipt.reject);
    return this.#closePromise;
  }

  async #terminate(child: ChildProcess): Promise<void> {
    // A root-exit receipt cannot prove that a Windows tree kill succeeded. In particular, a
    // failed first attempt may have killed only the root; the retry must still confirm the tree.
    if ((child.exitCode !== null || child.signalCode !== null)
      && !(this.#platform === "win32" && child.pid !== undefined)) return;
    let cancelWait = (): void => {};
    const exited = new Promise<void>(resolve => {
      const finish = (): void => { cancelWait(); resolve(); };
      child.once("close", finish);
      cancelWait = () => child.removeListener("close", finish);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let failCleanup!: (error: unknown) => void;
    const cleanupFailed = new Promise<never>((_, reject) => { failCleanup = reject; });
    const gone = (): boolean => {
      if (child.pid === undefined) return child.exitCode !== null || child.signalCode !== null;
      try { process.kill(child.pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    };
    const signal = (kind: NodeJS.Signals): void => {
      try {
        if (this.#platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    try {
      if (this.#platform === "win32" && child.pid !== undefined) {
        (this.#deps.killWindowsProcessTree ?? killWindowsProcessTree)(child.pid);
        // Bun on Windows can retain null exit/signal fields after taskkill has reaped the tree.
        // Verify with the OS before releasing the process and its stdio handles.
        if (gone()) {
          child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
          this.#child = undefined;
          return;
        }
      } else {
        signal("SIGTERM");
        timer = this.#setTimer(() => {
          try { signal("SIGKILL"); } catch (error) { failCleanup(error); }
        }, this.#killGraceMs);
      }
      await Promise.race([exited, cleanupFailed, new Promise<void>((resolve, reject) => {
        deadline = this.#setTimer(() => {
          try {
            if (gone()) resolve();
            else reject(new StepSessionError("StepCode process cleanup could not be confirmed.", "step_cli_cleanup_failed"));
          } catch (error) { reject(error); }
        }, this.#killGraceMs + 2_000);
      })]);
      // A POSIX parent can exit on SIGTERM while a descendant ignores it. The owned group still
      // needs SIGKILL before the parent-close receipt releases cleanup.
      if (this.#platform !== "win32" && child.pid !== undefined) signal("SIGKILL");
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.();
      this.#child = undefined;
    } finally {
      if (timer !== undefined) this.#clearTimer(timer as never);
      if (deadline !== undefined) this.#clearTimer(deadline as never);
      cancelWait();
    }
  }
}

/** Resolve this route's binary, or explain how to install it. */
export function resolveStepCliBinaryPath(which?: WhichFn): string {
  const found = findStepCliBinary(STEP_CLI_PROFILE.binaryCandidates[0]!, which);
  if (found) return found;
  throw new StepSessionError(
    `${STEP_CLI_PROFILE.label} is not installed. ${STEP_CLI_PROFILE.installHint}.`,
    "step_cli_binary_missing",
  );
}

/** Env and working directory for one session process. */
export function stepCliProcessEnvironment(openCodexHome: string): { env: Record<string, string>; cwd: string } {
  const sessions = stepCliSessionDir(openCodexHome);
  return { env: buildStepCliEnv(openCodexHome), cwd: dirname(sessions) };
}

export { buildStepCliEnv } from "./env";
export type { StepCliProfile };
