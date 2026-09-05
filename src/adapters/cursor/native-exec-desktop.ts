import { spawn } from "node:child_process";
import { shellInvocation } from "../../lib/win-exec";
import { create } from "@bufbuild/protobuf";
import {
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  ComputerUseSuccessSchema,
  RecordScreenDiscardSuccessSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  RecordScreenSaveSuccessSchema,
  RecordScreenStartSuccessSchema,
  type ComputerUseArgs,
  type ComputerUseResult,
  type RecordScreenArgs,
  type RecordScreenResult,
} from "./gen/agent_pb";
import { errorText } from "./native-exec-common";
import type { CursorNativeToolDeps } from "./native-exec-tools";
import type { DesktopExecutorConfig } from "./desktop-executor-contract";

const DEFAULT_DESKTOP_TIMEOUT_MS = 30_000;

export type { DesktopExecutorConfig } from "./desktop-executor-contract";

/**
 * Build `computerUse` / `recordScreen` deps from external executor commands. Returns `{}` when no
 * command is configured (the dispatcher then falls back to the honest "not supported" default).
 * Every method maps results to protobuf and NEVER throws — a throw would propagate into the
 * stream loop and fail the conversation.
 */
export function desktopDepsFromConfig(config?: DesktopExecutorConfig): CursorNativeToolDeps {
  if (!config?.computerUseCommand && !config?.recordScreenCommand) return {};
  const deps: CursorNativeToolDeps = {};
  if (config.computerUseCommand) {
    deps.computerUse = (args: ComputerUseArgs) => runComputerUse(config, args);
  }
  if (config.recordScreenCommand) {
    deps.recordScreen = (args: RecordScreenArgs) => runRecordScreen(config, args);
  }
  return deps;
}

async function runComputerUse(config: DesktopExecutorConfig, args: ComputerUseArgs): Promise<ComputerUseResult> {
  const actionCount = args.actions.length;
  try {
    const out = await runExternalJson(config.computerUseCommand!, {
      toolCallId: args.toolCallId,
      actions: args.actions,
    }, config);
    if (out && typeof out === "object" && "error" in out) {
      return computerUseError(String((out as { error: unknown }).error), actionCount);
    }
    const result = out as { screenshot?: string; screenshotPath?: string; durationMs?: number; log?: string };
    return create(ComputerUseResultSchema, {
      result: { case: "success", value: create(ComputerUseSuccessSchema, {
        actionCount,
        durationMs: typeof result?.durationMs === "number" ? result.durationMs : 0,
        screenshot: result?.screenshot,
        screenshotPath: result?.screenshotPath,
        log: result?.log,
      }) },
    });
  } catch (err) {
    return computerUseError(errorText(err), actionCount);
  }
}

async function runRecordScreen(config: DesktopExecutorConfig, args: RecordScreenArgs): Promise<RecordScreenResult> {
  try {
    const out = await runExternalJson(config.recordScreenCommand!, {
      mode: args.mode,
      toolCallId: args.toolCallId,
      saveAsFilename: args.saveAsFilename,
    }, config) as Record<string, unknown>;
    if (out?.startSuccess) {
      const s = out.startSuccess as { wasPriorRecordingCancelled?: boolean; wasSaveAsFilenameIgnored?: boolean };
      return create(RecordScreenResultSchema, { result: { case: "startSuccess", value: create(RecordScreenStartSuccessSchema, {
        wasPriorRecordingCancelled: Boolean(s.wasPriorRecordingCancelled),
        wasSaveAsFilenameIgnored: Boolean(s.wasSaveAsFilenameIgnored),
      }) } });
    }
    if (out?.saveSuccess) {
      const s = out.saveSuccess as { path?: string; recordingDurationMs?: number };
      return create(RecordScreenResultSchema, { result: { case: "saveSuccess", value: create(RecordScreenSaveSuccessSchema, {
        path: String(s.path ?? ""),
        recordingDurationMs: BigInt(Math.trunc(s.recordingDurationMs ?? 0)),
      }) } });
    }
    if (out?.discardSuccess) {
      return create(RecordScreenResultSchema, { result: { case: "discardSuccess", value: create(RecordScreenDiscardSuccessSchema, {}) } });
    }
    const failure = out?.failure as { error?: unknown } | undefined;
    return recordScreenFailure(failure?.error ? String(failure.error) : "record-screen executor returned no recognized result");
  } catch (err) {
    return recordScreenFailure(errorText(err));
  }
}

function computerUseError(error: string, actionCount: number): ComputerUseResult {
  return create(ComputerUseResultSchema, {
    result: { case: "error", value: create(ComputerUseErrorSchema, { error, actionCount, durationMs: 0 }) },
  });
}

function recordScreenFailure(error: string): RecordScreenResult {
  return create(RecordScreenResultSchema, {
    result: { case: "failure", value: create(RecordScreenFailureSchema, { error }) },
  });
}

/**
 * Spawn `command` via the platform shell (sh -c on POSIX, cmd.exe /d /s /c on win32 —
 * the configured command is platform-native shell syntax; devlog
 * 260715_cross_platform_audit/020), write `payload` as JSON to stdin, return parsed stdout JSON.
 */
function runExternalJson(command: string, payload: unknown, config: DesktopExecutorConfig): Promise<unknown> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const inv = shellInvocation(command);
    const child = spawn(inv.file, inv.args, {
      cwd: config.cwd,
      env: config.env ? { ...process.env, ...config.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...inv.options,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`desktop executor timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`desktop executor exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`desktop executor produced invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });

    // A command that never reads stdin - `echo`, a script that exits on a bad flag,
    // anything that fails before its first read - closes the pipe while we are still
    // writing to it. The write then fails with EPIPE, and on Linux that surfaces as an
    // ASYNCHRONOUS 'error' event on the stream rather than a throw, so the try/catch
    // below never saw it and the rejection escaped as an unhandled stream error. On
    // macOS the same command usually drains the small payload first, which is why this
    // only ever went red on the Linux shard.
    //
    // EPIPE here is not a failure of the executor CONTRACT: the child's exit code and
    // stdout are what decide the result, and both are handled in 'close' above. So the
    // pipe error is swallowed deliberately and the outcome is left to the child, which
    // is what makes "bad output maps to failure" reachable instead of exploding.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch (err) {
      // Kept for the synchronous half: a stream already destroyed when we reach this
      // line throws immediately instead of emitting.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    }
  });
}
