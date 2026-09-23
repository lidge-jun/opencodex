import { spawn, spawnSync } from "node:child_process";
import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "./stop-contract.mjs";
import { proxyIdentityAt } from "../server/proxy-liveness";
import { probeProxyLiveness } from "./proxy-liveness-probe.mjs";
import { decidePostStopUpdate } from "./stop-decision.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { getConfigDir, loadConfig } from "../config";
import { readPid, readRuntimePort, getRuntimePortPath } from "../config/process-state";
import { pendingTeardownOutstanding } from "../config/pending-teardown";
import type { ServiceOwnership } from "../service/state";
import { planUpdateRuntimeHandling, planStoppedRuntimeRecovery, inspectPackageRuntimeLiveness } from "./runtime-ownership.mjs";
import { unprivilegedOwnershipMutationEnvironment } from "../service/ownership-mutation-lease.mjs";
import { withUpdateOwnershipLease, readUpdateRuntimeTarget } from "./ownership-transaction";
import { npmInvocation } from "./npm-invocation.mjs";
import { pnpmInvocation, pnpmInvocationForPath, resolvePnpmCommands } from "./pnpm-invocation.mjs";
import {
  detectInstallFromPath,
  detectInstallOwnershipFromPath,
} from "./install-detection.mjs";
import type {
  DetectedInstall,
  InstallOwnership,
  MiseInstallOwner,
} from "./install-detection.d.mts";
import {
  pnpmOwnerInvocation,
  readPnpmGlobalPackage,
  resolvePnpmGlobalOwner,
  runPnpmGlobalUpdate,
} from "./pnpm-global-install.mjs";
import type { PnpmGlobalOwner, PnpmGlobalOwnerResult } from "./pnpm-global-install.mjs";
import { checkRegistryPackageIntegrity } from "./registry-integrity.mjs";
import {
  npmCachePreflightFailureMessage,
  runNpmCachePreflight,
} from "./npm-cache-preflight.mjs";
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "./tray-update-plan.mjs";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { packageVersion } from "../lib/package-version";
import { selfLaunchArgv } from "../lib/self-launch-argv";

/**
 * A `codex-history-backup-*.json` surviving a stop means the native-history restore was
 * skipped (locked state DB) — routed threads stay hidden in the Codex app until a retry.
 */
export function historyRestoreIncomplete(configDir = getConfigDir()): boolean {
  try {
    return readdirSync(configDir).some(
      name => name.startsWith("codex-history-backup-") && name.endsWith(".json"),
    );
  } catch {
    return false;
  }
}

export const PKG = "@bitkyc08/opencodex";
const HERE = dirname(fileURLToPath(import.meta.url)); // .../opencodex/src/update

export type Installer = DetectedInstall;
export type Channel = "latest" | "preview";
export type { InstallOwnership, MiseInstallOwner };

/** Infer how opencodex is installed from the running module's path. */
export function detectInstall(): Installer {
  return detectInstallFromPath(HERE, { exists: existsSync });
}

/** Resolve installer ownership and verified mise update guidance for this package. */
export function detectInstallOwnership(): InstallOwnership {
  return detectInstallOwnershipFromPath(HERE, { exists: existsSync });
}

export function miseUpdateCommand(
  ownership: InstallOwnership = detectInstallOwnership(),
): string | null {
  return ownership.installer === "mise" && ownership.owner
    ? `mise upgrade ${ownership.owner.tool}`
    : null;
}

function packageRoot(): string {
  return resolve(HERE, "..", "..");
}

function runningPnpmShimPath(): string | undefined {
  const invoked = process.argv[1];
  if (!invoked) return undefined;
  const name = invoked.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (!new Set(["ocx", "opencodex", "ocx.cmd", "opencodex.cmd", "ocx.ps1", "opencodex.ps1"]).has(name ?? "")) {
    return undefined;
  }
  return resolve(invoked);
}

function runPnpmCandidate(
  commandPath: string,
  args: readonly string[],
  capture = false,
): { status: number | null; stdout?: string | null; stderr?: string | null } {
  const invocation = pnpmInvocationForPath(commandPath, args);
  if (!invocation) return { status: 1 };
  return spawnSync(invocation.file, invocation.args, {
    stdio: capture ? "pipe" : "ignore",
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    env: unprivilegedOwnershipMutationEnvironment(process.env),
    ...invocation.options,
  });
}

/** Resolve the exact pnpm executable/group/bin that own this package. */
export function resolveCurrentPnpmGlobalOwner(): PnpmGlobalOwnerResult {
  return resolvePnpmGlobalOwner({
    packageName: PKG,
    packagePath: packageRoot(),
    commandPaths: resolvePnpmCommands(),
    runningShimPath: runningPnpmShimPath(),
    runPnpm: runPnpmCandidate,
  });
}

