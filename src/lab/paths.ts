import { chmodSync, existsSync, mkdirSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getConfigDir } from "../config";

/** Return true when path is the Lab root or a descendant path component. */
function isAtOrBelowLabBoundary(path: string, labRootBoundary: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedBoundary = resolve(labRootBoundary);
  if (normalizedPath === normalizedBoundary) return true;
  const prefix = normalizedBoundary + sep;
  return normalizedPath.startsWith(prefix) && normalizedPath.length > normalizedBoundary.length;
}

/** Reject symlink, non-directory, and reparse-point substitutions for a Lab-owned component. */
function assertRestrictedDirectoryComponent(path: string): void {
  const componentStats = lstatSync(path);
  if (componentStats.isSymbolicLink()) {
    throw new Error(`restricted directory component is a symbolic link: ${path}`);
  }
  if (!componentStats.isDirectory()) {
    throw new Error(`restricted path component is not a directory: ${path}`);
  }
  const canonical = resolve(realpathSync.native(path));
  const canonicalParent = resolve(realpathSync.native(dirname(path)));
  const expectedCanonical = resolve(join(canonicalParent, basename(path)));
  if (canonical !== expectedCanonical) {
    throw new Error(`restricted directory component contains a link or reparse-point substitution: ${path}`);
  }
}

/**
 * Create (or harden) a directory to mode 0o700 without following symlinks on Lab-owned
 * components. Ancestors above labRootBoundary are treated as infrastructure and are not
 * inspected for symlinks (for example macOS /var → /private/var).
 */
export function ensureRestrictedDir(dir: string, labRootBoundary: string): void {
  const abs = resolve(dir);
  const boundary = resolve(labRootBoundary);
  const parts = abs.split(sep);
  let current = parts[0] === "" ? sep : parts[0]!;
  for (const part of parts.slice(1)) {
    if (part === "") continue;
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
    if (isAtOrBelowLabBoundary(current, boundary)) {
      assertRestrictedDirectoryComponent(current);
    }
  }
  if (!existsSync(abs)) return;
  if (!isAtOrBelowLabBoundary(abs, boundary)) return;
  assertRestrictedDirectoryComponent(abs);
  if (process.platform !== "win32") {
    const mode = lstatSync(abs).mode & 0o777;
    if (mode !== 0o700) chmodSync(abs, 0o700);
  }
}

/** Canonical Compatibility Lab state root under the OpenCodex config dir. */
export function labRoot(configDir = getConfigDir()): string {
  return join(configDir, "lab");
}

export function labLedgerPath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "compatibility.jsonl");
}

export function labSqlitePath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "compatibility.sqlite");
}

export function labArtifactsDir(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "artifacts");
}

export function labScratchDir(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "scratch");
}

/** Shared Lab export directory. Public evidence bundles intentionally live here too. */
export function labExportDir(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "export");
}

export function labCommunityDir(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "community");
}

export function labPublicOriginDir(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "public-origin-v1");
}

export const LAB_PUBLIC_PUBLISHER_KEY_FILE = "publisher-ed25519.pem";

export function labPublicPublisherKeyPath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), LAB_PUBLIC_PUBLISHER_KEY_FILE);
}

/** Opaque per-installation salt for local fingerprinting (never exported as evidence). */
export function labInstallationSaltPath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "installation-salt.bin");
}

export function labAutomationPolicyPath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "automation-policy.json");
}

export function labAutomationStatePath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "automation-state.json");
}

export function labAutomationRoutesPath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "automation-routes.json");
}

/** Ensure lab directories exist with restrictive permissions where the platform allows. */
export function ensureLabDirs(configDir = getConfigDir()): {
  root: string;
  ledgerPath: string;
  sqlitePath: string;
  artifactsDir: string;
  scratchDir: string;
  exportDir: string;
  communityDir: string;
  publicOriginDir: string;
} {
  const root = labRoot(configDir);
  const artifactsDir = labArtifactsDir(configDir);
  const scratchDir = labScratchDir(configDir);
  const exportDir = labExportDir(configDir);
  const communityDir = labCommunityDir(configDir);
  const publicOriginDir = labPublicOriginDir(configDir);
  ensureRestrictedDir(root, root);
  ensureRestrictedDir(artifactsDir, root);
  ensureRestrictedDir(scratchDir, root);
  ensureRestrictedDir(exportDir, root);
  ensureRestrictedDir(communityDir, root);
  ensureRestrictedDir(publicOriginDir, root);
  return {
    root,
    ledgerPath: labLedgerPath(configDir),
    sqlitePath: labSqlitePath(configDir),
    artifactsDir,
    scratchDir,
    exportDir,
    communityDir,
    publicOriginDir,
  };
}
