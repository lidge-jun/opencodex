import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { findExecutableOnPath } from "./workspace-executable";
import {
  remoteWorkspaceProcessInvocation,
  removeRemoteWorkspaceIsolation,
  runRemoteWorkspaceCleanupSteps,
  stopRemoteWorkspaceProcess,
  waitForRemoteWorkspaceProcessExit,
} from "./workspace-process";
import { startRemoteWorkspaceToolBridge } from "./workspace-tool-bridge";
import { REMOTE_WORKSPACE_DYNAMIC_TOOLS } from "./workspace-tools";
import type {
  RemoteWorkspaceRuntimeFactory,
  RemoteWorkspaceRuntimeHandle,
} from "./workspace-sessions";

const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;

interface PendingResponse {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeError(value: unknown, fallback: string): string {
  return (value instanceof Error ? value.message : typeof value === "string" ? value : fallback)
    .replace(/[^\x20-\x7e\n\t]/g, " ")
    .slice(0, 4_096);
}

function messageText(value: unknown): string | null {
  const message = record(value);
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const text = message.content.flatMap(raw => {
    const part = record(raw);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("");
  return text || null;
}

function remotePiInstructions(deviceName: string, tools: readonly string[]): string {
  const name = deviceName.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120) || "remote executor";
  const remoteTools = tools.map(tool => `remote_${tool}`).join(", ");
  return [
    `You operate only on the OpenCodex remote executor named ${JSON.stringify(name)}.`,
    `Use only these tools for filesystem and command work: ${remoteTools}.`,
    "The Hub working directory is an empty isolation boundary, not the user's project.",
    "If a remote tool fails or the executor is offline, stop and report it. Never substitute local operations.",
  ].join(" ");
}

function extensionSource(tools: readonly string[]): string {
  const allowed = new Set(tools);
  const definitions = REMOTE_WORKSPACE_DYNAMIC_TOOLS[0].tools.filter(tool => allowed.has(tool.name)).map(tool => ({
    remoteName: `remote_${tool.name}`,
    tool: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
  return `const definitions = ${JSON.stringify(definitions)};
const endpoint = process.env.OCX_REMOTE_WORKSPACE_BRIDGE_URL;
const token = process.env.OCX_REMOTE_WORKSPACE_BRIDGE_TOKEN;

export default function registerRemoteWorkspace(pi) {
  if (!endpoint || !token) throw new Error("Remote Workspace bridge is unavailable");
  for (const definition of definitions) {
    pi.registerTool({
      name: definition.remoteName,
      label: definition.remoteName,
      description: definition.description,
      parameters: definition.parameters,
      async execute(_toolCallId, parameters, signal) {
        const response = await fetch(endpoint + "/invoke", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({ tool: definition.tool, arguments: parameters }),
          signal,
        });
        const result = await response.json();
        if (!response.ok || !result || result.success !== true) {
          throw new Error(result && typeof result.text === "string" ? result.text : "Remote Workspace tool failed");
        }
        return { content: [{ type: "text", text: result.text }], details: { remote: true } };
      },
    });
  }
}
`;
}

class PiRpcProcess {
  private readonly pending = new Map<string, PendingResponse>();
  private nextId = 0;
  private closed = false;
  private activeSettle: { resolve(): void; reject(error: Error): void } | null = null;

  onEvent: ((event: Record<string, unknown>) => void) | null = null;

  constructor(private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    void this.read();
    void this.drainStderr();
    void child.exited.then(code => this.fail(new Error(`Pi RPC exited with code ${code}`)));
  }

  async command(type: string, fields: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("Pi RPC is closed");
    const id = `ocx-${++this.nextId}`;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.send({ id, type, ...fields });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error("Pi RPC write failed"));
      }
    }
    return result;
  }

  async prompt(message: string): Promise<void> {
    if (this.activeSettle) throw new Error("Pi Remote Workspace turn is already active");
    const settled = new Promise<void>((resolve, reject) => { this.activeSettle = { resolve, reject }; });
    try {
      const accepted = await this.command("prompt", { message });
      if (accepted.success !== true) throw new Error(safeError(accepted.error, "Pi rejected the prompt"));
      await settled;
    } catch (error) {
      this.activeSettle = null;
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (!this.activeSettle) return;
    await this.command("abort", {}, 3_000).catch(() => {});
  }

  async close(): Promise<void> {
    try {
      if (!this.closed) {
        try { this.child.stdin.end(); } catch { /* already closed */ }
      }
      const graceful = await waitForRemoteWorkspaceProcessExit(this.child, 1_500);
      if (!graceful) {
        await stopRemoteWorkspaceProcess(this.child);
      }
    } finally {
      // Active and pending RPC waiters cannot survive a failed process teardown.
      this.fail(new Error("Pi Remote Workspace session closed"));
    }
  }

  private send(value: Record<string, unknown>): void {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) throw new Error("Pi RPC message is too large");
    this.child.stdin.write(line);
    this.child.stdin.flush();
  }

  private async read(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > MAX_JSON_LINE_BYTES && !buffer.includes("\n")) {
          throw new Error("Pi RPC output line is too large");
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) throw new Error("Pi RPC output line is too large");
          if (line) {
            const event = record(JSON.parse(line));
            if (!event) throw new Error("invalid Pi RPC event");
            this.receive(event);
          }
          newline = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      void stopRemoteWorkspaceProcess(this.child).catch(() => {});
      this.fail(new Error(safeError(error, "Pi RPC output failed")));
    } finally {
      reader.releaseLock();
    }
  }

