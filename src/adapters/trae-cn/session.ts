import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandInvocation } from "../../lib/win-exec";
import { redactSecretString } from "../../lib/redact";
import type { AdapterEvent } from "../../types";
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
}

export class TraeAcpError extends Error {
  constructor(message: string, readonly code = "trae_acp_error") {
    super(message);
    this.name = "TraeAcpError";
  }
}

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

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

  constructor(private readonly child: ChildProcess, private readonly timeoutMs: number) {
    this.lifecycle = new Promise(resolve => {
      child.once("error", error => { this.failure ??= error; this.fail(error); });
      child.once("close", resolve);
      if (child.exitCode !== null) resolve();
    });
    child.stderr?.on("data", (chunk: Uint8Array) => {
      this.stderr.push(new TextDecoder().decode(chunk));
      while (this.stderr.join("").length > 8192) this.stderr.shift();
    });
    this.reader = this.read();
    this.reader.catch(() => undefined);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure ??= error;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

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
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  write(message: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin?.writable) throw new TraeAcpError("TRAE CN ACP input is closed", "trae_acp_closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw this.failure ?? new TraeAcpError("TRAE CN ACP is closed", "trae_acp_closed");
    const id = ++this.nextId;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TraeAcpError(`TRAE CN ACP timed out during ${method}`, "trae_acp_timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  nextUpdate(): Promise<TraeAcpFrame | null> {
    const queued = this.updates.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  diagnostic(): string {
    return redactSecretString(this.failure?.message || this.stderr.join("")).trim().slice(0, 512);
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.child.kill("SIGTERM");
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
      try { await this.lifecycle; } finally { clearTimeout(timer); }
      this.fail(new TraeAcpError("TRAE CN ACP session closed", "trae_acp_closed"));
      await this.reader;
    })();
    return this.closing;
  }
}

export interface TraeSession {
  readonly models: string[];
  prompt(modelId: string, text: string, emit: (event: AdapterEvent) => void, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export async function openTraeSession(baseUrl: string | undefined, deps: TraeAcpDeps = {}): Promise<TraeSession> {
  if (!traeCnDestinationMatches(baseUrl)) throw new TraeAcpError("TRAE CN requires its canonical provider destination", "non_canonical_destination");
  const binary = (deps.resolveBinary ?? resolveTraeCli)();
  if (!binary) throw new TraeAcpError("TRAE CN CLI not found. Install traecli and sign in through TRAE CN.", "cli_not_found");
  const env = traeCnChildEnv();
  const ownHome = deps.home === undefined;
  const home = deps.home ?? await mkdtemp(join(tmpdir(), "ocx-trae-cn-"));
  const work = deps.cwd ?? await mkdtemp(join(tmpdir(), "ocx-trae-cn-work-"));
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
    child = (deps.spawn ?? nodeSpawn)(invocation.file, invocation.args, {
      ...invocation.options, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      cwd: deps.cwd ?? work,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  const client = new TraeAcpClient(child, deps.timeoutMs ?? 300_000);
  let opened = false;
  try {
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
      async prompt(modelId, text, emit, signal) {
        if (signal?.aborted) return;
        if (!models.includes(modelId)) throw new TraeAcpError(`TRAE CN model is not available to this account: ${modelId}`, "trae_model_unavailable");
        const abort = () => { void client.close(); };
        signal?.addEventListener("abort", abort, { once: true });
        let completion: Promise<unknown> | undefined;
        try {
          await client.request("session/set_model", { sessionId, modelId });
          let output = false;
          let sawTool = false;
          completion = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
          while (true) {
            const frame = await Promise.race([
              client.nextUpdate(),
              completion.then(() => null, () => null),
            ]);
            if (!frame) break;
            if (frame.kind !== "update" || frame.sessionId !== sessionId) continue;
            if (frame.update.sessionUpdate === "tool_call" || frame.update.sessionUpdate === "tool_call_update") sawTool = true;
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
          if (stop === "cancelled") return;
          if (stop !== "stop" && stop !== "max_tokens") throw new TraeAcpError(`TRAE CN stopped the turn: ${stop}`, "trae_turn_stopped");
          if (!output) throw new TraeAcpError(sawTool
            ? "TRAE CN ended after an internal tool turn without a text response. Retry the text request or select another model."
            : "TRAE CN ended without a text response.", "trae_empty_response");
          const usage = traeUsage(result);
          emit({ type: "done", stopReason: stop, ...(usage ? { usage } : {}) });
        } finally {
          signal?.removeEventListener("abort", abort);
          completion?.catch(() => undefined);
        }
      },
      close: async () => {
        await client.close();
        await cleanup();
      },
    };
  } catch (error) {
    if (error instanceof TraeAcpError && error.code === "trae_acp_closed") {
      const detail = client.diagnostic();
      if (detail && detail !== error.message) throw new TraeAcpError(detail, error.code);
    }
    throw error;
  } finally {
    if (!opened) {
      await client.close().catch(() => undefined);
      await cleanup();
    }
  }
}
