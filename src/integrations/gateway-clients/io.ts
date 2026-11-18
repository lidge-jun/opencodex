import { createHash } from "node:crypto";
import {
  closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
  rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  atomicWriteFileNoFollowStreamed, isMissingPathError, nextAtomicTempSequence, syncParentDirectory,
} from "../../config/atomic-write";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import { readBoundedRegularFileSync } from "../../lib/bounded-file-read";
import { parseJsonc } from "../../lib/jsonc";
import { assertNotRealCodexHomeUnderTest, assertNotRealHomeUnderTest } from "../../lib/test-home-guard";
import { renameAtomicFile } from "../../lib/windows-atomic-replace";
import type { GatewayClientContext, GatewayClientResult, GatewayOverride } from "./types";

export const GATEWAY_PLACEHOLDER_KEY = "opencodex-local";
const MAX_CLIENT_BYTES = 4 * 1024 * 1024;
// Restore records include base64 copies of up to three profiles or both settings and parsed prior values.
const MAX_STASH_BYTES = 32 * 1024 * 1024;

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface ClientFile {
  target: string;
  bytes: Buffer;
  hash: string;
}

/** Resolve the existing prefix even when a new client file or directory is needed. */
function resolveClientPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    const parent = dirname(path);
    if (!isMissingPathError(error) || parent === path) throw error;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refusing an unresolvable gateway client symlink: ${path}`);
    }
    return join(resolveClientPath(parent), basename(path));
  }
}

function underCanonicalHome(ctx: GatewayClientContext, path: string): string {
  const subpath = relative(ctx.home, path);
  if (subpath === ".." || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) {
    throw new Error(`Gateway client path is outside the home directory: ${path}`);
  }
  return join(realpathSync(ctx.home), subpath);
}

/** Compare the resolved file against the fixed names under the canonical home. */
function clientDestination(ctx: GatewayClientContext, path: string, allowedPaths: readonly string[]): string {
  const parent = dirname(path);
  if (relative(underCanonicalHome(ctx, parent), resolveClientPath(parent)) !== "") {
    throw new Error(`Gateway client file resolves outside the allowed client directory: ${path}`);
  }
  const target = resolveClientPath(path);
  // Following links in the allowlist would let a redirected profile authorize its own destination.
  if (!allowedPaths.some(allowed => relative(underCanonicalHome(ctx, allowed), target) === "")) {
    throw new Error(`Gateway client file resolves outside the allowed client paths: ${path}`);
  }
  return target;
}

function readClientDestination(target: string): ClientFile | null {
  try {
    const bytes = readBoundedRegularFileSync(target, MAX_CLIENT_BYTES);
    return { target, bytes, hash: sha256(bytes) };
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export function readClientFile(ctx: GatewayClientContext, path: string, allowedPaths: readonly string[] = [path]): ClientFile | null {
  return readClientDestination(clientDestination(ctx, path, allowedPaths));
}

/** Inspect a candidate without failing status or recovery when it cannot be resolved or read. */
export function inspectClientFile(ctx: GatewayClientContext, path: string, allowedPaths: readonly string[] = [path]): ClientFile | null | undefined {
  try { return readClientFile(ctx, path, allowedPaths); } catch { return undefined; }
}

export function assertClientSize(bytes: Uint8Array): void {
  if (bytes.length > MAX_CLIENT_BYTES) throw new Error("Gateway client file would exceed the 4 MiB limit");
}

export function checkedClientDestination(ctx: GatewayClientContext, path: string, original: ClientFile | null, allowedPaths: readonly string[] = [path], destination = original?.target): string {
  const target = clientDestination(ctx, path, allowedPaths);
  const current = readClientDestination(target);
  if (original?.hash !== current?.hash || (destination !== undefined && destination !== target)) {
    throw new Error(`Gateway client file changed before update: ${path}`);
  }
  return target;
}

/** Replace the resolved client file using the directory's inherited Windows ACL. */
export function writeClientFile(ctx: GatewayClientContext, path: string, original: ClientFile | null, bytes: Uint8Array, allowedPaths: readonly string[] = [path]): void {
  assertClientSize(bytes);
  const target = checkedClientDestination(ctx, path, original, allowedPaths);
  const dir = dirname(target);
  assertNotRealHomeUnderTest(dir);
  assertNotRealCodexHomeUnderTest(dir);
  const mode = original && process.platform !== "win32" ? statSync(target).mode & 0o777 : 0o644;
  const temp = join(dir, `.${basename(target)}.ocx-${process.pid}-${nextAtomicTempSequence()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      if (process.platform !== "win32") fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameAtomicFile(temp, target, undefined, "config", {
      validateBeforeRename: destination => { checkedClientDestination(ctx, path, original, allowedPaths, destination); },
    });
  } catch (error) {
    try { unlinkSync(temp); } catch (cleanup) {
      if (!isMissingPathError(cleanup)) throw new AggregateError([error, cleanup], "Could not update the gateway client or remove its temporary file");
    }
    throw error;
  }
  syncParentDirectory(target);
}

