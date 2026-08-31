#!/usr/bin/env node
/**
 * opencodex npm bin launcher.
 *
 * The package source is TypeScript that runs on the Bun runtime. To let
 * `npm install -g @bitkyc08/opencodex` work without a separately-installed Bun,
 * we bundle the runtime via the `bun` npm dependency and exec it from this
 * Node shim. (Dev still runs `bun run src/cli/index.ts` directly via the shebang on
 * src/cli/index.ts — only the published npm `bin` routes through here.)
 */
import { spawn, spawnSync } from "node:child_process";
import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../src/update/stop-contract.mjs";
import { probeProxyLiveness } from "../src/update/proxy-liveness-probe.mjs";
import { decidePostStopUpdate } from "../src/update/stop-decision.mjs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";
import { npmInvocation } from "../src/update/npm-invocation.mjs";
import { hasPendingTeardownIn } from "../src/config/pending-teardown-names.mjs";
import {
  npmCachePreflightFailureMessage,
  runNpmCachePreflight,
} from "../src/update/npm-cache-preflight.mjs";
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "../src/update/tray-update-plan.mjs";
import { bootRestoreProbe, transactionalNpmUpdate } from "../src/update/transactional-install.mjs";
import {
  CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS,
  isCodexCliUpdateInspectionArgv,
} from "../src/update/codex-cli-update-launch-policy.mjs";

const PKG = "@bitkyc08/opencodex";
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli", "index.ts");
const NODE_LAUNCH_CONTEXT_ENV = "OCX_NODE_LAUNCH_CONTEXT";
const NODE_LAUNCH_PROOF_PREFIX = "--ocx-internal-launch-proof=";

function isNodeModulesInstall() {
  return here.split(/[\\/]/).includes("node_modules");
}

function isBunGlobalInstall() {
  return /[\\/]\.bun[\\/]/.test(here);
}

function currentPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

function updateTag(currentVersion) {
  // Allowlist the tag: the value is argv-controlled and (on Windows) flows into a
  // shell-joined spawnSync — never forward arbitrary strings.
  const tagIndex = process.argv.indexOf("--tag");
  const explicit = tagIndex !== -1 ? process.argv[tagIndex + 1] : undefined;
  if (explicit === "preview" || explicit === "latest") return explicit;
  return String(currentVersion).includes("-preview.") ? "preview" : "latest";
}

