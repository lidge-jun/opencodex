import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandInvocation } from "../../lib/win-exec";
import { redactSecretString } from "../../lib/redact";
import type { AdapterEvent, OcxProviderConfig } from "../../types";
import { readJsonLines } from "../coding-agent/protocol";
import { resolveTraeCli, traeCnChildEnv, traeCnDestinationMatches } from "./profile";
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
  killWindowsProcessTree?: (pid: number) => void;
  signalPosixProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  makeTempDir?: typeof mkdtemp;
}

export class TraeAcpError extends Error {
  constructor(message: string, readonly code = "trae_acp_error") {
    super(message);
    this.name = "TraeAcpError";
  }
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
  private readonly stderr: string[] = [];
  private readonly reader: Promise<void>;
  private readonly lifecycle: Promise<void>;
  private failure?: Error;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly child: ChildProcess, private readonly timeoutMs: number, private readonly deps: TraeAcpDeps) {
    this.lifecycle = new Promise(resolve => {
      child.once("error", error => { this.failure ??= error; this.fail(error); });
      child.once("close", resolve);
      if (child.exitCode !== null) resolve();
    });
    child.stdin?.on("error", error => this.fail(error));
    child.stderr?.on("data", (chunk: Uint8Array) => {
      this.stderr.push(new TextDecoder().decode(chunk));
      while (this.stderr.join("").length > 8192) this.stderr.shift();
    });
    this.reader = this.read();
    this.reader.catch(() => undefined);
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
        if (this.waiters.length) this.waiters.shift()!(frame);
        else if (this.updates.length < 1024) this.updates.push(frame);
        else throw new TraeAcpProtocolError("TRAE CN ACP update queue exceeded its bound");
      }
      this.fail(this.failure ?? new TraeAcpError("TRAE CN ACP closed before the turn completed", "trae_acp_closed"));
    } catch (error) {
      // The shared JSONL parser includes stdout snippets, which can contain partial secrets.
      this.fail(error instanceof TraeAcpError ? error
        : new TraeAcpProtocolError("TRAE CN ACP returned malformed or unsupported protocol data."));
    }
  }

  /** Write one JSON-RPC frame only while the child input remains available. */
  write(message: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin?.writable) throw new TraeAcpError("TRAE CN ACP input is closed", "trae_acp_closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Register before writing so immediate responses and stream errors settle the same request. */
  async request(method: string, params: Record<string, unknown>, dispatch?: TraePromptDispatch): Promise<unknown> {
    if (this.closed) throw this.failure ?? new TraeAcpError("TRAE CN ACP is closed", "trae_acp_closed");
    const id = ++this.nextId;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TraeAcpError(`TRAE CN ACP timed out during ${method}`, "trae_acp_timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
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
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  /** Expose only a bounded, redacted diagnostic when the CLI closes unexpectedly. */
  diagnostic(): string {
    return redactSecretString(this.stderr.join("").trim() || this.failure?.message || "").trim().slice(0, 512);
  }

  /** Stop RPCs first, then terminate the owned process tree and bound all remaining waits. */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail(new TraeAcpError("TRAE CN ACP session closed", "trae_acp_closed"));
    this.closing = (async () => {
      const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
        if (this.deps.signalPosixProcessGroup) this.deps.signalPosixProcessGroup(pid, signal);
        else process.kill(-pid, signal);
      };
      const terminate = (signal: NodeJS.Signals): void => {
        const pid = this.child.pid;
        if (pid && (this.deps.platform ?? process.platform) === "win32") {
          try {
            if (this.deps.killWindowsProcessTree) this.deps.killWindowsProcessTree(pid);
            else execFileSync(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", "/F"],
              { stdio: "ignore", windowsHide: true, timeout: 1000 });
            return;
          } catch { /* Fall back to the direct child if tree termination is unavailable. */ }
        } else if (pid) {
          try { signalGroup(pid, signal); return; } catch { /* The process group may already be gone. */ }
        }
        try { this.child.kill(signal); } catch { /* Already exited. */ }
      };
      terminate("SIGTERM");
      const reapTimeoutMs = this.deps.reapTimeoutMs ?? 2250;
      if (!await waitBounded(this.lifecycle, this.deps.killGraceMs ?? 2000)) {
        terminate("SIGKILL");
        await waitBounded(this.lifecycle, reapTimeoutMs);
      } else if (this.child.pid && (this.deps.platform ?? process.platform) !== "win32") {
        // The group can outlive its leader, even when the leader closed every pipe.
        try { signalGroup(this.child.pid, "SIGKILL"); } catch { /* The group has already exited. */ }
      }
      this.child.stdin?.destroy();
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      await waitBounded(this.reader, reapTimeoutMs);
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
  const binary = (deps.resolveBinary ?? resolveTraeCli)();
  if (!binary) throw new TraeAcpError("TRAE CN CLI not found. Install traecli and sign in through TRAE CN.", "cli_not_found");
  const env = traeCnChildEnv(process.env, deps.platform ?? process.platform);
  const ownHome = deps.home === undefined;
  const makeTempDir = deps.makeTempDir ?? mkdtemp;
  const home = deps.home ?? await makeTempDir(join(tmpdir(), "ocx-trae-cn-"));
  let work: string;
  try { work = deps.cwd ?? await makeTempDir(join(tmpdir(), "ocx-trae-cn-work-")); } catch (error) {
    if (ownHome) await rm(home, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const cleanup = async (): Promise<void> => {
    await Promise.all([
      ...(ownHome ? [rm(home, { recursive: true, force: true }).catch(() => undefined)] : []),
      ...(!deps.cwd ? [rm(work, { recursive: true, force: true }).catch(() => undefined)] : []),
    ]);
  };
  env.HOME = home;
  if ((deps.platform ?? process.platform) === "win32") env.USERPROFILE = home;
  const disabledTools = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "TodoWrite", "AskUserQuestion"];
  const args = [...disabledTools.flatMap(tool => ["--disallowed-tool", tool]), "acp", "serve"];
  const invocation = commandInvocation(binary, args, deps.platform ?? process.platform, { env });
  let child: ChildProcess;
  try {
    signal?.throwIfAborted();
    child = (deps.spawn ?? nodeSpawn)(invocation.file, invocation.args, {
      ...invocation.options, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      detached: (deps.platform ?? process.platform) !== "win32",
      cwd: deps.cwd ?? work,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  const client = new TraeAcpClient(child, deps.timeoutMs ?? 300_000, deps);
  const abort = () => { void client.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  let opened = false;
  try {
    signal?.throwIfAborted();
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "opencodex", title: "OpenCodex", version: "1" },
    });
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
        const abort = () => { void client.close(); };
        signal?.addEventListener("abort", abort, { once: true });
        let completion: Promise<unknown> | undefined;
        try {
          await client.request("session/set_model", { sessionId, modelId });
          if (signal?.aborted) return;
          let output = false;
          completion = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, dispatch);
          while (true) {
            const frame = await Promise.race([
              client.nextUpdate(),
              completion.then(() => null, () => null),
            ]);
            if (!frame) break;
            if (frame.kind !== "update" || frame.sessionId !== sessionId) continue;
            if (frame.update.sessionUpdate === "current_model_update") {
              if (frame.update.currentModelId !== modelId) {
                throw new TraeAcpError("TRAE CN changed the selected model unexpectedly.", "trae_model_changed");
              }
              continue;
            }
            for (const event of traePromptEvents(sessionId, frame.update)) {
              if (event.type === "text_delta") output = true;
              emit(event);
              if (event.type === "error") {
                client.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
                await client.close();
                return;
              }
            }
          }
          const result = await completion;
          const stop = traeStopReason(result);
          const usage = traeUsage(result);
          if (stop === "cancelled") {
            if (!signal?.aborted) emit({ type: "incomplete", reason: "upstream_cancelled", retryable: false,
              message: "TRAE CN cancelled the turn.", ...(usage ? { usage } : {}) });
            return;
          }
          if (stop === "refusal") {
            emit({ type: "incomplete", reason: "content_filter", retryable: false,
              message: "TRAE CN refused the turn.", ...(usage ? { usage } : {}) });
            return;
          }
          if (stop !== "stop" && stop !== "max_tokens") throw new TraeAcpError(`TRAE CN stopped the turn: ${stop}`, "trae_turn_stopped");
          if (!output) throw new TraeAcpError("TRAE CN ended without a text response.", "trae_empty_response");
          emit({ type: "done", stopReason: stop, ...(usage ? { usage } : {}) });
        } catch (error) {
          if (error instanceof TraeAcpError && error.code === "trae_acp_closed") {
            await client.close();
            throw new TraeAcpError(client.diagnostic() || error.message, error.code);
          }
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          completion?.catch(() => undefined);
        }
      },
      close: async () => {
        signal?.removeEventListener("abort", abort);
        try { await client.close(); } finally { await cleanup(); }
      },
    };
  } catch (error) {
    if (error instanceof TraeAcpError && error.code === "trae_acp_closed") {
      await client.close();
      const detail = client.diagnostic();
      if (detail && detail !== error.message) throw new TraeAcpError(detail, error.code);
    }
    throw error;
  } finally {
    if (!opened) {
      signal?.removeEventListener("abort", abort);
      await client.close().catch(() => undefined);
      await cleanup();
    }
  }
}
