import { execFileSync, spawn } from "node:child_process";
import { isIP } from "node:net";
import { existsSync } from "node:fs";
import { getRuntimePortPath, readRuntimePort, readProcessCommandLine, isOcxStartCommandLine, type RuntimePortState } from "../config/process-state";
import { configuredAdminToken } from "../lib/admin-secrets";
import { isRealBunBinary } from "../lib/bun-binary-validator.mjs";
import { isProcessAlive } from "../lib/process-control";
import { parseStrictSemver } from "../lib/strict-semver";
import { startArgv } from "../lib/self-launch-argv";
import { diagnoseService } from "../service/diagnostics";
import { inspectGuardedManagerTarget } from "../service/guarded-manager-target";
import { acquireOwnershipMutationLease, unprivilegedOwnershipMutationEnvironment } from "../service/ownership-mutation-lease.mjs";
import { serviceStatePaths } from "../service/state";
import { findLiveProxy, probeEndpointLiveness, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import { waitForPortAvailable } from "../server/ports";
import { UPDATE_RESTART_CHILD_ENV, type UpdateRestartChildMarker } from "./update-restart-child";
import { assertUpdateRestartConfiguration, assertUpdateRestartHome, readUpdateRestartHome, type UpdateRestartHome } from "./update-restart-home";
import { observeAttestedUpdateReplacement, stopAttestedUpdateTarget } from "./update-restart-transport";
import type { UpdateRestartCandidate } from "./update-restart-candidate";
import { INCOMPLETE_INSTALL_RECOVERY } from "./restart-failure";
import { computeVersionSkew } from "./version-skew";
import { createSupervisionLatch, inspectDesktopSupervision } from "../service/desktop-supervision.mjs";

export interface UpdateRestartChild { pid?: number; exitCode: number | null; signalCode: string | null }
export interface UpdateRestartIo {
  inspectSupervision?: typeof inspectDesktopSupervision;
  now(): number;
  acquire(): { release(): void };
  home(): UpdateRestartHome;
  checkHome(home: UpdateRestartHome): void;
  runtime(): RuntimePortState | null;
  standalone(target: UpdateRestartCandidate["target"]): boolean;
  /** Whether the executable the replacement will run is complete (not the npm `bun` placeholder). */
  runtimeReady(): boolean;
  stop(candidate: UpdateRestartCandidate, deadlineAt: number, beforeStop: () => void): Promise<void>;
  stopped(candidate: UpdateRestartCandidate, deadlineAt: number): Promise<boolean>;
  start(marker: UpdateRestartChildMarker): UpdateRestartChild;
  observe(deadlineAt: number, childPid: number): Promise<LiveProxy | null>;
  wait(ms: number): Promise<void>;
}
const ELIGIBILITY_REASONS = ["windows", "unsupported_platform", "foreground", "service", "shared_or_client",
  "package_tree_fenced", "unverifiable_ancestry", "target_changed", "configuration_changed", "desktop"] as const;
export type UpdateRestartEligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

/** Carries only a closed reason code across the eligibility/transport boundary. */
export class UpdateRestartEligibilityError extends Error {
  constructor(readonly reason: UpdateRestartEligibilityReason) { super("Update restart eligibility refused"); }
}
export type UpdateRestartResult = { ok: true; live: LiveProxy }
  | { ok: false; code: string; reason?: UpdateRestartEligibilityReason };

function sameRuntime(candidate: UpdateRestartCandidate, current: RuntimePortState | null): boolean {
  const expected = candidate.runtime;
  return !!current && current.pid === expected.pid && current.port === expected.port
    && current.hostname === expected.hostname && current.attestationSecret === expected.attestationSecret
    && current.siblingOfPort === undefined;
}

/** A terminal update transaction: it never enters generic restart recovery. */
export async function runUpdateRestart(candidate: UpdateRestartCandidate, deadlineAt: number, io: UpdateRestartIo): Promise<UpdateRestartResult> {
  const latch = createSupervisionLatch();
  let phase = "eligibility";
  let lease: { release(): void } | undefined;
  // Recorded here because the stop transport sanitizes anything thrown by beforeStop.
  let runtimeRefused = false;
  let eligibilityReason: UpdateRestartEligibilityReason | undefined;
  try {
    if (!parseStrictSemver(candidate.cliVersion) || candidate.cliVersion === "0.0.0"
      || computeVersionSkew(candidate.cliVersion, candidate.target.version).relation !== "cli-newer") {
      throw new Error("version");
    }
    const withinDeadline = () => { if (io.now() >= deadlineAt) throw new Error("deadline"); };
    withinDeadline();
    lease = io.acquire();
    const home = candidate.home;
    if (JSON.stringify(io.home()) !== JSON.stringify(home)) throw new Error("home_changed");
    const revalidate = () => {
      withinDeadline();
      io.checkHome(home);
      const currentRuntime = io.runtime();
      if (!sameRuntime(candidate, currentRuntime)) {
        eligibilityReason = currentRuntime?.siblingOfPort !== undefined ? "shared_or_client" : "target_changed";
        throw new Error("target");
      }
      const supervision = (io.inspectSupervision ?? inspectDesktopSupervision)({ targetPid: candidate.target.pid });
      const evidence = supervision.kind === "desktop" && supervision.runtimePid !== candidate.target.pid
        ? { kind: "unknown" as const, reason: "unrelated-target", desktopSeen: false } : supervision;
      if (latch.observe(evidence)) {
        eligibilityReason = "desktop";
        throw new UpdateRestartEligibilityError("desktop");
      }
      try {
        if (!io.standalone(candidate.target)) throw new Error("target");
      } catch (error) {
        if (error instanceof UpdateRestartEligibilityError && ELIGIBILITY_REASONS.includes(error.reason)) eligibilityReason = error.reason;
        throw error;
      }
      if (!io.runtimeReady()) {
        runtimeRefused = true;
        throw new Error("runtime");
      }
      withinDeadline();
    };
    revalidate();
    phase = "stop";
    await io.stop(candidate, deadlineAt, revalidate);
    withinDeadline();
    phase = "settle";
    if (!await io.stopped(candidate, deadlineAt)) throw new Error("stop_unconfirmed");
    // Shutdown is confirmed from here on and nothing has launched yet.
    phase = "prelaunch";
    withinDeadline();
    io.checkHome(home);
    // An in-place npm install can still be swapping its Bun in; wait for it inside the deadline,
    // then repeat the launch preconditions synchronously so the wait opens no gap before spawn.
    phase = "runtime";
    while (!io.runtimeReady()) {
      withinDeadline();
      await io.wait(Math.min(100, deadlineAt - io.now()));
    }
    phase = "prelaunch";
    withinDeadline();
    io.checkHome(home);
    phase = "start";
    const child = io.start({ home, version: candidate.cliVersion, port: candidate.target.port, hostname: candidate.runtime.hostname ?? "", deadlineAt });
    // The child must acquire its own lease and validate this frozen handoff before preflight.
    lease.release();
    lease = undefined;
    if (!Number.isSafeInteger(child.pid) || !child.pid || child.pid === candidate.target.pid) throw new Error("launch_unknown");
    phase = "replacement";
    while (io.now() < deadlineAt) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("child_exited");
      io.checkHome(home);
      const live = await io.observe(deadlineAt, child.pid);
      withinDeadline();
      if (live) {
        io.checkHome(home);
        if (live.source !== "runtime" || live.pid !== child.pid || live.port !== candidate.target.port
          || (live.hostname ?? "") !== (candidate.target.hostname ?? "") || live.role === "client"
          || live.packageTreeFenced || live.version !== candidate.cliVersion) throw new Error("replacement_mismatch");
        return { ok: true, live };
      }
      await io.wait(Math.min(100, deadlineAt - io.now()));
    }
    throw new Error("deadline");
  } catch {
    return { ok: false, code: runtimeRefused ? "update_restart_runtime_incomplete" : `update_restart_${phase}_failed`,
      ...(eligibilityReason ? { reason: eligibilityReason } : {}) };
  }
  finally { lease?.release(); }
}

