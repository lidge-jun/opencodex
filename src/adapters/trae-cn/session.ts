import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandInvocation } from "../../lib/win-exec";
import { redactSecretString } from "../../lib/redact";
import type { AdapterEvent, OcxProviderConfig } from "../../types";
import { CodingAgentStreamLimitError, readJsonLines } from "../coding-agent/protocol";
import { resolveTraeCli, traeCnChildEnv, traeCnDestinationMatches } from "./profile";
import { traePosixInvocation, traeStopPipe } from "./process";
import { prepareTraeWindowsJob, TraeWindowsJobFrames } from "./windows-job";
import { parseTraeAcpMessage, parseTraeModels, traePromptEvents, traeSessionId, traeStopReason, traeUsage, TraeAcpProtocolError, type TraeAcpFrame } from "./protocol";

export type SpawnTraeCli = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export interface TraeAcpDeps {
  spawn?: SpawnTraeCli;
  resolveBinary?: () => string | undefined;
  home?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  killGraceMs?: number;
  reapTimeoutMs?: number;
  makeTempDir?: typeof mkdtemp;
}

export class TraeAcpError extends Error {
  constructor(message: string, readonly code = "trae_acp_error") {
    super(message);
    this.name = "TraeAcpError";
  }
}

/** Keep actionable local errno values without forwarding paths or arbitrary error text. */
function startupFailure(stage: "resolve_cli" | "environment" | "home" | "workspace" | "spawn", error: unknown): TraeAcpError {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const safeCode = typeof code === "string" && ["ENOSPC", "EACCES", "EPERM", "EROFS", "ENOENT", "EMFILE", "ENFILE", "EAGAIN", "EINVAL"].includes(code) ? code : "UNKNOWN";
  return new TraeAcpError(`TRAE CN startup failed during ${stage} (${safeCode}).`, `trae_startup_${stage}_${safeCode.toLowerCase()}`);
}

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export interface TraePromptDispatch {
  beforeSend(): void;
  onSend(): void;
}

