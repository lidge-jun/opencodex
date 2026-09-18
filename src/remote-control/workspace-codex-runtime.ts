import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { resolveCodexRuntime } from "../codex/runtime";
import { remoteWorkspaceThreadStartParams } from "./workspace-coordinator";
import { startRemoteWorkspaceToolBridge } from "./workspace-tool-bridge";
import { truncateRemoteWorkspaceUtf8 } from "./workspace-utf8";
import { REMOTE_WORKSPACE_TOOL_NAMESPACE } from "./workspace-tools";
import { findExecutableOnPath } from "./workspace-executable";
import {
  remoteWorkspaceProcessInvocation,
  removeRemoteWorkspaceIsolation,
  runRemoteWorkspaceCleanupSteps,
  stopRemoteWorkspaceProcess,
  waitForRemoteWorkspaceProcessExit,
} from "./workspace-process";
import {
  codexRemotePermissionProfileCompatibility,
  resolveCodexLinuxSandboxBinary,
} from "./workspace-codex-sandbox";
import type {
  RemoteWorkspaceRuntimeFactory,
  RemoteWorkspaceRuntimeHandle,
  RemoteWorkspaceSessionEvent,
} from "./workspace-sessions";

const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_BUFFERED_ASSISTANT_ITEMS = 32;
const MAX_BUFFERED_ASSISTANT_BYTES = 64 * 1024;
const MAX_EARLY_TURN_COMPLETIONS = 16;
const START_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: unknown };
}

interface PendingRpc {
  resolve(message: JsonRpcMessage): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  const raw = object(value);
  if (!raw) throw new Error("invalid Codex App Server message");
  if (raw.id !== undefined && typeof raw.id !== "string" && typeof raw.id !== "number") {
    throw new Error("invalid Codex App Server message ID");
  }
  if (raw.method !== undefined && typeof raw.method !== "string") {
    throw new Error("invalid Codex App Server method");
  }
  const params = raw.params === undefined ? undefined : object(raw.params);
  const result = raw.result === undefined ? undefined : object(raw.result);
  const error = raw.error === undefined ? undefined : object(raw.error);
  if ((raw.params !== undefined && !params)
    || (raw.result !== undefined && !result)
    || (raw.error !== undefined && !error)) {
    throw new Error("invalid Codex App Server message fields");
  }
  return {
    ...(raw.id !== undefined ? { id: raw.id } : {}),
    ...(typeof raw.method === "string" ? { method: raw.method } : {}),
    ...(params ? { params } : {}),
    ...(result ? { result } : {}),
    ...(error ? { error: { message: error.message } } : {}),
  };
}

