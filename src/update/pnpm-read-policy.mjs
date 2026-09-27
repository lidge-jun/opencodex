import { mkdtempSync, lstatSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read probes never inherit the caller's project as their working directory. */
export const PNPM_READ_CWD = dirname(fileURLToPath(import.meta.url));
const MUTATIONS = new Set(["add", "install", "update", "remove", "uninstall"]);

/** Run a synchronous pnpm mutation outside the package, in a private workspace boundary. */
export function withPnpmCommandCwd(args, run) {
  if (!MUTATIONS.has(args?.[0])) return run(PNPM_READ_CWD);
  const cwd = mkdtempSync(join(tmpdir(), "ocx-pnpm-command-"));
  const created = lstatSync(cwd);
  const files = ["pnpm-workspace.yaml", ".npmrc"];
  try {
    // Stop discovery at our own workspace, rather than inheriting a shared /tmp workspace.
    writeFileSync(join(cwd, files[0]), "packages: []\nignorePnpmfile: true\n", { flag: "wx", mode: 0o600 });
    writeFileSync(join(cwd, files[1]), "ignore-pnpmfile=true\n", { flag: "wx", mode: 0o600 });
    return run(cwd);
  } finally {
    try {
      const now = lstatSync(cwd);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== created.dev || now.ino !== created.ino) {
        throw new Error("temporary directory identity changed");
      }
      // Never recursively remove pnpm-created or replacement contents.
      for (const name of files) {
        try { unlinkSync(join(cwd, name)); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      rmdirSync(cwd);
    } catch {
      console.warn("[opencodex] Temporary pnpm workspace cleanup was incomplete; retained for inspection.");
    }
  }
}

/** pnpm 11 uses pnpm_config_ while earlier versions use npm_config_. */
export function pnpmReadEnvironment(env = process.env) {
  const ignored = new Set(["npm_config_ignore_pnpmfile", "pnpm_config_ignore_pnpmfile"]);
  const isolated = Object.fromEntries(Object.entries(env).filter(([key]) => !ignored.has(key.toLowerCase())));
  return { ...isolated, npm_config_ignore_pnpmfile: "true", pnpm_config_ignore_pnpmfile: "true" };
}
