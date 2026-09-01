import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  assertStableLockFile,
  hardenStableLockFile,
  openStableLockFile,
  type StableLockFile,
} from "./native-main-lock-file";
import { nativeMainOwnerFilesystemSupported } from "./native-main-owner";
import type { NativeProfileContext } from "./native-profile-store";
import { NativeProfileError } from "./native-profile-types";

export const NATIVE_MAIN_CLAIM_DB = ".opencodex-native-main.claim.sqlite";

export interface NativeMainClaimOptions {
  waitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  hardenPath?: (path: string) => Promise<void>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export const NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES = 32;
export const hardenedIdentities = new Map<string, string>();

export function rememberHardenedIdentity(path: string, identity: string): void {
  hardenedIdentities.delete(path);
  hardenedIdentities.set(path, identity);
  while (hardenedIdentities.size > NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES) {
    const oldest = hardenedIdentities.keys().next().value;
    if (oldest === undefined) break;
    hardenedIdentities.delete(oldest);
  }
}

export function nativeMainClaimPath(context: NativeProfileContext): string {
  return join(context.codexHome, NATIVE_MAIN_CLAIM_DB);
}

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

function busyClaimError(message: string): NativeProfileError {
  return new NativeProfileError("NATIVE_MAIN_CLAIM_BUSY", message, 503, true);
}

function unavailableClaimError(): NativeProfileError {
  return new NativeProfileError(
    "NATIVE_MAIN_CLAIM_UNAVAILABLE",
    "The native-main cross-process claim is unavailable.",
    503,
    true,
  );
}

function mapClaimSetupError(error: unknown, busyMessage: string): NativeProfileError {
  if (error instanceof NativeProfileError) return error;
  return isBusy(error) ? busyClaimError(busyMessage) : unavailableClaimError();
}

async function openClaimDatabase(
  context: NativeProfileContext,
  options: NativeMainClaimOptions,
): Promise<{ database: Database; file: StableLockFile }> {
  const platform = options.platform ?? process.platform;
  if (!nativeMainOwnerFilesystemSupported(context.codexHome, platform, options.env ?? process.env)) {
    throw new NativeProfileError(
      "NATIVE_MAIN_CLAIM_UNAVAILABLE",
      "Native-main claims are unsupported on this CODEX_HOME filesystem.",
      503,
      true,
    );
  }
  const path = nativeMainClaimPath(context);
  let file: StableLockFile | undefined;
  let database: Database | undefined;
  try {
    file = openStableLockFile(path, platform);
    const identity = `${file.dev}:${file.ino}`;
    if (hardenedIdentities.get(path) !== identity) {
      // The resolved platform is threaded into the DEFAULT hardener, not left to
      // `hardenStableLockFile`'s own `process.platform` read. Otherwise a test
      // that forces `platform` here still exercises the host's branch, and the
      // production default — the thing that actually hardens a coordinator
      // database — stays unproved. An audit deleted this call entirely and 89
      // tests stayed green, because nearly every claim test injects `hardenPath`.
      await (options.hardenPath ?? ((target: string) => hardenStableLockFile(target, platform)))(path);
      assertStableLockFile(path, file);
      rememberHardenedIdentity(path, identity);
    }
    database = new Database(path, { create: true });
    // Journal-mode negotiation itself may need a database lock. Disable
    // SQLite's synchronous busy wait first so a contender never blocks Bun's
    // event loop while the current shared holder is waiting for JS to release.
    database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL");
    const mode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get()?.journal_mode;
    if (mode?.toLowerCase() !== "delete") throw new Error("native-main claim database is not in rollback-journal mode");
    assertStableLockFile(path, file);
    return { database, file };
  } catch (error) {
    try { database?.close(); } catch { /* mapped below */ }
    try { file?.close(); } catch { /* mapped below */ }
    throw mapClaimSetupError(error, "Native-main credentials are changing.");
  }
}

function releaseClaim(database: Database | undefined, file: StableLockFile | undefined): void {
  try { database?.exec("ROLLBACK"); } catch { /* close still releases the OS-backed claim */ }
  try { database?.close(); } catch { /* operation already completed */ }
  try { file?.close(); } catch { /* operation already completed */ }
}

function waitForClaimRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withNativeMainSharedClaim<T>(
  context: NativeProfileContext,
  operation: () => Promise<T>,
  options: NativeMainClaimOptions = {},
): Promise<T> {
  let database: Database | undefined;
  let file: StableLockFile | undefined;
  try {
    ({ database, file } = await openClaimDatabase(context, options));
    database.exec("BEGIN");
    // A deferred BEGIN alone owns no lock. Reading page 1 through sqlite_schema
    // establishes the SHARED lock that an exclusive transition must drain.
    database.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_schema LIMIT 1").get();
    assertStableLockFile(nativeMainClaimPath(context), file);
  } catch (error) {
    releaseClaim(database, file);
    throw mapClaimSetupError(error, "Native-main credentials are changing.");
  }
  try {
    return await operation();
  } finally {
    releaseClaim(database, file);
  }
}

export async function withNativeMainExclusiveClaim<T>(
  context: NativeProfileContext,
  operation: () => Promise<T>,
  options: NativeMainClaimOptions = {},
): Promise<T> {
  const signal = options.signal;
  const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
  const pollMs = Math.max(1, options.pollMs ?? 50);
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    let database: Database | undefined;
    let file: StableLockFile | undefined;
    try {
      ({ database, file } = await openClaimDatabase(context, options));
      database.exec("BEGIN EXCLUSIVE");
      assertStableLockFile(nativeMainClaimPath(context), file);
    } catch (error) {
      releaseClaim(database, file);
      if (signal?.aborted) throw signal.reason;
      const mapped = mapClaimSetupError(error, "Native-main credentials are in use.");
      if (mapped.code === "NATIVE_MAIN_CLAIM_BUSY" && Date.now() < deadline) {
        await waitForClaimRetry(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
        continue;
      }
      throw mapped;
    }
    try {
      if (signal?.aborted) throw signal.reason;
      return await operation();
    } finally {
      releaseClaim(database, file);
    }
  }
}
