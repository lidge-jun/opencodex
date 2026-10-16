import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";

export const CODEX_SHIM_STATE_MAX_BYTES = 1024 * 1024;

interface ShimState {
  schema?: 2;
  mode?: "path-overlay";
  launcherPath?: string;
  wrapperIdentity?: OverlayIdentity;
  envIdentity?: OverlayIdentity;
  transactionId?: string;
  platform: NodeJS.Platform;
  wrapperPath: string;
  originalPath: string;
  backupPath: string;
  wrappers?: ShimFileState[];
}

export interface OverlayIdentity { dev: number; ino: number }
export interface OverlayState {
  schema: 2;
  mode: "path-overlay";
  platform: NodeJS.Platform;
  wrapperPath: string;
  launcherPath: string;
  // Older schema-2 records remain readable, but absent identities confer no mutation authority.
  wrapperIdentity?: OverlayIdentity;
  envIdentity?: OverlayIdentity;
  transactionId?: string;
}

export function decodeOverlayState(value: unknown, configDir: string): OverlayState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  const platforms = ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "android", "netbsd", "haiku", "cygwin"];
  const validPath = (path: unknown): path is string => typeof path === "string" && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path);
  if (state.schema !== 2 || state.mode !== "path-overlay" || !platforms.includes(String(state.platform))
    || !validPath(configDir) || !validPath(state.wrapperPath) || !validPath(state.launcherPath)
    || state.wrapperPath !== join(resolve(configDir), "bin", "codex")
    || dirname(state.wrapperPath).includes(":") || resolve(state.launcherPath) === state.wrapperPath) return null;
  for (const field of ["originalPath", "backupPath", "realPath"]) {
    if (state[field] !== undefined && state[field] !== state.launcherPath) return null;
  }
  if (state.preserveOnly !== undefined && state.preserveOnly !== false) return null;
  if (state.wrappers !== undefined) {
    if (!Array.isArray(state.wrappers) || state.wrappers.length !== 1) return null;
    const file = state.wrappers[0];
    if (!file || typeof file !== "object" || file.wrapperPath !== state.wrapperPath
      || file.originalPath !== state.launcherPath || file.backupPath !== state.launcherPath
      || (file.realPath !== undefined && file.realPath !== state.launcherPath) || file.preserveOnly) return null;
  }
  for (const key of ["wrapperIdentity", "envIdentity"]) {
    const id = state[key] as Partial<OverlayIdentity> | undefined;
    if (id !== undefined && (!id || !Number.isSafeInteger(id.dev) || !Number.isSafeInteger(id.ino))) return null;
  }
  if (state.transactionId !== undefined && (typeof state.transactionId !== "string" || !/^[a-f0-9-]{36}$/.test(state.transactionId))) return null;
  return state as unknown as OverlayState;
}

export function readOverlayState(configDir = getConfigDir()): OverlayState | null {
  return decodeOverlayState(readStateResult(join(configDir, "codex-shim.json")).state, configDir);
}

interface ShimFileState {
  wrapperPath: string;
  originalPath: string;
  backupPath: string;
  realPath?: string;
  preserveOnly?: boolean;
}

interface ShimStateReadResult {
  state: ShimState | null;
  present: boolean;
  warning?: string;
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function readBoundedRegularFile(path: string, maxBytes: number): { bytes: Buffer; content: string; stat: Stats } | { warning: string } | null {
  let lexicalBefore: Stats;
  try {
    lexicalBefore = lstatSync(path);
    if (lexicalBefore.isSymbolicLink() || !lexicalBefore.isFile()) {
      return { warning: `Codex shim state is not a direct regular file at ${path}; auto-restore skipped.` };
    }
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return null;
    return { warning: `Codex shim state could not be inspected at ${path}.` };
  }
  let fd: number;
  try {
    fd = openSync(path, process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return null;
    return { warning: `Codex shim state could not be opened as a regular file at ${path}.` };
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return { warning: `Codex shim state is not a regular file at ${path}; auto-restore skipped.` };
    if (before.size > maxBytes) {
      return { warning: `Codex shim state exceeds the 1 MiB startup limit at ${path}; auto-restore skipped.` };
    }
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return { warning: `Codex shim state changed while being read at ${path}; auto-restore skipped.` };
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, offset) !== 0) {
      return { warning: `Codex shim state exceeds the 1 MiB startup limit at ${path}; auto-restore skipped.` };
    }
    const after = fstatSync(fd);
    let lexicalAfter: Stats;
    try {
      lexicalAfter = lstatSync(path);
    } catch {
      return { warning: `Codex shim state changed while being read at ${path}; auto-restore skipped.` };
    }
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.mode !== after.mode || before.uid !== after.uid
      || lexicalBefore.dev !== before.dev || lexicalBefore.ino !== before.ino
      || lexicalBefore.mode !== before.mode || lexicalBefore.uid !== before.uid
      || lexicalBefore.size !== before.size || lexicalBefore.mtimeMs !== before.mtimeMs || lexicalBefore.ctimeMs !== before.ctimeMs
      || !lexicalAfter.isFile() || lexicalAfter.isSymbolicLink() || lexicalAfter.dev !== after.dev || lexicalAfter.ino !== after.ino
      || lexicalAfter.mode !== after.mode || lexicalAfter.uid !== after.uid
      || lexicalAfter.size !== after.size || lexicalAfter.mtimeMs !== after.mtimeMs || lexicalAfter.ctimeMs !== after.ctimeMs) {
      return { warning: `Codex shim state changed while being read at ${path}; auto-restore skipped.` };
    }
    return { bytes: buffer, content: buffer.toString("utf8"), stat: after };
  } finally {
    closeSync(fd);
  }
}