/** Bound child and stream teardown even when a dispatcher keeps its pipes open. */
async function waitBounded(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Own the JSON-RPC stream, pending requests, and bounded process shutdown. */
class TraeAcpClient {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly updates: TraeAcpFrame[] = [];
  private readonly waiters: Array<(frame: TraeAcpFrame | null) => void> = [];
  private stderr = "";
  private stderrTruncated = false;
  private readonly windowsFrames?: TraeWindowsJobFrames;
  private initialized = false;
  private launchStatus?: number;
  private spawnFailed = false;
  private selectedModel?: { sessionId: string; modelId: string };
  private readonly reader: Promise<void>;
  private readonly lifecycle: Promise<void>;
  private failure?: Error;
  private closed = false;
  private updatesEnded = false;
  private closing?: Promise<void>;

  constructor(private readonly child: ChildProcess, private readonly timeoutMs: number, private readonly deps: TraeAcpDeps) {
    if ((deps.platform ?? process.platform) === "win32") {
      this.windowsFrames = new TraeWindowsJobFrames(text => this.appendStderr(text), (stage, code) => {
        this.fail(new TraeAcpError("TRAE CN Windows supervisor failed during " + stage + " (Win32 " + code + ").",
          stage === "transport" ? "trae_acp_transport" : "trae_startup_windows_" + stage));
      });
    }
    this.lifecycle = new Promise(resolve => {
      child.once("error", error => {
        this.spawnFailed = child.pid === undefined && !this.initialized;
        this.fail(startupFailure("spawn", error));
      });
      child.once("close", () => { this.windowsFrames?.finish(); resolve(); });
    });
    child.stdin?.on("error", error => this.fail(error));
    traeStopPipe(child)?.on("error", () => undefined);
    let control = "";
    traeStopPipe(child)?.on("data", (chunk: Uint8Array) => {
      control = (control + Buffer.from(chunk).toString("ascii")).slice(-64);
      const launch = /OCX_TRAE_LAUNCH:(126|127)\n/.exec(control);
      if (launch) this.launchStatus = Number(launch[1]);
    });
    const stderrDecoder = new TextDecoder();
    child.stderr?.on("data", (chunk: Uint8Array) => {
      if (this.windowsFrames) this.windowsFrames.push(chunk);
      else this.appendStderr(stderrDecoder.decode(chunk, { stream: true }));
    });
    child.stderr?.once("end", () => { if (!this.windowsFrames) this.appendStderr(stderrDecoder.decode()); });
    this.reader = this.read();
    this.reader.catch(() => undefined);
  }

  private appendStderr(text: string): void {
    if (this.stderrTruncated) return;
    if (this.stderr.length + text.length > 8192) {
      this.stderr = "";
      this.stderrTruncated = true;
    } else this.stderr += text;
  }

  markInitialized(): void { this.initialized = true; }

  /** A successful set_model supersedes setup notifications; guard updates after that acknowledgement. */
  acknowledgeModelSelection(sessionId: string, modelId: string): void {
    this.selectedModel = { sessionId, modelId };
    for (let index = this.updates.length - 1; index >= 0; index--) {
      const frame = this.updates[index]!;
      if (frame.kind === "update" && frame.sessionId === sessionId && frame.update.sessionUpdate === "current_model_update") {
        this.updates.splice(index, 1);
      }
    }
  }

  closedError(error: TraeAcpError): TraeAcpError {
    if (!this.initialized && this.launchStatus) {
      return startupFailure("spawn", { code: this.launchStatus === 127 ? "ENOENT" : "EACCES" });
    }
    return new TraeAcpError(this.diagnostic() || error.message, error.code);
  }

  /** Wake every waiter immediately; process reaping is separate from request settlement. */
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure ??= error;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  /** Demultiplex bounded replies and session updates; client capabilities stay disabled. */
  private async read(): Promise<void> {
    try {
      if (!this.child.stdout) throw new TraeAcpProtocolError("TRAE CN ACP stdout is unavailable");
      for await (const message of readJsonLines(this.child.stdout, { maxLineBytes: 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 })) {
        const frame = parseTraeAcpMessage(message);
        if (frame.kind === "request") {
          this.write({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Client capabilities are disabled for this text-only provider" } });
          throw new TraeAcpError("TRAE CN requested a disabled client capability", "trae_client_request_unsupported");
        }
        if (frame.kind === "response") {
          const waiter = this.pending.get(frame.id);
          if (!waiter) continue;
          this.pending.delete(frame.id);
          clearTimeout(waiter.timer);
          if (frame.error) waiter.reject(new TraeAcpError(redactSecretString(frame.error.message).slice(0, 512), "trae_acp_rpc_error"));
          else waiter.resolve(frame.result);
          continue;
        }
        const selected = this.selectedModel;
        if (selected && frame.sessionId === selected.sessionId && frame.update.sessionUpdate === "current_model_update") {
          if (frame.update.currentModelId !== selected.modelId) {
            throw new TraeAcpError("TRAE CN changed the selected model unexpectedly.", "trae_model_changed");
          }
          continue;
        }
        if (this.waiters.length) this.waiters.shift()!(frame);
        else if (this.updates.length < 1024) this.updates.push(frame);
        else throw new TraeAcpProtocolError("TRAE CN ACP update queue exceeded its bound");
      }
      this.fail(this.failure ?? new TraeAcpError("TRAE CN ACP closed before the turn completed", "trae_acp_closed"));
    } catch (error) {
      // The shared JSONL parser includes stdout snippets, which can contain partial secrets.
      this.fail(error instanceof CodingAgentStreamLimitError
        ? new TraeAcpError("TRAE CN ACP stdout exceeded its size limit.", "trae_stdout_limit")
        : error instanceof TraeAcpError ? error
        : new TraeAcpProtocolError("TRAE CN ACP returned malformed or unsupported protocol data."));
    }
  }

  /** Write one JSON-RPC frame only while the child input remains available. */
  write(message: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin?.writable) throw new TraeAcpError("TRAE CN ACP input is closed", "trae_acp_closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Register before writing so immediate responses and stream errors settle the same request. */
  async request(method: string, params: Record<string, unknown>, dispatch?: TraePromptDispatch,
    onSuccess?: (result: unknown) => void): Promise<unknown> {
    if (this.closed) throw this.failure ?? new TraeAcpError("TRAE CN ACP is closed", "trae_acp_closed");
    const id = ++this.nextId;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TraeAcpError(`TRAE CN ACP timed out during ${method}`, "trae_acp_timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: result => {
        try { onSuccess?.(result); resolve(result); } catch (error) { reject(error); }
      }, reject, timer });
    });
    try {
      dispatch?.beforeSend();
      this.write({ jsonrpc: "2.0", id, method, params });
      dispatch?.onSend();
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    return result;
  }

  /** Drain already-received updates before reporting end of the stream. */
  nextUpdate(): Promise<TraeAcpFrame | null> {
    const queued = this.updates.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed || this.updatesEnded) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  /** Settle the one update consumer without subscribing again for every streamed chunk. */
  endUpdates(): void {
    this.updatesEnded = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  /** Expose only a bounded, redacted diagnostic when the CLI closes unexpectedly. */
  diagnostic(): string {
    if (this.stderrTruncated) return "TRAE CN stderr exceeded the diagnostic limit; its contents were suppressed.";
    return redactSecretString(this.stderr.trim() || this.failure?.message || "").trim().slice(0, 512);
  }

  /** Stop RPCs first, then terminate the owned process tree and bound all remaining waits. */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail(new TraeAcpError("TRAE CN ACP session closed", "trae_acp_closed"));
    this.closing = (async () => {
      const reapTimeoutMs = this.deps.reapTimeoutMs ?? 2250;
      const graceMs = this.deps.killGraceMs ?? 2000;
      let stopped: boolean;
      if ((this.deps.platform ?? process.platform) === "win32") {
        try { this.child.stdin?.end("__OCX_STOP_TRAE__\n"); } catch { /* Supervisor may have exited. */ }
        let exited = await waitBounded(this.lifecycle, graceMs + reapTimeoutMs);
        if (!exited) {
          // Closing the supervisor's non-inherited Job handle kills remaining members.
          // Without its accounting proof we still report an unconfirmed shutdown.
          try { this.child.kill("SIGKILL"); } catch { /* Already exited. */ }
          exited = await waitBounded(this.lifecycle, reapTimeoutMs);
        }
        stopped = exited && (this.spawnFailed || this.windowsFrames?.processTreeExited === true);
      } else {
        try { traeStopPipe(this.child)?.end("stop\n"); } catch { /* An exited supervisor already closed the descriptor. */ }
        stopped = await waitBounded(this.lifecycle, graceMs + reapTimeoutMs);
      }
      traeStopPipe(this.child)?.destroy();
      this.child.stdin?.destroy();
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      await waitBounded(this.reader, reapTimeoutMs);
      if (!stopped) throw new TraeAcpError("TRAE CN process shutdown was not confirmed before its deadline.", "trae_shutdown_timeout");
    })();
    return this.closing;
  }
}

export interface TraeSession {
  readonly models: string[];
  prompt(modelId: string, text: string, emit: (event: AdapterEvent) => void, signal?: AbortSignal, dispatch?: TraePromptDispatch): Promise<void>;
  close(): Promise<void>;
}

/** Start a cancellable ACP session in owned temporary directories; callers close successful sessions. */
export async function openTraeSession(
  baseUrl: string | undefined, deps: TraeAcpDeps = {}, signal?: AbortSignal,
  routing: Pick<OcxProviderConfig, "proxy" | "noProxy"> = {},
): Promise<TraeSession> {
  signal?.throwIfAborted();
  if (routing.proxy !== undefined || routing.noProxy !== undefined) {
    throw new TraeAcpError("TRAE CN ACP cannot honor provider proxy/noProxy overrides; the official CLI owns its network route.", "trae_proxy_unsupported");
  }
  if (!traeCnDestinationMatches(baseUrl)) throw new TraeAcpError("TRAE CN requires its canonical provider destination", "non_canonical_destination");
  let binary: string | undefined;
  try { binary = (deps.resolveBinary ?? resolveTraeCli)(); } catch (error) { throw startupFailure("resolve_cli", error); }
  if (!binary) throw new TraeAcpError("TRAE CN CLI not found. Install traecli and sign in through TRAE CN.", "cli_not_found");
  let env: Record<string, string>;
  try { env = traeCnChildEnv(process.env, deps.platform ?? process.platform); } catch (error) { throw startupFailure("environment", error); }
  const ownHome = deps.home === undefined;
  const makeTempDir = deps.makeTempDir ?? mkdtemp;
  let home: string;
  try { home = deps.home ?? await makeTempDir(join(tmpdir(), "ocx-trae-cn-")); } catch (error) { throw startupFailure("home", error); }
  let work: string;
  try { work = deps.cwd ?? await makeTempDir(join(tmpdir(), "ocx-trae-cn-work-")); } catch (error) {
    if (ownHome) await rm(home, { recursive: true, force: true }).catch(() => undefined);
    throw startupFailure("workspace", error);
  }
  let cleanupSupervisor: (() => Promise<void>) | undefined;
  const cleanup = async (): Promise<void> => {
    await cleanupSupervisor?.().catch(() => undefined);
    await Promise.all([
      ...(ownHome ? [rm(home, { recursive: true, force: true }).catch(() => undefined)] : []),
      ...(!deps.cwd ? [rm(work, { recursive: true, force: true }).catch(() => undefined)] : []),
    ]);
  };
  env.HOME = home;
  if ((deps.platform ?? process.platform) === "win32") env.USERPROFILE = home;
  const disabledTools = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "TodoWrite", "AskUserQuestion"];
  const args = [...disabledTools.flatMap(tool => ["--disallowed-tool", tool]), "acp", "serve"];
  let child: ChildProcess;
  try {
    signal?.throwIfAborted();
    const invocation = commandInvocation(binary, args, deps.platform ?? process.platform, { env });
    const windows = (deps.platform ?? process.platform) === "win32";
    const owned = windows
      ? await prepareTraeWindowsJob(invocation, home, work, deps.reapTimeoutMs ?? 2250, env)
      : { ...traePosixInvocation(invocation.file, invocation.args, deps.killGraceMs ?? 2000), options: {} };
    if ("cleanup" in owned) cleanupSupervisor = owned.cleanup;
    signal?.throwIfAborted();
    child = (deps.spawn ?? nodeSpawn)(owned.file, owned.args, {
      ...owned.options, env, stdio: windows ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"], windowsHide: true,
      detached: !windows,
      cwd: deps.cwd ?? work,
    });
  } catch (error) {
    await cleanup();
    if (signal?.aborted) throw error;
    throw startupFailure("spawn", error);
  }
  const client = new TraeAcpClient(child, deps.timeoutMs ?? 300_000, deps);
  const abort = () => { void client.close().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  let opened = false;
  try {
    signal?.throwIfAborted();
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "opencodex", title: "OpenCodex", version: "1" },
    });
    client.markInitialized();
    const result = await client.request("session/new", {
      cwd: deps.cwd ?? work, mcpServers: [], _meta: { trae: { options: { skills: [] } } },
    });
    const sessionId = traeSessionId(result);
    const models = parseTraeModels(result);
    opened = true;
    return {
      models,
      async prompt(modelId, text, emit, signal, dispatch) {
        if (signal?.aborted) return;
        if (!models.includes(modelId)) throw new TraeAcpError(`TRAE CN model is not available to this account: ${modelId}`, "trae_model_unavailable");
        const abort = () => { void client.close().catch(() => undefined); };
        signal?.addEventListener("abort", abort, { once: true });
        let completion: Promise<unknown> | undefined;
        try {
          await client.request("session/set_model", { sessionId, modelId }, undefined, () => client.acknowledgeModelSelection(sessionId, modelId));
          if (signal?.aborted) return;
          let output = false;
          let receivedCompletion: unknown;
          let completionReceived = false;
          completion = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, dispatch, result => {
            receivedCompletion = result;
            completionReceived = true;
          });
          const endUpdatesAfterBatch = () => {
            const timer = setTimeout(() => client.endUpdates(), 0);
            timer.unref?.();
          };
          void completion.then(endUpdatesAfterBatch, endUpdatesAfterBatch);
          while (true) {
            const frame = await client.nextUpdate();
            if (!frame) break;
            if (frame.kind !== "update" || frame.sessionId !== sessionId) continue;
            for (const event of traePromptEvents(sessionId, frame.update)) {
              if (event.type === "error") {
                const usage = completionReceived ? traeUsage(receivedCompletion) : undefined;
                emit({ ...event, ...(usage ? { usage } : {}) });
                client.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
                await client.close();
                return;
              }
              if (event.type === "text_delta") output = true;
              emit(event);
            }
          }
          const result = await completion;
          const usage = traeUsage(result);
          let stop: string;
          try { stop = traeStopReason(result); } catch {
            emit({ type: "error", message: "TRAE CN ACP ended with an invalid protocol response.", code: "trae_acp_protocol_error",
              status: 502, errorType: "upstream_error", retryable: false, ...(usage ? { usage } : {}) });
            return;
          }
          if (stop === "cancelled") {
            emit({ type: "incomplete", reason: "upstream_cancelled", retryable: false,
              message: "TRAE CN cancelled the turn.", ...(usage ? { usage } : {}) });
            return;
          }
          if (stop === "refusal") {
            emit({ type: "incomplete", reason: "content_filter", retryable: false,
              message: "TRAE CN refused the turn.", ...(usage ? { usage } : {}) });
            return;
          }
          if (stop === "max_turn_requests") {
            emit({ type: "incomplete", reason: "max_turn_requests", retryable: false,
              message: "TRAE CN reached its request limit for this turn.", ...(usage ? { usage } : {}) });
            return;
          }
          const terminalError = stop !== "stop" && stop !== "max_tokens"
            ? { message: "TRAE CN stopped the turn: " + stop, code: "trae_turn_stopped" }
            : !output && stop !== "max_tokens" ? { message: "TRAE CN ended without a text response.", code: "trae_empty_response" } : undefined;
          if (terminalError) {
            emit({ type: "error", ...terminalError,
              status: 502, errorType: "upstream_error", retryable: false, ...(usage ? { usage } : {}) });
            return;
          }
          emit({ type: "done", stopReason: stop, ...(usage ? { usage } : {}) });
        } catch (error) {
          if (error instanceof TraeAcpError && error.code === "trae_acp_closed") {
            await client.close();
            throw client.closedError(error);
          }
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          completion?.catch(() => undefined);
        }
      },
      close: async () => {
        signal?.removeEventListener("abort", abort);
        await client.close();
        await cleanup();
      },
    };
  } catch (error) {
    if (error instanceof TraeAcpError && error.code === "trae_acp_closed") {
      await client.close();
      throw client.closedError(error);
    }
    throw error;
  } finally {
    if (!opened) {
      signal?.removeEventListener("abort", abort);
      // Keep owned files when process exit could not be confirmed.
      await client.close().then(cleanup).catch(() => undefined);
    }
  }
}
