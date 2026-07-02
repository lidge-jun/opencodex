import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readPid } from "./config";

export const PKG = "@bitkyc08/opencodex";
const HERE = dirname(fileURLToPath(import.meta.url)); // .../opencodex/src

export type Installer = "bun" | "npm" | "source";
export type Channel = "latest" | "preview";

/** Infer how opencodex is installed from the running module's path. */
export function detectInstall(): Installer {
  if (!HERE.includes("node_modules")) return "source"; // a git checkout, not a global install
  return HERE.includes(".bun") ? "bun" : "npm";
}

export function currentVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version as string) ?? "?";
  } catch {
    return "?";
  }
}

export function updateTag(current: string): Channel {
  const tagIndex = process.argv.indexOf("--tag");
  const explicit = tagIndex !== -1 ? process.argv[tagIndex + 1] : undefined;
  if (explicit === "preview" || explicit === "latest") return explicit;
  return current.includes("-preview.") ? "preview" : "latest";
}

/**
 * npm is `npm.cmd` on Windows, and Node/Bun refuse shell-less .cmd spawns
 * (CVE-2024-27980 hardening) — route Windows npm invocations through the shell.
 */
function npmSpawnTarget(bin: string): { bin: string; shell: boolean } {
  if (process.platform !== "win32" || bin !== "npm") return { bin, shell: false };
  return { bin: "npm.cmd", shell: true };
}

/** Latest published version from the registry (best-effort; null if npm isn't available). */
export function latestVersion(tag: string): string | null {
  const npm = npmSpawnTarget("npm");
  const r = spawnSync(npm.bin, ["view", `${PKG}@${tag}`, "version"], { encoding: "utf8", timeout: 12000, windowsHide: true, shell: npm.shell });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The global-install command opencodex would run to update on this channel. */
export function updateCommand(installer: Installer, tag: Channel): { bin: string; args: string[] } {
  const bin = installer === "bun" ? "bun" : "npm";
  const args = installer === "bun"
    ? ["add", "-g", `${PKG}@${tag}`]
    : ["install", "-g", `${PKG}@${tag}`];
  return { bin, args };
}

/** Human-readable form of {@link updateCommand}, used in the update prompt label. */
export function updateCommandStr(installer: Installer, tag: Channel): string {
  const { bin, args } = updateCommand(installer, tag);
  return `${bin} ${args.join(" ")}`;
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

  // Remember whether a background service manages the proxy BEFORE stopping — `ocx stop`
  // unloads it permanently, so a successful update must reinstall/restart it afterwards.
  let serviceWasInstalled = false;
  try {
    const { isServiceInstalled } = await import("./service");
    serviceWasInstalled = isServiceInstalled();
  } catch { /* best-effort */ }

  // Never replace package files under a live proxy: the running server dynamic-imports
  // modules after startup, so an in-place update leaves it executing mixed old/new code.
  // Full `ocx stop` semantics (graceful drain, service stop, native Codex restore).
  if (readPid()) {
    console.log("⏹  Stopping the running proxy before updating...");
    const stop = spawnSync(process.execPath, [process.argv[1], "stop"], { stdio: "inherit", windowsHide: true });
    if (stop.status !== 0 || readPid()) {
      console.error("⚠️  Could not stop the running proxy; aborting the update. Run 'ocx stop' and retry.");
      process.exit(1);
    }
  }

  const { bin, args: cmdArgs } = updateCommand(installer, tag);
  console.log(`Updating${latest ? ` to v${latest}` : ""}…\n$ ${bin} ${cmdArgs.join(" ")}`);

  const target = npmSpawnTarget(bin);
  const r = spawnSync(target.bin, cmdArgs, { stdio: "inherit", timeout: 180000, windowsHide: true, shell: target.shell });
  if (r.status === 0) {
    console.log(`\n✅ Updated${latest ? ` to v${latest}` : ""}.`);
    // Re-bake the bundled Bun path into the Codex autostart shim on every
    // platform when one is installed (refresh-only; never installs fresh).
    try {
      const { isCodexShimInstalled, installCodexShim } = await import("./codex-shim");
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
      const svc = spawnSync(process.execPath, [process.argv[1], "service", "install"], { stdio: "inherit", windowsHide: true });
      if (svc.status !== 0) console.warn("⚠️  Service refresh failed — run 'ocx service install' manually.");
    } else {
      console.log("Restart the proxy:  ocx start");
    }
  } else {
    console.error(`\n⚠️  Update failed (${bin} exit ${r.status ?? "?"}). Try manually:  ${bin} ${cmdArgs.join(" ")}`);
    process.exit(1);
  }
}
