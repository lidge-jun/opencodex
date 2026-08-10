import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  assertStableLockFile,
  hardenStableLockFile,
  openStableLockFile,
  type StableLockFile,
} from "./native-main-lock-file";
import type { NativeProfileContext } from "./native-profile-store";
import { NativeProfileError } from "./native-profile-types";

export const NATIVE_MAIN_OWNER_RETRY_MS = 250;
export const NATIVE_MAIN_OWNER_DB = ".opencodex-native-main.owner.sqlite";

export type NativeMainOwnerUnavailableReason = "lock-unavailable" | "unsupported-filesystem";

export type NativeMainOwnerSnapshot =
  | { status: "acquiring"; homeId: string }
  | { status: "contended"; homeId: string }
  | { status: "held"; homeId: string }
  | { status: "unavailable"; homeId: string; reason: NativeMainOwnerUnavailableReason }
  | { status: "closing"; homeId: string }
  | { status: "released"; homeId: string };

export interface NativeMainOwnerOptions {
  retryMs?: number;
  hardenPath?: (path: string) => Promise<void>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface NativeMainOwnerReference {
  readonly homeId: string;
  snapshot(): NativeMainOwnerSnapshot;
  subscribe(listener: (snapshot: NativeMainOwnerSnapshot) => void): () => void;
  release(): Promise<void>;
}

interface OwnerEntry {
  readonly context: NativeProfileContext;
  readonly lockPath: string;
  readonly options: Required<Pick<NativeMainOwnerOptions, "retryMs" | "platform">>
    & Pick<NativeMainOwnerOptions, "env" | "hardenPath">;
  refs: number;
  generation: number;
  snapshot: NativeMainOwnerSnapshot;
  listeners: Set<(snapshot: NativeMainOwnerSnapshot) => void>;
  database?: Database;
  file?: StableLockFile;
  prepared: boolean;
  timer?: ReturnType<typeof setTimeout>;
  drive?: Promise<void>;
  activeOperations: Set<Promise<unknown>>;
  aclTimeoutRetryUsed: boolean;
  closing: boolean;
}

const entries = new Map<string, OwnerEntry>();
const detachedEntries = new Set<OwnerEntry>();
let exitHookInstalled = false;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database (?:is|table is) locked/i.test(message);
}

export function nativeMainOwnerFilesystemSupported(
  codexHome: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === "win32") {
    const normalized = codexHome.replaceAll("/", "\\");
    if (normalized.startsWith("\\\\?\\UNC\\")) return false;
    if (normalized.startsWith("\\\\") && !normalized.startsWith("\\\\?\\")) return false;
  }
  if (
    platform === "linux"
    && (env.WSL_INTEROP !== undefined || env.WSL_DISTRO_NAME !== undefined)
    && /^\/mnt\/[a-z](?:\/|$)/i.test(codexHome)
  ) return false;
  return true;
}

function publish(entry: OwnerEntry, snapshot: NativeMainOwnerSnapshot): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    try { listener({ ...snapshot }); } catch { /* an observer cannot forfeit process ownership */ }
  }
}

function closeDatabase(entry: OwnerEntry): void {
  const database = entry.database;
  entry.database = undefined;
  if (!database) return;
  try { database.exec("ROLLBACK"); } catch { /* close still releases the OS-backed lock */ }
  try { database.close(); } catch { /* the process exit path is best-effort */ }
}

function closeEntry(entry: OwnerEntry): void {
  closeDatabase(entry);
  try { entry.file?.close(); } catch { /* the process exit path is best-effort */ }
  entry.file = undefined;
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const entry of entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      closeEntry(entry);
    }
    for (const entry of detachedEntries) closeEntry(entry);
    entries.clear();
    detachedEntries.clear();
  });
}

