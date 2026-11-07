/** File clients drain before disconnect removes its connection and service credential. */
import { loadConfig } from "../config";
import { lstatSync } from "node:fs";
import { readClientConnectionState, sameClientConnectionOwner } from "../client/state";
import { withClientLifecycle, withClientLifecycleSync, type ClientLifecycleLockDeps } from "../client/lifecycle-lock";
import { readDesktopDisconnectReceipt, type DesktopDisconnectReceipt } from "../claude/desktop-remote-store";
import { readServiceApiTokenState } from "../lib/service-secrets";
import { readRouteIntentReceiptStrict } from "./route-intent-state";
import { homeRouteIntentPath } from "../client/link-home";
import type { OcxClientConnectionConfig } from "../types";

export async function cleanupConnectedRouteIntent(
  connection: OcxClientConnectionConfig, expected: DesktopDisconnectReceipt, lifecycleLockDeps?: ClientLifecycleLockDeps, recoverConflicts = false,
): Promise<void> {
  const receipt = readRouteIntentReceiptStrict();
  if (!receipt) {
    let homeReceiptPresent = false;
    try { lstatSync(homeRouteIntentPath()); homeReceiptPresent = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (connection.link && (connection.selectedClients.some(id => id !== "codex" && id !== "claude") || homeReceiptPresent)) {
      throw new Error("Route intent cleanup receipt is missing; preserve the connection and repair its route ownership evidence before disconnect");
    }
    return;
  }
  // A valid unbound receipt is standalone Home state, not evidence of a Child apply.
  if (receipt.linkId === undefined) return;
  if (!connection.link || receipt.linkId !== connection.link.linkId) throw new Error("Route intent cleanup receipt belongs to another context; preserve it before disconnect");
  const guard = () => {
    const pending = readDesktopDisconnectReceipt();
    const current = readClientConnectionState();
    const token = readServiceApiTokenState();
    if (pending.kind !== "valid" || JSON.stringify(pending.value) !== JSON.stringify(expected)
      || current.kind !== "connected" || !sameClientConnectionOwner(current.value, connection)
      || current.value.pendingOperation || token.kind !== "present" || token.fingerprint !== connection.tokenFingerprint) {
      throw new Error("client_disconnect_owner_changed");
    }
  };
  const local = loadConfig();
  const { cleanupRouteIntent } = await import("./route-intent");
  const { stripGrokConfig } = await import("../grok/inject");
  const { injectClaudeAgentDefs } = await import("../claude/agents-inject");
  const config = { ...local, hostname: "127.0.0.1", unauthenticatedLoopbackListener: undefined };
  const outcomes = await cleanupRouteIntent({ config, linkId: connection.link.linkId, document: receipt.document, models: receipt.models ?? [], beforeWrite: guard, recoverConflicts,
    withReceiptWrite: write => withClientLifecycleSync(() => { guard(); write(); }, lifecycleLockDeps),
    withFileWrites: work => withClientLifecycle(work, lifecycleLockDeps) });
  if (outcomes.some(row => row.outcome !== "current")) throw new Error("Route intent cleanup was partial; ownership and disconnect receipts retained. Repair the conflicting client and rerun ocx disconnect.");
  withClientLifecycleSync(() => {
    guard();
    const grok = stripGrokConfig();
    if (!grok.ok) throw new Error("Grok route cleanup was partial; rerun ocx disconnect after repair");
    const config = loadConfig();
    const agents = injectClaudeAgentDefs({ ...config, claudeCode: { ...config.claudeCode, enabled: false } }, {});
    if (agents === null) throw new Error("Claude route cleanup was partial; rerun ocx disconnect after repair");
    guard();
  }, lifecycleLockDeps);
}
