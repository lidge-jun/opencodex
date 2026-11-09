import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { validatedCodexExecInvocationAsync } from "../codex/exec-boundary";
import { MessageBudget } from "./budget";
import { isRecord } from "./types";

export interface QueueMcpOptions { codex: string; codexHome: string; allowReplyRead?: boolean }
export type QueueRpcResult = { status: "response"; result: Record<string, unknown> }
  | { status: "not_sent" | "unknown"; error: { code: string } };

/** Execute only explicit stored-thread RPCs; bodies never enter argv or diagnostics. */
export async function queueMcpRpc(options: QueueMcpOptions, method: "thread/list" | "thread/queue/add" | "thread/items/list" | "thread/items/read" | "thread/turns/list",
  params: Record<string, unknown>, signal?: AbortSignal): Promise<QueueRpcResult> {
  const reads = ["thread/items/list", "thread/items/read", "thread/turns/list"];
  if (!["thread/list", "thread/queue/add", ...reads].includes(method) || (reads.includes(method) && !options.allowReplyRead)) {
    return { status: "not_sent", error: { code: "queue_mcp_method_not_allowed" } };
  }
  const budget = new MessageBudget(20_000, signal);
  try {
    budget.throwIfEnded();
    if (process.platform === "win32" || !isAbsolute(options.codex) || !isAbsolute(options.codexHome)
      || !statSync(options.codexHome).isDirectory()) {
      return { status: "not_sent", error: { code: "unsupported_queue_mcp_environment" } };
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: options.codexHome };
    delete env.CODEX_THREAD_ID;
    const invocation = await validatedCodexExecInvocationAsync(options.codex, ["app-server", "--listen", "stdio://"],
      { env, cwd: options.codexHome, signal: budget.signal, verifyAnyAppBundle: true });
    budget.throwIfEnded();
    return await new Promise<QueueRpcResult>(resolve => {
      const child = spawn(invocation.file, invocation.args, {
        ...invocation.options, env, cwd: options.codexHome, detached: true, stdio: ["pipe", "pipe", "ignore"],
      });
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "", bytes = 0, submitted = false, stage = "initialize";
      let outcome: QueueRpcResult | undefined;
      let termTimer: ReturnType<typeof setTimeout> | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const stopGroup = (kind: NodeJS.Signals): void => {
        if (!child.pid) return;
        try { process.kill(-child.pid, kind); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(kind);
        }
      };
      const finish = (value: QueueRpcResult): void => {
        if (outcome) return;
        outcome = value;
        clearTimeout(deadline);
        child.stdin.end();
        termTimer = setTimeout(() => stopGroup("SIGTERM"), 300);
        killTimer = setTimeout(() => stopGroup("SIGKILL"), 600);
      };
      const fail = (code: string): void => finish({ status: submitted ? "unknown" : "not_sent", error: { code } });
      const cancel = (): void => fail("queue_mcp_cancelled");
      const write = (frame: unknown): void => { child.stdin.write(JSON.stringify(frame) + "\n"); };
      const deadline = setTimeout(() => fail("queue_mcp_timeout"), budget.remainingMs(12_000));
      budget.signal.addEventListener("abort", cancel, { once: true });
      child.stdin.on("error", () => fail("queue_mcp_stdin_failed"));
      child.on("error", () => fail("queue_mcp_launch_failed"));
      child.stdout.on("data", (chunk: Buffer) => {
        if (outcome) return;
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) { fail("queue_mcp_output_limit"); return; }
        try { pending += decoder.decode(chunk, { stream: true }); }
        catch { fail("queue_mcp_invalid_utf8"); return; }
        let newline: number;
        while (!outcome && (newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          let frame: unknown;
          try { frame = JSON.parse(line); } catch { fail("queue_mcp_invalid_json"); break; }
          if (!isRecord(frame)) { fail("queue_mcp_invalid_response"); break; }
          if (frame.id === undefined) continue;
          if ((stage === "initialize" && frame.id !== 1) || (stage === "request" && frame.id !== 2)) {
            fail("queue_mcp_mismatched_response"); break;
          }
          if (frame.error !== undefined) {
            if (!isRecord(frame.error) || !Number.isInteger(frame.error.code) || typeof frame.error.message !== "string" || frame.result !== undefined) { fail("queue_mcp_invalid_error"); break; }
            finish({ status: "not_sent", error: { code: stage === "initialize" ? "queue_mcp_initialize_rejected" : "queue_mcp_request_rejected" } });
            break;
          }
          if (!isRecord(frame.result)) { fail("queue_mcp_invalid_response"); break; }
          if (stage === "initialize") {
            stage = "request";
            write({ method: "initialized", params: {} });
            submitted = method === "thread/queue/add";
            write({ id: 2, method, params });
          } else finish({ status: "response", result: frame.result });
        }
      });
      child.on("close", () => {
        clearTimeout(deadline); clearTimeout(termTimer); clearTimeout(killTimer);
        budget.signal.removeEventListener("abort", cancel);
        stopGroup("SIGKILL");
        resolve(outcome ?? { status: submitted ? "unknown" : "not_sent", error: { code: "queue_mcp_disconnected" } });
      });
      if (budget.signal.aborted) cancel();
      else write({ id: 1, method: "initialize", params: {
        clientInfo: { name: "opencodex_queue_mcp", version: "1.0.0" }, capabilities: { experimentalApi: true, explicitGatewayOauth: true },
      } });
    });
  } catch {
    return { status: "not_sent", error: { code: "queue_mcp_preflight_failed" } };
  } finally { budget.dispose(); }
}
