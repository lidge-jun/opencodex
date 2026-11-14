import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { OcxMessage, OcxParsedRequest } from "../../types";
import { commandInvocation } from "../../lib/win-exec";
import type { SpawnFn, KillWindowsProcessTreeFn } from "../coding-agent/turn";
import { CodingAgentProtocolError, type StreamMessage } from "../coding-agent/protocol";
import {
  capUtf8Bytes,
  partitionAntigravityMessages,
  stableAntigravityMessageText,
  type RawAntigravityUsage,
} from "./protocol";

const MAX_WARM_SESSIONS = 4;
const DEFAULT_WARM_SESSION_TTL_MS = 90_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const WINDOWS_TRANSIENT_RM_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
const SYNC_RM_MAX_ATTEMPTS = 6;
const SYNC_RM_RETRY_DELAY_MS = 40;

function defaultSleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Best-effort recursive removal with retries for transient Windows file locks. */
export function removeAntigravityPathBestEffort(targetPath: string): Promise<void> {
  return rm(targetPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
}

/** Synchronous best-effort recursive removal with short retries on transient Windows lock codes. */
export function removeAntigravityPathSyncBestEffort(
  targetPath: string,
  rmSyncFn: typeof rmSync = rmSync,
  sleepMsFn?: (ms: number) => void,
): void {
  const sleep = sleepMsFn ?? defaultSleepMs;
  for (let attempt = 0; attempt < SYNC_RM_MAX_ATTEMPTS; attempt++) {
    try {
      rmSyncFn(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (!code || !WINDOWS_TRANSIENT_RM_CODES.has(code) || attempt + 1 >= SYNC_RM_MAX_ATTEMPTS) {
        return;
      }
      sleep(SYNC_RM_RETRY_DELAY_MS);
    }
  }
}

export interface WarmParkedToolCall {
  seq: number;
  callId: string;
  mcpAlias: string;
  wireName: string;
  argumentsJson: string;
}

function defaultKillWindowsProcessTree(pid: number): void {
  const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    stdio: "pipe",
    windowsHide: true,
  });
}

function extractMessagePlainText(message: OcxMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => {
      if (part.type === "text" || part.type === "document") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractToolResultText(message: Extract<OcxMessage, { role: "toolResult" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => {
      if (part.type === "text" || part.type === "document") return part.text;
      return `[${part.type}]`;
    })
    .join("\n");
}

function normalizeAssistantText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function buildAntigravitySessionSignature(input: {
  baseUrl: string;
  resolvedModelSlug: string;
  rulesMarkdown: string;
  toolsCatalogJson: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.baseUrl,
      input.resolvedModelSlug,
      input.rulesMarkdown,
      input.toolsCatalogJson,
    ]))
    .digest("hex");
}

export interface TurnFrameStopHandle {
  stopped: boolean;
  stop(): void;
}

export function createTurnFrameStopHandle(onStop?: () => void): TurnFrameStopHandle {
  const handle: TurnFrameStopHandle = {
    stopped: false,
    stop(): void {
      if (handle.stopped) return;
      handle.stopped = true;
      onStop?.();
    },
  };
  return handle;
}

export interface CreateWarmSessionOptions {
  signature: string;
  binary: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  turnDir: string;
  homeDir?: string;
  ownedHomeDir?: string;
  effectiveHomeDir?: string;
  capturePath: string;
  resultsPath: string;
  platform: NodeJS.Platform;
  brainDirOverride?: string;
  spawnFn?: SpawnFn;
  killWindowsProcessTree?: KillWindowsProcessTreeFn;
  killGraceMs?: number;
  reapTimeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onUnexpectedIdleExit?: (session: WarmAntigravitySession) => void;
}

export class WarmAntigravitySession {
  readonly id = randomUUID();
  readonly signature: string;
  readonly child: ChildProcess;
  readonly turnDir: string;
  readonly ownedHomeDir?: string;
  readonly effectiveHomeDir?: string;
  readonly capturePath: string;
  readonly resultsPath: string;
  readonly platform: NodeJS.Platform;
  readonly brainDirOverride?: string;

  conversationId?: string;
  readonly seenToolStepIndices = new Set<number>();
  usageBaseline?: RawAntigravityUsage;
  nextCaptureSeq = 1;
  transcriptBlocks: string[] = [];
  mode: "active" | "awaiting_tool_results" | "idle_after_stop" | "disposed" = "active";
  parkedToolCalls: WarmParkedToolCall[] = [];
  lastAssistantText = "";
  lastUsedAt = Date.now();
  idleTimer?: ReturnType<typeof setTimeout>;

