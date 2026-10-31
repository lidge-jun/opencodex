import { existsSync } from "node:fs";
import { restoreNativeCodex } from "../codex/inject";
import { hasInjectedCodexRouting } from "../codex/injected-marker";
import { readBoundedCodexConfig } from "../codex/inject/bounded-config-reader";
import { journalOwner, JOURNAL_PATH } from "../codex/journal";
import { CODEX_CONFIG_PATH } from "../codex/paths";
import { siblingOfLivePort, siblingSkipMessage } from "../codex/sibling-start";
import type { OcxClientConnectionConfig } from "../types";
import { pendingTeardownOutstanding } from "../config/pending-teardown";
import { stripGrokConfig } from "../grok/inject";
import { isDesktopSupervised } from "../lib/system-restart-contract";
import { serviceEnvironmentOwnedHere } from "../service/guards";
import { stopRestoreWriteGuard } from "./restore-ownership";
import { isLinkConnection } from "./state";

export type LinkRoutingRestoreResult = { success: boolean; restored: boolean; message: string };

const resumeGuidance = "After starting the Child again, run `ocx sync --restart-codex` to restore its Home routing.";
const refusal = (reason: string): LinkRoutingRestoreResult => ({
  success: false, restored: false,
  message: `Link Child Codex routing restore refused: ${reason}. No further writes; inspect remaining recovery evidence.`,
});

/** Unsupervised signal cleanup; explicit parent stop and restart retain their own restoration. */
export function restoreLinkClientRouting(expected: OcxClientConnectionConfig): LinkRoutingRestoreResult {
  if (siblingOfLivePort() !== null) return { success: true, restored: false, message: siblingSkipMessage() };
  if (!isLinkConnection(expected)) {
    return { success: true, restored: false, message: "Hub connection-owned integrations preserved." };
  }
  const preserve = () => process.env.OCX_SERVICE === "1" || isDesktopSupervised()
    || pendingTeardownOutstanding();
  if (preserve()) return { success: true, restored: false, message: "Supervised restart or pending teardown owns the client integrations." };
  const guard = stopRestoreWriteGuard(expected);
  const withWriteGuard = <T>(write: () => T): T => guard.run(() => {
    if (preserve()) throw new Error("restart or teardown ownership changed");
    const owner = journalOwner({ readOnly: true });
    if (existsSync(JOURNAL_PATH) && (owner?.kind !== "client" || owner.apiKeyId !== expected.apiKeyId)) {
      throw new Error("the Codex journal belongs to another owner or is unverified");
    }
    return write();
  });
  try {
    withWriteGuard(() => {
      const owner = journalOwner({ readOnly: true });
      if (owner === null) {
        const config = readBoundedCodexConfig(CODEX_CONFIG_PATH);
        if (existsSync(JOURNAL_PATH) || (config !== null && hasInjectedCodexRouting(config))) throw new Error("the client journal is missing or unverified");
      }
    });
    const result = restoreNativeCodex({ withWriteGuard });
    if (result.artifacts.config.state === "failed" || result.historyPreflightRefusal) {
      return refusal("native Codex restoration was not authorized or could not complete");
    }
    const grok = serviceEnvironmentOwnedHere() ? withWriteGuard(() => stripGrokConfig()) : { ok: true, changed: false };
    if (!result.success || !grok.ok) return refusal("native Codex or managed Grok restoration did not complete");
    return { success: true, restored: result.artifacts.config.changed || result.artifacts.catalog.changed || grok.changed,
      message: `Link Child native Codex and managed Grok restored; connection credentials preserved. ${resumeGuidance}` };
  } catch (error) {
    return refusal(error instanceof Error ? error.message : "restoration failed");
  }
}
