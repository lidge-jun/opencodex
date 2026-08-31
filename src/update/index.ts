import { spawn, spawnSync } from "node:child_process";
import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "./stop-contract.mjs";
import { proxyIdentityAt } from "../server/proxy-liveness";
import { probeProxyLiveness } from "./proxy-liveness-probe.mjs";
import { decidePostStopUpdate } from "./stop-decision.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getConfigDir, loadConfig } from "../config";
import { readPid, readRuntimePort } from "../config/process-state";
import { pendingTeardownOutstanding } from "../config/pending-teardown";
import { npmInvocation } from "./npm-invocation.mjs";
import {
  npmCachePreflightFailureMessage,
  runNpmCachePreflight,
} from "./npm-cache-preflight.mjs";
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "./tray-update-plan.mjs";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
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

export type Installer = "bun" | "npm" | "source";
export type Channel = "latest" | "preview";

/** Infer how opencodex is installed from the running module's path. */
export function detectInstall(): Installer {
  if (!HERE.includes("node_modules")) return "source"; // a git checkout, not a global install
  return HERE.includes(".bun") ? "bun" : "npm";
}

export function currentVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(HERE, "..", "..", "package.json"), "utf8")).version as string) ?? "?";
  } catch {
    return "?";
  }
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

function npmSpawnTarget(args: readonly string[]): { bin: string; args: string[]; options: { windowsVerbatimArguments?: boolean } } | null {
  const invocation = npmInvocation(args);
  if (!invocation) return null;
  return { bin: invocation.file, args: invocation.args, options: invocation.options };
}

