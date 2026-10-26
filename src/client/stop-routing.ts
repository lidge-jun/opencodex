import { existsSync } from "node:fs";
import { codexHomeIsAbsent } from "../codex/codex-home-owner";
import { configWriteLockFailureMessage, withConfigWriteLock } from "../codex/config-write-lock";
import { hasInjectedCodexRouting } from "../codex/injected-marker";
import { readBoundedCodexConfig } from "../codex/inject/bounded-config-reader";
import { journalOwner, JOURNAL_PATH, restoreJournalState } from "../codex/journal";
import { CODEX_CONFIG_PATH, CODEX_HOME } from "../codex/paths";
import { siblingOfLivePort, siblingSkipMessage } from "../codex/sibling-start";
import type { OcxClientConnectionConfig } from "../types";
import { withClientLifecycleSync } from "./lifecycle-lock";
import { assertNoClientDisconnectPending, isLinkConnection, readClientConnectionState, sameClientConnectionOwner } from "./state";

export type LinkRoutingRestoreResult = { success: boolean; restored: boolean; message: string };

const resumeGuidance = "After starting the Child again, run `ocx sync --restart-codex` to restore its Home routing.";
const refusal = (reason: string): LinkRoutingRestoreResult => ({
  success: false, restored: false,
  message: `Link Child Codex routing restore refused: ${reason}. Connection and recovery evidence preserved.`,
});

/** Restore only this connection's Codex journal; stop never disconnects or restores other clients. */
export function restoreLinkClientRouting(expected: OcxClientConnectionConfig): LinkRoutingRestoreResult {
  if (siblingOfLivePort() !== null) return { success: true, restored: false, message: siblingSkipMessage() };
  if (!isLinkConnection(expected) || !expected.selectedClients.includes("codex")) {
    return { success: true, restored: false, message: "This connection owns no Link Child Codex routing to restore." };
  }
  try {
    if (codexHomeIsAbsent(CODEX_HOME)) return { success: true, restored: false, message: `Codex home is absent. ${resumeGuidance}` };
    // File lock first, then L. Journal replay uses the held file lock and never acquires N;
    // this follows injection's file -> N -> L -> C order without taking N inside L.
    const locked = withConfigWriteLock(CODEX_CONFIG_PATH, held => withClientLifecycleSync((): LinkRoutingRestoreResult => {
      const current = readClientConnectionState();
      if (current.kind !== "connected" || !isLinkConnection(current.value)
        || !sameClientConnectionOwner(current.value, expected)
        || current.value.tokenFingerprint !== expected.tokenFingerprint
        || JSON.stringify(current.value.link) !== JSON.stringify(expected.link)
        || JSON.stringify(current.value.selectedClients) !== JSON.stringify(expected.selectedClients)) {
        return refusal("the connected owner changed");
      }
      assertNoClientDisconnectPending();
      if (current.value.pendingOperation) return refusal("key rotation is pending");
      const owner = journalOwner({ readOnly: true });
      if (owner === null) {
        const config = readBoundedCodexConfig(CODEX_CONFIG_PATH);
        if (existsSync(JOURNAL_PATH) || (config !== null && hasInjectedCodexRouting(config))) return refusal("the client journal is missing or unverified");
        return { success: true, restored: false, message: `No owned Codex routing remains. ${resumeGuidance}` };
      }
      if (owner.kind !== "client" || owner.apiKeyId !== expected.apiKeyId) return refusal("the Codex journal belongs to another owner");
      const result = restoreJournalState({ heldConfigWriteLock: held });
      if (!result.complete) return refusal("the Codex config/profile pair could not be completely restored");
      return { success: true, restored: result.configRewritten || result.profileRewritten,
        message: `Link Child Codex routing restored; connection, catalog and other integrations preserved. ${resumeGuidance}` };
    }));
    return locked.ok ? locked.value : refusal(configWriteLockFailureMessage(locked));
  } catch (error) {
    return refusal(error instanceof Error ? error.message : "restoration failed");
  }
}
