import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG = "@bitkyc08/opencodex";
const HERE = dirname(fileURLToPath(import.meta.url)); // .../opencodex/src

type Installer = "bun" | "npm" | "source";

/** Infer how opencodex is installed from the running module's path. */
function detectInstall(): Installer {
  if (!HERE.includes("node_modules")) return "source"; // a git checkout, not a global install
  return HERE.includes(".bun") ? "bun" : "npm";
}

function currentVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version as string) ?? "?";
  } catch {
    return "?";
  }
}

/** Latest published version from the registry (best-effort; null if npm isn't available). */
function latestVersion(): string | null {
  const r = spawnSync("npm", ["view", PKG, "version"], { encoding: "utf8", timeout: 12000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * `ocx update` — self-update opencodex to the latest published version, using the same package
 * manager it was installed with (bun or npm global). A source checkout is told to `git pull` instead.
 */
export function runUpdate(): void {
  const installer = detectInstall();
  const current = currentVersion();
  console.log(`opencodex v${current} (installed via ${installer})`);

  if (installer === "source") {
    console.log("Running from a source checkout — update with:  git pull && bun install");
    return;
  }

  const latest = latestVersion();
  if (latest && latest === current) {
    console.log(`Already on the latest version (v${latest}).`);
    return;
  }

  const bin = installer === "bun" ? "bun" : "npm";
  const cmdArgs = installer === "bun"
    ? ["add", "-g", `${PKG}@latest`]
    : ["install", "-g", `${PKG}@latest`];
  console.log(`Updating${latest ? ` to v${latest}` : ""}…\n$ ${bin} ${cmdArgs.join(" ")}`);

  const r = spawnSync(bin, cmdArgs, { stdio: "inherit", timeout: 180000, windowsHide: true });
  if (r.status === 0) {
    console.log(`\n✅ Updated${latest ? ` to v${latest}` : ""}. Restart the proxy:  ocx stop && ocx start`);
  } else {
    console.error(`\n⚠️  Update failed (${bin} exit ${r.status ?? "?"}). Try manually:  ${bin} ${cmdArgs.join(" ")}`);
    process.exit(1);
  }
}