function errorMessage(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  return raw.replace(/[^\x20-\x7e\n\t]/g, " ").slice(0, 4_096) || fallback;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nestedString(value: unknown, keys: readonly string[]): string | null {
  let current: unknown = value;
  for (const key of keys) current = object(current)?.[key];
  return typeof current === "string" && current.length > 0 ? current : null;
}

function itemText(value: unknown): string | null {
  const item = object(value);
  if (!item) return null;
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  if (!Array.isArray(item.content)) return null;
  const parts: string[] = [];
  for (const raw of item.content) {
    const part = object(raw);
    const text = part && typeof part.text === "string" ? part.text : null;
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function appendBoundedUtf8(current: string, delta: string, maximum: number): string {
  const marker = "\n[truncated]";
  if (current.endsWith(marker)) return current;
  const combined = `${current}${delta}`;
  if (Buffer.byteLength(combined, "utf8") <= maximum) return combined;
  const bodyLimit = maximum - Buffer.byteLength(marker, "utf8");
  return `${truncateRemoteWorkspaceUtf8(combined, bodyLimit)}${marker}`;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  if (!map.has(key) && map.size >= maximum) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

class JsonLineRpcProcess {
  private readonly pending = new Map<string | number, PendingRpc>();
  private nextId = 0;
  private closed = false;
  private closeError: Error | null = null;

  onRequest: ((message: JsonRpcMessage) => Promise<JsonRpcMessage>) | null = null;
  onNotification: ((message: JsonRpcMessage) => void) | null = null;
  onClose: ((error: Error) => void) | null = null;

  constructor(private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    void this.readStdout();
    void this.drainStderr();
    void child.exited.then(code => this.fail(new Error(`Codex App Server exited with code ${code}`)));
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonRpcMessage> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error("Codex App Server is closed"));
    const id = ++this.nextId;
    const result = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error("Codex App Server write failed"));
      }
    }
    return result;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    try {
      if (!this.closed) {
        try { this.child.stdin.end(); } catch { /* child already closed */ }
      }
      const graceful = await waitForRemoteWorkspaceProcessExit(this.child, 1_500);
      if (!graceful) {
        await stopRemoteWorkspaceProcess(this.child);
      }
    } finally {
      // Pending callers must settle even if the OS refuses to reap the child.
      this.fail(new Error("Codex App Server session closed"));
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) throw this.closeError ?? new Error("Codex App Server is closed");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) throw new Error("Codex App Server message is too large");
    this.child.stdin.write(line);
    this.child.stdin.flush();
  }

  private async readStdout(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > MAX_JSON_LINE_BYTES && !buffer.includes("\n")) {
          throw new Error("Codex App Server output line is too large");
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) throw new Error("Codex App Server output line is too large");
          if (line) this.receive(parseJsonRpcMessage(JSON.parse(line)));
          newline = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      void stopRemoteWorkspaceProcess(this.child).catch(() => {});
      this.fail(new Error(errorMessage(error, "Codex App Server output failed")));
    } finally {
      reader.releaseLock();
    }
  }

  private async drainStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    let retained = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        retained = Math.min(MAX_STDERR_BYTES, retained + next.value.byteLength);
      }
    } catch {
      // stdout and the exit code own the user-visible process failure.
    } finally {
      reader.releaseLock();
      void retained;
    }
  }

  private receive(message: JsonRpcMessage): void {
    if (!message || typeof message !== "object") throw new Error("invalid Codex App Server message");
    if (message.id !== undefined && typeof message.method !== "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(errorMessage(message.error.message, "Codex App Server request failed")));
      else pending.resolve(message);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id === undefined) {
      this.onNotification?.(message);
      return;
    }
    const id = message.id;
    const request = this.onRequest;
    if (!request) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32_601, message: "client request handler is unavailable" } });
      return;
    }
    void request(message).then(
      response => this.send({ jsonrpc: "2.0", ...response }),
      error => this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32_000, message: errorMessage(error, "Remote Workspace tool failed") },
      }),
    );
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose?.(error);
  }
}

interface ActiveTurn {
  id: string;
  resolve(): void;
  reject(error: Error): void;
}

export interface CodexRemoteWorkspaceRuntimeOptions {
  /** Test seam. Production resolves the configured, trusted Codex runtime. */
  command?: readonly string[];
  env?: Record<string, string | undefined>;
  version?: string;
}

export class CodexRemoteWorkspaceRuntimeFactory implements RemoteWorkspaceRuntimeFactory {
  readonly profile = "codex" as const;

  constructor(private readonly options: CodexRemoteWorkspaceRuntimeOptions = {}) {}

  async available(): Promise<{ available: boolean; version?: string; reason?: string }> {
    if (this.options.command && this.options.command.length > 0) {
      return { available: true, version: this.options.version ?? "test" };
    }
    const resolved = resolveCodexRuntime();
    const compatibility = codexRemotePermissionProfileCompatibility();
    if (!compatibility.compatible) return { available: false, reason: compatibility.reason };
    return resolved.runtime.version
      ? { available: true, version: resolved.runtime.version }
      : { available: false, reason: "Codex CLI is not installed or runnable on this Hub." };
  }

