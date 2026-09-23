/** Opt-in consistency guard for a desktop-approved stop. Not a consent proof. */
import { waitForExit } from "../lib/process-control";
import { waitForPortAvailable } from "../server/ports";
import { probeEndpointLiveness, probeHostname } from "../server/proxy-liveness";
import type { GuardedManagerTarget } from "../service/guarded-manager-target";
import type { ResolveJson } from "./resolve";
import { STOP_SUMMARY_SCHEMA, type StopOutcome, type StopRunRecord, type StopServiceOutcome } from "./stop-report";

export interface StopApproval {
  pid: number;
  port: number;
  hostname: string;
  configHome: string;
  cliVersion: string;
  compatibilityToken: string;
}

export interface GuardedStopSnapshot {
  approval: StopApproval;
  manager: Exclude<GuardedManagerTarget, { kind: "unknown" }>;
}

function sameGuardedManager(
  expected: GuardedStopSnapshot["manager"],
  current: GuardedManagerTarget,
): boolean {
  if (expected.kind === "absent") return current.kind === "absent";
  return current.kind === "bound" && current.pid === expected.pid
    && current.managerPid === expected.managerPid && current.backend === expected.backend;
}

export type StopApprovalParse = { ok: true; json: boolean; approval: StopApproval | null } | { ok: false };

export function parseStopApproval(argv: string[]): StopApprovalParse {
  if (argv.length === 0) return { ok: true, json: false, approval: null };
  if (argv.every(arg => arg === "--json")) return { ok: true, json: true, approval: null };
  const names = ["--expect-pid", "--expect-port", "--expect-hostname",
    "--expect-config-home", "--expect-cli-version", "--expect-compatibility-token"];
  if (argv.filter(arg => arg === "--json").length !== 1) return { ok: false };
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--json") continue;
    if (!names.includes(flag) || values.has(flag) || index + 1 >= argv.length) return { ok: false };
    values.set(flag, argv[++index]!);
  }
  if (values.size !== names.length) return { ok: false };
  const integer = (value: string | undefined, max: number): number | null => {
    if (!value || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : null;
  };
  const pid = integer(values.get("--expect-pid"), Number.MAX_SAFE_INTEGER);
  const port = integer(values.get("--expect-port"), 65535);
  const compatibilityToken = values.get("--expect-compatibility-token") ?? "";
  const configHome = values.get("--expect-config-home") ?? "";
  const cliVersion = values.get("--expect-cli-version") ?? "";
  if (pid === null || port === null || !/^[a-f0-9]{64}$/.test(compatibilityToken)
    || !configHome || !cliVersion) return { ok: false };
  return { ok: true, json: true, approval: {
    pid, port, hostname: values.get("--expect-hostname") ?? "",
    configHome, cliVersion, compatibilityToken,
  } };
}

export function matchesStopApproval(expected: StopApproval, now: ResolveJson): boolean {
  return now.schema === "ocx-resolve/1" && now.liveness.status === "live"
    && now.liveness.pid === expected.pid && now.liveness.port === expected.port
    && now.port.effective === expected.port && (now.liveness.hostname ?? "") === expected.hostname
    && now.liveness.role !== "client" && now.configHome === expected.configHome
    && now.cliVersion === expected.cliVersion && now.ownership.kind !== "unknown"
    && now.takeover.kind === "supported" && now.takeover.token === expected.compatibilityToken;
}

export function approvalChanged(): StopOutcome {
  return { ok: false, summary: {
    schema: STOP_SUMMARY_SCHEMA, ok: false, outcome: "approval-changed", exitCode: 1,
    runtimeDown: false, service: "absent", proxy: "unknown", sharedTeardown: "skipped",
    message: "The approved runtime or managing CLI changed; no stop was attempted.",
  } };
}

export function managerStillActive(
  service: StopServiceOutcome,
  record?: Pick<StopRunRecord, "proxy" | "sharedTeardown">,
): StopOutcome {
  return { ok: false, summary: {
    schema: STOP_SUMMARY_SCHEMA, ok: false, outcome: "manager-still-active", exitCode: 1,
    runtimeDown: false, service,
    proxy: record?.proxy ?? "unknown", sharedTeardown: record?.sharedTeardown ?? "skipped",
    message: "The approved runtime and service manager could not both be confirmed stopped.",
  } };
}