function scheduleRetry(entry: OwnerEntry, generation: number): void {
  if (entry.closing || entry.refs === 0 || entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (entry.generation !== generation || entry.closing || entry.refs === 0) return;
    entry.drive = drive(entry, generation).finally(() => {
      if (entry.generation === generation) entry.drive = undefined;
    });
  }, entry.options.retryMs);
  entry.timer.unref?.();
}

async function prepareOwnerDatabase(entry: OwnerEntry): Promise<void> {
  if (entry.prepared) return;
  let file: StableLockFile | undefined;
  let database: Database | undefined;
  try {
    file = openStableLockFile(entry.lockPath, entry.options.platform);
    database = new Database(entry.lockPath, { create: true });
    // The resolved platform is threaded into the DEFAULT hardener for the same
    // reason the claim path does it: otherwise a test that forces `platform`
    // here still exercises the host's branch, and the production default — the
    // thing that actually hardens the owner's lock file — stays unproved. An
    // audit replaced this fallback with a no-op and 91 tests stayed green.
    if (entry.options.hardenPath) {
      await entry.options.hardenPath(entry.lockPath);
    } else {
      await hardenStableLockFile(entry.lockPath, entry.options.platform, {
        retryTimedOutOnce: entry.aclTimeoutRetryUsed,
      });
    }
    assertStableLockFile(entry.lockPath, file);
    entry.file = file;
    file = undefined;
  } catch (error) {
    try { file?.close(); } catch { /* mapped by caller */ }
    throw error;
  } finally {
    try { database?.close(); } catch { /* the caller publishes the hard failure */ }
  }
  entry.prepared = true;
}