  private async drainStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    try { while (!(await reader.read()).done) { /* drain without retaining secrets */ } }
    catch { /* stdout/exit code owns the failure */ }
    finally { reader.releaseLock(); }
  }

  private receive(event: Record<string, unknown>): void {
    if (event.type === "response" && typeof event.id === "string") {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(event.id);
      pending.resolve(event);
      return;
    }
    if (event.type === "agent_settled") {
      const active = this.activeSettle;
      this.activeSettle = null;
      active?.resolve();
    }
    if (event.type === "extension_error") {
      const active = this.activeSettle;
      this.activeSettle = null;
      active?.reject(new Error(safeError(event.error, "Pi Remote Workspace extension failed")));
    }
    this.onEvent?.(event);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const active = this.activeSettle;
    this.activeSettle = null;
    active?.reject(error);
  }
}

export interface PiRemoteWorkspaceRuntimeOptions {
  command?: readonly string[];
  env?: Record<string, string | undefined>;
  version?: string;
}

export class PiRemoteWorkspaceRuntimeFactory implements RemoteWorkspaceRuntimeFactory {
  readonly profile = "pi" as const;

  constructor(private readonly options: PiRemoteWorkspaceRuntimeOptions = {}) {}

  async available(): Promise<{ available: boolean; version?: string; reason?: string }> {
    const command = this.options.command && this.options.command.length > 0
      ? this.options.command[0]
      : findExecutableOnPath("pi");
    return command
      ? { available: true, ...(this.options.version ? { version: this.options.version } : {}) }
      : { available: false, reason: "Pi is not installed on this Hub." };
  }

  async start(options: Parameters<RemoteWorkspaceRuntimeFactory["start"]>[0]): Promise<RemoteWorkspaceRuntimeHandle> {
    const configuredCommand = this.options.command && this.options.command.length > 0
      ? [...this.options.command]
      : null;
    const executable = configuredCommand?.[0] ?? findExecutableOnPath("pi");
    if (!executable) throw new Error("Pi is not installed on this Hub");
    const commandPrefix = configuredCommand ?? [executable];
    const isolation = mkdtempSync(join(tmpdir(), "ocx-remote-pi-"));
    try {
      chmodSync(isolation, 0o700);
    } catch (error) {
      removeRemoteWorkspaceIsolation(isolation);
      throw error;
    }
    const extensionPath = join(isolation, "remote-workspace-extension.js");
    try {
      writeFileSync(extensionPath, extensionSource(options.tools), { mode: 0o600 });
    } catch (error) {
      removeRemoteWorkspaceIsolation(isolation);
      throw error;
    }
    const threadId = options.resumeThreadId ?? randomUUID();
    const bridge = (() => {
      try {
        return startRemoteWorkspaceToolBridge({
          coordinator: options.coordinator,
          threadId,
          tools: options.tools,
          onTool: tool => options.emit("tool", `Running ${tool} on ${options.deviceName}/${options.rootLabel}`),
        });
      } catch (error) {
        removeRemoteWorkspaceIsolation(isolation);
        throw error;
      }
    })();
    const childEnv = {
      ...process.env,
      ...this.options.env,
      OCX_REMOTE_WORKSPACE_BRIDGE_URL: bridge.url,
      OCX_REMOTE_WORKSPACE_BRIDGE_TOKEN: bridge.token,
    };
    const invocation = remoteWorkspaceProcessInvocation([
      ...commandPrefix,
      "--mode", "rpc",
      "--session-id", threadId,
      "--name", `OCX Remote: ${options.deviceName}`,
      "--no-builtin-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--extension", extensionPath,
      "--tools", options.tools.map(tool => `remote_${tool}`).join(","),
      "--system-prompt", remotePiInstructions(options.deviceName, options.tools),
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
    const rpc = new PiRpcProcess(child);
    rpc.onEvent = event => {
      if (event.type === "message_end") {
        const text = messageText(event.message);
        if (text) options.emit("assistant", text);
      }
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        options.emit("tool", `Pi requested ${event.toolName}`);
      }
    };
    try {
      const state = await rpc.command("get_state");
      if (state.success !== true) throw new Error(safeError(state.error, "Pi RPC failed to initialize"));
    } catch (error) {
      await rpc.close().catch(() => {});
      await bridge.stop();
      removeRemoteWorkspaceIsolation(isolation);
      throw error;
    }
    let stopped = false;
    let stopOperation: Promise<void> | null = null;
    return {
      threadId,
      prompt: text => rpc.prompt(text),
      stop(): Promise<void> {
        if (stopOperation) return stopOperation;
        stopped = true;
        stopOperation = runRemoteWorkspaceCleanupSteps([
          () => rpc.abort(),
          () => rpc.close(),
          () => bridge.stop(),
          () => removeRemoteWorkspaceIsolation(isolation),
        ]);
        return stopOperation;
      },
    };
  }
}
