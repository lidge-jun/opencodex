import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readJsonLines } from "../coding-agent/protocol";
import { record, type JsonObject, type ZcodeSettings } from "./settings";
import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";

export type ZcodeSpawn = typeof spawn;
type Pending = { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** ZCode 0.16.5 uses request/result NDJSON, without a jsonrpc field. */
export class ZcodeClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private terminalError?: Error;
  private reading: Promise<void>;
  private exited: Promise<void>;
  private detachShutdown: () => void;
  onEvent: (message: JsonObject) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(settings: ZcodeSettings, spawnProcess: ZcodeSpawn = spawn) {
    const [command, ...args] = settings.command;
    this.child = spawnProcess(command!, [...args, "app-server"], {
      cwd: settings.home, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: settings.home, PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_CONFIG_HOME: `${settings.home}/.config`, XDG_CACHE_HOME: `${settings.home}/.cache` },
    }) as ChildProcessWithoutNullStreams;
    this.exited = new Promise(resolve => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    // Discard vendor diagnostics: stderr may contain account or request data.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail(new Error("ZCode protocol input closed.")));
    this.child.once("error", () => this.fail(new Error("ZCode isolated launcher could not start.")));
    this.child.once("exit", () => this.fail(new Error("ZCode app server exited before completing the turn.")));
    this.reading = this.read();
    this.detachShutdown = registerOptionalShutdownHook(`zcode-${crypto.randomUUID()}`, () => { void this.close(); });
  }

  private fail(error: Error): void {
    if (this.closed || this.terminalError) return;
    this.terminalError = error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.onFailure(error);
  }

  private write(frame: JsonObject): void {
    if (this.closed || this.terminalError) throw this.terminalError ?? new Error("ZCode client is closed.");
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private async read(): Promise<void> {
    try {
      for await (const message of readJsonLines(this.child.stdout)) {
        if (typeof message.method === "string") {
          if (message.id !== undefined) {
            if (message.method === "session/requestRuntimePreferences") {
              this.write({ id: message.id, result: {
                nativeSearchEnhancementsEnabled: false, memoryEnabled: false,
                askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: "preflight-v1",
              } });
            } else if (message.method === "interaction/requestPermission") {
              // Permission decisions cannot be safely represented by all OpenCodex clients.
              // Native non-interactive actions still run under ZCode's edit mode and OS sandbox.
              this.write({ id: message.id, result: { decision: "deny", reason: "Interactive approval is unavailable through this bridge." } });
            } else if (message.method === "interaction/requestUserInput") {
              this.write({ id: message.id, result: { action: "cancel" } });
              this.fail(new Error("ZCode requires user input; continue in the isolated ZCode client."));
            } else {
              this.write({ id: message.id, error: { code: -32601, message: "Unsupported ZCode client request." } });
            }
          } else this.onEvent(message);
        } else if (typeof message.id === "number") {
          const item = this.pending.get(message.id);
          if (!item) continue;
          clearTimeout(item.timer);
          this.pending.delete(message.id);
          // Never forward raw error messages/stacks: the vendor includes prompts and paths.
          if (message.error) item.reject(new Error("ZCode rejected the protocol request. Check the isolated login and model configuration."));
          else item.resolve(record(message.result));
        }
      }
      this.fail(new Error("ZCode protocol output closed."));
    } catch {
      this.fail(new Error("ZCode returned an invalid or oversized protocol stream."));
    }
  }

  request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    if (this.terminalError || this.closed) return Promise.reject(this.terminalError ?? new Error("ZCode client is closed."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ZCode protocol request timed out."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("ZCode protocol write failed.")); }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachShutdown();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("ZCode client closed.")); }
    this.pending.clear();
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    const killTimer = setTimeout(() => this.child.kill("SIGKILL"), 500);
    // Never await an uncooperative descendant that inherited stdout indefinitely.
    await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 750))]);
    clearTimeout(killTimer);
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
