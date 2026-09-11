/**
 * Locate the Devin CLI.
 *
 * The official installer (`curl -fsSL https://cli.devin.ai/install.sh | bash`)
 * and the Homebrew cask both drop the binary in one of a small set of places.
 * The environment override comes first so an operator can point at a specific
 * build without touching PATH, and PATH is the last resort rather than the
 * first so a shadowed name cannot silently win.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

export const DEVIN_CLI_BIN_ENV = "OPENCODEX_DEVIN_CLI_BIN";

export const DEVIN_CLI_INSTALL_HINT =
  "Install the Devin CLI with `curl -fsSL https://cli.devin.ai/install.sh | bash` or `brew install --cask devin-cli`, then run `devin auth login`.";

let cached: string | undefined;

/** Reset the discovery cache (tests, or an explicit re-check after an install). */
export function clearDevinCliBinaryCache(): void {
  cached = undefined;
}

function candidatePaths(home: string): string[] {
  return [
    join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", "devin.exe"),
    join(home, ".local", "share", "devin", "bin", "devin"),
    join(home, ".devin", "bin", "devin"),
    join(home, ".local", "bin", "devin"),
    "/opt/homebrew/bin/devin",
    "/usr/local/bin/devin",
    "/usr/bin/devin",
  ];
}

function fromPath(exists: (p: string) => boolean): string | undefined {
  const pathVar = process.env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const name of ["devin", "devin.exe"]) {
      const full = join(dir, name);
      if (exists(full)) return full;
    }
  }
  return undefined;
}

/**
 * Resolve the executable, or undefined when it is not installed.
 *
 * `exists` and `home` are seams so the resolution order can be tested without
 * depending on what happens to be installed on the machine running the tests.
 */
export function resolveDevinCliBinary(opts?: { exists?: (p: string) => boolean; home?: string; useCache?: boolean }): string | undefined {
  const exists = opts?.exists ?? existsSync;
  const useCache = opts?.useCache ?? opts === undefined;
  if (useCache && cached) return cached;
  const override = process.env[DEVIN_CLI_BIN_ENV]?.trim();
  if (override) {
    if (useCache) cached = override;
    return override;
  }
  const home = opts?.home ?? homedir();
  const found = candidatePaths(home).find((p) => exists(p)) ?? fromPath(exists);
  if (found && useCache) cached = found;
  return found;
}
