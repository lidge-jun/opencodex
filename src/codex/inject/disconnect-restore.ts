/**
 * The Codex half of `ocx disconnect`: restore what the client injection changed, or prove there
 * is nothing left to restore.
 *
 * The journal replays its pre-injection snapshot only while config.toml is byte-for-byte the
 * original or the first injected bytes. Codex itself appends to config.toml (trusted projects,
 * notice flags), and after that the replay would delete those lines, so the journal restore
 * stays partial forever. When the only difference is lines OpenCodex does not own, there is
 * nothing to undo: config.toml is left as it is and the journal, whose one remaining use is that
 * unsafe replay, is retired. While any OpenCodex line remains the journal is kept.
 *
 * Everything runs under one held Codex config write lock, so the file judged is the file kept.
 */
import { existsSync, readFileSync } from "node:fs";
import { configWriteLockFailureMessage, withConfigWriteLockHeld } from "../config-write-lock";
import { JOURNAL_PATH, removeJournal, restoreJournalState } from "../journal";
import { CodexHomeOwnerRefusal } from "../codex-home-owner";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH } from "../paths";
import { beginCodexWriteSection, publishCodexArtifact } from "./config-write-section";
import { remainingOpencodexConfigKeys } from "./remove";

export type DisconnectCodexRestore =
  | { ok: true; journalRetired: boolean }
  | { ok: false; reason: string };

export function restoreCodexForDisconnect(): DisconnectCodexRestore {
  const locked = withConfigWriteLockHeld(CODEX_CONFIG_PATH, undefined, (held): DisconnectCodexRestore => {
    beginCodexWriteSection(held);
    const restored = restoreJournalState({ heldConfigWriteLock: held });
    if (restored.complete) return { ok: true, journalRetired: false };
    if (restored.lockBusy) return { ok: false, reason: "another process is writing the Codex configuration; retry shortly" };
    if (restored.lockUnsafe) return { ok: false, reason: restored.lockUnsafe };
    if (restored.ownershipRefusal) return { ok: false, reason: new CodexHomeOwnerRefusal(restored.ownershipRefusal).message };
    if (restored.unverified) {
      return { ok: false, reason: `the journal ${JOURNAL_PATH} does not record what OpenCodex wrote, so a changed Codex file cannot be told apart from your own edits; files and journal were kept` };
    }
    if (restored.profileRestoreFailed || !restored.profileRestored) {
      return { ok: false, reason: `${CODEX_PROFILE_PATH} changed after OpenCodex wrote it or could not be restored; files and journal were kept` };
    }
    if (!restored.configChanged) return { ok: false, reason: `the journal ${JOURNAL_PATH} could not be removed` };
    const config = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, "utf-8") : "";
    const remaining = remainingOpencodexConfigKeys(config);
    if (remaining.length > 0) {
      return {
        ok: false,
        reason: `${CODEX_CONFIG_PATH} changed after OpenCodex wrote it and still has OpenCodex settings (${remaining.join(", ")}), so the journal was kept. `
          + "Remove them from that file: each named key with its whole value (a multiline value ends at its closing quotes or bracket), "
          + "and each named table with every line under it. Keep every other line, then run ocx disconnect again",
      };
    }
    publishCodexArtifact(JOURNAL_PATH, held, (_path, hooks) => removeJournal(hooks));
    return { ok: true, journalRetired: true };
  });
  if (!locked.ok) return { ok: false, reason: configWriteLockFailureMessage(locked) };
  return locked.value;
}