async function drive(entry: OwnerEntry, generation: number): Promise<void> {
  if (entry.closing || entry.refs === 0 || entry.generation !== generation || entry.database) return;
  if (!nativeMainOwnerFilesystemSupported(
    entry.context.codexHome,
    entry.options.platform,
    entry.options.env ?? process.env,
  )) {
    publish(entry, { status: "unavailable", homeId: entry.context.homeId, reason: "unsupported-filesystem" });
    return;
  }
  let candidate: Database | undefined;
  try {
    await prepareOwnerDatabase(entry);
    if (entry.closing || entry.refs === 0 || entry.generation !== generation) return;
    candidate = new Database(entry.lockPath, { create: true });
    candidate.exec("PRAGMA locking_mode = NORMAL; PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    assertStableLockFile(entry.lockPath, entry.file!);
    if (entry.closing || entry.refs === 0 || entry.generation !== generation) {
      try { candidate.exec("ROLLBACK"); } catch { /* close below */ }
      candidate.close();
      return;
    }
    entry.database = candidate;
    candidate = undefined;
    publish(entry, { status: "held", homeId: entry.context.homeId });
  } catch (error) {
    try { candidate?.close(); } catch { /* acquisition already failed */ }
    if (entry.closing || entry.refs === 0 || entry.generation !== generation) return;
    if (isBusy(error)) {
      publish(entry, { status: "contended", homeId: entry.context.homeId });
      scheduleRetry(entry, generation);
      return;
    }
    if (errorCode(error) === "ETIMEDOUT" && !entry.aclTimeoutRetryUsed) {
      entry.aclTimeoutRetryUsed = true;
      // A timeout is neither ownership contention nor a permanent ACL denial.
      // Stay fail-closed in `acquiring` and spend exactly one fresh-budget retry.
      scheduleRetry(entry, generation);
      return;
    }
    publish(entry, { status: "unavailable", homeId: entry.context.homeId, reason: "lock-unavailable" });
  }
}

function entryFor(context: NativeProfileContext, options: NativeMainOwnerOptions): OwnerEntry {
  const existing = entries.get(context.homeId);
  if (existing) {
    if (existing.context.codexHome !== context.codexHome) {
      throw new NativeProfileError("CODEX_HOME_UNAVAILABLE", "The canonical native-main home changed unexpectedly.", 409);
    }
    return existing;
  }
  const entry: OwnerEntry = {
    context,
    lockPath: join(context.codexHome, NATIVE_MAIN_OWNER_DB),
    options: {
      retryMs: Math.max(1, options.retryMs ?? NATIVE_MAIN_OWNER_RETRY_MS),
      platform: options.platform ?? process.platform,
      env: options.env,
      hardenPath: options.hardenPath,
    },
    refs: 0,
    generation: 1,
    snapshot: { status: "acquiring", homeId: context.homeId },
    listeners: new Set(),
    activeOperations: new Set(),
    aclTimeoutRetryUsed: false,
    prepared: false,
    closing: false,
  };
  entries.set(context.homeId, entry);
  installExitHook();
  return entry;
}

export function retainNativeMainOwner(
  context: NativeProfileContext,
  options: NativeMainOwnerOptions = {},
): NativeMainOwnerReference {
  const entry = entryFor(context, options);
  if (entry.closing) {
    throw new NativeProfileError("NATIVE_MAIN_OWNER_BUSY", "Native-main ownership is closing.", 503, true);
  }
  entry.refs += 1;
  if (!entry.drive && !entry.database && !entry.timer && entry.snapshot.status !== "unavailable") {
    const generation = entry.generation;
    entry.drive = drive(entry, generation).finally(() => {
      if (entry.generation === generation) entry.drive = undefined;
    });
  }
  let released = false;
  return {
    homeId: context.homeId,
    snapshot: () => ({ ...entry.snapshot }),
    subscribe(listener) {
      entry.listeners.add(listener);
      listener({ ...entry.snapshot });
      return () => { entry.listeners.delete(listener); };
    },
    async release() {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs !== 0 || entry.closing) return;
      entry.closing = true;
      entry.generation += 1;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      publish(entry, { status: "closing", homeId: entry.context.homeId });
      // Detach synchronously before the first await. startServer is synchronous,
      // so a failed listen must be able to create a fresh reference immediately;
      // SQLite will keep that successor contended until this entry finishes close.
      if (entries.get(entry.context.homeId) === entry) entries.delete(entry.context.homeId);
      detachedEntries.add(entry);
      if (entry.drive) await Promise.allSettled([entry.drive]);
      while (entry.activeOperations.size > 0) {
        await Promise.allSettled([...entry.activeOperations]);
      }
      closeEntry(entry);
      publish(entry, { status: "released", homeId: entry.context.homeId });
      detachedEntries.delete(entry);
    },
  };
}

export function nativeMainOwnerSnapshot(context: NativeProfileContext): NativeMainOwnerSnapshot | null {
  const entry = entries.get(context.homeId);
  return entry ? { ...entry.snapshot } : null;
}

export function assertNativeMainOwner(context: NativeProfileContext): void {
  const entry = entries.get(context.homeId);
  if (entry?.snapshot.status === "held" && entry.database && !entry.closing) return;
  const unavailable = entry?.snapshot.status === "unavailable";
  throw new NativeProfileError(
    unavailable ? "NATIVE_MAIN_OWNER_UNAVAILABLE" : "NATIVE_MAIN_OWNER_BUSY",
    unavailable
      ? "This process cannot establish native-main ownership for the effective CODEX_HOME."
      : "Another OpenCodex process owns the physical native-main login for the effective CODEX_HOME.",
    503,
    true,
  );
}

export async function withNativeMainOwnerOperation<T>(
  context: NativeProfileContext,
  operation: () => Promise<T>,
): Promise<T> {
  const entry = entries.get(context.homeId);
  // Direct manager unit tests and non-server library consumers retain the historical
  // transaction-only behavior. Every live server registers an entry before listen.
  if (!entry) return operation();
  assertNativeMainOwner(context);
  let tracked!: Promise<T>;
  tracked = Promise.resolve().then(operation).finally(() => { entry.activeOperations.delete(tracked); });
  entry.activeOperations.add(tracked);
  return tracked;
}