function ownerPnpmTarget(
  owner: PnpmGlobalOwner,
  args: readonly string[],
): { bin: string; args: string[]; options: { windowsVerbatimArguments?: boolean }; env: Record<string, string | undefined> } | null {
  const invocation = pnpmOwnerInvocation(owner, args);
  if (!invocation) return null;
  return {
    bin: invocation.file,
    args: invocation.args,
    options: invocation.options,
    env: invocation.env,
  };
}

function runOwnedPnpm(
  owner: PnpmGlobalOwner,
  args: readonly string[],
  capture: boolean,
  stdio: "inherit" | "pipe" | "ignore" = capture ? "pipe" : "inherit",
): { status: number | null; stdout?: string | null; stderr?: string | null } {
  const target = ownerPnpmTarget(owner, args);
  if (!target) return { status: 1 };
  return spawnSync(target.bin, target.args, {
    stdio,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    env: unprivilegedOwnershipMutationEnvironment(target.env),
    ...target.options,
  });
}

/** Re-read the owning group's active package and return its verified launcher. */
export function resolvePnpmActiveLauncher(owner: PnpmGlobalOwner): string | null {
  const active = readPnpmGlobalPackage(
    PKG,
    (args, capture = false) => runOwnedPnpm(owner, args, capture),
    undefined,
    {
      owner,
      expectedGlobalDir: owner.globalDir,
      expectedGlobalRoot: owner.globalRoot,
      globalBinDir: owner.globalBinDir,
    },
  );
  return active.ok ? join(active.path, "bin", "ocx.mjs") : null;
}

export function currentVersion(): string {
  return packageVersion("?");
}

export function defaultUpdateTag(current: string): Channel {
  return current.includes("-preview.") ? "preview" : "latest";
}

export function updateTag(current: string): Channel {
  const tagIndex = process.argv.indexOf("--tag");
  const explicit = tagIndex !== -1 ? process.argv[tagIndex + 1] : undefined;
  if (explicit === "preview" || explicit === "latest") return explicit;
  return defaultUpdateTag(current);
}

type SpawnTarget = {
  bin: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
  env?: Record<string, string | undefined>;
};

function npmSpawnTarget(args: readonly string[]): SpawnTarget | null {
  const invocation = npmInvocation(args);
  if (!invocation) return null;
  return { bin: invocation.file, args: invocation.args, options: invocation.options };
}

function pnpmSpawnTarget(args: readonly string[], owner?: PnpmGlobalOwner): SpawnTarget | null {
  if (owner) {
    const invocation = pnpmOwnerInvocation(owner, args);
    if (!invocation) return null;
    return {
      bin: invocation.file,
      args: invocation.args,
      options: invocation.options,
      env: invocation.env,
    };
  }
  const invocation = pnpmInvocation(args);
  if (!invocation) return null;
  return { bin: invocation.file, args: invocation.args, options: invocation.options };
}

function registrySpawnTarget(
  installer: Installer,
  args: readonly string[],
  owner?: PnpmGlobalOwner,
): SpawnTarget | null {
  // A pnpm command without an owner would silently fall back to the first PATH
  // candidate. That is unsafe when multiple PNPM_HOME installations expose the
  // same version, so registry queries use the same hard binding as mutation.
  return installer === "pnpm"
    ? owner ? pnpmSpawnTarget(args, owner) : null
    : npmSpawnTarget(args);
}

function selectedPnpmOwner(owner?: PnpmGlobalOwner): PnpmGlobalOwner | undefined {
  if (owner) return owner;
  const result = resolveCurrentPnpmGlobalOwner();
  return result.ok ? result.owner : undefined;
}

function updateSpawnTarget(bin: string, args: readonly string[]): SpawnTarget | null {
  if (bin === "npm") return npmSpawnTarget(args);
  if (bin === "pnpm") return pnpmSpawnTarget(args);
  if (process.platform === "win32" && bin === "bun") {
    return { bin: process.execPath, args: [...args], options: {} };
  }
  return { bin, args: [...args], options: {} };
}

/**
 * The GUI update worker sets OCX_SERVICE=1 and has stdio ignored — inheriting that for
 * Background package-manager children can open stacked visible consoles on Windows.
 * Pipe instead and relay bounded output after the child exits. (Ported from PR #167.)
 */
function updateChildStdio(): "inherit" | "pipe" {
  if (process.env.OCX_SERVICE === "1") return "pipe";
  if (typeof process.stdout.isTTY === "boolean" && !process.stdout.isTTY) return "pipe";
  return "inherit";
}

function logSpawnOutput(label: string, result: { stdout?: string | Buffer | null; stderr?: string | Buffer | null }): void {
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stdout) console.log(stdout.length > 4000 ? `${label}${stdout.slice(-4000)}` : stdout);
  if (stderr) console.error(stderr.length > 4000 ? `${label}${stderr.slice(-4000)}` : stderr);
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll("\"", "\\\"")}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function launcherStartHint(launcher: string, port: number): string {
  return `${shellQuote(process.execPath)} ${shellQuote(launcher)} start --port ${Math.trunc(port)}`;
}

