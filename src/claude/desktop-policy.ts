/** Read-only, privacy-safe Windows policy diagnosis for Claude Desktop 3P. */
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import { resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";
import { decodeWindowsTextBytes } from "../lib/windows-text";

const CLAUDE_POLICY_KEY = "HKLM\\SOFTWARE\\Policies\\Claude";
const CLAUDE_POLICY_PARENT_KEY = "HKLM\\SOFTWARE\\Policies";
const POLICY_PROBE_TIMEOUT_MS = 2_000;

export type ClaudeDesktopPolicyState = "present" | "absent" | "unknown" | "not_applicable";

export interface ClaudeDesktopPolicyProbeResult {
  readonly status: number | null;
  /** Kept inside the probe boundary; diagnostics never return or log it. */
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly spawnFailed: boolean;
}

export type ClaudeDesktopPolicyProbeRunner = (
  file: string,
  args: readonly string[],
) => ClaudeDesktopPolicyProbeResult;

export interface ClaudeDesktopPolicyProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly run?: ClaudeDesktopPolicyProbeRunner;
  readonly resolveSystemDirectory?: () => string;
}

export interface ClaudeDesktopPolicyHealth {
  readonly ok: boolean;
  readonly status: "ok" | "warning";
  readonly state: ClaudeDesktopPolicyState;
  readonly message: string;
  readonly action: string;
}

const defaultPolicyProbeRunner: ClaudeDesktopPolicyProbeRunner = (file, args) => {
  const result = spawnSync(file, [...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024,
    timeout: POLICY_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.status,
    // Decoded only to prove key absence. This never crosses the probe boundary.
    stdout: result.stdout ? decodeWindowsTextBytes(result.stdout) : "",
    timedOut: errorCode === "ETIMEDOUT" || result.signal !== null,
    spawnFailed: result.error !== undefined && errorCode !== "ETIMEDOUT",
  };
};

function usable(result: ClaudeDesktopPolicyProbeResult): boolean {
  return !result.timedOut && !result.spawnFailed && result.status !== null;
}

function parentListsPolicyKey(output: string): boolean {
  const expected = CLAUDE_POLICY_KEY.toLowerCase();
  return output.split(/\r?\n/).some(line => line.trim().toLowerCase()
    .replace(/^hkey_local_machine\\/, "hklm\\") === expected);
}

/**
 * Detect machine-level Claude managed policy without reading or exposing its contents.
 *
 * `reg.exe` returns exit 1 for both a missing key and query/access failures. As in the
 * Windows tray registry reader, absence is therefore accepted only when the immediate
 * parent can be queried successfully. Every other failure stays unknown.
 */
export function probeClaudeDesktopPolicy(
  options: ClaudeDesktopPolicyProbeOptions = {},
): ClaudeDesktopPolicyState {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return "not_applicable";

  let regExe: string;
  try {
    const systemDirectory = (options.resolveSystemDirectory ?? resolveTrustedWindowsSystemDirectory)();
    regExe = win32.join(systemDirectory, "reg.exe");
  } catch {
    return "unknown";
  }

  const run = options.run ?? defaultPolicyProbeRunner;
  let policy: ClaudeDesktopPolicyProbeResult;
  try {
    policy = run(regExe, ["query", CLAUDE_POLICY_KEY, "/reg:64"]);
  } catch {
    return "unknown";
  }
  if (!usable(policy)) return "unknown";
  if (policy.status === 0) return "present";
  if (policy.status !== 1) return "unknown";

  let parent: ClaudeDesktopPolicyProbeResult;
  try {
    parent = run(regExe, ["query", CLAUDE_POLICY_PARENT_KEY, "/reg:64"]);
  } catch {
    return "unknown";
  }
  if (!usable(parent) || parent.status !== 0) return "unknown";
  // The child can be listed by a readable parent while its own ACL blocks the
  // query. That is unreadable, not absent.
  return parentListsPolicyKey(parent.stdout) ? "unknown" : "absent";
}

/** State-only health projection shared by CLI, apply, and management status. */
export function claudeDesktopPolicyHealth(
  state: ClaudeDesktopPolicyState,
): ClaudeDesktopPolicyHealth {
  if (state === "present") {
    return {
      ok: false,
      status: "warning",
      state,
      message: "Windows managed Claude policy is active, so Claude Desktop will ignore the local third-party profile.",
      action: "Ask your administrator to remove or revise the managed Claude policy, then fully quit and reopen Claude Desktop.",
    };
  }
  if (state === "unknown") {
    return {
      ok: false,
      status: "warning",
      state,
      message: "OpenCodex could not verify Windows managed Claude policy; Desktop third-party profile health is unverified.",
      action: "Check access to Windows machine policy and run the status check again before relying on Claude Desktop 3P.",
    };
  }
  return {
    ok: true,
    status: "ok",
    state,
    message: state === "absent"
      ? "No Windows managed Claude policy was detected."
      : "Windows managed Claude policy is not applicable on this platform.",
    action: "No action required.",
  };
}

export function claudeDesktopPolicyWarning(
  state: ClaudeDesktopPolicyState,
): string | undefined {
  const health = claudeDesktopPolicyHealth(state);
  return health.ok ? undefined : `${health.message} Action: ${health.action}`;
}
