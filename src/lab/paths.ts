import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";

function ensureRestrictedDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const mode = statSync(dir).mode & 0o777;
  if (mode !== 0o700) chmodSync(dir, 0o700);
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

export function labExportDir(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "export");
}

/** Opaque per-installation salt for local fingerprinting (never exported as evidence). */
export function labInstallationSaltPath(configDir = getConfigDir()): string {
  return join(labRoot(configDir), "installation-salt.bin");
}

/** Ensure lab directories exist with restrictive permissions where the platform allows. */
export function ensureLabDirs(configDir = getConfigDir()): {
  root: string;
  ledgerPath: string;
  sqlitePath: string;
  artifactsDir: string;
  scratchDir: string;
  exportDir: string;
} {
  const root = labRoot(configDir);
  const artifactsDir = labArtifactsDir(configDir);
  const scratchDir = labScratchDir(configDir);
  const exportDir = labExportDir(configDir);
  ensureRestrictedDir(root);
  ensureRestrictedDir(artifactsDir);
  return {
    root,
    ledgerPath: labLedgerPath(configDir),
    sqlitePath: labSqlitePath(configDir),
    artifactsDir,
    scratchDir,
    exportDir,
  };
}
