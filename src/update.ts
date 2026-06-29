import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

/** Latest published version from the registry (best-effort; null if npm isn't available). */
export function latestVersion(tag: string): string | null {
  const r = spawnSync("npm", ["view", `${PKG}@${tag}`, "version"], { encoding: "utf8", timeout: 12000, windowsHide: true });
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

  const { bin, args: cmdArgs } = updateCommand(installer, tag);
  console.log(`Updating${latest ? ` to v${latest}` : ""}…\n$ ${bin} ${cmdArgs.join(" ")}`);

  const r = spawnSync(bin, cmdArgs, { stdio: "inherit", timeout: 180000, windowsHide: true });
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
    // The launchd/systemd/Task Scheduler service bakes an absolute Bun path;
    // advise refreshing it (reinstall is heavier, so we don't auto-run it).
    try {
      const { isServiceInstalled } = await import("./service");
      if (isServiceInstalled()) console.log("Service detected — refresh its baked path:  ocx service install");
    } catch { /* best-effort advisory */ }
    console.log("Restart the proxy:  ocx stop && ocx start");
  } else {
    console.error(`\n⚠️  Update failed (${bin} exit ${r.status ?? "?"}). Try manually:  ${bin} ${cmdArgs.join(" ")}`);
    process.exit(1);
  }
}
