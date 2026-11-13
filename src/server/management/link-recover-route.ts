import { recoverRemoteChild } from "../../link/link-recover";
import { operationRecoveryResolver, type LinkRecoveryTarget } from "../../link/operation-recovery-slot";
import { readTombstones, removeTombstone, tombstonesPath } from "../../link/tombstones";
import { readLinkRetirement } from "../../link/retirement";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { serialized } from "./link-enrollment";
import { underAliasLock } from "./link-operation";
import { fail, isRecord, knownHostsFile, readStoreFor, runnerFor, type LinkRouteState } from "./link-route-state";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const noStore = { headers: { "cache-control": "no-store" } };

/** GET /api/link/recover: the forced revokes still waiting for cleanup (no fingerprints, no routes). */
export function handleLinkRecoverList(): Response {
  let store;
  try { store = readTombstones(tombstonesPath()); } catch {
    return fail("tombstone_store_unreadable", "The link tombstone file cannot be read; it was left as it is.", 503);
  }
  return Response.json({
    tombstones: store.tombstones.map(t => ({ linkId: t.linkId, alias: t.alias, revokedAt: t.revokedAt, ...(t.remotePlatform ? { remotePlatform: t.remotePlatform } : {}) })),
  }, noStore);
}

/**
 * POST /api/link/recover {linkId} | {operationId}: clean an ephemeral Child a forced revoke (a
 * tombstone) or an interrupted enrollment (the O1 journal) left behind. The tombstone or journal
 * entry is settled only on the Child's receipt bound to that link.
 */
export async function handleLinkRecover(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const body = await readManagementJsonBodyOr(ctx.req, null);
  const fields: Record<string, unknown> = isRecord(body) ? body : {};
  const keys = Object.keys(fields);
  const only = (key: string, pattern: RegExp): string | null => {
    const value = fields[key];
    return keys.length === 1 && keys[0] === key && typeof value === "string" && pattern.test(value) ? value : null;
  };
  const linkId = only("linkId", LINK_ID);
  const operationId = only("operationId", OPERATION_ID);
  if (!linkId && !operationId) return fail("invalid_body", "Send exactly one of linkId (lnk_ and 16 hex digits) or operationId.", 400);

  let target: LinkRecoveryTarget;
  if (linkId) {
    if (readStoreFor(ctx).links.some(link => link.id === linkId)) {
      return fail("link_present", "This link still exists; revoke it with --purge instead.", 409);
    }
    let found;
    try { found = readTombstones(tombstonesPath()).tombstones.find(t => t.linkId === linkId); } catch {
      return fail("tombstone_store_unreadable", "The link tombstone file cannot be read; it was left as it is.", 503);
    }
    if (!found) return fail("tombstone_not_found", "No forced revoke of this link is waiting for cleanup.", 404);
    target = {
      linkId: found.linkId, alias: found.alias, hostKeyFingerprint: found.hostKeyFingerprint,
      ...(found.remotePlatform ? { remotePlatform: found.remotePlatform } : {}),
      ...(found.explicitRoute ? { explicitRoute: found.explicitRoute } : {}),
    };
  } else {
    const resolver = operationRecoveryResolver();
    if (!resolver) return fail("operation_journal_unavailable", "This Home has no link operation journal; recover by --link-id.", 409);
    const lookup = resolver.lookup(operationId!);
    if (lookup.kind === "not_found") return fail("operation_not_found", "No link operation has this id.", 404);
    if (lookup.kind === "not_residual") return fail("operation_not_residual", "This link operation left nothing on its Child to recover.", 409);
    target = lookup.target;
  }

  // Under the alias lock enrollment and revoke take (src/link/alias-lock.ts, across processes) and the per-alias
  // operation set within this runtime, both keyed without case.
  return underAliasLock(ctx, target.alias, true, () => serialized(state, target.alias, async () => {
    // Under the lock a removal of this link takes: the link must still be gone, and its removal finished. A retirement
    // receipt still outstanding (#8416) means the revoke has not settled; recovering now would let its retry act on a
    // Child already cleaned (and, before, write a fresh tombstone for it).
    if (readStoreFor(ctx).links.some(link => link.id === target.linkId)) {
      return fail("link_present", "This link still exists; revoke it with --purge instead.", 409);
    }
    let pending: boolean;
    try { pending = readLinkRetirement(target.linkId) !== null; } catch { pending = true; }
    if (pending) {
      return fail("link_retirement_pending", "This link's removal is unfinished; repeat ocx link revoke for it to finish, then recover.", 409);
    }
    // A Home-initiated link that still names this alias may own the Child now: a re-enrollment, or one whose
    // revoke ran its disconnect but did not commit (journalled or not). Recover would then settle the old
    // link and purge the binary under it, so it waits until no such link exists. Read under the lock.
    const wanted = target.alias.toLowerCase();
    if (readStoreFor(ctx).links.some(link => link.direction === "hub-initiated" && link.alias.toLowerCase() === wanted)) {
      return fail("alias_linked", "A link to this machine's alias still exists, so its Child may belong to that link; settle any open operation on that link (ocx link operations), revoke the link, then recover.", 409);
    }
    const outcome = await recoverRemoteChild(runnerFor(ctx), target, knownHostsFile(ctx));
    if (!outcome.ok) return fail(outcome.code, outcome.message, outcome.status, outcome.hint);
    try {
      withConfigMutationLockSync(() => { removeTombstone(target.linkId, tombstonesPath()); });
      if (operationId) operationRecoveryResolver()?.settle(operationId);
    } catch {
      return fail("tombstone_remove_failed", "The Child was cleaned, but its tombstone could not be removed; run recover again.", 503);
    }
    return Response.json({ linkId: target.linkId, outcome: "clean", purged: outcome.purged }, noStore);
  }));
}
