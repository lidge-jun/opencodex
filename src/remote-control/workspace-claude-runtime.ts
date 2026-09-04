import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { remoteWorkspaceDeveloperInstructions } from "./workspace-tools";
import { findExecutableOnPath } from "./workspace-executable";
import {
  remoteWorkspaceProcessInvocation,
  removeRemoteWorkspaceIsolation,
  runRemoteWorkspaceCleanupSteps,
  stopRemoteWorkspaceProcess,
} from "./workspace-process";
import { startRemoteWorkspaceToolBridge } from "./workspace-tool-bridge";
import type {
  RemoteWorkspaceRuntimeFactory,
  RemoteWorkspaceRuntimeHandle,
} from "./workspace-sessions";

const MAX_OUTPUT_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function safeError(value: unknown, fallback: string): string {
  return (value instanceof Error ? value.message : typeof value === "string" ? value : fallback)
    .replace(/[^\x20-\x7e\n\t]/g, " ")
    .slice(0, 4_096);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assistantText(value: unknown): string | null {
  const message = record(value);
  if (!message || !Array.isArray(message.content)) return null;
  const text = message.content.flatMap(raw => {
    const part = record(raw);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("");
  return text || null;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (retained >= MAX_STDERR_BYTES) continue;
      const chunk = next.value.subarray(0, MAX_STDERR_BYTES - retained);
      chunks.push(chunk);
      retained += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export interface ClaudeRemoteWorkspaceRuntimeOptions {
  command?: readonly string[];
  env?: Record<string, string | undefined>;
  version?: string;
}

export class ClaudeRemoteWorkspaceRuntimeFactory implements RemoteWorkspaceRuntimeFactory {
  readonly profile = "claude" as const;

  constructor(private readonly options: ClaudeRemoteWorkspaceRuntimeOptions = {}) {}

  async available(): Promise<{ available: boolean; version?: string; reason?: string }> {
    const command = this.options.command && this.options.command.length > 0
      ? this.options.command[0]
      : findExecutableOnPath("claude");
    return command
      ? { available: true, ...(this.options.version ? { version: this.options.version } : {}) }
      : { available: false, reason: "Claude Code is not installed on this Hub." };
  }

  async start(options: Parameters<RemoteWorkspaceRuntimeFactory["start"]>[0]): Promise<RemoteWorkspaceRuntimeHandle> {
    const configuredCommand = this.options.command && this.options.command.length > 0
      ? [...this.options.command]
      : null;
    const executable = configuredCommand?.[0] ?? findExecutableOnPath("claude");
    if (!executable) throw new Error("Claude Code is not installed on this Hub");
    const commandPrefix = configuredCommand ?? [executable];
    const isolation = mkdtempSync(join(tmpdir(), "ocx-remote-claude-"));
    try {
      chmodSync(isolation, 0o700);
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
    const mcpPath = join(isolation, "mcp.json");
    try {
      writeFileSync(mcpPath, `${JSON.stringify({
        mcpServers: {
          ocx_remote_workspace: {
            type: "http",
            url: `${bridge.url}/mcp`,
            headers: { Authorization: `Bearer ${bridge.token}` },
          },
        },
      })}\n`, { mode: 0o600 });
    } catch (error) {
      await bridge.stop();
      removeRemoteWorkspaceIsolation(isolation);
      throw error;
    }
    let firstTurn = options.resumeThreadId === undefined;
    let active: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
    let stopped = false;
    let stopOperation: Promise<void> | null = null;

    const runPrompt = async (text: string): Promise<void> => {
      if (stopped) throw new Error("Claude Remote Workspace session is stopped");
      if (active) throw new Error("Claude Remote Workspace turn is already active");
      const args = [
        ...commandPrefix,
        "-p",
        "--input-format", "text",
        "--output-format", "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--mcp-config", mcpPath,
        "--setting-sources", "",
        "--tools", "",
        "--allowedTools", "mcp__ocx_remote_workspace__*",
        "--permission-mode", "dontAsk",
        "--disable-slash-commands",
        "--no-chrome",
        "--system-prompt", remoteWorkspaceDeveloperInstructions(options.deviceName, options.tools),
        firstTurn ? "--session-id" : "--resume",
        threadId,
      ];
      const childEnv = { ...process.env, ...this.options.env };
      const invocation = remoteWorkspaceProcessInvocation(args, { env: childEnv });
      const child = Bun.spawn([invocation.file, ...invocation.args], {
        cwd: isolation,
        env: childEnv,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        ...invocation.options,
      });
      active = child;
      try {
        child.stdin.write(text);
        child.stdin.end();
      } catch (error) {
        await stopRemoteWorkspaceProcess(child);
        if (active === child) active = null;
        throw error;
      }
      const stderrPromise = drain(child.stderr);
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let emittedAssistant = false;
      let resultError: string | null = null;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          if (Buffer.byteLength(buffer, "utf8") > MAX_OUTPUT_LINE_BYTES && !buffer.includes("\n")) {
            throw new Error("Claude Code output line is too large");
          }
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (Buffer.byteLength(line, "utf8") > MAX_OUTPUT_LINE_BYTES) throw new Error("Claude Code output line is too large");
            if (line) {
              const event = record(JSON.parse(line));
              if (event?.type === "assistant") {
                const answer = assistantText(event.message);
                if (answer) { options.emit("assistant", answer); emittedAssistant = true; }
              }
              if (event?.type === "result") {
                if (event.is_error === true) resultError = safeError(event.result, "Claude Code turn failed");
                else if (!emittedAssistant && typeof event.result === "string" && event.result) {
                  options.emit("assistant", event.result);
                  emittedAssistant = true;
                }
              }
            }
            newline = buffer.indexOf("\n");
          }
        }
        const exitCode = await child.exited;
        const stderr = await stderrPromise;
        if (resultError) throw new Error(resultError);
        if (exitCode !== 0) throw new Error(safeError(stderr, `Claude Code exited with code ${exitCode}`));
        firstTurn = false;
      } catch (error) {
        await stopRemoteWorkspaceProcess(child);
        await stderrPromise.catch(() => "");
        throw error;
      } finally {
        reader.releaseLock();
        if (active === child) active = null;
      }
    };

    return {
      threadId,
      canResume: () => !firstTurn,
      prompt: runPrompt,
      stop(): Promise<void> {
        if (stopOperation) return stopOperation;
        stopped = true;
        const child = active;
        stopOperation = runRemoteWorkspaceCleanupSteps([
          async () => { if (child) await stopRemoteWorkspaceProcess(child); },
          () => bridge.stop(),
          () => removeRemoteWorkspaceIsolation(isolation),
        ]);
        return stopOperation;
      },
    };
  }
}