  private readonly frameQueue: StreamMessage[] = [];
  private streamProtocolError?: CodingAgentProtocolError;
  private stdoutEnded = false;
  private childProcessError?: Error;
  private readonly processLifecycle: Promise<void>;
  private pendingWake?: () => void;
  private stderrBuffer = "";
  private stderrTurnOffset = 0;
  private turnStderrTail = "";
  private killed = false;
  private syncDisposed = false;
  private disposePromise?: Promise<void>;
  private readonly idleExitHandlers: Array<(session: WarmAntigravitySession) => void> = [];

  private readonly killWinFn: KillWindowsProcessTreeFn;
  private readonly killGraceMs: number;
  private readonly reapTimeoutMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(options: CreateWarmSessionOptions) {
    this.signature = options.signature;
    this.turnDir = options.turnDir;
    this.ownedHomeDir = options.ownedHomeDir ?? options.homeDir;
    this.effectiveHomeDir = options.effectiveHomeDir ?? this.ownedHomeDir;
    this.capturePath = options.capturePath;
    this.resultsPath = options.resultsPath;
    this.platform = options.platform;
    this.brainDirOverride = options.brainDirOverride;
    this.killWinFn = options.killWindowsProcessTree ?? defaultKillWindowsProcessTree;
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.reapTimeoutMs = options.reapTimeoutMs ?? (this.killGraceMs * 2 + 250);
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    if (options.onUnexpectedIdleExit) {
      this.idleExitHandlers.push(options.onUnexpectedIdleExit);
    }

    const spawnFn = options.spawnFn ?? nodeSpawn;
    const invocation = commandInvocation(options.binary, [...options.args], options.platform, { env: options.env });
    this.child = spawnFn(invocation.file, invocation.args, {
      ...invocation.options,
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.stdin?.on("error", () => { /* surfaced via close/stderr */ });

    this.processLifecycle = new Promise<void>(resolve => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        this.stdoutEnded = true;
        this.wakeConsumer();
        resolve();
        if (this.mode === "awaiting_tool_results" || this.mode === "idle_after_stop") {
          for (const handler of this.idleExitHandlers) handler(this);
          void this.dispose();
        }
      };
      this.child.once("error", err => {
        this.childProcessError = err;
        if (this.child.pid === undefined) settle();
      });
      this.child.once("close", settle);
      if (this.child.exitCode !== null) settle();
    });

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      if (this.stderrBuffer.length < MAX_STDERR_BYTES) {
        this.stderrBuffer = (this.stderrBuffer + chunk).slice(0, MAX_STDERR_BYTES);
      }
      if (chunk) {
        this.turnStderrTail = capUtf8Bytes(this.turnStderrTail + chunk, MAX_STDERR_BYTES, true);
      }
    });

    this.attachStdoutReader();
  }

  private attachStdoutReader(): void {
    const stdout = this.child.stdout;
    if (!stdout) {
      this.stdoutEnded = true;
      return;
    }
    const decoder = new StringDecoder("utf8");
    let partial = "";
    let partialBytes = 0;

    const pushLine = (rawLine: string): void => {
      const trimmed = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!trimmed.trim()) return;
      const clean = trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed;
      try {
        const parsed: unknown = JSON.parse(clean);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          this.streamProtocolError = new CodingAgentProtocolError("Antigravity CLI stdout frame was not a JSON object.");
          this.stdoutEnded = true;
          this.wakeConsumer();
          return;
        }
        this.frameQueue.push(parsed as StreamMessage);
        this.wakeConsumer();
      } catch {
        this.streamProtocolError = new CodingAgentProtocolError("Antigravity CLI emitted malformed JSON on stdout.");
        this.stdoutEnded = true;
        this.wakeConsumer();
      }
    };

    stdout.on("data", (chunk: Buffer | string) => {
      if (this.streamProtocolError) return;
      const decoded = typeof chunk === "string" ? chunk : decoder.write(chunk);
      let start = 0;
      while (start < decoded.length) {
        const nl = decoded.indexOf("\n", start);
        if (nl < 0) {
          const rest = decoded.slice(start);
          partialBytes += Buffer.byteLength(rest, "utf8");
          if (partialBytes > MAX_LINE_BYTES) {
            this.streamProtocolError = new CodingAgentProtocolError("Antigravity CLI stdout frame exceeded line byte limit.");
            this.stdoutEnded = true;
            this.wakeConsumer();
            return;
          }
          partial += rest;
          break;
        }
        const segment = decoded.slice(start, nl);
        partialBytes += Buffer.byteLength(segment, "utf8");
        if (partialBytes > MAX_LINE_BYTES) {
          this.streamProtocolError = new CodingAgentProtocolError("Antigravity CLI stdout frame exceeded line byte limit.");
          this.stdoutEnded = true;
          this.wakeConsumer();
          return;
        }
        const fullLine = partial ? partial + segment : segment;
        partial = "";
        partialBytes = 0;
        pushLine(fullLine);
        start = nl + 1;
      }
    });

    const onEnd = (): void => {
      const tail = decoder.end();
      if (tail) partial += tail;
      if (partial && !this.streamProtocolError) {
        if (Buffer.byteLength(partial, "utf8") <= MAX_LINE_BYTES) pushLine(partial);
        partial = "";
      }
      this.stdoutEnded = true;
      this.wakeConsumer();
    };
    stdout.once("end", onEnd);
    stdout.once("close", onEnd);
    stdout.once("error", () => {
      this.stdoutEnded = true;
      this.wakeConsumer();
    });
  }

  private wakeConsumer(): void {
    const fn = this.pendingWake;
    this.pendingWake = undefined;
    fn?.();
  }

  addUnexpectedIdleExitHandler(handler: (session: WarmAntigravitySession) => void): void {
    this.idleExitHandlers.push(handler);
  }

  notifyTurnStop(): void {
    this.wakeConsumer();
  }

  markTurnStart(): void {
    this.frameQueue.length = 0;
    this.stderrTurnOffset = this.stderrBuffer.length;
    this.turnStderrTail = "";
    this.lastUsedAt = Date.now();
  }

  readTurnStderr(): string {
    const turnTail = this.turnStderrTail.trim();
    if (turnTail) return turnTail;
    const turnSlice = this.stderrBuffer.slice(this.stderrTurnOffset).trim();
    return turnSlice || this.stderrBuffer.trim();
  }

  getLaunchError(): Error | undefined {
    return this.childProcessError;
  }

  getExitCode(): number | null {
    return this.child.exitCode;
  }

  isProcessSettled(): boolean {
    return (
      this.mode === "disposed"
      || this.child.exitCode !== null
      || this.childProcessError !== undefined
      || this.streamProtocolError !== undefined
    );
  }

  writeStdinLine(line: string): void {
    if (!this.child.stdin || this.child.stdin.destroyed) {
      throw new CodingAgentProtocolError("Antigravity CLI stdin is closed.");
    }
    this.child.stdin.write(`${line}\n`);
  }

  writeToolResultsPayload(payload: string): void {
    appendFileSync(this.resultsPath, payload, { encoding: "utf8", mode: 0o600 });
  }

  async nextFrame(stopHandle: TurnFrameStopHandle): Promise<StreamMessage | undefined> {
    while (true) {
      if (stopHandle.stopped || this.mode === "disposed") return undefined;
      if (this.frameQueue.length > 0) return this.frameQueue.shift()!;
      if (this.streamProtocolError) throw this.streamProtocolError;
      if (this.stdoutEnded || this.isProcessSettled()) return undefined;
      await new Promise<void>(resolve => {
        this.pendingWake = resolve;
      });
    }
  }

  killImmediate(): void {
    if (this.killed || this.child.killed) return;
    this.killed = true;
    if (this.platform === "win32" && this.child.pid !== undefined) {
      try {
        this.killWinFn(this.child.pid);
        return;
      } catch {
        // Fall back to direct child termination.
      }
    }
    try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
  }

  private cleanupPaths(): string[] {
    const paths = [this.turnDir];
    if (this.ownedHomeDir) {
      paths.push(this.ownedHomeDir);
    }
    if (this.conversationId) {
      const homeRoot = this.effectiveHomeDir ?? homedir();
      const brainRoot = this.brainDirOverride ?? join(homeRoot, ".gemini", "antigravity-cli", "brain");
      paths.push(join(brainRoot, this.conversationId));
    }
    return paths;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.mode = "disposed";
    if (this.idleTimer !== undefined) {
      this.clearTimeoutFn(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.wakeConsumer();

    this.disposePromise = (async () => {
      try { this.child.stdin?.destroy(); } catch { /* ignore */ }
      this.killImmediate();
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      if (this.platform !== "win32") {
        sigkillTimer = this.setTimeoutFn(() => {
          try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
        }, this.killGraceMs);
      }
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.processLifecycle,
        new Promise<void>(resolve => {
          reapTimer = this.setTimeoutFn(resolve, this.reapTimeoutMs);
        }),
      ]);
      if (sigkillTimer !== undefined) this.clearTimeoutFn(sigkillTimer);
      if (reapTimer !== undefined) this.clearTimeoutFn(reapTimer);
      try { this.child.stdout?.destroy(); } catch { /* ignore */ }

      for (const target of this.cleanupPaths()) {
        await removeAntigravityPathBestEffort(target);
      }
    })();
    return this.disposePromise;
  }

  disposeSync(): void {
    if (this.syncDisposed) return;
    this.syncDisposed = true;
    this.mode = "disposed";
    if (this.idleTimer !== undefined) {
      this.clearTimeoutFn(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.wakeConsumer();
    try { this.child.stdin?.destroy(); } catch { /* ignore */ }
    try { this.child.stdout?.destroy(); } catch { /* ignore */ }
    this.killImmediate();
    this.disposePromise ??= Promise.resolve();

    for (const target of this.cleanupPaths()) {
      removeAntigravityPathSyncBestEffort(target);
    }
  }
}

export interface WarmContinuationMatch {
  session: WarmAntigravitySession;
  dispatchKind: "tool_results" | "user_followup";
  payload: string;
  nextTranscriptBlocks: string[];
}

export class AntigravitySessionPool {
  private readonly idleSessions: WarmAntigravitySession[] = [];
  private readonly allLiveSessions = new Set<WarmAntigravitySession>();
  private exitHookInstalled = false;

  constructor(
    private readonly maxSessions = MAX_WARM_SESSIONS,
    private readonly idleTtlMs = DEFAULT_WARM_SESSION_TTL_MS,
  ) {}

  get idleCount(): number {
    return this.idleSessions.length;
  }

  get liveCount(): number {
    return this.allLiveSessions.size;
  }

  registerLive(session: WarmAntigravitySession): void {
    this.allLiveSessions.add(session);
    session.addUnexpectedIdleExitHandler(exited => {
      this.unregisterLive(exited);
      void exited.dispose();
    });
    if (!this.exitHookInstalled) {
      this.exitHookInstalled = true;
      process.once("exit", () => {
        this.disposeAllSync();
      });
    }
  }

  unregisterLive(session: WarmAntigravitySession): void {
    this.allLiveSessions.delete(session);
    const idx = this.idleSessions.indexOf(session);
    if (idx >= 0) this.idleSessions.splice(idx, 1);
  }

  park(
    session: WarmAntigravitySession,
    setTimeoutFn: typeof setTimeout = setTimeout,
    clearTimeoutFn: typeof clearTimeout = clearTimeout,
  ): void {
    if (session.isProcessSettled()) {
      this.unregisterLive(session);
      void session.dispose();
      return;
    }
    session.lastUsedAt = Date.now();
    if (session.idleTimer !== undefined) {
      clearTimeoutFn(session.idleTimer);
    }
    const timer = setTimeoutFn(() => {
      session.idleTimer = undefined;
      this.unregisterLive(session);
      void session.dispose();
    }, this.idleTtlMs);
    timer.unref?.();
    session.idleTimer = timer;

    const existingIdx = this.idleSessions.indexOf(session);
    if (existingIdx >= 0) this.idleSessions.splice(existingIdx, 1);
    this.idleSessions.push(session);

    while (this.idleSessions.length > this.maxSessions) {
      const oldest = this.idleSessions.shift();
      if (oldest) {
        this.allLiveSessions.delete(oldest);
        void oldest.dispose();
      }
    }
  }

  acquireContinuation(
    signature: string,
    parsed: OcxParsedRequest,
    vendorNameByWire: ReadonlyMap<string, string> | undefined,
    clearTimeoutFn: typeof clearTimeout = clearTimeout,
  ): WarmContinuationMatch | undefined {
    const { conversation: nonDevMessages } = partitionAntigravityMessages(parsed.context.messages);
    const incomingBlocks = nonDevMessages.map(m => stableAntigravityMessageText(m, vendorNameByWire, parsed.modelId));

    // Prune dead sessions first and search MRU -> LRU.
    for (let i = this.idleSessions.length - 1; i >= 0; i--) {
      const candidate = this.idleSessions[i]!;
      if (candidate.isProcessSettled()) {
        this.idleSessions.splice(i, 1);
        this.allLiveSessions.delete(candidate);
        void candidate.dispose();
        continue;
      }
      if (candidate.signature !== signature) continue;

      const baseLen = candidate.transcriptBlocks.length;
      if (incomingBlocks.length <= baseLen) continue;
      let prefixMatches = true;
      for (let j = 0; j < baseLen; j++) {
        if (incomingBlocks[j] !== candidate.transcriptBlocks[j]) {
          prefixMatches = false;
          break;
        }
      }
      if (!prefixMatches) continue;

      if (candidate.mode === "awaiting_tool_results") {
        const expectedTools = candidate.parkedToolCalls;
        if (expectedTools.length === 0) continue;
        if (nonDevMessages.length < baseLen + 1 + expectedTools.length) continue;

        const assistantMsg = nonDevMessages[baseLen]!;
        if (assistantMsg.role !== "assistant" || !Array.isArray(assistantMsg.content)) continue;
        const assistantCalls = assistantMsg.content.filter(part => part.type === "toolCall");
        if (assistantCalls.length !== expectedTools.length) continue;

        const callsMatch = expectedTools.every(expected =>
          assistantCalls.some(call => call.id === expected.callId && call.name === expected.wireName),
        );
        if (!callsMatch) continue;

        const resultsByCallId = new Map<string, Extract<OcxMessage, { role: "toolResult" }>>();
        const extraBlocks: string[] = [];
        let allResultsValid = true;
        for (let k = baseLen + 1; k < nonDevMessages.length; k++) {
          const msg = nonDevMessages[k]!;
          if (msg.role === "toolResult") {
            if (resultsByCallId.has(msg.toolCallId)) {
              allResultsValid = false;
              break;
            }
            resultsByCallId.set(msg.toolCallId, msg);
            continue;
          }
          if (msg.role === "developer" || msg.role === "user") {
            const blockText = incomingBlocks[k]?.trim();
            if (blockText) extraBlocks.push(blockText);
            continue;
          }
          allResultsValid = false;
          break;
        }
        if (!allResultsValid || resultsByCallId.size !== expectedTools.length) continue;
        if (!expectedTools.every(expected => resultsByCallId.has(expected.callId))) continue;

        const lines: string[] = [];
        for (let idx = 0; idx < expectedTools.length; idx++) {
          const expected = expectedTools[idx]!;
          const resultMsg = resultsByCallId.get(expected.callId)!;
          let text = extractToolResultText(resultMsg);
          if (idx === expectedTools.length - 1 && extraBlocks.length > 0) {
            text = text ? `${text}\n\n${extraBlocks.join("\n\n")}` : extraBlocks.join("\n\n");
          }
          lines.push(`${JSON.stringify({
            seq: expected.seq,
            text,
            isError: Boolean(resultMsg.isError),
          })}\n`);
        }

        this.idleSessions.splice(i, 1);
        if (candidate.idleTimer !== undefined) {
          clearTimeoutFn(candidate.idleTimer);
          candidate.idleTimer = undefined;
        }
        candidate.mode = "active";
        candidate.parkedToolCalls = [];
        return {
          session: candidate,
          dispatchKind: "tool_results",
          payload: lines.join(""),
          nextTranscriptBlocks: incomingBlocks,
        };
      }

      if (candidate.mode === "idle_after_stop") {
        if (nonDevMessages.length < baseLen + 2) continue;
        const assistantMsg = nonDevMessages[baseLen]!;
        if (assistantMsg.role !== "assistant") continue;
        if (Array.isArray(assistantMsg.content) && assistantMsg.content.some(part => part.type === "toolCall")) {
          continue;
        }
        const echoedAssistantText = normalizeAssistantText(extractMessagePlainText(assistantMsg));
        if (echoedAssistantText !== normalizeAssistantText(candidate.lastAssistantText)) continue;

        const tailMessages = nonDevMessages.slice(baseLen + 1);
        if (
          !tailMessages.some(msg => msg.role === "user")
          || !tailMessages.every(msg => msg.role === "user" || msg.role === "developer")
        ) {
          continue;
        }

        const tailBlocks = incomingBlocks.slice(baseLen + 1).filter(block => block.length > 0);
        const stdinLine = JSON.stringify({
          event: "user",
          message: { content: [{ type: "text" as const, text: tailBlocks.join("\n\n") }] },
        });

        this.idleSessions.splice(i, 1);
        if (candidate.idleTimer !== undefined) {
          clearTimeoutFn(candidate.idleTimer);
          candidate.idleTimer = undefined;
        }
        candidate.mode = "active";
        return {
          session: candidate,
          dispatchKind: "user_followup",
          payload: stdinLine,
          nextTranscriptBlocks: incomingBlocks,
        };
      }
    }

    return undefined;
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.allLiveSessions];
    this.idleSessions.splice(0);
    this.allLiveSessions.clear();
    await Promise.all(sessions.map(s => s.dispose()));
  }

  disposeAllSync(): void {
    const sessions = [...this.allLiveSessions];
    this.idleSessions.splice(0);
    this.allLiveSessions.clear();
    for (const session of sessions) {
      session.disposeSync();
    }
  }
}

export const defaultAntigravitySessionPool = new AntigravitySessionPool();