export async function runApprovedStop(
  expected: StopApproval,
  read: () => Promise<ResolveJson | null>,
  tracked: () => { pid: number; port: number; hostname: string } | null,
  managerTarget: () => GuardedManagerTarget,
  stop: (snapshot: GuardedStopSnapshot) => Promise<StopOutcome>,
): Promise<StopOutcome> {
  let snapshot: GuardedStopSnapshot | null = null;
  try {
    const now = await read();
    const target = tracked();
    const manager = managerTarget();
    if (!now || !matchesStopApproval(expected, now) || !target
      || target.pid !== expected.pid || target.port !== expected.port
      || target.hostname !== expected.hostname || manager.kind === "unknown"
      || (manager.kind === "bound" && manager.pid !== expected.pid)) return approvalChanged();
    snapshot = { approval: expected, manager };
  } catch { return approvalChanged(); }
  return snapshot ? stop(snapshot) : approvalChanged();
}

const GUARDED_SETTLE_MS = 5_000;

/** Compose the existing bounded PID/port waiters, then prove health absence. */
export async function settleApprovedTarget(
  approved: StopApproval,
  io: {
    now?: () => number;
    waitExit?: (pid: number, timeoutMs: number) => boolean;
    waitPort?: typeof waitForPortAvailable;
    probe?: typeof probeEndpointLiveness;
  } = {},
): Promise<boolean> {
  const now = io.now ?? Date.now;
  const deadline = now() + GUARDED_SETTLE_MS;
  const remaining = () => Math.max(0, deadline - now());
  if (!(io.waitExit ?? waitForExit)(approved.pid, remaining()) || remaining() <= 0) return false;
  const hostname = probeHostname(approved.hostname || undefined);
  if (!await (io.waitPort ?? waitForPortAvailable)(approved.port, hostname,
    { timeoutMs: remaining(), intervalMs: 50 }) || remaining() <= 0) return false;
  const verdict = await (io.probe ?? probeEndpointLiveness)(
    { port: approved.port, hostname: approved.hostname || undefined },
    { timeoutMs: Math.min(250, remaining()) },
  );
  return verdict === "dead" && now() <= deadline;
}

export async function runGuardedManagerStep(
  snapshot: GuardedStopSnapshot,
  io: {
    revalidateManager: () => GuardedManagerTarget;
    stopManager: () => StopServiceOutcome;
    signalApproved: () => Promise<boolean>;
    settle: () => Promise<boolean>;
    managerState: () => Promise<"inactive" | "active" | "unknown">;
  },
): Promise<{ service: StopServiceOutcome; effect: "stopped" | "approval-changed" | "manager-still-active" | "failed";
  proxy: "stopped" | "unknown"; handledByProxy: boolean }> {
  try {
    if (!sameGuardedManager(snapshot.manager, io.revalidateManager())) {
      return { service: "absent", effect: "approval-changed", proxy: "unknown", handledByProxy: false };
    }
  } catch {
    return { service: "absent", effect: "approval-changed", proxy: "unknown", handledByProxy: false };
  }
  const service = snapshot.manager.kind === "absent" ? "absent" : io.stopManager();
  let handledByProxy = false;
  if (snapshot.manager.kind === "absent") {
    try { handledByProxy = await io.signalApproved(); }
    catch { return { service, effect: "failed", proxy: "unknown", handledByProxy }; }
  }
  if (!await io.settle()) {
    return { service, effect: "manager-still-active", proxy: "unknown", handledByProxy };
  }
  try {
    if (await io.managerState() !== "inactive") {
      return { service, effect: "manager-still-active", proxy: "unknown", handledByProxy };
    }
  } catch { return { service, effect: "manager-still-active", proxy: "unknown", handledByProxy }; }
  return { service, effect: "stopped", proxy: "stopped", handledByProxy };
}

export async function guardFinalStopSummary(
  record: StopRunRecord,
  managerState: () => Promise<"inactive" | "active" | "unknown">,
  finish: () => StopOutcome,
): Promise<StopOutcome> {
  try {
    if (await managerState() !== "inactive") return managerStillActive(record.service, record);
  } catch { return managerStillActive(record.service, record); }
  return finish();
}
