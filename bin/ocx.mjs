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
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@bitkyc08/opencodex";
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli", "index.ts");

function isNodeModulesInstall() {
  return here.split(/[\\/]/).includes("node_modules");
}

function isBunGlobalInstall() {
  return /[\\/]\.bun[\\/]/.test(here);
}

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
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

function runNpmSelfUpdate() {
  const current = currentPackageVersion();
  const tag = updateTag(current);
  const npm = npmBin();
  // Node ≥18.20/20.12 refuses to spawn .cmd/.bat without a shell (CVE-2024-27980
  // hardening) — spawning "npm.cmd" shell-less throws EINVAL on Windows.
  const winShell = process.platform === "win32";
  const latestResult = spawnSync(npm, ["view", `${PKG}@${tag}`, "version"], {
    encoding: "utf8",
    timeout: 12000,
    windowsHide: true,
    shell: winShell,
  });
  const latest = latestResult.status === 0 ? latestResult.stdout.trim() : "";

  console.log(`opencodex v${current} (installed via npm, tag ${tag})`);
  if (latest && latest === current) {
    console.log(`Already on the latest ${tag} version (v${latest}).`);
    process.exit(0);
  }

  // Remember whether a background service manages the proxy BEFORE stopping — `ocx stop`
  // unloads it permanently, so a successful update must reinstall it afterwards.
  const serviceStatePath = join(configDir(), "service-state.json");
  const serviceWasInstalled = existsSync(serviceStatePath);
  /** Read the backend from service-state.json so the update reinstalls the same one. */
  function serviceReinstallArgs() {
    try {
      const state = JSON.parse(readFileSync(serviceStatePath, "utf8"));
      if (state.backend === "native") return [launcher, "service", "install", "--native"];
    } catch { /* missing or corrupt — fall through to default */ }
    return [launcher, "service", "install"];
  }

  // Capture listen target before stop clears runtime-port.json (mirrors GUI/CLI update worker).
  // Do not treat a live runtime port of 10100 as "missing" — track whether the read succeeded.
  let bakePort = 10100;
  let sawRuntimePort = false;
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
        sawRuntimePort = true;
      }
    }
  } catch { /* fall through to config */ }
  if (!sawRuntimePort) {
    try {
      const cfg = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"));
      if (Number.isFinite(cfg?.port) && cfg.port > 0 && cfg.port <= 65535) bakePort = Math.trunc(cfg.port);
    } catch { /* keep default */ }
  }

  // Never replace package files under a live proxy — stop it first (full `ocx stop`
  // semantics: graceful drain, service stop, native Codex restore). Gate on the service
  // and the runtime-port record too: a service-managed or orphaned proxy can be live
  // while ocx.pid is stale/missing.
  const launcher = fileURLToPath(import.meta.url);
  const hasRuntimeState =
    existsSync(join(configDir(), "ocx.pid")) || existsSync(join(configDir(), "runtime-port.json"));
  if (serviceWasInstalled || hasRuntimeState) {
    console.log("⏹  Stopping the running proxy before updating...");
    const stopRes = spawnSync(process.execPath, [launcher, "stop"], { stdio: "inherit", windowsHide: true });
    const stillHasRuntimeState =
      existsSync(join(configDir(), "ocx.pid")) || existsSync(join(configDir(), "runtime-port.json"));
    if (stopRes.status !== 0 || stillHasRuntimeState) {
      console.error("opencodex: could not stop the running proxy; aborting the update. Run 'ocx stop' and retry.");
      process.exit(1);
    }
    if (historyRestoreIncomplete()) {
      console.warn(
        "opencodex: WARNING — Codex resume history was NOT restored (history DB locked; Codex app/IDE open?).\n" +
        "  Routed threads stay hidden in the native Codex app until restored.\n" +
        "  After the update: close the Codex app, then run 'ocx stop' once to restore.",
      );
    }
  }

  console.log(`Updating${latest ? ` to v${latest}` : ""}...\n$ ${npm} install -g ${PKG}@${tag}`);
  const res = spawnSync(npm, ["install", "-g", `${PKG}@${tag}`], {
    stdio: "inherit",
    timeout: 180000,
    windowsHide: true,
    shell: winShell,
  });
  if (res.status === 0) {
    console.log(`\nUpdated${latest ? ` to v${latest}` : ""}.`);
    repairCodexShimIfNeeded();
    // The stop above unloaded any managed service; reinstall via the freshly-installed
    // launcher so the new files write the baked paths and the service restarts.
    if (serviceWasInstalled) {
      console.log("Reinstalling the background service with the updated files...");
      const prevBake = process.env.OCX_BAKE_PORT;
      process.env.OCX_BAKE_PORT = String(bakePort);
      try {
        const svcArgs = serviceReinstallArgs();
        const svc = spawnSync(process.execPath, svcArgs, { stdio: "inherit", windowsHide: true });
        if (svc.status !== 0) console.warn("opencodex: service refresh failed — run 'ocx service install' manually.");
      } finally {
        if (prevBake === undefined) delete process.env.OCX_BAKE_PORT;
        else process.env.OCX_BAKE_PORT = prevBake;
      }
    } else {
      console.log("Restart the proxy:  ocx start");
    }
    process.exit(0);
  }
  console.error(`\nUpdate failed (${npm} exit ${res.status ?? "?"}). Try manually:  ${npm} install -g ${PKG}@${tag}`);
  process.exit(1);
}

function bunBinDir() {
  // Resolve the `bun` dependency's directory without hardcoding the platform
  // package — npm's os/cpu/libc resolution already picked the right @oven/bun-*.
  return dirname(require.resolve("bun/package.json"));
}

// The `bun` package ships a tiny ASCII placeholder at bin/bun.exe until its
// postinstall downloads the real ~60MB binary. --ignore-scripts / pnpm leave
// the ~450-byte stub in place, which is NOT executable (ENOEXEC). A size gate
// cleanly distinguishes the stub from a real binary on every platform.
const REAL_BUN_MIN_BYTES = 1_000_000;

function findBunBinary(bunDir) {
  // The npm `bun` package ships the binary as bin/bun.exe on every platform;
  // probe bin/bun too for forward compatibility.
  for (const name of ["bun.exe", "bun"]) {
    const p = join(bunDir, "bin", name);
    if (existsSync(p) && statSync(p).size >= REAL_BUN_MIN_BYTES) return p;
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

function resolveBun() {
  let bunDir;
  try {
    bunDir = bunBinDir();
  } catch {
    fail("the `bun` dependency is not installed.");
  }

  let bin = findBunBinary(bunDir);
  if (bin) return bin;

  // Lazy fallback: --ignore-scripts (or a failed postinstall) leaves the
  // ~450-byte placeholder stub. Run the bun package's own installer once.
  const installJs = join(bunDir, "install.js");
  if (existsSync(installJs)) {
    const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });
    if (r.status === 0) bin = findBunBinary(bunDir);
  }
  if (!bin) fail("Bun binary missing after install attempt.");
  return bin;
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

if (process.argv[2] === "update" && isNodeModulesInstall() && !isBunGlobalInstall()) {
  runNpmSelfUpdate();
}

const bun = resolveBun();

// Run the Bun child asynchronously and FORWARD termination signals to it, then wait
// for its graceful shutdown before this launcher exits. The previous blocking
// spawnSync() could not run JS signal handlers and did not forward signals, so a
// signal delivered only to this launcher (Codex app, IDE terminal, service wrapper,
// or `kill -INT <launcherPid>`) killed the launcher and ORPHANED the Bun proxy —
// port left bound, pid/runtime-port files left behind, Codex config not restored.
const child = spawn(bun, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });

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