  async start(options: Parameters<RemoteWorkspaceRuntimeFactory["start"]>[0]): Promise<RemoteWorkspaceRuntimeHandle> {
    const command = this.options.command
      ? [...this.options.command]
      : [resolveCodexRuntime().runtime.command];
    if (command.length < 1) throw new Error("Codex CLI is unavailable on this Hub");
    const executablePath = isAbsolute(command[0]!) ? command[0]! : findExecutableOnPath(command[0]!);
    if (!executablePath) throw new Error("Codex CLI executable could not be resolved on this Hub");
    command[0] = executablePath;
    const runtimeDirectory = dirname(realpathSync(executablePath));
    const isolation = mkdtempSync(join(tmpdir(), "ocx-remote-codex-"));
    let processPath = process.env.PATH ?? "/usr/bin:/bin";
    const runtimeReadPaths = [runtimeDirectory];
    try {
      chmodSync(isolation, 0o700);
      if (process.platform === "linux") {
        const native = resolveCodexLinuxSandboxBinary(executablePath);
        if (!native) {
          throw new Error("Codex Remote Workspace could not locate the native Linux permission-profile helper");
        }
        const helperDir = join(isolation, "sandbox-bin");
        mkdirSync(helperDir, { mode: 0o700 });
        const helper = join(helperDir, "codex-linux-sandbox");
        try { linkSync(native, helper); }
        catch { symlinkSync(native, helper); }
        processPath = `${helperDir}:${processPath}`;
        runtimeReadPaths.push(dirname(native), helperDir);
      }
    } catch (error) {
      removeRemoteWorkspaceIsolation(isolation);
      throw error;
    }
    const thread = { id: "" };
    const bridge = (() => {
      try {
        return startRemoteWorkspaceToolBridge({
          coordinator: options.coordinator,
          threadId: () => thread.id,
          tools: options.tools,
          onTool: tool => options.emit("tool", `Running ${tool} on ${options.deviceName}/${options.rootLabel}`),
        });
      } catch (error) {
        removeRemoteWorkspaceIsolation(isolation);
        throw error;
      }
    })();
    const tokenEnvVar = "OCX_REMOTE_WORKSPACE_MCP_TOKEN";
    const mcpPrefix = `mcp_servers.${REMOTE_WORKSPACE_TOOL_NAMESPACE}`;
    const childEnv = { ...process.env, ...this.options.env, PATH: processPath, [tokenEnvVar]: bridge.token };
    const invocation = remoteWorkspaceProcessInvocation([
      ...command,
      "-c", `${mcpPrefix}.url=${JSON.stringify(`${bridge.url}/mcp`)}`,
      "-c", `${mcpPrefix}.bearer_token_env_var=${JSON.stringify(tokenEnvVar)}`,
      "-c", `${mcpPrefix}.required=true`,
      "-c", `${mcpPrefix}.enabled_tools=${JSON.stringify(options.tools)}`,
      "-c", `${mcpPrefix}.default_tools_approval_mode="approve"`,
      "app-server", "--listen", "stdio://",
    ], { env: childEnv });
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      child = Bun.spawn([invocation.file, ...invocation.args], {
        cwd: isolation,
        env: childEnv,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        ...invocation.options,
      });
    } catch (error) {
      await bridge.stop();
      removeRemoteWorkspaceIsolation(isolation);
      throw error;
    }
    const peer = new JsonLineRpcProcess(child);
    let activeTurn: ActiveTurn | null = null;
    let stopped = false;
    const completedBeforeWait = new Map<string, { status: string; error: string | null }>();
    const assistantDeltas = new Map<string, string>();
    let stopOperation: Promise<void> | null = null;

    const finishTurn = (turnId: string, status: string, detail: string | null): void => {
      if (!activeTurn || activeTurn.id !== turnId) {
        setBounded(completedBeforeWait, turnId, { status, error: detail }, MAX_EARLY_TURN_COMPLETIONS);
        return;
      }
      const current = activeTurn;
      activeTurn = null;
      assistantDeltas.clear();
      if (status === "completed") current.resolve();
      else current.reject(new Error(detail ?? `Codex turn ${status}`));
    };

    peer.onRequest = async message => {
      if (message.method !== "item/tool/call" || message.id === undefined) {
        throw new Error("unsupported Codex App Server client request");
      }
      const tool = nestedString(message.params, ["tool"]) ?? "remote tool";
      options.emit("tool", `Running ${tool} on ${options.deviceName}/${options.rootLabel}`);
      return options.coordinator.handle({
        method: "item/tool/call",
        id: message.id,
        params: message.params,
      });
    };
    peer.onNotification = message => {
      const params = message.params ?? {};
      if (message.method === "item/agentMessage/delta") {
        const itemId = nestedString(params, ["itemId"]) ?? nestedString(params, ["item", "id"]);
        const delta = nestedString(params, ["delta"]);
        if (itemId && delta) {
          setBounded(
            assistantDeltas,
            itemId,
            appendBoundedUtf8(assistantDeltas.get(itemId) ?? "", delta, MAX_BUFFERED_ASSISTANT_BYTES),
            MAX_BUFFERED_ASSISTANT_ITEMS,
          );
        }
        return;
      }
      if (message.method === "item/completed") {
        const item = object(params.item);
        const itemId = item && typeof item.id === "string" ? item.id : null;
        const text = itemText(item) ?? (itemId ? assistantDeltas.get(itemId) ?? null : null);
        if (itemId) assistantDeltas.delete(itemId);
        if (text) options.emit("assistant", text);
        return;
      }
      if (message.method === "turn/completed") {
        const turn = object(params.turn);
        const turnId = turn && typeof turn.id === "string" ? turn.id : null;
        if (!turnId) return;
        const status = typeof turn?.status === "string" ? turn.status : "failed";
        const detail = nestedString(turn, ["error", "message"]);
        finishTurn(turnId, status, detail);
      }
    };
    peer.onClose = error => {
      const current = activeTurn;
      activeTurn = null;
      completedBeforeWait.clear();
      assistantDeltas.clear();
      current?.reject(error);
    };

