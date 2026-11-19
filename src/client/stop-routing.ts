import { existsSync } from "node:fs";
import { restoreNativeCodex } from "../codex/inject";
import { hasInjectedCodexRouting } from "../codex/injected-marker";
import { readBoundedCodexConfig } from "../codex/inject/bounded-config-reader";
import { journalOwner, JOURNAL_PATH } from "../codex/journal";
import { CODEX_CONFIG_PATH } from "../codex/paths";
import { siblingOfLivePort, siblingSkipMessage } from "../codex/sibling-start";
import type { OcxClientConnectionConfig } from "../types";
import { stripGrokConfig } from "../grok/inject";
import { isDesktopSupervised } from "../lib/system-restart-contract";
import { serviceEnvironmentOwnedHere } from "../service/guards";
import { stopRestoreWriteGuard } from "./restore-ownership";
import { isLinkConnection } from "./state";
import { linkNativeTeardownDecision, type LinkStopRuntime } from "./stop-native-handoff";

export type LinkRoutingRestoreResult = { success: boolean; restored: boolean; message: string; retainListener?: true };
type LinkRoutingRestoreOptions = { syncFenced: boolean; runtime?: LinkStopRuntime };

const resumeGuidance = "After starting the Child again, run `ocx sync --restart-codex` to restore its Home routing.";
const refusal = (reason: string): LinkRoutingRestoreResult => ({
  success: false, restored: false,
  message: `Link Child Codex routing restore refused: ${reason}. No further writes; inspect remaining recovery evidence.`,
});

function preserveSupervisedRouting(): boolean {
  return process.env.OCX_SERVICE === "1" || isDesktopSupervised();
}

/** Await file writers before releasing the socket, retaining it when safe cleanup is refused. */
export async function restoreLinkClientRoutingBeforeExit(
  expected: OcxClientConnectionConfig, options: LinkRoutingRestoreOptions,
): Promise<LinkRoutingRestoreResult> {
  expected = structuredClone(expected);
  options = { ...options, ...(options.runtime ? { runtime: { ...options.runtime } } : {}) };
  const retainOnRefusal = (result: LinkRoutingRestoreResult): LinkRoutingRestoreResult => result.success ? result : {
    ...result, retainListener: true,
    message: `${result.message} The listener remains bound; repair the reported evidence, then retry ocx stop.`,
  };
  // A parent receipt defers native Codex/Grok only. It never proves that a live owner
  // will remove Link file routes before this socket closes, even when the receipt is valid.
  if (siblingOfLivePort() !== null || !isLinkConnection(expected) || preserveSupervisedRouting()) {
    return retainOnRefusal(restoreLinkClientRouting(expected, options));
  }
  try {
    const { restoreLinkFileRouting } = await import("./stop-file-routing");
    if (!options.syncFenced) throw new Error("the runtime sync fence could not be verified");
    await restoreLinkFileRouting(expected, { beforeWrite: () => {
      if (preserveSupervisedRouting() || siblingOfLivePort() !== null) throw new Error("restart or teardown ownership changed");
    } });
  } catch (error) {
    return { success: false, restored: false, retainListener: true,
      message: `Link Child file routing restore refused: ${error instanceof Error ? error.message : "restoration failed"}. The listener remains bound; repair the client configuration or ownership evidence, then retry ocx stop.` };
  }
  return retainOnRefusal(restoreLinkClientRouting(expected, options));
}

/** Unsupervised signal cleanup; explicit parent stop and restart retain their own restoration. */
export function restoreLinkClientRouting(expected: OcxClientConnectionConfig, options: LinkRoutingRestoreOptions): LinkRoutingRestoreResult {
  if (siblingOfLivePort() !== null) return { success: true, restored: false, message: siblingSkipMessage() };
  if (!isLinkConnection(expected)) {
    return { success: true, restored: false, message: "Hub connection-owned integrations preserved." };
  }
  if (preserveSupervisedRouting()) return { success: true, restored: false, message: "Supervised restart owns native Codex and managed Grok restoration." };
  if (options?.syncFenced !== true) return refusal("the runtime sync fence could not be verified");
  const nativeTeardown = linkNativeTeardownDecision(options.runtime);
  if (nativeTeardown === "defer") return { success: true, restored: false, message: "The active parent stop owns native Codex and managed Grok restoration." };
  if (nativeTeardown === "refuse") return refusal("pending native teardown has no verified active parent stop");
  const guard = stopRestoreWriteGuard(expected);
  const withWriteGuard = <T>(write: () => T): T => guard.run(() => {
    if (preserveSupervisedRouting() || linkNativeTeardownDecision(options.runtime) !== "restore") throw new Error("restart or teardown ownership changed");
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