/** Latest published version from the registry (best-effort; null if the manager isn't available). */
export function latestVersion(
  tag: string,
  installer: Installer = detectInstall(),
  owner?: PnpmGlobalOwner,
): string | null {
  const resolvedOwner = installer === "pnpm" ? selectedPnpmOwner(owner) : undefined;
  if (installer === "pnpm" && !resolvedOwner) return null;
  const manager = registrySpawnTarget(installer, ["view", `${PKG}@${tag}`, "version"], resolvedOwner);
  if (!manager) return null;
  const r = spawnSync(manager.bin, manager.args, {
    encoding: "utf8",
    timeout: 12000,
    windowsHide: true,
    env: unprivilegedOwnershipMutationEnvironment(manager.env ?? process.env),
    ...manager.options,
  });
  return r.status === 0 && typeof r.stdout === "string" ? (r.stdout.trim() || null) : null;
}

/** The global-install command opencodex would run to update on this channel. */
export function updateCommand(installer: Installer, tag: Channel, resolvedVersion?: string | null): { bin: string; args: string[] } {
  if (installer === "mise") {
    throw new Error("mise-owned installations must be upgraded through mise");
  }
  // Immutable target: when the registry resolved a concrete version, install exactly
  // that version — the dist-tag can move between resolution and install (TOCTOU).
  const target = resolvedVersion || tag;
  if (installer === "bun") return { bin: "bun", args: ["add", "-g", `${PKG}@${target}`] };
  if (installer === "pnpm") {
    return { bin: "pnpm", args: ["add", "-g", "--allow-build=bun", `${PKG}@${target}`] };
  }
  const bin = "npm";
  const args = ["install", "-g", `${PKG}@${target}`];
  return { bin, args };
}

/** Human-readable form of {@link updateCommand}, used in the update prompt label. */
export function updateCommandStr(installer: Installer, tag: Channel, resolvedVersion?: string | null): string {
  const { bin, args } = updateCommand(installer, tag, resolvedVersion);
  return `${bin} ${args.join(" ")}`;
}

/**
 * Pre-flight integrity metadata check (NOT independent tamper-proofing — the installer
 * verifies tarballs against the same registry metadata). Two failure lanes:
 *  - transient registry failure (spawn error/timeout/nonzero exit) → `{ ok: "skipped" }`
 *    so registry absence never turns into an unconditional update failure;
 *  - successful query with missing/malformed SRI → `{ ok: false }` (anomalous
 *    metadata — fail closed BEFORE the running proxy is stopped).
 * `dist.integrity` may be a quoted, space-separated multi-hash list; any sha512 token passes.
 */
export function checkUpdatePackageIntegrity(
  version: string | null,
  spawn: typeof spawnSync = spawnSync,
  installer: Installer = detectInstall(),
  owner?: PnpmGlobalOwner,
): { ok: true; integrity: string } | { ok: false; reason: string } | { ok: "skipped"; reason: string } {
  const resolvedOwner = installer === "pnpm" ? selectedPnpmOwner(owner) : undefined;
  if (installer === "pnpm" && !resolvedOwner) {
    return { ok: false, reason: "could not identify pnpm's owning global installation" };
  }
  const manager = registrySpawnTarget(installer, ["view", `${PKG}@${version}`, "dist.integrity"], resolvedOwner);
  if (!manager) return { ok: "skipped", reason: `${installer} executable was not found on a trusted PATH entry` };
  const result = checkRegistryPackageIntegrity(PKG, version, args => {
    const target = registrySpawnTarget(installer, args, resolvedOwner);
    if (!target) return { status: 1 };
    return spawn(target.bin, target.args, {
      encoding: "utf8",
      timeout: 12000,
      windowsHide: true,
      env: unprivilegedOwnershipMutationEnvironment(target.env ?? process.env),
      ...target.options,
    });
  });
  return result;
}

/**
 * The recorded runtime owner, in the shape the shared update rule reads.
 *
 * Fails CLOSED. A resolution this process could not obtain is not evidence that nobody owns
 * the runtime, and treating it as such is how an unreadable record reactivates the npm
 * launcher over a takeover the user consented to.
 */
interface RuntimeOwnershipObservation {
  readonly ownership: ServiceOwnership | null;
  readonly ownershipUnknown: boolean;
  readonly subjectToken: string;
}

async function resolvedRuntimeOwnership(): Promise<RuntimeOwnershipObservation> {
  try {
    const { resolveServiceOwnership } = await import("../service");
    const resolution = resolveServiceOwnership();
    if (resolution.kind === "owned") return {
      ownership: resolution.ownership,
      ownershipUnknown: false,
      subjectToken: JSON.stringify(["owned", resolution.revision, resolution.ownership]),
    };
    if (resolution.kind === "none") return {
      ownership: null,
      ownershipUnknown: false,
      subjectToken: JSON.stringify(["none", resolution.revision]),
    };
    return { ownership: null, ownershipUnknown: true, subjectToken: "unknown" };
  } catch {
    return { ownership: null, ownershipUnknown: true, subjectToken: "unknown" };
  }
}