export function removeCreatedClientFile(ctx: GatewayClientContext, path: string, original: ClientFile, allowedPaths: readonly string[] = [path]): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to remove a symlinked gateway client file: ${path}`);
  checkedClientDestination(ctx, path, original, allowedPaths);
  assertNotRealHomeUnderTest(dirname(original.target));
  assertNotRealCodexHomeUnderTest(dirname(original.target));
  unlinkSync(original.target);
  syncParentDirectory(original.target);
}

export function clientRefusal(message: string, code: GatewayClientResult["code"] = "io-error", changedFiles: string[] = []): GatewayClientResult {
  return { ok: false, code, message, changed: changedFiles.length > 0, changedFiles, notes: [] };
}

export function mutateClient(ctx: GatewayClientContext, work: () => GatewayClientResult): GatewayClientResult {
  try { return withConfigMutationLockSync(work, ctx.stateDir); }
  catch (error) { return clientRefusal((error as Error).message); }
}

/** Create `dir` (and parents); returns the directories that did not exist before, outermost first. */
export function mkdirTracked(dir: string): string[] {
  const created: string[] = [];
  for (let cur = dir; !existsSync(cur); cur = dirname(cur)) created.unshift(cur);
  mkdirSync(dir, { recursive: true });
  return created;
}

/** Remove the directories this connector created, deepest first, only while empty. */
export function rmdirsIfEmpty(ctx: GatewayClientContext, dirs: readonly string[]): void {
  for (const dir of [...dirs].reverse()) {
    try {
      const allowed = underCanonicalHome(ctx, dir);
      if (relative(allowed, realpathSync(dir)) === "") rmdirSync(allowed);
    } catch { /* gone or not empty */ }
  }
}

function stashDirectory(ctx: GatewayClientContext): string {
  return join(ctx.stateDir, "gateway-clients");
}

export function stashPath(ctx: GatewayClientContext, id: string): string {
  return join(stashDirectory(ctx), `${id}.json`);
}

function assertStashDirectory(path: string): void {
  if (!lstatSync(dirname(path)).isDirectory()) throw new Error("Gateway restore record directory is not a regular directory");
}

export function hasStash(ctx: GatewayClientContext, id: string): boolean {
  const path = stashPath(ctx, id);
  try {
    assertStashDirectory(path);
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export function readStash<T>(ctx: GatewayClientContext, id: string): T | null {
  const path = stashPath(ctx, id);
  try {
    assertStashDirectory(path);
    const bytes = readBoundedRegularFileSync(path, MAX_STASH_BYTES);
    const value = JSON.parse(bytes.toString("utf8")) as { version?: number } & T;
    if (value?.version !== 1) throw new Error("Unknown gateway restore record version");
    return value;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export function inspectStashPresence(ctx: GatewayClientContext, id: string): boolean {
  try { return hasStash(ctx, id); } catch { return true; }
}

export function writeStash(ctx: GatewayClientContext, id: string, value: object): void {
  const path = stashPath(ctx, id);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_STASH_BYTES) throw new Error("Gateway restore record would exceed its size limit");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertStashDirectory(path);
  atomicWriteFileNoFollowStreamed(path, fd => writeFileSync(fd, bytes));
}

export function dropStash(ctx: GatewayClientContext, id: string): void {
  const path = stashPath(ctx, id);
  assertStashDirectory(path);
  rmSync(path, { force: true });
  removeEmptyStashDirectory(ctx);
}

export function removeEmptyStashDirectory(ctx: GatewayClientContext): void {
  const dir = stashDirectory(ctx);
  try {
    if (lstatSync(dir).isDirectory()) rmdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

export function isRestoreFile(home: string, path: string, record: {
  originalBytes: unknown; createdDirs: unknown; resolvedPath?: unknown;
}): boolean {
  const allowedDirs: string[] = [];
  for (let dir = dirname(path); relative(home, dir) !== "" && dir !== dirname(dir); dir = dirname(dir)) allowedDirs.push(dir);
  return (record.originalBytes === null || typeof record.originalBytes === "string")
    && (record.resolvedPath === undefined || typeof record.resolvedPath === "string")
    && Array.isArray(record.createdDirs) && record.createdDirs.every(dir => allowedDirs.includes(dir));
}

export const normalizeUrl = (url: unknown): string => typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";

/** Where an organisation's admin_settings.json lives (Google's enterprise gateway docs). */
export function adminSettingsPath(ctx: GatewayClientContext): string | undefined {
  if (ctx.adminSettingsPath) return ctx.adminSettingsPath;
  if (ctx.platform === "win32") {
    const base = ctx.env.ProgramData;
    return base ? join(base, "Antigravity", "admin_settings.json") : undefined;
  }
  return ctx.platform === "darwin"
    ? "/Library/Application Support/Antigravity/admin_settings.json"
    : "/etc/antigravity/admin_settings.json";
}

/** What admin_settings.json sets under `gateway`, or null when nothing. */
export function adminGatewayOverride(ctx: GatewayClientContext): GatewayOverride | null {
  const path = adminSettingsPath(ctx);
  if (!path) return null;
  let gateway: unknown;
  try {
    // A missing file is no override; EACCES or a parse failure is an unknown one, never a thrown status.
    const bytes = readBoundedRegularFileSync(resolveClientPath(path), MAX_CLIENT_BYTES);
    gateway = (parseJsonc(bytes.toString("utf8")) as { gateway?: unknown } | null)?.gateway;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    return { source: "admin_settings", code: "admin-unreadable", detail: "admin_settings.json exists but could not be read, so its gateway settings are unknown" };
  }
  if (!gateway || typeof gateway !== "object" || Object.keys(gateway).length === 0) return null;
  return { source: "admin_settings", code: "admin-gateway", detail: "organization admin_settings.json sets the gateway and wins over the user settings and AGY_LLM_GATEWAY_* variables" };
}

/** The env override, or null. Only the environment of the process OpenCodex runs in is visible. */
export function envGatewayOverride(ctx: GatewayClientContext, targetUrl?: string): GatewayOverride | null {
  const raw = ctx.env.AGY_LLM_GATEWAY_URL?.trim();
  if (!raw) return null;
  if (targetUrl && normalizeUrl(raw) === normalizeUrl(targetUrl)) return null;
  let shown = "an unparseable value";
  try { shown = new URL(raw).origin; } catch { /* keep generic */ }
  return { source: "env", code: "env-gateway", detail: `AGY_LLM_GATEWAY_URL is set to ${shown} in the environment OpenCodex sees (other shells are not checked) and wins over ~/.antigravity/settings.json` };
}
