import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getConfigDir, loadConfig, readPid, readRuntimePort } from "../config";

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

/**
 * npm is `npm.cmd` on Windows, and Node/Bun refuse shell-less .cmd spawns
 * (CVE-2024-27980 hardening) — route Windows npm invocations through the shell.
 */
function npmSpawnTarget(bin: string): { bin: string; shell: boolean } {
  if (process.platform !== "win32" || bin !== "npm") return { bin, shell: false };
  return { bin: "npm.cmd", shell: true };
}

/**
 * The GUI update worker sets OCX_SERVICE=1 and has stdio ignored — inheriting that for
 * `npm.cmd` (shell:true) opens stacked visible consoles on Windows. Pipe instead and
 * relay bounded output after the child exits. (Ported from PR #167.)
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
  const npm = npmSpawnTarget("npm");
  const r = spawnSync(npm.bin, ["view", `${PKG}@${tag}`, "version"], { encoding: "utf8", timeout: 12000, windowsHide: true, shell: npm.shell });
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
  const npm = npmSpawnTarget("npm");
  const r = spawn(
    npm.bin,
    ["view", `${PKG}@${version}`, "dist.integrity"],
    { encoding: "utf8", timeout: 12000, windowsHide: true, shell: npm.shell },
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

  // Remember whether a background service manages the proxy BEFORE stopping — `ocx stop`
  // unloads it permanently, so a successful update must reinstall/restart it afterwards.
  let serviceWasInstalled = false;
  try {
    const { isServiceInstalled } = await import("../service");
    serviceWasInstalled = isServiceInstalled();
  } catch { /* best-effort */ }

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
  };

  // Never replace package files under a live proxy: the running server dynamic-imports
  // modules after startup, so an in-place update leaves it executing mixed old/new code.
  // Gate on the service and the runtime-port record too, not just the pid file — a
  // service-managed or orphaned proxy can be live while ocx.pid is stale/missing.
  // Full `ocx stop` semantics (drain, service stop, restore).
  if (serviceWasInstalled || readPid() || readRuntimePort()) {
    console.log("⏹  Stopping the running proxy before updating...");
    const stopStdio = updateChildStdio();
    const stop = spawnSync(process.execPath, [process.argv[1], "stop"], {
      stdio: stopStdio,
      encoding: stopStdio === "pipe" ? "utf8" : undefined,
      windowsHide: true,
    });
    if (stopStdio === "pipe") logSpawnOutput("", stop);
    if (stop.status !== 0 || readPid() || readRuntimePort()) {
      console.error("⚠️  Could not stop the running proxy; aborting the update. Run 'ocx stop' and retry.");
      process.exit(1);
    }
    if (historyRestoreIncomplete()) {
      console.warn(
        "⚠️  Codex resume history was NOT restored (history DB locked — Codex app/IDE open?).\n" +
        "    Your routed threads stay hidden in the native Codex app until restored.\n" +
        "    After the update: close the Codex app, then run 'ocx stop' once to restore.",
      );
    }
  }

  const { bin, args: cmdArgs } = updateCommand(installer, tag, latest);
  console.log(`Updating${latest ? ` to v${latest}` : ""}…\n$ ${bin} ${cmdArgs.join(" ")}`);

  const target = npmSpawnTarget(bin);
  const installStdio = updateChildStdio();
  const r = spawnSync(target.bin, cmdArgs, {
    stdio: installStdio,
    encoding: installStdio === "pipe" ? "utf8" : undefined,
    timeout: 180000,
    windowsHide: true,
    shell: target.shell,
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
    // The stop above unloaded any managed service; reinstall it with the NEW files
    // (spawn the fresh cli.ts so updated code writes the baked paths) so a
    // launchd/schtasks/systemd user isn't left with the background proxy down.
    if (serviceWasInstalled) {
      console.log("🔁 Reinstalling the background service with the updated files...");
      const { serviceReinstallArgs } = await import("../service");
      const { waitForPortAvailable } = await import("../server/ports");
      const freed = await waitForPortAvailable(capturedListen.port, capturedListen.hostname, {
        timeoutMs: 5_000,
        intervalMs: 25,
      });
      if (!freed) console.warn(`⚠️  Port ${capturedListen.port} still busy; reinstalling with pinned --port anyway.`);
      const prevBake = process.env.OCX_BAKE_PORT;
      process.env.OCX_BAKE_PORT = String(capturedListen.port);
      try {
        const svcStdio = updateChildStdio();
        const svc = spawnSync(process.execPath, [process.argv[1], ...serviceReinstallArgs()], {
          stdio: svcStdio,
          encoding: svcStdio === "pipe" ? "utf8" : undefined,
          windowsHide: true,
        });
        if (svcStdio === "pipe") logSpawnOutput("", svc);
        if (svc.status !== 0) {
          // On Windows, schtasks /create requires elevation. The CLI inherits the
          // user's (non-admin) token, so the service reinstall can fail with access
          // denied. Fall back to a direct detached proxy start so the update never
          // leaves the user without a running proxy.
          console.warn("⚠️  Service refresh failed — starting the proxy directly instead.");
          console.warn("   Run 'ocx service install' as administrator to refresh the background service.");
          const env = { ...process.env };
          delete env.OCX_SERVICE;
          const child = spawn(process.execPath, [process.argv[1], "start", "--port", String(capturedListen.port)], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env,
          });
          child.unref();
          console.log(`✅ Proxy starting on port ${capturedListen.port}.`);
        }
      } finally {
        if (prevBake === undefined) delete process.env.OCX_BAKE_PORT;
        else process.env.OCX_BAKE_PORT = prevBake;
      }
    } else {
      console.log("Restart the proxy:  ocx start");
    }
  } else {
    console.error(`\n⚠️  Update failed (${bin} exit ${r.status ?? "?"}). Try manually:  ${bin} ${cmdArgs.join(" ")}`);
    process.exit(1);
  }
}