function expandUserPath(raw) {
  // Mirror src/config.ts expandUserPath — the Bun proxy expands `~`, so this launcher's
  // pid/state gates must resolve the same directory or they silently check the wrong path.
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

function configDir() {
  const raw = process.env.OPENCODEX_HOME?.trim();
  return resolve(raw ? expandUserPath(raw) : join(homedir(), ".opencodex"));
}

function shouldRepairCodexShim() {
  return existsSync(join(configDir(), "codex-shim.json"));
}

function historyRestoreIncomplete() {
  // Mirror src/update/index.ts historyRestoreIncomplete — a codex-history-backup-*.json surviving
  // a stop means the native-history restore was skipped (locked state DB).
  try {
    return readdirSync(configDir()).some(
      name => name.startsWith("codex-history-backup-") && name.endsWith(".json"),
    );
  } catch {
    return false;
  }
}

function repairCodexShimIfNeeded() {
  if (!shouldRepairCodexShim()) return;
  const launcher = fileURLToPath(import.meta.url);
  const res = spawnSync(process.execPath, [launcher, "codex-shim", "install"], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (res.status !== 0) {
    console.warn(`opencodex: Codex shim repair failed (${res.status ?? "unknown exit"}). Try: ocx codex-shim install`);
  }
}

function trayInstallState() {
  const statePath = join(configDir(), "tray-state.json");
  if (!existsSync(statePath)) return { installed: false, running: false };
  let running = false;
  try {
    const heartbeat = JSON.parse(readFileSync(join(configDir(), "tray-heartbeat.json"), "utf8"));
    if (Number.isSafeInteger(heartbeat.pid) && Date.now() - Number(heartbeat.timestamp) < 15_000) {
      process.kill(heartbeat.pid, 0);
      running = true;
    }
  } catch { /* installed but not running */ }
  return { installed: true, running };
}

function runTrayLifecycle(launcher, action) {
  return spawnSync(process.execPath, [launcher, "tray", action], {
    stdio: "inherit",
    windowsHide: true,
  });
}

function runNpmSelfUpdate() {
  const current = currentPackageVersion();
  const tag = updateTag(current);
  const latestInvocation = npmInvocation(["view", `${PKG}@${tag}`, "version"]);
  const installInvocation = npmInvocation(["install", "-g", `${PKG}@${tag}`]);
  if (!latestInvocation || !installInvocation) {
    console.error("opencodex: could not resolve npm from a trusted absolute PATH entry; aborting before stopping the proxy.");
    process.exit(1);
  }
  const latestResult = spawnSync(latestInvocation.file, latestInvocation.args, {
    encoding: "utf8",
    timeout: 12000,
    windowsHide: true,
    ...latestInvocation.options,
  });
  const latest = latestResult.status === 0 ? latestResult.stdout.trim() : "";

  console.log(`opencodex v${current} (installed via npm, tag ${tag})`);
  if (latest && latest === current) {
    console.log(`Already on the latest ${tag} version (v${latest}).`);
    process.exit(0);
  }

  const cachePreflight = runNpmCachePreflight();
  if (!cachePreflight.ok) {
    console.error(`opencodex: ${npmCachePreflightFailureMessage(cachePreflight.reason)}. Aborting before stopping the proxy.`);
    process.exit(1);
  }

  // Remember whether a background service manages the proxy BEFORE stopping — `ocx stop`
  // unloads it, so a successful update must refresh and restart it afterwards.
  const serviceStatePath = join(configDir(), "service-state.json");
  const serviceWasInstalled = existsSync(serviceStatePath);
  const trayBeforeUpdate = planWindowsTrayUpdate(
    process.platform === "win32" ? trayInstallState() : { installed: false, running: false },
  );
  /**
   * Refresh the existing service in place. `service repair` discovers the installed backend;
   * healthy Windows scheduler registrations avoid `schtasks /create`, while stale definitions
   * may be re-registered and require elevation.
   */
  function serviceRefreshArgs() {
    return [launcher, "service", "repair"];
  }
  /** Register from scratch, preserving the recorded backend. Only for a genuinely absent service. */
  function serviceInstallArgs() {
    try {
      const state = JSON.parse(readFileSync(serviceStatePath, "utf8"));
      if (state.backend === "native") return [launcher, "service", "install", "--native"];
    } catch { /* missing or corrupt — fall through to default */ }
    return [launcher, "service", "install"];
  }
  /**
   * Structured "is a service actually registered?" answer.
   *
   * This file is plain Node ESM and cannot import `diagnoseService()` from the
   * TypeScript runtime, so it asks the freshly-installed launcher — which runs that
   * diagnostic under Bun — and reads `startup.serviceInstalled`.
   *
   * Returns `null` when the probe itself could not answer, which callers must treat as
   * "unknown" rather than "absent": failing closed here means NOT re-registering.
   */
  function readServiceInstalledFromStatus(launcherPath) {
    try {
      const st = spawnSync(process.execPath, [launcherPath, "status", "--json"], {
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      if (st.status !== 0 || typeof st.stdout !== "string" || !st.stdout.trim()) return null;
      const installed = JSON.parse(st.stdout)?.startup?.serviceInstalled;
      return typeof installed === "boolean" ? installed : null;
    } catch {
      return null;
    }
  }

  // Capture listen target before stop clears runtime-port.json (mirrors GUI/CLI update worker).
  // Do not treat a live runtime port of 10100 as "missing" — track whether the read succeeded.
  let bakePort = 10100;
  // The hostname travels with the port: a proxy bound to ::1 or a specific interface is
  // invisible to a probe that assumes 127.0.0.1, and "no answer" would then read as
  // "stopped" for exactly the proxy the probe exists to find.
  let bakeHostname = "127.0.0.1";
  let sawRuntimePort = false;
  let sawRuntimeHostname = false;
  try {
    const rt = JSON.parse(readFileSync(join(configDir(), "runtime-port.json"), "utf8"));
    if (Number.isFinite(rt?.port) && rt.port > 0 && rt.port <= 65535) {
      // Only trust runtime when its pid still looks alive (stale crash leftovers fall back to config).
      const rtPid = Number(rt?.pid);
      let runtimeLive = false;
      if (Number.isSafeInteger(rtPid) && rtPid > 0) {
        try {
          process.kill(rtPid, 0);
          runtimeLive = true;
        } catch (e) {
          if (e && typeof e === "object" && "code" in e && e.code === "EPERM") runtimeLive = true;
        }
      }
      if (runtimeLive) {
        bakePort = Math.trunc(rt.port);
        if (typeof rt?.hostname === "string" && rt.hostname.trim() !== "") {
          bakeHostname = rt.hostname.trim();
          sawRuntimeHostname = true;
        }
        sawRuntimePort = true;
      }
    }
  } catch { /* fall through to config */ }
  // Port and hostname resolve INDEPENDENTLY: a legacy runtime record carries a port and no
  // hostname, and skipping config in that case probed 127.0.0.1 for a proxy bound to ::1.
  if (!sawRuntimePort || bakeHostname === "127.0.0.1") {
    try {
      const cfg = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"));
      if (!sawRuntimePort && Number.isFinite(cfg?.port) && cfg.port > 0 && cfg.port <= 65535) {
        bakePort = Math.trunc(cfg.port);
      }
      if (!sawRuntimeHostname && typeof cfg?.hostname === "string" && cfg.hostname.trim() !== "") {
        bakeHostname = cfg.hostname.trim();
      }
    } catch { /* keep default */ }
  }
  // Wildcard and bracketed-IPv6 normalization lives in probeProxyLiveness, so both lanes
  // get it from one place.

  const launcher = fileURLToPath(import.meta.url);

  function startProxyDirectly() {
    if (!existsSync(launcher)) {
      console.error("opencodex: cannot restart the proxy because the launcher is missing; reinstall opencodex manually.");
      return;
    }
    const env = { ...process.env };
    delete env.OCX_SERVICE;
    console.log(`Attempting to restart the proxy on port ${bakePort}.`);
    const child = spawn(process.execPath, [launcher, "start", "--port", String(bakePort)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    child.on("error", error => {
      console.error(`opencodex: direct proxy restart failed: ${error.message}`);
    });
    child.unref();
  }

  function refreshBackgroundServiceOrStartDirect() {
    const prevBake = process.env.OCX_BAKE_PORT;
    process.env.OCX_BAKE_PORT = String(bakePort);
    try {
      let svc = spawnSync(process.execPath, serviceRefreshArgs(), { stdio: "inherit", windowsHide: true });
      // `serviceWasInstalled` is inferred from service-state.json alone, which can be
      // STALE — present while the registration is gone. Repair refuses that case by
      // design, and its thrown Error is indistinguishable from any other failure at
      // this layer (plain Error, inherited stdio, generic exit status). So ask for
      // structured state instead of parsing the failure: install only when the
      // diagnostic says the service is genuinely absent. Installing after ANY repair
      // failure would resurrect the elevation prompt this change exists to avoid, and
      // could re-register a service the user just uninstalled.
      if (svc.status !== 0 && readServiceInstalledFromStatus(launcher) === false) {
        console.log("No registered service found — installing it instead.");
        svc = spawnSync(process.execPath, serviceInstallArgs(), { stdio: "inherit", windowsHide: true });
      }
      let needDirectStart = svc.status !== 0;
      if (!needDirectStart) {
        // Exit 0 can still leave stale/missing assets that never bring the proxy
        // back — match the GUI/CLI fallthrough so /healthz is not left dead.
        try {
          const st = spawnSync(process.execPath, [launcher, "status", "--json"], {
            encoding: "utf8",
            timeout: 20_000,
            windowsHide: true,
          });
          if (st.status === 0 && typeof st.stdout === "string" && st.stdout.trim()) {
            const parsed = JSON.parse(st.stdout);
            const proxyUp = parsed?.proxy?.running === true || parsed?.proxy?.health?.ok === true;
            const viable = parsed?.startup?.serviceViable === true;
            if (!proxyUp && !viable) needDirectStart = true;
          } else {
            // status failed or empty — fail closed to direct start (match CLI).
            needDirectStart = true;
          }
        } catch {
          needDirectStart = true;
        }
      }
      if (needDirectStart) {
        // Repair normally avoids elevation for a healthy registration, but a stale Windows
        // scheduler definition can require it. It can also fail — or exit 0 while leaving
        // a non-viable manager. Fall back to a direct detached proxy start so the
        // update never leaves the user without a running proxy.
        console.warn(
          svc.status === 0
            ? "opencodex: service refresh left a non-viable manager — starting the proxy directly instead."
            : "opencodex: service refresh failed — starting the proxy directly instead.",
        );
        console.warn("  Run 'ocx service repair' to see why the background service could not restart.");
        startProxyDirectly();
      }
    } finally {
      if (prevBake === undefined) delete process.env.OCX_BAKE_PORT;
      else process.env.OCX_BAKE_PORT = prevBake;
    }
  }

  // Never replace package files under a live proxy — stop it first (full `ocx stop`
  // semantics: graceful drain, service stop, native Codex restore). Gate on the service
  // and the runtime-port record too: a service-managed or orphaned proxy can be live
  // while ocx.pid is stale/missing.
  if (trayBeforeUpdate.stopBeforeReplacement) {
    console.log("⏹  Handing off the Windows tray before updating...");
    try {
      handoffWindowsTrayForUpdate(trayBeforeUpdate, {
        stop: () => {
          const stopped = runTrayLifecycle(launcher, "stop");
          return { exitStatus: stopped.status, running: trayInstallState().running };
        },
        start: () => runTrayLifecycle(launcher, "start"),
      });
    } catch {
      console.error("opencodex: could not stop the Windows tray; aborting before package replacement.");
      process.exit(1);
    }
  }
  const hasRuntimeState =
    existsSync(join(configDir(), "ocx.pid")) || existsSync(join(configDir(), "runtime-port.json"));

  function recoverStoppedRuntimeAfterFailure() {
    if (serviceWasInstalled) {
      console.warn("opencodex: update failed after stopping the proxy — restoring the previous background service.");
      refreshBackgroundServiceOrStartDirect();
    } else if (hasRuntimeState) {
      console.warn("opencodex: update failed after stopping the proxy — restarting the previous version directly.");
      startProxyDirectly();
    }
  }

  // An outstanding pending-teardown receipt is a fourth reason to run the stop. After a
  // parent crashed mid-deferral the service, pid and runtime records can all be absent
  // while the shared client config still points at a proxy that is gone; installing over
  // that silently skips the recovery the receipt was written to trigger (#3008). Presence
  // is the whole test here — the launcher cannot parse it, and `ocx stop` is what decides
  // whether the obligation is safe to finish.
  const hasPendingTeardown = hasPendingTeardownIn(readdirSync, configDir());
  if (serviceWasInstalled || hasRuntimeState || hasPendingTeardown) {
    console.log("⏹  Stopping the running proxy before updating...");
    const stopRes = spawnSync(process.execPath, [launcher, "stop"], { stdio: "inherit", windowsHide: true });
    const stillHasRuntimeState =
      existsSync(join(configDir(), "ocx.pid")) || existsSync(join(configDir(), "runtime-port.json"));
    // A history-only failure means teardown succeeded and a backup manifest is waiting for
    // review: the proxy is down and replacing package files is safe. Every other nonzero
    // status is a stop that did not finish, and a signal kill (status null) says nothing
    // about whether it did - both abort, because replacing files under a live server
    // leaves it running mixed old and new modules (#3008).
    // The same decision the Bun updater makes, from the same module (#3008). Absent PID and
    // runtime files are weak evidence, so the captured endpoint is asked; "unknown" aborts
    // because a silent listener is exactly the state where replacing files is dangerous.
    const decision = decidePostStopUpdate({
      status: stopRes.status,
      hasRuntimeState: stillHasRuntimeState,
      // Re-checked AFTER the stop: a quarantined receipt lets the stop itself succeed
      // (there is nothing left to stop), so a pre-stop check alone let the retry install
      // over a teardown that never ran.
      teardownOutstanding: hasPendingTeardownIn(readdirSync, configDir()),
      liveness: probeProxyLiveness(bakePort, bakeHostname),
    });
    const historyOnlyStop = decision.reason === "history-only";
    if (!decision.proceed) {
      if (trayBeforeUpdate.restoreOnFailure) runTrayLifecycle(launcher, "start");
      if (decision.reason === "teardown-outstanding") {
        console.error("opencodex: a shared teardown from an earlier stop is still outstanding and needs manual review; aborting the update.");
        console.error("opencodex: confirm no proxy is running, run 'ocx restore', then remove the pending-teardown file in the opencodex home.");
      } else console.error(decision.reason === "proxy-unknown"
        ? `opencodex: could not confirm the proxy on ${bakeHostname}:${bakePort} is stopped; aborting the update. Run 'ocx stop' and retry.`
        : "opencodex: could not stop the running proxy; aborting the update. Run 'ocx stop' and retry.");
      process.exit(1);
    }
    if (historyOnlyStop || historyRestoreIncomplete()) {
      console.warn(
        "opencodex: WARNING — Codex resume-history metadata restore is incomplete (a backup manifest remains).\n" +
        "  The DB may be busy or the manifest/target may need review; untracked routed history is intentionally unchanged.\n" +
        "  After the update: close the Codex app, run 'ocx doctor', then run 'ocx stop' once to retry.",
      );
    }
  }

  // #1942/#1849: stage -> verify -> swap -> rollback instead of installing straight
  // into the live tree. A failure at any point leaves either the old or the new tree
  // complete — never a file-less skeleton. Falls back to the legacy in-place install
  // only when the transactional module cannot run at all.
  const packageDir = resolve(here, "..");
  console.log(`Updating${latest ? ` to v${latest}` : ""} (transactional)...`);
  let res;
  try {
    const tx = transactionalNpmUpdate({
      packageDir,
      pkgName: PKG,
      targetVersion: latest || undefined,
      tag,
      runNpm: (args) => {
        const invocation = npmInvocation(args);
        if (!invocation) return { status: 1 };
        return spawnSync(invocation.file, invocation.args, {
          stdio: "inherit",
          timeout: 180000,
          windowsHide: true,
          ...invocation.options,
        });
      },
      log: (line) => console.log(line),
    });
    if (tx.ok) {
      res = { status: 0 };
    } else if (tx.phase === "stage" || tx.phase === "verify") {
      // Live tree untouched: report and stop. Nothing to roll back.
      console.error(`opencodex: update aborted before touching the live install (${tx.phase}): ${tx.error}`);
      res = { status: 1 };
    } else {
      console.error(`opencodex: update failed (${tx.phase}): ${tx.error}${tx.rolledBack ? " — previous version restored." : ""}`);
      res = { status: 1 };
    }
  } catch (error) {
    // An unexpected throw means we cannot prove the live tree is untouched, so the
    // legacy in-place install (which deletes live first) is exactly the wrong rescue —
    // it recreates the #1849 destruction path. Report and stop; the boot probe and the
    // recovery marker cover the swap-window states.
    console.error(`opencodex: transactional update failed unexpectedly (${error?.message ?? error}). ` +
      `The live install was not knowingly modified; run 'ocx update' again or reinstall with ` +
      `npm install -g --allow-scripts=bun ${PKG}@${tag}.`);
    res = { status: 1 };
  }
  if (res.status === 0) {
    console.log(`\nUpdated${latest ? ` to v${latest}` : ""}.`);
    repairCodexShimIfNeeded();
    if (trayBeforeUpdate.refreshAfterReplacement) {
      const tray = spawnSync(process.execPath, [launcher, ...trayBeforeUpdate.installArgs], {
        stdio: "inherit",
        windowsHide: true,
      });
      if (tray.status !== 0) {
        console.warn("opencodex: Windows tray refresh failed. Run: ocx tray install");
        if (trayBeforeUpdate.restoreOnFailure) runTrayLifecycle(launcher, "start");
      }
    }
    // The stop above unloaded any managed service; refresh via the freshly-installed
    // launcher so the new files write the baked paths and the service restarts.
    if (serviceWasInstalled) {
      console.log("Refreshing the background service with the updated files...");
      refreshBackgroundServiceOrStartDirect();
    } else {
      console.log("Restart the proxy:  ocx start");
    }
    process.exit(0);
  }
  if (trayBeforeUpdate.restoreOnFailure) runTrayLifecycle(launcher, "start");
  recoverStoppedRuntimeAfterFailure();
  console.error(`\nUpdate failed (npm exit ${res.status ?? "?"}). Try manually:  npm install -g --allow-scripts=bun ${PKG}@${tag}`);
  process.exit(1);
}

function bunBinDir() {
  // Resolve the `bun` dependency's directory without hardcoding the platform
  // package — npm's os/cpu/libc resolution already picked the right @oven/bun-*.
  return dirname(require.resolve("bun/package.json"));
}

const BUN_OVERRIDE_ENV = "OPENCODEX_BUN_PATH";
// Mirrors BUN_RUNTIME_SOURCE_ENV in src/lib/bun-runtime.ts. This launcher is plain
// Node and runs before any TypeScript is loaded, so the name is repeated rather than
// imported; tests/ocx-launcher-source.test.ts pins the two together.
const BUN_RUNTIME_SOURCE_ENV = "OCX_BUN_RUNTIME_SOURCE";
const BUN_RUNTIME_PATH_ENV = "OCX_BUN_RUNTIME_PATH";

function findBunBinary(bunDir) {
  // The npm `bun` package ships the binary as bin/bun.exe on every platform;
  // probe bin/bun too for forward compatibility.
  for (const name of ["bun.exe", "bun"]) {
    const p = join(bunDir, "bin", name);
    if (isRealBunBinary(p)) return p;
  }
  return null;
}

function fail(msg) {
  console.error(
    `opencodex: ${msg}\n` +
      "The bundled Bun runtime could not be prepared. This usually means the\n" +
      "install skipped lifecycle scripts (e.g. npm blocked bun's postinstall\n" +
      "under allowScripts) or optional dependencies. Reinstall with:\n" +
      "  npm install -g --allow-scripts=bun @bitkyc08/opencodex\n" +
      "(use sudo if the original install used sudo; without --ignore-scripts\n" +
      "and without --omit=optional / optional=false)"
  );
  process.exit(1);
}

function resolveBun({ allowInstall = true } = {}) {
  // Keep direct npm-launcher starts aligned with durable service/shim installs:
  // a valid explicit runtime must win even when the bundled dependency exists.
  const override = process.env[BUN_OVERRIDE_ENV]?.trim();
  if (override) {
    const overridePath = resolve(override);
    if (isRealBunBinary(overridePath)) return { path: overridePath, source: "override" };
    console.error(
      `opencodex: ${BUN_OVERRIDE_ENV} is missing, unreadable, or not a complete Bun binary; falling back to the bundled runtime.`,
    );
  }

  let bunDir;
  try {
    bunDir = bunBinDir();
  } catch {
    fail("the `bun` dependency is not installed.");
  }

  let bin = findBunBinary(bunDir);
  if (bin) return { path: bin, source: "bundled" };

  // Lazy fallback: --ignore-scripts (or a failed postinstall) leaves the
  // ~450-byte placeholder stub. Run the bun package's own installer once.
  const installJs = join(bunDir, "install.js");
  if (allowInstall && existsSync(installJs)) {
    const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });
    if (r.status === 0) bin = findBunBinary(bunDir);
  }
  if (!bin) fail("Bun binary missing after install attempt.");
  return { path: bin, source: "bundled" };
}

// `ocx update --help` prints usage and exits WITHOUT side effects. The npm launcher
// intercepts `update` before the Bun CLI starts, so the help short-circuit must live
// here too — otherwise --help runs the real self-update, stops the proxy, and drops
// in-flight routed streams (issue #168).
const updateHelpRequested = process.argv[2] === "update" &&
  process.argv.slice(3).some(a => a === "--help" || a === "-h" || a === "help");
if (updateHelpRequested) {
  console.log("Usage: ocx update [--tag latest|preview]\n\nUpdate opencodex. Preview installs stay on the preview tag unless overridden.");
  process.exit(0);
}

const codexCliUpdateInspection = isCodexCliUpdateInspectionArgv(process.argv);
if (codexCliUpdateInspection && typeof process.versions.bun === "string") {
  console.error("opencodex: codex-cli-update inspection must use the published Node launcher.");
  process.exit(1);
}

if (process.argv[2] === "update" && isNodeModulesInstall() && !isBunGlobalInstall()) {
  runNpmSelfUpdate();
}

// #1849 boot probe: a prior update that lost power (or double-faulted) mid-swap leaves a
// backup sibling and a broken live tree. Restore before anything tries to run from the
// broken tree; reap stale backups once the live tree verifies healthy.
if (!codexCliUpdateInspection && isNodeModulesInstall() && !isBunGlobalInstall()) {
  try {
    const probe = bootRestoreProbe(resolve(here, ".."));
    if (probe.action === "restored") {
      console.warn(`opencodex: previous update left a broken install — restored the backup from ${probe.from}.`);
    } else if (probe.action === "failed") {
      console.warn(`opencodex: a backup from a failed update exists but could not be restored automatically: ${probe.error}`);
    }
  } catch { /* the probe must never block launch */ }
}

const bunRuntime = resolveBun({ allowInstall: !codexCliUpdateInspection });
const bun = bunRuntime.path;

// Run the Bun child asynchronously and FORWARD termination signals to it, then wait
// for its graceful shutdown before this launcher exits. The previous blocking
// spawnSync() could not run JS signal handlers and did not forward signals, so a
// signal delivered only to this launcher (Codex app, IDE terminal, service wrapper,
// or `kill -INT <launcherPid>`) killed the launcher and ORPHANED the Bun proxy —
// port left bound, pid/runtime-port files left behind, Codex config not restored.
//
// Provenance seam for issue #701: THIS launcher runs under Node, which does not
// auto-load a project `.env`/`.env.local`; the Bun child does, before any opencodex
// code evaluates. So this is the last point that can still tell a real shell export
// from a working-directory dotenv value, and we record which Anthropic credential or
// destination slots already existed. The context is paired with a random proof carried
// in argv, which project dotenv cannot modify during an ordinary `ocx` invocation.
// `src/cli/claude.ts` treats anything present in the Bun child but missing from this
// list as ambient project pollution rather than user auth or destination,
// which stopped a project dotenv from silently moving a claude.ai subscriber onto API
// billing and prevents it from redirecting the subscriber's OAuth bearer.
// Disabling Bun's dotenv wholesale with --no-env-file is NOT an option: config
// interpolation and provider settings legitimately read the project environment.
const preBunAnthropicSlots = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
  .filter(name => typeof process.env[name] === "string" && process.env[name] !== "");
// A configured CODEX_CLI_PATH may legitimately be cwd-relative (`./tools/codex`), which the
// ordinary runtime resolver accepts. Inspection only trusts absolute local paths, so capture
// the absolute form here, in the launcher, while the original cwd is still authoritative;
// resolving it later would silently reinterpret it against a different working directory.
//
// A bare command with no separator (`codex`) is NOT a relative path: the runtime resolver
// deliberately hands those to executable lookup along PATH. Rewriting it to `<cwd>/codex`
// would make the inspector treat it as an explicit path and stop searching PATH entirely.
const configuredCodexCliPath = typeof process.env.CODEX_CLI_PATH === "string" && process.env.CODEX_CLI_PATH !== ""
  ? process.env.CODEX_CLI_PATH
  : null;
const preBunCodexCliPath = configuredCodexCliPath !== null
    && (configuredCodexCliPath.includes("/") || configuredCodexCliPath.includes("\\") || /^[A-Za-z]:/.test(configuredCodexCliPath))
  ? resolve(configuredCodexCliPath)
  : configuredCodexCliPath;
const preBunPath = typeof process.env.PATH === "string" ? process.env.PATH : null;
const preBunPathExt = typeof process.env.PATHEXT === "string" ? process.env.PATHEXT : null;
const preBunCodexCliManagerRoots = Object.fromEntries(
  CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS.flatMap(name => {
    const value = process.env[name];
    return typeof value === "string" && value !== "" ? [[name, value]] : [];
  }),
);
const launchProof = randomBytes(32).toString("base64url");
const launchContext = JSON.stringify({
  version: 1,
  proof: launchProof,
  anthropicEnvSlots: preBunAnthropicSlots,
  codexCliInspectionEnv: codexCliUpdateInspection ? {
    codexCliPath: preBunCodexCliPath,
    path: preBunPath,
    pathExt: preBunPathExt,
    managerRoots: preBunCodexCliManagerRoots,
    configDir: configDir(),
  } : null,
});
// The inspection snapshot above already carries PATH, PATHEXT, and the manager-root slots as
// proof-bound values, and `inspectCodexCliInstall` reads them from that snapshot rather than
// from the live environment. Inheriting them again would spend the 32,767-character Windows
// environment block twice, so a large-but-valid shell environment could stop the Bun child
// from spawning and fail the command before it reports anything. Drop the duplicates for the
// one-shot inspection launch only; every other launch inherits the environment unchanged.
// Windows environment names are case-insensitive, but this spread produces an ordinary
// case-sensitive object, and a real Windows environment commonly spells the variable `Path`.
// Deleting only the canonical upper-case spelling would silently leave that copy behind and
// reintroduce the duplication this block exists to prevent, so match on the lowercase form.
const inheritedEnv = { ...process.env };
if (codexCliUpdateInspection) {
  const snapshotted = new Set(
    ["PATH", "PATHEXT", ...CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS].map(name => name.toLowerCase()),
  );
  for (const name of Object.keys(inheritedEnv)) {
    if (snapshotted.has(name.toLowerCase())) delete inheritedEnv[name];
  }
}
const child = spawn(bun, [cliPath, `${NODE_LAUNCH_PROOF_PREFIX}${launchProof}`, ...process.argv.slice(2)], {
  stdio: "inherit",
  // A headless Windows parent (Task Scheduler, dashboard restart, shortcut) has no
  // console to inherit. Without this flag Windows allocates a visible console for
  // the long-running Bun child, and closing that window kills the proxy (#1236).
  windowsHide: true,
  env: {
    ...inheritedEnv,
    [NODE_LAUNCH_CONTEXT_ENV]: launchContext,
    [BUN_RUNTIME_SOURCE_ENV]: bunRuntime.source,
    [BUN_RUNTIME_PATH_ENV]: bunRuntime.path,
  },
});

// Windows has no real POSIX signals (no SIGHUP); forwarding is best-effort there.
const FORWARDED = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const handlers = FORWARDED.map(sig => {
  const handler = () => {
    try {
      child.kill(sig);
    } catch {
      /* child already exited */
    }
  };
  process.on(sig, handler);
  return [sig, handler];
});
const clearHandlers = () => {
  for (const [sig, handler] of handlers) process.removeListener(sig, handler);
};

child.on("error", err => {
  clearHandlers();
  console.error(`opencodex: failed to launch Bun runtime: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearHandlers();
  // Mirror the child's terminating signal/exit code so this launcher's status matches.
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
