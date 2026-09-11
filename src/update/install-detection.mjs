import { realpathSync } from "node:fs";

/**
 * Infer the package manager from the path of the running package.
 *
 * PATH is deliberately not consulted here. A machine can have npm, pnpm, and Bun
 * installed at the same time; the package layout is the evidence of which manager owns
 * the files that the updater must change. The legacy `global/<version>` spelling is only
 * accepted when the adjacent filesystem metadata also looks like a pnpm global group.
 *
 * The real path is considered in addition to the spelling visible to the module loader.
 * This matters when Node is launched with preserved symlinks: a pnpm package can be
 * exposed through an npm-looking prefix while its target is still under pnpm's global
 * virtual store.
 */
export function detectInstallFromPath(packagePath, deps = {}) {
  const exists = deps.exists;
  const candidates = [String(packagePath)];
  try {
    const resolved = (deps.realpath ?? realpathSync)(String(packagePath));
    if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
  } catch {
    // Synthetic paths in source-level checks, and a partially removed install, have no
    // realpath. The lexical path still carries the evidence when it is available.
  }

  let sawNodeModules = false;
  for (const candidate of candidates) {
    const detected = detectInstallCandidate(candidate, exists);
    if (detected === "pnpm" || detected === "bun") return detected;
    if (detected === "npm") sawNodeModules = true;
  }
  return sawNodeModules ? "npm" : "source";
}

function detectInstallCandidate(packagePath, exists) {
  const normalized = String(packagePath).replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  // Windows paths are case-insensitive. Treating the structural marker this way also
  // keeps a preserved-symlink path from being downgraded merely because its casing came
  // from a Windows API or a user-created junction.
  if (!segments.some(segment => segment.toLowerCase() === "node_modules")) return "source";

  // Strong signatures survive normal symlink resolution: the v10 isolated virtual store
  // and v11 global virtual store are both manager-owned paths. Do not classify an arbitrary
  // npm prefix such as `/opt/global/v11` from its directory name alone.
  if (
    /(?:^|\/)node_modules\/\.pnpm(?:\/|$)/i.test(normalized)
    || /(?:^|\/)store\/v\d+\/links(?:\/|$)/i.test(normalized)
  ) return "pnpm";

  // `--preserve-symlinks` can leave a v10/v11 group path visible. Corroborate it with the
  // group's virtual store or the v11 global store before selecting pnpm.
  const globalMatch = normalized.match(/^(.*\/global\/(?:v)?\d+)(?:\/[^/]+)*\/node_modules(?:\/|$)/i);
  if (globalMatch && exists) {
    const globalRoot = globalMatch[1];
    const groupRoot = normalized.slice(0, normalized.toLowerCase().indexOf("/node_modules"));
    if (
      exists(`${groupRoot}/node_modules/.pnpm`)
      || exists(`${groupRoot}/node_modules/.modules.yaml`)
      || exists(`${groupRoot}/node_modules/.pnpm/lock.yaml`)
      || exists(`${globalRoot}/store`)
      || exists(`${globalRoot}/pnpm-lock.yaml`)
    ) return "pnpm";
  }

  // Bun's global layout is specifically `.bun/install/global/node_modules`. A bare `.bun`
  // directory is not enough: npm projects can quite legitimately live under a dot-directory
  // with that name, especially on Windows where package paths are often user-selected.
  if (/(?:^|\/)\.bun\/install\/global\/node_modules(?:\/|$)/i.test(normalized)) return "bun";

  return "npm";
}