/** Sanitized, actionable text for each terminal update-restart code; it claims only what that phase proved. */
export function describeUpdateRestartFailure(code: string, reason?: UpdateRestartEligibilityReason): string {
  if (reason && (code === "update_restart_eligibility_failed" || code === "update_restart_stop_failed")) {
    const action = (() => {
      switch (reason) {
        case "windows": return "Restart from a newer CLI is unavailable on Windows. Run `ocx status`, then restart through the owning service or desktop app.";
        case "unsupported_platform": return "Restart from a newer CLI requires macOS or Linux. Run `ocx status`, then use the owning lifecycle manager.";
        case "desktop": return "OpenCodex Desktop supervises this proxy. Use the app's updater (tray → Check for Updates), or quit OpenCodex before updating and restarting from this CLI.";
        case "service": return "An installed or active service owns lifecycle control. Run `ocx status`, then use the owning installation's `ocx service restart`.";
        case "foreground": return "The proxy is attached to a parent process. Run `ocx status`; if it runs in a terminal, restart it in that terminal, otherwise use its owning app or supervisor.";
        case "shared_or_client": return "This is a shared or connected-client runtime. Run `ocx status` and restart through its owning Hub, service or desktop app.";
        case "package_tree_fenced": return `The proxy's package files are unsettled. Wait for the install to finish. ${INCOMPLETE_INSTALL_RECOVERY}`;
        case "unverifiable_ancestry": return "The proxy's process ancestry or manager could not be verified. Run `ocx status` to identify its owner before restarting.";
        case "configuration_changed": return "The selected configuration or connection changed. Run `ocx status` to inspect the intended proxy before restarting.";
        case "target_changed": return "The captured proxy identity changed. Run `ocx status` to inspect the intended proxy before restarting.";
      }
    })();
    return `${action} Nothing was stopped by this restart attempt.`;
  }
  switch (code) {
    case "update_restart_runtime_incomplete":
      return `This installation's Bun runtime is incomplete; nothing was stopped. Wait for the install to finish, then run \`ocx restart\` again. ${INCOMPLETE_INSTALL_RECOVERY}`;
    case "update_restart_eligibility_failed":
      return "The running proxy is not eligible for an update restart from this CLI (it is supervised, shared, or changed); nothing was stopped. Run `ocx status` to inspect the intended proxy.";
    case "update_restart_stop_failed":
      return "The guarded stop of the old proxy could not be confirmed; inspect `ocx status` before retrying.";
    case "update_restart_settle_failed":
      return "The old proxy was not confirmed stopped, so no second proxy was started; inspect `ocx status` before retrying.";
    case "update_restart_prelaunch_failed":
      return "The old proxy stopped, but its home, ownership or deadline changed before launch, so nothing was launched. Check `ocx status`; if no proxy is running, run `ocx start`.";
    case "update_restart_runtime_failed":
      return `The old proxy stopped, but this installation's Bun runtime did not finish installing in time, so nothing was launched. ${INCOMPLETE_INSTALL_RECOVERY} Run \`ocx status\`; if no proxy is running, run \`ocx start\` once the install completes.`;
    case "update_restart_start_failed":
      return "The old proxy stopped, but the new proxy's launch could not be confirmed. Check `ocx status`; if no proxy is running, run `ocx start`.";
    case "update_restart_replacement_failed":
      return "The new proxy did not verify as the expected replacement in time; inspect `ocx status` before retrying.";
    default:
      return "Update restart could not be confirmed; inspect `ocx status` before retrying.";
  }
}

