import { execFileSync } from "node:child_process";
import { statSync, type Stats } from "node:fs";
import { systemdUserBusEnvironment } from "../service/systemd";
import { assertLiveServiceManagerAllowed } from "../service/guards";
import { LABEL, TASK } from "../service/state";

export type UpdateRestartSupervision = "inactive" | "active" | "unknown";
export interface UpdateRestartSupervisorReply { status: number | null; stdout: string; stderr: string }
export interface UpdateRestartSupervisionDeps {
  platform?: NodeJS.Platform;
  now?: () => number;
  uid?: number;
  stat?: (path: string) => Pick<Stats, "isFile" | "mode">;
  environment?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  run?: (command: string, args: string[], timeoutMs: number, environment: NodeJS.ProcessEnv) => UpdateRestartSupervisorReply;
}
const PROBE_TIMEOUT_MS = 2000;
export const UPDATE_RESTART_SYSTEMD_ARGS = ["--user", "show", "-p", "LoadState", "-p", "ActiveState", "-p", "MainPID", "-p", "FragmentPath", "-p", "NeedDaemonReload", TASK];

function run(command: string, args: string[], timeout: number, env: NodeJS.ProcessEnv): UpdateRestartSupervisorReply {
  assertLiveServiceManagerAllowed("update restart supervision");
  try {
    return { status: 0, stdout: execFileSync(command, args, { encoding: "utf8", timeout, env,
      killSignal: "SIGKILL", maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (error) {
    const failure = error as { status?: number | null; signal?: string; code?: string; stdout?: Buffer; stderr?: Buffer };
    if (failure.signal || failure.code || !Number.isInteger(failure.status)) throw new Error("update_restart_supervision_unverified");
    return { status: failure.status!, stdout: failure.stdout?.toString() ?? "", stderr: failure.stderr?.toString() ?? "" };
  }
}

/** Ignore PATH; usr-merged systemctl symlinks may resolve to a regular trusted-location target. */
export function resolveUpdateRestartSupervisor(deps: UpdateRestartSupervisionDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const paths = platform === "linux" ? ["/usr/bin/systemctl", "/bin/systemctl"] : platform === "darwin" ? ["/bin/launchctl"] : [];
  for (const path of paths) {
    try {
      const stat = (deps.stat ?? statSync)(path);
      if (stat.isFile() && (stat.mode & 0o002) === 0 && (stat.mode & 0o111) !== 0) return path;
    } catch { /* Try the next trusted location; no PATH fallback. */ }
  }
  return null;
}

/** All manager evidence shares the transaction deadline, including the retained PID-bound probe. */
export function runBoundedUpdateRestartSupervisor(command: string, args: string[], deadlineAt: number, deps: UpdateRestartSupervisionDeps = {}) {
  const now = deps.now ?? Date.now;
  const remaining = deadlineAt - now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("update_restart_supervision_unverified");
  const environment = (deps.platform ?? process.platform) === "linux"
    ? systemdUserBusEnvironment(deps.environment ?? process.env, { uid: deps.uid, exists: deps.exists })
    : { ...(deps.environment ?? process.env) };
  const result = (deps.run ?? run)(command, args, Math.min(PROBE_TIMEOUT_MS, remaining), environment);
  if (now() >= deadlineAt) throw new Error("update_restart_supervision_unverified");
  return result;
}

/** Registration presence is independent of liveness; only positive inactivity admits. */
export function probeUpdateRestartSupervision(deadlineAt: number, deps: UpdateRestartSupervisionDeps = {}, command = resolveUpdateRestartSupervisor(deps)): UpdateRestartSupervision {
  const platform = deps.platform ?? process.platform;
  if (!command) return "unknown";
  if (platform === "darwin") {
    const uid = deps.uid ?? process.getuid?.() ?? 0;
    const states = [`gui/${uid}/${LABEL}`, `user/${uid}/${LABEL}`].map(target => {
      try {
        const result = runBoundedUpdateRestartSupervisor(command, ["print", target], deadlineAt, deps);
        return result.status === 112 || result.status === 113 ? "inactive" : result.status === 0 ? "active" : "unknown";
      } catch { return "unknown"; }
    });
    return states.includes("unknown") ? "unknown" : states.includes("active") ? "active" : "inactive";
  }
  if (platform === "linux") {
    try {
      const result = runBoundedUpdateRestartSupervisor(command, UPDATE_RESTART_SYSTEMD_ARGS, deadlineAt, deps);
      return classifyUpdateRestartSystemdSupervision(result);
    } catch { return "unknown"; }
  }
  return "unknown";
}

/** The retained manager observation must satisfy the same positive-inactivity contract. */
export function classifyUpdateRestartSystemdSupervision(result: UpdateRestartSupervisorReply): UpdateRestartSupervision {
  if (result.status !== 0) return "unknown";
  const fields = new Map<string, string>();
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!match || fields.has(match[1]!)) return "unknown";
    fields.set(match[1]!, match[2]!);
  }
  const pid = fields.get("MainPID");
  if (!pid || !/^\d+$/.test(pid) || !Number.isSafeInteger(Number(pid))) return "unknown";
  if (!["loaded", "not-found"].includes(fields.get("LoadState") ?? "")) return "unknown";
  if (fields.get("ActiveState") === "inactive" && pid === "0") return "inactive";
  return fields.get("ActiveState") === "active" || Number(pid) > 0 ? "active" : "unknown";
}
