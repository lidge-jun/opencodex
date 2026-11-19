/** File clients drain before disconnect removes its connection and service credential. */
import { loadConfig } from "../config";
import { lstatSync } from "node:fs";
import { readClientConnectionState, sameClientConnectionOwner } from "../client/state";
import { withClientLifecycle, withClientLifecycleSync, type ClientLifecycleLockDeps } from "../client/lifecycle-lock";
import { readDesktopDisconnectReceipt, type DesktopDisconnectReceipt } from "../claude/desktop-remote-store";
import { readServiceApiTokenState } from "../lib/service-secrets";
import { readLocalRouteIntentOff, readRouteIntentReceiptStrict, readRouteIntentUnappliedProof } from "./route-intent-state";
import { homeRouteIntentPath } from "../client/link-home";
import type { OcxClientConnectionConfig } from "../types";

/** Droid's empty-roster contribution has no selectors, so its generic classifier cannot prove absence. */
async function droidRoutingAbsent(port: number): Promise<boolean> {
  const { INTEGRATION_CLIENTS } = await import("./registry");
  const { defaultIntegrationIO, loadTarget } = await import("./config-io");
  const { createIntegrationStateStore } = await import("./store");
  const target = loadTarget(defaultIntegrationIO(createIntegrationStateStore()), INTEGRATION_CLIENTS.droid.configPath());
  if (!target.ok) return false;
  if (target.before === null) return true;
  try {
    const value: unknown = JSON.parse(target.before);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const rows = (value as Record<string, unknown>).customModels;
    if (rows === undefined) return true;
    if (!Array.isArray(rows)) return false;
    return rows.every(row => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      if (typeof row.displayName === "string" && row.displayName.startsWith("OpenCodex:")) return false;
      if (typeof row.baseUrl !== "string") return false;
      const url = new URL(row.baseUrl);
      return !(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port === String(port));
    });
  } catch { return false; }
}

export async function cleanupConnectedRouteIntent(
  connection: OcxClientConnectionConfig, expected: DesktopDisconnectReceipt, lifecycleLockDeps?: ClientLifecycleLockDeps, recoverConflicts = false,
): Promise<void> {
  const receipt = readRouteIntentReceiptStrict();
  if (!receipt) {
    let homeReceiptPresent = false;
    try { lstatSync(homeRouteIntentPath()); homeReceiptPresent = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (connection.link) {
      const { createIntegrationStateStore } = await import("./store");
      const { isIntegrationClientId } = await import("./registry");
      const { readIntegrationState } = await import("./state");
      const { listAsideProfileStores } = await import("./aside-profile-context");
      const store = createIntegrationStateStore();
      const records = store.readRecordsStrict();
      // Connect proved, for this exact connection, that no route apply has begun (`--no-sync`, an
      // older Home). An ownership record then predates the link: it is the person's standalone
      // integration, which disconnect keeps. Unowned routing residue still refuses below.
      const proof = readRouteIntentUnappliedProof();
      const neverApplied = !homeReceiptPresent && proof?.linkId === connection.link.linkId && proof.connectedAt === connection.connectedAt;
      const owned = !neverApplied && (Object.keys(records).length > 0
        || listAsideProfileStores(store).some(child => Object.keys(child.store.readRecordsStrict()).length > 0));
      const standalone = (id: string) => neverApplied && records[id as keyof typeof records] !== undefined;
      const config = loadConfig();
      // Older Homes and --no-sync may never invoke the controller. Only disk absence,
      // not selectedClients alone, proves those file clients have nothing to drain.
      const unproved = connection.selectedClients.some(id => id !== "codex" && id !== "claude" && !standalone(id)
        && (!isIntegrationClientId(id) || readIntegrationState({ clientId: id, config, port: config.port, models: [], store }).state !== "absent"));
      const droidUnproved = connection.selectedClients.includes("droid") && !standalone("droid") && !await droidRoutingAbsent(config.port);
      if (homeReceiptPresent || owned || unproved || droidUnproved) {
        throw new Error("Route intent cleanup receipt is missing; preserve the connection and repair its route ownership evidence before disconnect");
      }
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
  // Integrations the Child owned before this link come back instead of being removed; a local
  // opt-out is the person's own later choice and wins.
  const { readFileIntentOriginals } = await import("../client/route-intent-file-originals");
  const originals = readFileIntentOriginals();
  const optedOut = new Set<string>(readLocalRouteIntentOff());
  const standalone = originals?.linkId === connection.link.linkId
    ? Object.fromEntries(Object.entries(originals.clients).filter(([client]) => !optedOut.has(client))) : {};
  const outcomes = await cleanupRouteIntent({ config, linkId: connection.link.linkId, document: receipt.document, models: receipt.models ?? [], beforeWrite: guard, recoverConflicts,
    withReceiptWrite: write => withClientLifecycleSync(() => { guard(); write(); }, lifecycleLockDeps),
    withFileWrites: work => withClientLifecycle(work, lifecycleLockDeps) }, standalone);
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
