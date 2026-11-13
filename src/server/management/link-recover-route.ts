import { recoverRemoteChild } from "../../link/link-recover";
import { operationRecoveryResolver, type LinkRecoveryTarget } from "../../link/operation-recovery-slot";
import { readTombstones, removeTombstone, tombstonesPath } from "../../link/tombstones";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { serialized } from "./link-enrollment";
import { fail, isRecord, knownHostsFile, readStoreFor, runnerFor, type LinkRouteState } from "./link-route-state";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

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
    target = { linkId: found.linkId, alias: found.alias, hostKeyFingerprint: found.hostKeyFingerprint, ...(found.remotePlatform ? { remotePlatform: found.remotePlatform } : {}) };
  } else {
    const resolver = operationRecoveryResolver();
    if (!resolver) return fail("operation_journal_unavailable", "This Home has no link operation journal; recover by --link-id.", 409);
    const lookup = resolver.lookup(operationId!);
    if (lookup.kind === "not_found") return fail("operation_not_found", "No link operation has this id.", 404);
    if (lookup.kind === "not_residual") return fail("operation_not_residual", "This link operation left nothing on its Child to recover.", 409);
    target = lookup.target;
  }

  return serialized(state, target.alias, async () => {
    const outcome = await recoverRemoteChild(runnerFor(ctx), target, knownHostsFile(ctx));
    if (!outcome.ok) return fail(outcome.code, outcome.message, outcome.status, outcome.hint);
    try {
      withConfigMutationLockSync(() => { removeTombstone(target.linkId, tombstonesPath()); });
      if (operationId) operationRecoveryResolver()?.settle(operationId);
    } catch {
      return fail("tombstone_remove_failed", "The Child was cleaned, but its tombstone could not be removed; run recover again.", 503);
    }
    return Response.json({ linkId: target.linkId, outcome: "clean", purged: true }, { headers: { "cache-control": "no-store" } });
  });
}