function standalone(target: UpdateRestartCandidate["target"]): boolean {
  try { assertUpdateRestartConfiguration(target.hostname ?? ""); }
  catch { throw new UpdateRestartEligibilityError("configuration_changed"); }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new UpdateRestartEligibilityError(process.platform === "win32" ? "windows" : "unsupported_platform");
  }
  const host = probeHostname(target.hostname).replace(/^\[|\]$/g, "");
  if (target.role === "client") throw new UpdateRestartEligibilityError("shared_or_client");
  if (target.packageTreeFenced) throw new UpdateRestartEligibilityError("package_tree_fenced");
  if (!isIP(host) || target.source !== "runtime") throw new UpdateRestartEligibilityError("unverifiable_ancestry");
  const command = readProcessCommandLine(target.pid);
  if (!command || !isOcxStartCommandLine(command)) throw new UpdateRestartEligibilityError("unverifiable_ancestry");
  if (diagnoseService().installed) throw new UpdateRestartEligibilityError("service");
  const manager = inspectGuardedManagerTarget(target.pid, target.port);
  if (manager.kind !== "absent") throw new UpdateRestartEligibilityError(manager.kind === "bound" ? "service" : "unverifiable_ancestry");
  let parent: string;
  try {
    parent = execFileSync("ps", ["-o", "ppid=", "-p", String(target.pid)], {
      encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { throw new UpdateRestartEligibilityError("unverifiable_ancestry"); }
  if (!/^[1-9]\d*$/.test(parent)) throw new UpdateRestartEligibilityError("unverifiable_ancestry");
  if (parent !== "1") throw new UpdateRestartEligibilityError("foreground");
  return true;
}

/** Production composition keeps stop/start side effects out of cli/index.ts. */
export function restartFromCurrentInstallation(candidate: UpdateRestartCandidate, deadlineAt: number, environment: NodeJS.ProcessEnv): Promise<UpdateRestartResult> {
  const argv = startArgv(candidate.target.port);
  const executable = process.execPath;
  return runUpdateRestart(candidate, deadlineAt, {
    now: Date.now,
    acquire: () => acquireOwnershipMutationLease(serviceStatePaths(), { waitMs: Math.max(0, Math.min(2000, deadlineAt - Date.now())) }),
    home: readUpdateRestartHome, checkHome: assertUpdateRestartHome, runtime: readRuntimePort, standalone,
    runtimeReady: () => isRealBunBinary(executable),
    stop: async (target, deadline, beforeStop) => {
      const token = configuredAdminToken();
      if (!token) throw new Error("update_restart_credential_unavailable");
      await stopAttestedUpdateTarget({ target: target.target, secret: target.runtime.attestationSecret,
        cliVersion: target.cliVersion, deadlineAt: deadline, beforeStop, adminToken: token });
    },
    stopped: async (target, deadline) => {
      while (Date.now() < deadline && isProcessAlive(target.target.pid)) await Bun.sleep(Math.min(100, deadline - Date.now()));
      if (Date.now() >= deadline || existsSync(getRuntimePortPath())) return false;
      const endpoint = { port: target.target.port, hostname: target.target.hostname };
      if (!await waitForPortAvailable(endpoint.port, probeHostname(endpoint.hostname),
        { timeoutMs: Math.max(0, Math.min(1000, deadline - Date.now())), intervalMs: 50 })) return false;
      if (Date.now() >= deadline) return false;
      return await probeEndpointLiveness(endpoint, { timeoutMs: Math.min(250, deadline - Date.now()) }) === "dead";
    },
    start: marker => {
      const env = unprivilegedOwnershipMutationEnvironment(environment);
      env.OPENCODEX_HOME = marker.home.config.path;
      env.CODEX_HOME = marker.home.codex.path;
      env[UPDATE_RESTART_CHILD_ENV] = JSON.stringify(marker);
      const child = spawn(executable, argv, { detached: true, stdio: "ignore", windowsHide: true, env });
      child.on("error", () => {}); // exit/health evidence reports failure; never retry a possibly launched child.
      child.unref();
      return child;
    },
    observe: async (deadline, childPid) => {
      const live = await findLiveProxy({ deadlineAt: deadline, attempts: 1 });
      if (!live) return null;
      if (live.pid !== childPid) throw new Error("update_restart_replacement_changed");
      const runtime = readRuntimePort(childPid);
      if (!runtime?.attestationSecret || runtime.port !== candidate.target.port
        || runtime.hostname !== candidate.runtime.hostname || runtime.siblingOfPort !== undefined) {
        throw new Error("update_restart_replacement_unattested");
      }
      const attested = await observeAttestedUpdateReplacement({ target: { ...live, pid: childPid },
        secret: runtime.attestationSecret, version: candidate.cliVersion, deadlineAt: deadline });
      const current = readRuntimePort(childPid);
      if (JSON.stringify(current) !== JSON.stringify(runtime)) throw new Error("update_restart_replacement_changed");
      return attested;
    },
    wait: ms => Bun.sleep(ms),
  });
}
