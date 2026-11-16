/**
 * Replacing the runtime that still serves an old version after a Desktop MSI install (#8246).
 *
 * Windows Installer replaces `ocx.exe` on disk but leaves running processes alone, so the old
 * runtime keeps answering /healthz with its old version. This module only ever acts on a runtime
 * this home attests (its runtime record and per-process secret) whose image is the installed
 * `ocx.exe` being updated. It asks that runtime for its own bound in-place restart, the same
 * owner-aware path `ocx restart` uses: a Desktop-supervised child hands its replacement to the
 * Desktop app (which starts the sibling `ocx.exe`), a service child exits for its manager, and a
 * detached runtime relaunches its own image. All three now run the installed bytes.
 *
 * A connected-client runtime under the Desktop app refuses that restart (409
 * `restart_supervised_desktop`): it keeps itself until its owner replaces it. When the Desktop
 * supervision probe proves this installation's app is the parent of exactly that pid, the runtime
 * is drained with the installed `ocx stop --json`, the same stop the app's own updater drain runs,
 * and the app's supervisor starts its sibling `ocx.exe` again after its backoff.
 *
 * Success is a different process answering with the target version; anything else is reported,
 * never assumed. A runtime from another installation, an unattested one, or a newer one is not
 * touched.
 */
import { win32 } from "node:path";
import type { LiveProxy } from "../server/proxy-liveness";
import type { ProxyRestartRequestOutcome } from "../cli/tray-proxy";
import { computeVersionSkew } from "../cli/version-skew";

export interface RuntimeReplaceDeps {
  findLive(): Promise<LiveProxy | null>;
  /** Drive-qualified image path of the process, or null when it cannot be read. */
  runtimeImage(pid: number): string | null;
  requestRestart(live: LiveProxy & { pid: number }, targetVersion: string): Promise<ProxyRestartRequestOutcome>;
  /** The Desktop app image proven to supervise exactly this runtime pid, or null. */
  desktopSupervisor(pid: number): string | null;
  /** Drain the runtime with the installed CLI's `ocx stop --json`; ok only for a confirmed stop. */
  drainRuntime(): Promise<{ ok: boolean; detail?: string }>;
  now(): number;
  wait(ms: number): Promise<void>;
}

export type StaleRuntimeReason =
  | "unknown-version"
  | "runtime-newer"
  | "incomparable"
  | "unattested"
  | "foreign-image"
  | "restart-refused"
  | "drain-failed"
  | "replacement-timeout";

export type RuntimeOutcome =
  | { kind: "serving-target"; live: LiveProxy; replaced: boolean }
  | { kind: "not-running" }
  | { kind: "stale"; live: LiveProxy | null; reason: StaleRuntimeReason; detail?: string };

export const RUNTIME_OBSERVE_INTERVAL_MS = 250;

/** Windows paths compare case-insensitively and with either separator. */
export function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (path: string) => path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * Make the serving runtime the installed version.
 *
 * `wasRunning` says whether a runtime answered before the install; without one this never starts
 * a runtime just to prove the update, and reports `not-running` instead.
 */
export async function settleRuntime(
  input: { installedExe: string; targetVersion: string; deadlineAt: number; wasRunning: boolean },
  deps: RuntimeReplaceDeps,
): Promise<RuntimeOutcome> {
  const live = await deps.findLive();
  if (!live) return input.wasRunning ? observe(input, deps, null) : { kind: "not-running" };
  if (live.version === input.targetVersion) return { kind: "serving-target", live, replaced: false };
  if (!live.version) return { kind: "stale", live, reason: "unknown-version" };
  const relation = computeVersionSkew(input.targetVersion, live.version).relation;
  if (relation === "proxy-newer") return { kind: "stale", live, reason: "runtime-newer" };
  if (relation !== "cli-newer") return { kind: "stale", live, reason: "incomparable" };
  if (live.source !== "runtime" || live.pid === null) return { kind: "stale", live, reason: "unattested" };
  const pid = live.pid;
  let image: string | null;
  try { image = deps.runtimeImage(pid); } catch { image = null; }
  if (!image || !sameWindowsPath(image, input.installedExe)) {
    return { kind: "stale", live, reason: "foreign-image", ...(image ? { detail: image } : {}) };
  }
  const request = await deps.requestRestart({ ...live, pid }, input.targetVersion);
  if (!request.accepted && !request.uncertain) {
    const detail = request.error instanceof Error ? request.error.message : undefined;
    if (detail === "restart_supervised_desktop") {
      let app: string | null;
      try { app = deps.desktopSupervisor(pid); } catch { app = null; }
      if (app && sameWindowsPath(win32.dirname(app), win32.dirname(input.installedExe))) {
        const drained = await deps.drainRuntime();
        if (!drained.ok) return { kind: "stale", live, reason: "drain-failed", ...(drained.detail ? { detail: drained.detail } : {}) };
        return observe(input, deps, pid);
      }
    }
    return { kind: "stale", live, reason: "restart-refused", ...(detail ? { detail } : {}) };
  }
  // An uncertain answer may still have been accepted: observe instead of asking twice.
  return observe(input, deps, pid);
}

async function observe(
  input: { targetVersion: string; deadlineAt: number },
  deps: RuntimeReplaceDeps,
  oldPid: number | null,
): Promise<RuntimeOutcome> {
  let last: LiveProxy | null = null;
  while (deps.now() < input.deadlineAt) {
    last = await deps.findLive();
    if (last && last.version === input.targetVersion && (oldPid === null || last.pid !== oldPid)) {
      return { kind: "serving-target", live: last, replaced: true };
    }
    await deps.wait(Math.max(0, Math.min(RUNTIME_OBSERVE_INTERVAL_MS, input.deadlineAt - deps.now())));
  }
  return { kind: "stale", live: last, reason: "replacement-timeout" };
}
