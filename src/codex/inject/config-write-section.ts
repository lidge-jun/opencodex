import type { AtomicWriteHooks } from "../../config/atomic-write";
import { existsSync, readFileSync } from "node:fs";
import { withConfigMutationLockSync } from "../../config";
import { atomicWriteFile } from "../../config/atomic-write";
import { ConfigWriteContentChanged, ConfigWriteLockRefusal, assertConfigWriteDestination, configDigest, publishConfigWriteTarget, recordPublishedConfigDigest, removeConfigWriteEntry, watchConfigWriteTargets, withConfigWriteLockHeld, type LockHandle } from "../config-write-lock";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH } from "../paths";
import { getCodexHome } from "../paths";
import { codexHomeIsAbsent } from "../codex-home-owner";
import { JOURNAL_PATH, removeJournal } from "../journal";
import { externalCodexModelProvider } from "./config-toml";

export function beginCodexWriteSection(held: LockHandle): void {
  assertConfigWriteDestination(CODEX_CONFIG_PATH, held);
  watchConfigWriteTargets(held, [CODEX_CONFIG_PATH, CODEX_PROFILE_PATH, JOURNAL_PATH]);
}
export function publishCodexArtifact<T>(path: string, held: LockHandle | undefined, run: (destination: string, hooks: AtomicWriteHooks) => T): T {
  if (!held) throw new Error("Codex artifact publication requires a held configuration lock");
  return publishConfigWriteTarget(CODEX_CONFIG_PATH, held, path, run);
}
export function removeCodexProfileEntry(held: LockHandle): void {
  removeConfigWriteEntry(CODEX_CONFIG_PATH, held, CODEX_PROFILE_PATH);
}
/** Courtesy cleanup re-reads provider ownership inside the same config section. */
export function cleanExternalProviderJournal(beforeClientWrite?: () => void): void {
  if (codexHomeIsAbsent(getCodexHome())) return;
  const locked = withConfigWriteLockHeld(CODEX_CONFIG_PATH, undefined, held => {
    beginCodexWriteSection(held);
    const cleanup = () => {
      beforeClientWrite?.();
      if (existsSync(CODEX_CONFIG_PATH) && externalCodexModelProvider(readFileSync(CODEX_CONFIG_PATH, "utf8"))) {
        publishCodexArtifact(JOURNAL_PATH, held, (_path, hooks) => removeJournal(hooks));
      }
    };
    if (beforeClientWrite) withConfigMutationLockSync(cleanup);
    else cleanup();
  });
  if (!locked.ok) throw new ConfigWriteLockRefusal(locked);
}
/** Where OpenCodex publishes config.toml; the test seam below names the site. */
export type CodexConfigPublishSite = "inject" | "journal" | "remove" | "retain" | "compensate";
let beforeCodexConfigPublishForTests: ((site: CodexConfigPublishSite) => void) | undefined;
/** Test seam: runs after a writer decided its bytes and immediately before it publishes config.toml. */
export function setBeforeCodexConfigPublishForTests(hook: typeof beforeCodexConfigPublishForTests): void {
  beforeCodexConfigPublishForTests = hook;
}
function readConfigOrNull(path: string): string | null {
  try { return readFileSync(path, "utf-8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/**
 * Publish config.toml only while it still holds `expected`, the bytes the caller decided from.
 *
 * The lock excludes other OpenCodex writers and its inode witness refuses an atomic rename, which
 * is how Codex writes. Neither sees a writer that rewrites the file in place, and restore used to
 * rename over such a write and report success. Comparing the bytes in `validateBeforeRename`
 * refuses any write that landed before that comparison; a refusal writes nothing and is retryable.
 *
 * What it cannot do: an in-place write landing after the comparison and before the rename (the
 * rename is the next system call) keeps the inode and is replaced. Closing that needs a
 * replace-if-unchanged primitive the filesystem does not offer, so the window is narrowed, not closed.
 */
export function publishCodexConfigIfUnchanged(held: LockHandle, site: CodexConfigPublishSite, expected: string | null, next: string): void {
  publishCodexArtifact(CODEX_CONFIG_PATH, held, (path, hooks) => atomicWriteFile(path, next, undefined, {
    ...hooks,
    validateBeforeRename: target => {
      beforeCodexConfigPublishForTests?.(site);
      if (readConfigOrNull(target) !== expected) throw new ConfigWriteContentChanged();
      hooks.validateBeforeRename?.(target);
    },
    afterRename: target => {
      recordPublishedConfigDigest(held, configDigest(next));
      hooks.afterRename?.(target);
    },
  }));
}