function updateSpawnTarget(bin: string, args: readonly string[]): { bin: string; args: string[]; options: { windowsVerbatimArguments?: boolean } } | null {
  if (bin === "npm") return npmSpawnTarget(args);
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

/** Latest published version from the registry (best-effort; null if npm isn't available). */
export function latestVersion(tag: string): string | null {
  const npm = npmSpawnTarget(["view", `${PKG}@${tag}`, "version"]);
  if (!npm) return null;
  const r = spawnSync(npm.bin, npm.args, {
    encoding: "utf8",
    timeout: 12000,
    windowsHide: true,
    ...npm.options,
  });
  return r.status === 0 ? (r.stdout.trim() || null) : null;
}

/** The global-install command opencodex would run to update on this channel. */
export function updateCommand(installer: Installer, tag: Channel, resolvedVersion?: string | null): { bin: string; args: string[] } {
  const bin = installer === "bun" ? "bun" : "npm";
  // Immutable target: when the registry resolved a concrete version, install exactly
  // that version — the dist-tag can move between resolution and install (TOCTOU).
  const target = resolvedVersion || tag;
  const args = installer === "bun"
    ? ["add", "-g", `${PKG}@${target}`]
    : ["install", "-g", `${PKG}@${target}`];
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
): { ok: true; integrity: string } | { ok: false; reason: string } | { ok: "skipped"; reason: string } {
  if (!version) return { ok: "skipped", reason: "no resolved version (registry unavailable)" };
  const npm = npmSpawnTarget(["view", `${PKG}@${version}`, "dist.integrity"]);
  if (!npm) return { ok: "skipped", reason: "npm executable was not found on a trusted PATH entry" };
  const r = spawn(
    npm.bin,
    npm.args,
    { encoding: "utf8", timeout: 12000, windowsHide: true, ...npm.options },
  );
  // status !== 0 covers nonzero exits AND timeouts (status === null).
  if (r.status !== 0) return { ok: "skipped", reason: `registry integrity query failed (status ${r.status ?? "timeout"})` };
  const tokens = (r.stdout ?? "").replace(/["']/g, "").trim().split(/\s+/).filter(Boolean);
  const match = tokens.find(token => /^sha512-[A-Za-z0-9+/=]+$/.test(token));
  if (!match) return { ok: false, reason: `registry returned no sha512 integrity for ${PKG}@${version}` };
  return { ok: true, integrity: match };
}

/**
 * `ocx update` fallback for source checkouts and Bun global installs. npm global installs are updated
 * in the Node bin launcher before Bun starts, so Windows does not replace the running Bun binary.
 */
export async function runUpdate(): Promise<void> {
  const installer = detectInstall();
  const current = currentVersion();
  const tag = updateTag(current);
  console.log(`opencodex v${current} (installed via ${installer}, tag ${tag})`);

  if (installer === "source") {
    console.log("Running from a source checkout — update with:  git pull && bun install");
    return;
  }

  const latest = latestVersion(tag);
  if (latest && latest === current) {
    console.log(`Already on the latest ${tag} version (v${latest}).`);
    return;
  }

  // Pre-flight integrity metadata check — runs BEFORE the proxy is stopped so an
  // anomalous registry entry aborts without unloading the running service.
  const integrity = checkUpdatePackageIntegrity(latest);
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
  const target = updateSpawnTarget(bin, cmdArgs);
  if (!target) {
    console.error("⚠️  Could not resolve npm from a trusted absolute PATH entry; aborting before stopping the proxy.");
    process.exit(1);
  }

  // Remember whether a background service manages the proxy BEFORE stopping — `ocx stop`
  // unloads it, so a successful update must repair/restart it afterwards.
  let serviceWasInstalled = false;
  try {
    const { isServiceInstalled } = await import("../service");
    serviceWasInstalled = isServiceInstalled();
  } catch { /* best-effort */ }
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
      process.exit(1);
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
  if (serviceWasInstalled || readPid() || readRuntimePort() || pendingTeardownOutstanding()) {
    console.log("⏹  Stopping the running proxy before updating...");
    const stopStdio = updateChildStdio();
    const stop = spawnSync(process.execPath, selfLaunchArgv(["stop"]), {
      stdio: stopStdio,
      encoding: stopStdio === "pipe" ? "utf8" : undefined,
      windowsHide: true,
    });
    if (stopStdio === "pipe") logSpawnOutput("", stop);
    // One decision, shared with the npm launcher (#3008). The two lanes disagreeing about
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
      process.exit(1);
    }
    if (historyOnlyStop || historyRestoreIncomplete()) {
      console.warn(
        "⚠️  Codex resume-history metadata restore is incomplete (a backup manifest remains).\n" +
        "    The DB may be busy or the manifest/target may need review; untracked routed history is intentionally unchanged.\n" +
        "    After the update: close the Codex app, run 'ocx doctor', then run 'ocx stop' once to retry.",
      );
    }
  }

  console.log(`Updating${latest ? ` to v${latest}` : ""}…\n$ ${bin} ${cmdArgs.join(" ")}`);

  const installStdio = updateChildStdio();
  const r = spawnSync(target.bin, target.args, {
    stdio: installStdio,
    encoding: installStdio === "pipe" ? "utf8" : undefined,
    timeout: 180000,
    windowsHide: true,
    ...target.options,
  });
  if (installStdio === "pipe") logSpawnOutput("", r);
  if (r.status === 0) {
    console.log(`\n✅ Updated${latest ? ` to v${latest}` : ""}.`);
    // Re-bake the bundled Bun path into the Codex autostart shim on every
    // platform when one is installed (refresh-only; never installs fresh).
    try {
      const { isCodexShimInstalled, installCodexShim } = await import("../codex/shim");
      if (isCodexShimInstalled()) {
        const result = installCodexShim();
        if (result.installed) console.log(`🔧 ${result.message}`);
      }
    } catch (e) {
      console.warn(`⚠️  Shim repair skipped: ${e instanceof Error ? e.message : e}`);
    }
    if (trayWasInstalled) {
      const trayArgs = selfLaunchArgv(planWindowsTrayUpdate({ installed: trayWasInstalled, running: trayWasRunning }).installArgs);
      const tray = spawnSync(process.execPath, trayArgs, { stdio: "inherit", windowsHide: true });
      if (tray.status === 0) {
        console.log("🔧 Refreshed Windows tray startup paths.");
      } else {
        console.warn("⚠️  Windows tray refresh failed. Run 'ocx tray install'.");
        if (trayWasRunning) spawnSync(process.execPath, selfLaunchArgv(["tray", "start"]), { stdio: "ignore", windowsHide: true });
      }
    }
    // The stop above unloaded any managed service; repair it with the NEW files
    // (spawn the fresh cli.ts so updated code writes the baked paths) so a
    // launchd/schtasks/systemd user isn't left with the background proxy down.
    if (serviceWasInstalled) {
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
        const svc = spawnSync(process.execPath, selfLaunchArgv(serviceReinstallArgs()), {
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
            const env = { ...process.env };
            delete env.OCX_SERVICE;
            const child = spawn(process.execPath, selfLaunchArgv(["start", "--port", String(capturedListen.port)]), {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
              env: withProcessRuntimeProvenance(env),
            });
            child.unref();
            console.log(`✅ Proxy starting on port ${capturedListen.port}.`);
          }
        }
      } finally {
        if (prevBake === undefined) delete process.env.OCX_BAKE_PORT;
        else process.env.OCX_BAKE_PORT = prevBake;
      }
    } else {
      console.log(`Restart the proxy:  ocx start --port ${capturedListen.port}`);
    }
  } else {
    if (trayWasRunning) {
      try {
        const { startWindowsTray } = await import("../tray/windows");
        startWindowsTray();
      } catch { /* keep the primary update failure */ }
    }
    console.error(`\n⚠️  Update failed (${bin} exit ${r.status ?? "?"}). Try manually:  ${bin} ${cmdArgs.join(" ")}`);
    process.exit(1);
  }
}