    try {
      await peer.request("initialize", {
        clientInfo: { name: "opencodex_remote_workspace", title: "OpenCodex Remote Workspace", version: "1" },
        capabilities: { experimentalApi: true },
      }, START_TIMEOUT_MS);
      peer.notify("initialized", {});
      const effective = await peer.request("config/read", { cwd: isolation, includeLayers: false }, START_TIMEOUT_MS);
      const effectiveConfig = object(effective.result?.config) ?? {};
      if (typeof effectiveConfig.sandbox_mode === "string" || effectiveConfig.sandbox_workspace_write) {
        throw new Error("Codex Remote Workspace requires permission profiles; remove legacy sandbox_mode settings from the selected Codex profile first");
      }
      const disabledServerNames = Object.keys(object(effectiveConfig.mcp_servers) ?? {});
      const disabledHookNames = Object.keys(object(effectiveConfig.hooks) ?? {});
      const threadParams = remoteWorkspaceThreadStartParams({
        executorName: options.deviceName,
        coordinatorIsolationPath: isolation,
        tools: options.tools,
        mcp: {
          url: `${bridge.url}/mcp`,
          bearerTokenEnvVar: tokenEnvVar,
          disabledServerNames,
          disabledHookNames,
          hubRuntimeReadPaths: runtimeReadPaths,
        },
      });
      const { ephemeral: _startOnlyEphemeral, ...resumeParams } = threadParams;
      const started = options.resumeThreadId
        ? await peer.request("thread/resume", { ...resumeParams, threadId: options.resumeThreadId }, START_TIMEOUT_MS)
        : await peer.request("thread/start", threadParams, START_TIMEOUT_MS);
      const threadId = nestedString(started.result, ["thread", "id"]);
      if (!threadId) throw new Error("Codex App Server returned no thread ID");
      if (options.resumeThreadId && threadId !== options.resumeThreadId) {
        throw new Error("Codex App Server resumed a different Remote Workspace thread");
      }
      thread.id = threadId;

      return {
        threadId,
        async prompt(text: string): Promise<void> {
          if (stopped) throw new Error("Codex Remote Workspace session is stopped");
          if (activeTurn) throw new Error("Codex Remote Workspace turn is already active");
          const startedTurn = await peer.request("turn/start", {
            threadId,
            input: [{ type: "text", text }],
            approvalPolicy: "never",
          });
          const turnId = nestedString(startedTurn.result, ["turn", "id"]);
          if (!turnId) throw new Error("Codex App Server returned no turn ID");
          const early = completedBeforeWait.get(turnId);
          if (early) {
            completedBeforeWait.delete(turnId);
            if (early.status === "completed") return;
            throw new Error(early.error ?? `Codex turn ${early.status}`);
          }
          await new Promise<void>((resolve, reject) => { activeTurn = { id: turnId, resolve, reject }; });
        },
        stop(): Promise<void> {
          if (stopOperation) return stopOperation;
          stopped = true;
          const turn = activeTurn;
          stopOperation = runRemoteWorkspaceCleanupSteps([
            async () => {
              if (turn) await peer.request("turn/interrupt", { threadId, turnId: turn.id }, 3_000).catch(() => {});
            },
            () => peer.close(),
            () => bridge.stop(),
            () => removeRemoteWorkspaceIsolation(isolation),
          ]);
          return stopOperation;
        },
      };
    } catch (error) {
      await peer.close().catch(() => {});
      await bridge.stop();
      removeRemoteWorkspaceIsolation(isolation);
      throw error;
    }
  }
}