/**
 * `ocx update` fallback for source checkouts and Bun global installs. npm and pnpm global installs
 * are updated in the Node bin launcher before Bun starts, so Windows does not replace the running
 * Bun binary.
 */
export async function runUpdate(): Promise<void> {
  const ownership = detectInstallOwnership();
  const installer = ownership.installer;
  const current = currentVersion();
  const tag = updateTag(current);
  console.log(`opencodex v${current} (installed via ${installer}, tag ${tag})`);

  if (installer === "mise") {
    const command = miseUpdateCommand(ownership);
    if (command) {
      console.error(`OpenCodex is externally managed by mise. Update it with: ${command}`);
    } else {
      console.error(
        "OpenCodex appears to be managed by mise, but its ownership metadata is unreadable or inconsistent. Repair the mise installation metadata before updating.",
      );
    }
    process.exitCode = 1;
    return;
  }

  if (installer === "source") {
    console.log("Running from a source checkout — update with:  git pull && bun install");
    return;
  }

  const ownerResult = installer === "pnpm" ? resolveCurrentPnpmGlobalOwner() : undefined;
  if (installer === "pnpm" && (!ownerResult || !ownerResult.ok)) {
    console.error(`⚠️  ${ownerResult?.reason ?? "Could not identify pnpm's owning global installation"}. Aborting before stopping the proxy.`);
    process.exit(1);
  }
  const owner = ownerResult?.ok ? ownerResult.owner : undefined;
  const latest = latestVersion(tag, installer, owner);
  if (latest && latest === current) {
    console.log(`Already on the latest ${tag} version (v${latest}).`);
    return;
  }

  // Pre-flight integrity metadata check — runs BEFORE the proxy is stopped so an
  // anomalous registry entry aborts without unloading the running service.
  const integrity = checkUpdatePackageIntegrity(latest, spawnSync, installer, owner);
  if (integrity.ok === false) {
    console.error(`⚠️  ${integrity.reason} — aborting the update before stopping the proxy.`);
    process.exit(1);
  }
  if (integrity.ok === "skipped") {
    console.warn(`⚠️  Integrity pre-flight skipped: ${integrity.reason}. Proceeding best-effort.`);
  } else {
    console.log(`Verified ${PKG}@${latest} integrity metadata ${integrity.integrity.slice(0, 24)}…`);
  }

  if (installer === "npm") {
    const cachePreflight = runNpmCachePreflight();
    if (!cachePreflight.ok) {
      console.error(`⚠️  ${npmCachePreflightFailureMessage(cachePreflight.reason)}. Aborting before stopping the proxy.`);
      process.exit(1);
    }
  }

  const { bin, args: cmdArgs } = updateCommand(installer, tag, latest);
  const target = installer === "pnpm" && owner
    ? pnpmSpawnTarget(cmdArgs, owner)
    : updateSpawnTarget(bin, cmdArgs);
  if (!target) {
    console.error(`⚠️  Could not resolve ${bin} from a trusted absolute PATH entry; aborting before stopping the proxy.`);
    process.exit(1);
  }

  const { serviceStatePaths } = await import("../service");
  const updateExitCode = await withUpdateOwnershipLease(serviceStatePaths(), async mutation => {
  // Remember whether a background service manages the proxy BEFORE stopping — `ocx stop`
  // unloads it, so a successful update must repair/restart it afterwards.
  let serviceWasInstalled = false;
  try {
    const { isServiceInstalled } = await import("../service");
    serviceWasInstalled = isServiceInstalled();
  } catch { /* best-effort */ }
  // What this update may do to the runtime. A desktop takeover vetoes both the stop and the
  // service refresh below; see `planUpdateRuntimeHandling` for why each half is wrong.
  const initialOwnership = await resolvedRuntimeOwnership();
  const runtimePlan = planUpdateRuntimeHandling({
    ...initialOwnership,
    serviceInstalled: serviceWasInstalled,
  });
  if (runtimePlan.notice) console.log(runtimePlan.notice);
  if (!runtimePlan.mayReplacePackage) {
    console.error("⚠️  Update stopped before tray handoff, runtime stop, or package replacement because runtime ownership is unknown.");
    return 1;
  }
  let trayWasInstalled = false;
  let trayWasRunning = false;
  if (process.platform === "win32") {
    try {
      const { getWindowsTrayStatus, startWindowsTray, stopWindowsTray } = await import("../tray/windows");
      const tray = getWindowsTrayStatus();
      const trayPlan = handoffWindowsTrayForUpdate(tray, {
        stop: () => {
          const stopped = stopWindowsTray();
          return { exitStatus: 0, running: stopped.running };
        },
        start: () => startWindowsTray(),
      });
      trayWasInstalled = trayPlan.refreshAfterReplacement;
      trayWasRunning = trayPlan.restoreOnFailure;
    } catch (error) {
      console.error(`⚠️  Could not stop the Windows tray; aborting before package replacement: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  // Capture listen target before stop clears runtime state (same contract as GUI update worker).
  // Prefer a live runtime record; a stale crashed leftover must not override config.port.
  const preUpdateConfig = loadConfig();
  const preUpdateRt = readRuntimePort();
  const livePid = readPid();
  const runtimeTrusted = !!(preUpdateRt && livePid && preUpdateRt.pid === livePid);
  const configPort = typeof preUpdateConfig.port === "number" && preUpdateConfig.port > 0
    ? preUpdateConfig.port
    : 10100;
  const capturedListen = {
    port: runtimeTrusted ? preUpdateRt.port : configPort,
    hostname: (runtimeTrusted ? preUpdateRt.hostname : undefined) ?? preUpdateConfig.hostname ?? "127.0.0.1",
    ...(runtimeTrusted && livePid ? { oldPid: livePid } : {}),
  };

  const currentPackageRuntimeLiveness = () => inspectPackageRuntimeLiveness({
    capturedTarget: capturedListen,
    readCurrentTarget: () => readUpdateRuntimeTarget(getRuntimePortPath(), capturedListen.hostname),
    probe: target => probeProxyLiveness(target.port, target.hostname),
  }).overall;
  const hadRuntimeState = serviceWasInstalled || !!livePid || !!preUpdateRt;

  let stopAttempted = false;
  let postUpdateLauncher = installer === "pnpm" && owner
    ? join(owner.packagePath, "bin", "ocx.mjs")
    : join(packageRoot(), "bin", "ocx.mjs");
  let postUpdateLauncherUsable = true;
  const sameOwner = (current: RuntimeOwnershipObservation) => {
    const before = initialOwnership.ownership, after = current.ownership;
    return before?.owner === after?.owner && before?.installId === after?.installId
      && before?.consentGeneration === after?.consentGeneration;
  };
  const startProxyDirectly = async (): Promise<boolean> => {
    if (!postUpdateLauncherUsable || !existsSync(postUpdateLauncher)) return false;
    const env = mutation.controlEnvironment();
    delete env.OCX_SERVICE;
    const child = spawn(process.execPath, [postUpdateLauncher, "start", "--port", String(capturedListen.port)], {
      detached: true, stdio: "ignore", windowsHide: true, env: withProcessRuntimeProvenance(env),
    });
    let failed = false;
    child.once("error", () => { failed = true; });
    child.unref();
    const deadline = Date.now() + 30_000;
    while (!failed && Date.now() < deadline) {
      const current = readUpdateRuntimeTarget(getRuntimePortPath(), capturedListen.hostname);
      if (current.kind === "target" && current.target.port === capturedListen.port
        && await proxyIdentityAt(current.target.port, { hostname: current.target.hostname, expectedPid: current.target.pid },
          { timeoutMs: 1500, deadlineAt: deadline, attempts: 1 })) return true;
      await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    console.warn("⚠️  Recovery did not report a healthy proxy before its deadline; run 'ocx service repair' or 'ocx start'.");
    return false;
  };
  const recoverStoppedRuntime = async (reason: string): Promise<void> => {
    try {
      const current = await resolvedRuntimeOwnership();
      const recovery = planStoppedRuntimeRecovery({
        stopAttempted, ...current, sameOwner: sameOwner(current),
        liveness: currentPackageRuntimeLiveness(), serviceInstalled: serviceWasInstalled,
        launcherUsable: postUpdateLauncherUsable && existsSync(postUpdateLauncher), hadRuntimeState,
      });
      if (recovery.action === "manual") {
        console.warn(`⚠️  ${reason}; runtime recovery requires manual review (${recovery.reason}).`);
      } else if (recovery.action === "service") {
        const { serviceReinstallArgs, isServiceViable } = await import("../service");
        const service = spawnSync(process.execPath, [postUpdateLauncher, ...serviceReinstallArgs()], {
          stdio: updateChildStdio(), windowsHide: true,
          env: mutation.controlEnvironment({ ...process.env, OCX_BAKE_PORT: String(capturedListen.port) }),
        });
        if (service.status !== 0 || !isServiceViable()) {
          const nowOwned = await resolvedRuntimeOwnership();
          const fallback = planStoppedRuntimeRecovery({
            stopAttempted, ...nowOwned, sameOwner: sameOwner(nowOwned),
            liveness: currentPackageRuntimeLiveness(), serviceInstalled: false,
            launcherUsable: postUpdateLauncherUsable && existsSync(postUpdateLauncher), hadRuntimeState,
          });
          if (fallback.action === "direct") await startProxyDirectly();
          else console.warn("⚠️  Service recovery was not confirmed; no second proxy was started.");
        }
      } else if (recovery.action === "direct") {
        await startProxyDirectly();
      }
    } catch {
      console.warn("⚠️  Runtime recovery could not be verified; run 'ocx service repair' or 'ocx start' after checking ownership.");
    }
  };

  try {
  // Never replace package files under a live proxy: the running server dynamic-imports
  // modules after startup, so an in-place update leaves it executing mixed old/new code.
  // Gate on the service and the runtime-port record too, not just the pid file — a
  // service-managed or orphaned proxy can be live while ocx.pid is stale/missing.
  //
  // An outstanding pending-teardown receipt is a fourth reason to run the stop. After a
  // parent crashed mid-deferral all three of the other signals can be absent while the
  // shared client config still points at a proxy that is gone; installing over that
  // silently skips the recovery the receipt was written to trigger (#3008).
  // Full `ocx stop` semantics (drain, service stop, restore).

  if (runtimePlan.mayStopRuntime && (serviceWasInstalled || readPid() || readRuntimePort() || pendingTeardownOutstanding())) {
    stopAttempted = true;
    console.log("⏹  Stopping the running proxy before updating...");
    const stopStdio = updateChildStdio();
    const stop = spawnSync(process.execPath, selfLaunchArgv(["stop"]), {
      env: mutation.controlEnvironment(),
      stdio: stopStdio,
      encoding: stopStdio === "pipe" ? "utf8" : undefined,
      windowsHide: true,
    });
    if (stopStdio === "pipe") logSpawnOutput("", stop);
    // One decision, shared with the package launcher (#3008). The two lanes disagreeing about
    // the same situation is how this shipped fixed on one side only. Absent PID and runtime
    // files are weak evidence - a crashed-but-listening proxy leaves none - so the captured
    // endpoint is asked, and `null` from proxyIdentityAt covers refusal AND timeout alike.
    const identity = await proxyIdentityAt(capturedListen.port, { hostname: capturedListen.hostname });
    const decision = decidePostStopUpdate({
      status: stop.status,
      hasRuntimeState: !!(readPid() || readRuntimePort()),
      // Re-checked AFTER the stop: a quarantined receipt lets the stop itself succeed
      // (there is nothing left to stop), so a pre-stop check alone let the retry install
      // over a teardown that never ran.
      teardownOutstanding: pendingTeardownOutstanding(),
      liveness: identity ? "live" : probeProxyLiveness(capturedListen.port, capturedListen.hostname),
    });
    const historyOnlyStop = decision.reason === "history-only";
    if (!decision.proceed) {
      if (trayWasRunning) {
        try {
          const { startWindowsTray } = await import("../tray/windows");
          startWindowsTray();
        } catch { /* preserve the proxy stop failure */ }
      }
      if (decision.reason === "teardown-outstanding") {
        console.error("⚠️  A shared teardown from an earlier stop is still outstanding and needs manual review; aborting the update.");
        console.error("    Confirm no proxy is running, run 'ocx restore', then remove the pending-teardown file in your opencodex home.");
      } else {
        console.error(decision.reason === "proxy-unknown"
          ? `⚠️  Could not confirm the proxy on ${capturedListen.hostname}:${capturedListen.port} is stopped; aborting the update. Run 'ocx stop' and retry.`
          : "⚠️  Could not stop the running proxy; aborting the update. Run 'ocx stop' and retry.");
      }
      return 1;
    }
    if (historyOnlyStop || historyRestoreIncomplete()) {
      console.warn(
        "⚠️  Codex resume-history metadata restore is incomplete (a backup manifest remains).\n" +
        "    The DB may be busy or the manifest/target may need review; untracked routed history is intentionally unchanged.\n" +
        "    After the update: close the Codex app, run 'ocx doctor', then run 'ocx stop' once to retry.",
      );
    }
    if (decision.reason === "history-deferred") {
      // Not the same warning: nothing was restored here. Saying "history metadata is
      // incomplete" would imply config and catalog came back, and an operator who
      // believed that would not know a teardown is still owed.
      console.warn(
        "⚠️  The shared teardown was refused by the Codex history preflight and restored nothing.\n" +
        "    Config, catalog, history and provenance were preserved, and the teardown receipt was kept.\n" +
        "    The proxy is down, so the update continues; close the Codex app and run 'ocx stop' once afterwards to finish the restore.",
      );
    }
  }

  const installStdio = updateChildStdio();
  let r: {
    status: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
  } | null = null;
  let replacementRefusal: string | null = null;
  // Ownership can change while registry work is in flight. Unknown at this exact
  // boundary blocks replacement; a confirmed desktop claim still permits updating the idle
  // npm installation while leaving the bundled sidecar alone.
  const replacementOwnership = await resolvedRuntimeOwnership();
  const replacementPlan = planUpdateRuntimeHandling({
    ...replacementOwnership,
    serviceInstalled: serviceWasInstalled,
  });
  const replacementLiveness = currentPackageRuntimeLiveness();
  if (replacementOwnership.subjectToken !== initialOwnership.subjectToken
    || !replacementPlan.mayReplacePackage
    || replacementLiveness !== "dead") {
    replacementRefusal = replacementPlan.notice
      ?? (replacementLiveness === "live"
        ? "⚠️  Update stopped because a proxy became live after the stop decision; rerun from the beginning."
        : "⚠️  Update stopped because runtime ownership or liveness changed after the stop decision; rerun from the beginning.");
  } else {
  console.log(`Updating${latest ? ` to v${latest}` : ""}…\n$ ${bin} ${cmdArgs.join(" ")}`);

  // Every post-update action below receives the verified active launcher.
  if (installer === "pnpm") {
    let update: ReturnType<typeof runPnpmGlobalUpdate>;
    try {
      update = runPnpmGlobalUpdate({
        packageName: PKG,
        currentVersion: current,
        targetVersion: latest || undefined,
        tag,
        owner: owner!,
        runningPackagePath: packageRoot(),
        runPnpm: (args, capture = false) => runOwnedPnpm(
          owner!,
          args,
          capture,
          capture ? "pipe" : installStdio,
        ),
        log: line => console.log(line),
      });
    } catch {
      // A thrown verifier/runner error means the active group is unknown. Mark the
      // launcher unusable and let the failure lane report a manual recovery path.
      update = {
        ok: false,
        phase: "rollback",
        rolledBack: false,
        error: "pnpm update failed unexpectedly; active package could not be verified",
      };
    }
    if (update.ok) {
      postUpdateLauncher = join(update.path, "bin", "ocx.mjs");
      postUpdateLauncherUsable = true;
      r = { status: 0, signal: null, stdout: "", stderr: "" };
    } else {
      postUpdateLauncherUsable = Boolean(update.activePath);
      if (update.activePath) postUpdateLauncher = join(update.activePath, "bin", "ocx.mjs");
      console.error(`⚠️  ${update.error}${update.rolledBack ? "." : " Manual recovery may be required."}`);
      r = { status: 1, signal: null, stdout: "", stderr: "" };
    }
  } else {
    r = spawnSync(target.bin, target.args, {
      stdio: installStdio,
      encoding: installStdio === "pipe" ? "utf8" : undefined,
      timeout: 180000,
      windowsHide: true,
      ...target.options,
      env: mutation.unprivilegedEnvironment(),
    });
  }
  if (r && installStdio === "pipe") logSpawnOutput("", r);
  }
  if (replacementRefusal) {
    await recoverStoppedRuntime("package replacement was refused");
    if (trayWasRunning) {
      try {
        const { startWindowsTray } = await import("../tray/windows");
        startWindowsTray();
      } catch { /* preserve the ownership refusal */ }
    }
    console.error(replacementRefusal);
    return 1;
  }
  if (!r) throw new Error("update replacement returned no result");
  const postInstallPlan = planUpdateRuntimeHandling({
    ...(await resolvedRuntimeOwnership()),
    serviceInstalled: serviceWasInstalled,
  });
  if (r.status === 0) {
    console.log(`\n✅ Updated${latest ? ` to v${latest}` : ""}.`);
    // Re-enter through the verified active package launcher. This keeps the Codex
    // shim, tray, service and proxy recovery paths on the same package/group that
    // pnpm selected, including when the update changed the global link target.
    try {
      const { isCodexShimInstalled } = await import("../codex/shim");
      if (isCodexShimInstalled()) {
        const shim = spawnSync(process.execPath, [postUpdateLauncher, "codex-shim", "install"], {
          stdio: "inherit",
          windowsHide: true,
          env: mutation.unprivilegedEnvironment(),
        });
        if (shim.status !== 0) console.warn("⚠️  Shim repair skipped: run 'ocx codex-shim install'.");
      }
    } catch {
      console.warn("⚠️  Shim repair skipped; run 'ocx codex-shim install'.");
    }
    if (trayWasInstalled) {
      const trayArgs = planWindowsTrayUpdate({ installed: trayWasInstalled, running: trayWasRunning }).installArgs;
      const tray = spawnSync(process.execPath, [postUpdateLauncher, ...trayArgs], { stdio: "inherit", windowsHide: true, env: mutation.unprivilegedEnvironment() });
      if (tray.status === 0) {
        console.log("🔧 Refreshed Windows tray startup paths.");
      } else {
        console.warn("⚠️  Windows tray refresh failed. Run 'ocx tray install'.");
        if (trayWasRunning) spawnSync(process.execPath, [postUpdateLauncher, "tray", "start"], { stdio: "ignore", windowsHide: true, env: mutation.unprivilegedEnvironment() });
      }
    }
    // The stop above unloaded any managed service; repair it with the NEW files
    // (spawn the fresh cli.ts so updated code writes the baked paths) so a
    // launchd/schtasks/systemd user isn't left with the background proxy down.
    if (postInstallPlan.mayRestoreService) {
      console.log("🔁 Refreshing the background service with the updated files...");
      const { serviceReinstallArgs } = await import("../service");
      const { reclaimListenPort } = await import("../server/port-reclaim");
      const freed = await reclaimListenPort(capturedListen.port, capturedListen.hostname, {
        timeoutMs: 30_000,
        intervalMs: 100,
        scanIntervalMs: 500,
        killOcxHolders: capturedListen.oldPid != null,
        onlyKillPids: capturedListen.oldPid != null ? [capturedListen.oldPid] : [],
      });
      if (!freed) {
        console.warn(`⚠️  Port ${capturedListen.port} still busy after 30s; repairing service with pinned --port ${capturedListen.port} anyway (refusing to hop).`);
      }
      const prevBake = process.env.OCX_BAKE_PORT;
      process.env.OCX_BAKE_PORT = String(capturedListen.port);
      try {
        const svcStdio = updateChildStdio();
        const svc = spawnSync(process.execPath, [postUpdateLauncher, ...serviceReinstallArgs()], {
          env: mutation.controlEnvironment(),
          stdio: svcStdio,
          encoding: svcStdio === "pipe" ? "utf8" : undefined,
          windowsHide: true,
        });
        if (svcStdio === "pipe") logSpawnOutput("", svc);
        const serviceRefreshed = svc.status === 0;
        let serviceViable = serviceRefreshed;
        if (serviceRefreshed) {
          try {
            const { isServiceViable } = await import("../service");
            serviceViable = isServiceViable();
          } catch {
            serviceViable = false;
          }
        }
        if (!serviceRefreshed || !serviceViable) {
          // Repair normally avoids elevation for a healthy scheduler task, but a stale
          // definition may require guarded create/elevation. It can also fail — or exit 0
          // while leaving stale/missing assets that never start
          // the proxy. Fall back to a direct detached proxy start so the update
          // never leaves the user without a running proxy — but only when the port is free.
          if (!freed) {
            console.warn(
              serviceRefreshed
                ? "⚠️  Service refresh left a non-viable manager and the captured port is still busy; not starting on another port."
                : "⚠️  Service refresh failed and the captured port is still busy; not starting on another port.",
            );
            console.warn(process.platform === "win32"
              ? `   Run 'ocx service repair', then 'ocx start --port ${capturedListen.port}'.`
              : `   Run 'ocx service repair' to see the reason, then 'ocx start --port ${capturedListen.port}'.`);
          } else {
            // Re-read rather than reuse the plan from before the package install: the app can
            // claim the runtime during an update that takes minutes, and the refusal the
            // repair above just returned is indistinguishable from any other failure here.
            const nowOwned = planUpdateRuntimeHandling({
              ...(await resolvedRuntimeOwnership()),
              serviceInstalled: true,
            });
            if (!nowOwned.mayStopRuntime) {
              console.warn(nowOwned.notice ?? "⚠️  The background runtime is owned elsewhere; not starting a second proxy.");
              return;
            }
            console.warn(
              serviceRefreshed
                ? "⚠️  Service refresh left a non-viable manager (stale or missing assets) — starting the proxy directly instead."
                : "⚠️  Service refresh failed — starting the proxy directly instead.",
            );
            // Elevation is a Windows-only remedy; elsewhere the refresh fails for
            // reasons `ocx service repair` reports directly (since it now verifies
            // the service actually serves).
            console.warn(process.platform === "win32"
              ? "   Run 'ocx service repair' to refresh the background service."
              : "   Run 'ocx service repair' to refresh the background service and see why it failed.");
            if (await startProxyDirectly()) console.log(`✅ Proxy is healthy on port ${capturedListen.port}.`);
          }
        }
      } finally {
        if (prevBake === undefined) delete process.env.OCX_BAKE_PORT;
        else process.env.OCX_BAKE_PORT = prevBake;
      }
    } else if (postInstallPlan.mayStopRuntime) {
      console.log(`Restart the proxy:  ${launcherStartHint(postUpdateLauncher, capturedListen.port)}`);
    }
  } else {
    if (stopAttempted && trayWasRunning && postUpdateLauncherUsable) {
      spawnSync(process.execPath, [postUpdateLauncher, "tray", "start"], { stdio: "ignore", windowsHide: true, env: mutation.unprivilegedEnvironment() });
    }
    await recoverStoppedRuntime("package update failed");
    console.error(`\n⚠️  Update failed (${bin} exit ${r.status ?? "?"}). Try manually:  ${bin} ${cmdArgs.join(" ")}`);
    return 1;
  }
  } catch (error) {
    await recoverStoppedRuntime("update failed unexpectedly");
    if (trayWasRunning) {
      try { const { startWindowsTray } = await import("../tray/windows"); startWindowsTray(); } catch { /* retain original failure */ }
    }
    throw error;
  }
  });
  if (updateExitCode) process.exit(updateExitCode);
}
