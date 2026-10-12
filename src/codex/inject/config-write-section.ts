import type { AtomicWriteHooks } from "../../config/atomic-write";
import { existsSync, readFileSync } from "node:fs";
import { withConfigMutationLockSync } from "../../config";
import { ConfigWriteLockRefusal, assertConfigWriteDestination, publishConfigWriteTarget, watchConfigWriteTargets, withConfigWriteLockHeld, type LockHandle } from "../config-write-lock";
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