function readStateResult(path = statePath()): ShimStateReadResult {
  const bounded = readBoundedRegularFile(path, CODEX_SHIM_STATE_MAX_BYTES);
  if (!bounded) return { state: null, present: false };
  if ("warning" in bounded) return { state: null, present: true, warning: bounded.warning };
  try {
    const value = JSON.parse(bounded.content) as unknown;
    if (!value || typeof value !== "object") return { state: null, present: true };
    const state = value as Record<string, unknown>;
    if (state.mode !== undefined || state.schema !== undefined) {
      // Legacy records stay readable; private overlay authority requires safe ownership.
      // Non-writable mode drift is readable for opt-in repair, never a healthy installation.
      if (process.platform !== "win32" && (bounded.stat.uid !== process.getuid?.() || (bounded.stat.mode & 0o022))) {
        return { state: null, present: true, warning: "Private Codex shim state is not owned by the current user or is group/world writable; preserving artifacts. Remove the private files manually before reinstalling." };
      }
      const overlay = decodeOverlayState(value, dirname(path));
      return { state: overlay ? { ...overlay, originalPath: overlay.launcherPath, backupPath: overlay.launcherPath } : null, present: true };
    }
    if (typeof state.platform !== "string") return { state: null, present: true };
    const validFile = (item: unknown): item is ShimFileState => {
      if (!item || typeof item !== "object") return false;
      const file = item as Record<string, unknown>;
      return typeof file.wrapperPath === "string"
        && typeof file.originalPath === "string"
        && typeof file.backupPath === "string"
        && (file.realPath === undefined || typeof file.realPath === "string")
        && (file.preserveOnly === undefined || typeof file.preserveOnly === "boolean");
    };
    if (state.wrappers !== undefined) {
      if (!Array.isArray(state.wrappers) || state.wrappers.length === 0 || !state.wrappers.every(validFile)) return { state: null, present: true };
    } else if (!validFile(state)) {
      return { state: null, present: true };
    }
    return { state: state as unknown as ShimState, present: true };
  } catch {
    return { state: null, present: true };
  }
}

function readState(): ShimState | null {
  return readStateResult().state;
}

function statePath(): string {
  return join(getConfigDir(), "codex-shim.json");
}

function writeState(state: ShimState | OverlayState): void {
  const path = statePath();
  recordOwnedConfigPath(getConfigDir(), path);
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  if (state.mode === "path-overlay") {
    if (!decodeOverlayState(state, getConfigDir()) || !state.wrapperIdentity || !state.envIdentity) {
      throw new Error("Invalid Codex overlay state: recorded ownership identities are required");
    }
    const staged = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staged, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(staged, path);
    } finally {
      try { unlinkSync(staged); } catch { /* committed or absent */ }
    }
    return;
  }
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function stateFiles(state: ShimState): ShimFileState[] {
  if (state.mode === "path-overlay" && state.launcherPath) return [{
    wrapperPath: state.wrapperPath, originalPath: state.launcherPath,
    backupPath: state.launcherPath, realPath: state.launcherPath,
  }];
  return state.wrappers?.length
    ? state.wrappers
    : [{ wrapperPath: state.wrapperPath, originalPath: state.originalPath, backupPath: state.backupPath }];
}

export type { ShimState, ShimFileState };
export { readBoundedRegularFile, fileErrorCode, readStateResult, readState, statePath, writeState, stateFiles };
