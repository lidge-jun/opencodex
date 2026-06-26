import { spawn } from "node:child_process";
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

const DEFAULT_DESKTOP_TIMEOUT_MS = 30_000;

/**
 * Opt-in external executor for computer-use / record-screen. opencodex is a headless proxy and
 * cannot drive a screen itself; set these commands only when running on a host that can. Each
 * command receives the request as JSON on stdin and must print a JSON result on stdout.
 */
export interface DesktopExecutorConfig {
  /** Command (run via `sh -c`) handling computer-use. Receives `{toolCallId, actions}` on stdin. */
  computerUseCommand?: string;
  /** Command handling record-screen. Receives `{mode, toolCallId, saveAsFilename?}` on stdin. */
  recordScreenCommand?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Max time to wait for the external process. Default 30s. */
  timeoutMs?: number;
}

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

/** Spawn `command` via the shell, write `payload` as JSON to stdin, return parsed stdout JSON. */
function runExternalJson(command: string, payload: unknown, config: DesktopExecutorConfig): Promise<unknown> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd: config.cwd,
      env: config.env ? { ...process.env, ...config.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
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

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    }
  });
}
