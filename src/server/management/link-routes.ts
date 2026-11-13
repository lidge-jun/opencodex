import { randomBytes } from "node:crypto";
import { isRouteClientId, ROUTE_CLIENT_IDS } from "../../link/route-intent";
import { seedRouteDeviceClients, reconcileHomeRouteDevices } from "../../routing/home-route-intent";
import { probe, confirmHost, apply, serialized } from "./link-enrollment";
import { fail, pairedSession, auth, port, isRecord, exactBody, runnerFor, readStoreFor, writeStoreFor, knownHostsFile, issueKey, revokeKeyIdempotent, compensateNewLink, reconcileLinkListener, type LinkRouteState } from "./link-route-state";
export type { LinkRouteState, PendingLinkHost, ConfirmedLinkHost, LinkRouteListener } from "./link-route-state";
import { requireRemotePlatform } from "../../link/remote-platform";
import { CHILD_USAGE_EXIT, classifyBoundRefusal, purgeDisconnectRemote } from "../../link/remote-plant";
import { assertSshAlias, buildExecArgv, remoteOcxArgv } from "../../link/ssh-argv";
import { clearCompensationFailed, compensationPath, readCompensation } from "../../link/compensation";
import { LinkTombstoneLimitError, readTombstones, recordTombstone, removeOwnTombstone, tombstoneNamesAlias, tombstonesPath, type LinkTombstone } from "../../link/tombstones";
import { loadHostCandidates } from "../../link/ssh-config";
import { effectiveLinkRoutes, newLinkId, type LinkStore } from "../../link/store";
import { claimLinkRetirement, clearLinkRetirement, disownLinkRetirement, readLinkRetirement, reownLinkRetirement, type LinkRetirement, type LinkRetirementMode } from "../../link/retirement";
import { sshFailureHint, sshRunnerErrorHint } from "../../link/ssh-runner";
import { attachLinkPeers, attachLinkRoutes, attachLinkTransport, attachLinkTunnelDiagnostics, projectLinkStatus, type LinkStatusDto } from "../../link/status-projection";
import { homeLinkChildParity } from "../../link/child-parity";
import { codexSettingsDigest, projectHomeCodexSettings } from "../../link/codex-settings";
import { localLinkPeer } from "../../link/compatibility";
import { packageVersion } from "../../lib/package-version";
import { buildPeerFeatures } from "../../remote/features";
import { isLinkPort } from "../../link/ports";
import { joinHome, type ClientLinkJoinDeps } from "../../client/link-join";
import { clientLinkStatusIdentity } from "../../client/link-status";
import { clientLinkTunnelStatus } from "../../client/link-tunnel";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr, readOptionalManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { linkDiagnosticsResponse } from "./link-diagnostics-route";
import { type IssuedApiKey } from "./oauth-account-routes";
import { acceptSystemRestart, resolveListenPort } from "./system-restart";
import { cleanupRecorded, journalInUse, journalOpenFailure, journalPathFor, journalUnreadable, NO_REVOKE_JOURNAL, openRevokeConflict, openRevokeJournal, replayOperation, resumedRevokeJournal, retirementOwner, revokeOperationDigest, fenceRetirementOwnerForForce, settleResumedRevoke, underAliasLock, type ForceTakeover, type RevokeJournal } from "./link-operation";
import { findOperation, isOperationId, readOperationsJournal, revokeSuspendingLink } from "../../link/operations-journal";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const isLinkPath = (path: string): boolean => path === "/api/link" || path.startsWith("/api/link/");

const states = new WeakMap<object, LinkRouteState>();
// One process runs at most one join: a join ends by restarting this process as a client.
let joinInProgress = false;

/**
 * The client runtime a join restarts into binds exactly the configured port, with no fallback.
 * A standalone that runs elsewhere (`ocx start --port`, or a port fallback) would restart into a
 * proxy that cannot bind where Codex is routed, so it may not join.
 */
function joinPortMatches(ctx: ManagementContext): boolean {
  const live = (ctx.deps.liveListenPort ?? resolveListenPort)();
  return live !== undefined && live === ctx.config.port;
}

type LinkJoinDenied = "pairing_required" | "standalone_required" | "join_port_mismatch";

/** Read-only explanation of the join gates, in the same order as `POST /api/link/join`. */
function joinDenied(ctx: ManagementContext): LinkJoinDenied | null {
  if (!pairedSession(ctx)) return "pairing_required";
  if ((ctx.config.runtimeRole ?? "standalone") !== "standalone") return "standalone_required";
  if (!joinPortMatches(ctx)) return "join_port_mismatch";
  return null;
}

function stateFor(ctx: ManagementContext): LinkRouteState | null {
  const supervisor = ctx.deps.linkSupervisor?.();
  const listener = ctx.deps.linkListener?.();
  if (!supervisor || !listener) return null;
  const key = ctx.config as object;
  const existing = states.get(key);
  if (existing) return existing;
  const state: LinkRouteState = {
    pendingHosts: new Map(),
    confirmedHosts: new Map(),
    compensationFailures: new Map(),
    supervisor,
    listener,
  };
  states.set(key, state);
  return state;
}

async function candidates(ctx: ManagementContext): Promise<Response> {
  const values = ctx.deps.loadLinkCandidates?.() ?? loadHostCandidates();
  return Response.json({ candidates: values.map(value => ({ alias: value.alias, source: value.source })) });
}

async function issue(ctx: ManagementContext): Promise<Response> {
  const raw = await readManagementJsonBodyOr(ctx.req, null);
  const body = exactBody(raw, isRecord(raw) && Object.hasOwn(raw, "selectedClients") ? ["alias", "tunnelPort", "selectedClients"] : ["alias", "tunnelPort"]);
  if (!body || typeof body.alias !== "string" || !isLinkPort(body.tunnelPort)) return fail("invalid_body", "alias and tunnelPort are required.", 400);
  try { assertSshAlias(body.alias); } catch { return fail("invalid_alias", "alias must be a valid SSH host alias.", 400); }
  const selection = body.selectedClients;
  if (selection !== undefined && (!Array.isArray(selection) || selection.length === 0 || selection.length > ROUTE_CLIENT_IDS.length || !selection.every(isRouteClientId) || new Set(selection).size !== selection.length)) return fail("invalid_body", "selectedClients must contain unique supported clients", 400);
  let issued: IssuedApiKey;
  try { issued = issueKey(ctx, `link:${body.alias}`); }
  catch { return fail("key_issue_failed", "The link key could not be issued.", 503); }
  const id = newLinkId();
  const state = stateFor(ctx);
  if (!state) {
    if (!revokeKeyIdempotent(ctx, issued.id)) {
      console.warn(`[link] compensation_failed apiKeyId=${issued.id} phase=revoke-without-lifecycle`);
      return fail("compensation_failed", "The link compensation could not be completed.", 500);
    }
    return fail("link_unavailable", "The link lifecycle is unavailable.", 503);
  }
  const record = { id, alias: body.alias, direction: "client-initiated" as const, hostKeyFingerprint: null, tunnelPort: body.tunnelPort, apiKeyId: issued.id, createdAt: new Date((ctx.deps.now ?? Date.now)()).toISOString() };
  let failureCode = "link_issue_failed";
  try {
    // Same atomic duplicate-check+append as the hub-initiated branch.
    const writeOutcome = withConfigMutationLockSync((): "dup" | "written" => {
      const current = readStoreFor(ctx);
      if (current.links.some(link => link.id === id)) throw new Error("link id collision");
      if (current.links.some(link => link.alias === body.alias && link.direction === "client-initiated")) return "dup";
      writeStoreFor(ctx, { ...current, links: [...current.links, record] });
      return "written";
    });
    if (writeOutcome === "dup") {
      const compensation = await compensateNewLink(ctx, state, record);
      return compensation ?? fail("link_exists", "A link for this alias already exists.", 409);
    }
    withConfigMutationLockSync(() => seedRouteDeviceClients(ctx.config, ctx.version, id, selection as import("../../link/route-intent").RouteClientId[] | undefined, readStoreFor(ctx).links.map(link => link.id)));
    await state.listener.ensureStarted();
    if (state.listener.status().state !== "listening") {
      failureCode = "listener_unavailable";
      throw new Error("link listener unavailable");
    }
    await state.supervisor.ensureStarted();
    const boundStore = readStoreFor(ctx);
    if (!port(boundStore.listenerPort)) throw new Error("link listener did not bind");
    return Response.json({ linkId: id, apiKeyId: issued.id, key: issued.key, listenerPort: boundStore.listenerPort });
  } catch {
    const compensation = await compensateNewLink(ctx, state, record);
    return compensation ?? fail(failureCode, failureCode === "listener_unavailable" ? "The link listener is unavailable." : "The link could not be issued.", 503);
  }
}

type LinkJoinRouteOverrides = {
  joinHome?: typeof joinHome;
};

function joinRouteOverrides(ctx: ManagementContext): LinkJoinRouteOverrides {
  return ctx.deps as ManagementApiDepsWithJoinOverrides;
}

type ManagementApiDepsWithJoinOverrides = ManagementContext["deps"] & LinkJoinRouteOverrides;

function joinFailure(error: unknown): Response {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  const hint = error && typeof error === "object" && "hint" in error && typeof error.hint === "string" ? error.hint : undefined;
  switch (code) {
    case "host_not_confirmed": return fail("host_not_confirmed", "Confirm the SSH host before joining the link.", 409);
    case "host_confirmation_expired": return fail("host_confirmation_expired", "The SSH host confirmation has expired.", 409);
    case "join_port_failed": return fail("join_port_failed", "No local port is available for the link tunnel.", 503);
    case "join_issue_failed": return fail("join_issue_failed", "The home could not issue a link.", 502, hint);
    case "remote_ocx_missing": return fail("remote_ocx_missing", "ocx was not found on the home.", 502, hint);
    case "join_tunnel_failed": return fail("join_tunnel_failed", "The SSH tunnel to the home did not become ready.", 502);
    case "admission_failed": return fail("admission_failed", "The home refused the issued link key.", 502);
    case "join_rollback_failed": {
      const linkId = error && typeof error === "object" && "linkId" in error && typeof error.linkId === "string" ? error.linkId : "unknown";
      return fail("join_rollback_failed", `The join failed and the home link could not be revoked; run ocx link revoke --link-id ${linkId} on the home.`, 502);
    }
    case "join_restart_failed": return fail("join_restart_failed", "The link is ready; restart OpenCodex to finish connecting as a Child.", 500);
    default: return fail("join_connect_failed", "The client link join could not be completed.", 502);
  }
}

async function handleJoin(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const body = exactBody(await readManagementJsonBodyOr(ctx.req, null), ["alias"]);
  if (!body || typeof body.alias !== "string") return fail("invalid_body", "alias is required.", 400);
  try { assertSshAlias(body.alias); } catch { return fail("invalid_alias", "alias must be a valid SSH host alias.", 400); }
  if (joinInProgress) return fail("join_in_progress", "A link join is already in progress.", 409);
  joinInProgress = true;
  try {
    const confirmed = state.confirmedHosts?.get(body.alias);
    const overrides = joinRouteOverrides(ctx);
    const deps: ClientLinkJoinDeps = {
      runner: runnerFor(ctx),
      knownHostsFile: knownHostsFile(ctx),
      scheduleRestart: () => { acceptSystemRestart(); },
      ...(confirmed && confirmed.runtimeKind !== "missing" && confirmed.ocxVersion !== null ? { confirmedHost: confirmed } : {}),
    };
    const result = await (overrides.joinHome ?? joinHome)(deps, { alias: body.alias });
    return Response.json({ linkId: result.linkId, alias: body.alias, restarting: true }, { status: 202 });
  } catch (error) {
    return joinFailure(error);
  } finally {
    joinInProgress = false;
  }
}

/**
 * Restart a Home-initiated link's tunnel now: the dashboard's Retry and `ocx link reconnect`.
 * The supervisor stops the current ssh child, if any, forgets its backoff or failed state and
 * spawns a fresh attempt; status then reports it like any other attempt.
 */
async function reconnect(ctx: ManagementContext, state: LinkRouteState, id: string): Promise<Response> {
  if (!LINK_ID.test(id)) return fail("invalid_link_id", "The link id is invalid.", 400);
  const record = readStoreFor(ctx).links.find(link => link.id === id);
  if (!record) return fail("link_not_found", "The link was not found.", 404);
  if (record.direction !== "hub-initiated") {
    return fail("link_not_home_initiated", "Only a Home-initiated link has a tunnel this computer can restart.", 409);
  }
  try {
    // A reverse forward may only target a port the link listener owns, as when a link is applied.
    await state.listener.ensureStarted();
    if (state.listener.status().state !== "listening") return fail("listener_unavailable", "The link listener is unavailable.", 503);
    await state.supervisor.ensureStarted();
    const restarted = await state.supervisor.reconnect(id);
    if (restarted === "suspended") return suspendedRefusal(ctx, id);
    if (!restarted) return fail("link_unavailable", "The link tunnel could not be restarted.", 503);
  } catch {
    return fail("link_unavailable", "The link tunnel could not be restarted.", 503);
  }
  return Response.json({ linkId: id });
}

/** 409 link_suspended: an unsettled revoke keeps the tunnel down (revokeSuspendsLink); the answer names it and the way out. */
function suspendedRefusal(ctx: ManagementContext, id: string): Response {
  const suspension = revokeSuspendingLink(journalPathFor(ctx), id);
  const headers = { "cache-control": "no-store" };
  if (!suspension) {
    return Response.json({ error: { code: "link_suspended", message: "An unsettled revoke keeps this link's tunnel down; see ocx link operations." } }, { status: 409, headers });
  }
  const op = suspension.operationId;
  const resolve = "ocx link operations resolve --operation-id " + op + " --yes";
  const message = suspension.state === "unknown"
    ? "Revoke operation " + op + " ended unknown and may have disconnected or purged the Child, so this link's tunnel stays down. Check the Child, then run: " + resolve
    : "Revoke operation " + op + " did not record its outcome (the Home stopped or the revoke failed before writing it), so this link's tunnel stays down. Repeat it with the flags of the first attempt: ocx link revoke --link-id " + id + " --operation-id " + op + ", with --purge only if the first attempt had it (the journal keeps only a digest of the flags, so a different --purge answers operation_mismatch); if it then ends unknown, run: " + resolve;
  return Response.json({ error: { code: "link_suspended", message }, operationId: op, operationState: suspension.state }, { status: 409, headers });
}

function validRemoveBody(payload: unknown): payload is Record<string, unknown> {
  return isRecord(payload)
    && !Object.keys(payload).some(key => key !== "force" && key !== "purge" && key !== "operationId")
    && (payload.force === undefined || typeof payload.force === "boolean")
    && (payload.purge === undefined || typeof payload.purge === "boolean")
    && !(payload.force === true && payload.purge === true)
    && (payload.operationId === undefined || isOperationId(payload.operationId));
}

async function remove(ctx: ManagementContext, state: LinkRouteState, id: string): Promise<Response> {
  if (!LINK_ID.test(id)) return fail("invalid_link_id", "The link id is invalid.", 400);
  let payload: unknown;
  try { payload = await readOptionalManagementJsonBody(ctx.req); }
  catch (error) {
    rethrowManagementBodyTooLarge(error);
    return fail("invalid_body", "force and purge must be booleans and cannot both be true.", 400);
  }
  if (payload === null || payload === undefined) payload = {};
  const valid = validRemoveBody(payload);
  const body = (valid ? payload : {}) as Record<string, unknown>;
  const force = valid && body.force === true, purge = valid && body.purge === true;
  // ocx link revoke --operation-id (structure/remote-link.md, "Operation journal"): a recorded revoke replays even
  // after its link is gone, under the lock of the alias it recorded.
  const operation = valid && typeof body.operationId === "string" ? { id: body.operationId, digest: revokeOperationDigest({ linkId: id, purge, force }) } : null;
  if (operation) {
    let recordedAlias: string | undefined;
    try { recordedAlias = findOperation(readOperationsJournal(journalPathFor(ctx)), operation.id)?.alias; } catch {
      return journalUnreadable();
    }
    if (recordedAlias !== undefined) {
      // Another write may prune the entry between that read and the replay: then this is a first revoke after all,
      // run below once the replay has released the alias lock.
      const notRecorded = new Response(null, { status: 204 });
      const replayed = await underAliasLock(ctx, recordedAlias, true, async () =>
        (await resumeRetirementBeforeReplay(ctx, state, id, operation, force, purge, true)) ?? (await replayOperation(ctx, state, operation, "revoke")) ?? notRecorded);
      if (replayed !== notRecorded) return replayed;
    }
  }
  // An interrupted removal resumes from its retirement receipt even after the record is gone.
  const target = readRemovalTarget(ctx, id);
  if ("response" in target) return target.response;
  // A queued or running job would keep opening SSH sessions to a Child this removal disconnects, so removal takes the
  // link's job admission lock before its first teardown await and holds it to the end: a job submitted meanwhile gets
  // 409 (single link) or a busy item, and a link a job already holds is refused here, before anything is stopped.
  const { childOpsEngineFor } = await import("./link-child-ops-routes");
  const releaseLink = childOpsEngineFor(state).reserve(id);
  if (!releaseLink) return fail("link_operation_in_progress", "A Child operation is running on this link; wait for it to finish, then remove the link.", 409);
  // The body is judged after the reservation, as it was before revokes were journalled (404, then 409, then 400).
  if (!valid) { releaseLink(); return fail("invalid_body", "force and purge must be booleans and cannot both be true.", 400); }
  try {
    // Enrollment and revoke of one alias are serialized: a force revoke cannot run between a purge and its receipt.
    // Also whenever a tombstone names this alias: recover may run against that machine under the alias lock.
    const admitted = operation !== null || journalInUse(ctx) || tombstoneNamesAlias(target.record.alias);
    // A journalled revoke, and every revoke once this Home journals, also takes the per-alias operation set that apply
    // holds for its whole run, so an apply and a revoke of one alias never overlap in this runtime.
    const exclusive = (action: () => Promise<Response>) => admitted ? serialized(state, target.record.alias, action) : action();
    return await underAliasLock(ctx, target.record.alias, admitted, () => exclusive(async () => {
      if (operation) {
        const resumed = await resumeRetirementBeforeReplay(ctx, state, id, operation, force, purge, false);
        if (resumed) return resumed;
        const replay = await replayOperation(ctx, state, operation, "revoke");
        if (replay) return replay;
      }
      // A plain --force may finish any receipt (foreignRetirement). Its refusals run first, before anything changes. Then its
      // owner, if open or unknown, is fenced for the whole takeover (fenceRetirementOwnerForForce) and the receipt is disowned,
      // so the owner is never credited with this removal and a link the force could not remove stays suspended; a takeover
      // that stops before its removal begins restores the owner as it was. A damaged journal does not stop a plain force
      // (as on dev): its owner cannot be fenced, but the receipt is still disowned. A readable journal whose owner cannot
      // be fenced refuses before the receipt changes hands.
      const plainForce = !operation && force;
      let forceReceipt: ReturnType<typeof readLinkRetirement> = null;
      let ownerId: string | undefined;
      let journalReadable = true;
      if (plainForce) {
        try { forceReceipt = readLinkRetirement(id); } catch { return fail("link_remove_failed", "The link retirement could not be read.", 503); }
        if (forceReceipt) {
          try { ownerId = retirementOwner(readOperationsJournal(journalPathFor(ctx)), forceReceipt, true)?.operationId; } catch { journalReadable = false; }
        }
      }
      const open = openRevokeConflict(ctx, id, operation?.id ?? ownerId, plainForce);
      if (open) return open;
      let fresh = readRemovalTarget(ctx, id);
      if ("response" in fresh) return fresh.response;
      const owned = foreignRetirement(ctx, fresh.receipt, operation?.id, force);
      if (owned) return owned;
      let takeover: ForceTakeover | null = null;
      let disownedReceipt: LinkRetirement | null = null;
      try {
        if (plainForce && forceReceipt) {
          if (journalReadable) {
            try { takeover = fenceRetirementOwnerForForce(ctx, forceReceipt); } catch {
              return fail("operation_journal_failed", "The unfinished revoke that owns this link's removal could not be settled; nothing was changed. Retry the request.", 500);
            }
          }
          let disowned: boolean;
          try {
            if (forceReceipt.operationId === undefined) disowned = true;
            else { disownedReceipt = disownLinkRetirement(forceReceipt); disowned = disownedReceipt !== null; }
          } catch { disowned = false; }
          if (!disowned) return fail("link_changed", "The link changed during removal.", 409);
          fresh = readRemovalTarget(ctx, id);
          if ("response" in fresh) return fresh.response;
        }
        let journal: RevokeJournal = takeover?.journal ?? NO_REVOKE_JOURNAL;
        if (operation) {
          try { journal = openRevokeJournal(ctx, operation, fresh.record.alias, id); } catch (error) {
            return journalOpenFailure(error);
          }
        }
        try { return await journal.finish(await removeReserved(ctx, state, id, fresh.record, fresh.receipt, force, purge, journal)); } finally { journal.release(); }
      } finally {
        if (takeover) {
          if (takeover.began) {
            try { takeover.settle(); } catch { /* the owner stays open: suspended, and replayed on repeat */ }
          } else {
            // The removal never reached the tunnel: the receipt goes back to its owner and the owner is restored as it was.
            try { if (disownedReceipt && forceReceipt?.operationId) reownLinkRetirement(disownedReceipt, forceReceipt.operationId); } catch { /* a plain force can still finish it */ }
            try { takeover.abandon(); } catch { /* the owner stays open: suspended, and replayed on repeat */ }
          }
        }
      }
    }));
  } finally { releaseLink(); }
}

const removalMode = (force: boolean, purge: boolean): LinkRetirementMode => force ? "force" : purge ? "purge" : "disconnect";

/**
 * A fresh removal that meets an interrupted removal's receipt continues it only under the same identity (#8416).
 * While the owning entry is journalled, only that operation continues it (its replay resumes the receipt and settles
 * the entry from its own evidence); anything else would be credited with a removal, or a Child purge, it never ran
 * and would clear the receipt the owner settles from. A receipt with no owner, or whose owning entry the journal has
 * pruned, has no evidence any new journal entry could truthfully settle from, not even one reusing the old id: only a
 * plain revoke, which writes no journal and claims no outcome, may finish it.
 * A plain --force may finish any receipt: it removes the link and its key locally, claims no Child cleanup, writes no
 * journal and leaves an owning entry with the outcome it recorded. It is the way out when the recorded cleanup cannot
 * be repeated (a purge already removed the Child's executable).
 */
function foreignRetirement(ctx: ManagementContext, receipt: ReturnType<typeof readLinkRetirement>, operationId: string | undefined, force: boolean): Response | null {
  if (!receipt || (operationId === undefined && force)) return null;
  let ownerJournalled = false;
  if (receipt.operationId !== undefined) {
    try { ownerJournalled = retirementOwner(readOperationsJournal(journalPathFor(ctx)), receipt) !== undefined; } catch {
      return journalUnreadable();
    }
  }
  if (ownerJournalled) {
    return receipt.operationId === operationId ? null
      : fail("link_retirement_owned", `This link's removal was interrupted under operation ${receipt.operationId}; repeat it with --operation-id ${receipt.operationId} to finish it, or remove it locally with --force and no --operation-id.`, 409);
  }
  return operationId === undefined ? null
    : fail("link_retirement_owned", "This link's removal was interrupted with no journalled operation left to settle it; repeat ocx link revoke without --operation-id (with --force if its Child cleanup cannot run again) to finish it.", 409);
}

/**
 * Before a recorded revoke replays its outcome, finish the retirement it left behind (#8416). A revoke interrupted
 * after its record removal, or one whose post-commit cleanup failed, would otherwise replay as committed (or unknown)
 * with the retired device's route intent, the listener reconciliation and the receipt still pending. The cleanup
 * resumes in the receipt's own mode; once it finishes, a revoke whose removal intent preceded the record's
 * disappearance is settled as committed. Returns the cleanup's failure, or null to replay.
 *
 * A resume takes the link's Child-job reservation first (unless the caller already holds it), as a fresh removal
 * does: a job admitted after the restart must not run while the resume revokes its key. While the record is still
 * listed (the process died after claiming the receipt), the resumed revoke and removal are marked on this entry.
 * Only this operation's own receipt, in the mode it asked for, is resumed: a receipt another removal claimed
 * (another operation, or none) leaves the recorded outcome to replay as it stands.
 */
async function resumeRetirementBeforeReplay(
  ctx: ManagementContext, state: LinkRouteState, id: string, operation: { id: string; digest: string }, force: boolean, purge: boolean, reserve: boolean,
): Promise<Response | null> {
  let receipt: ReturnType<typeof readLinkRetirement>;
  let recordListed: boolean;
  try {
    const op = findOperation(readOperationsJournal(journalPathFor(ctx)), operation.id);
    if (!op || op.kind !== "revoke" || op.digest !== operation.digest || op.linkId !== id) return null;
    receipt = readLinkRetirement(id);
    recordListed = readStoreFor(ctx).links.some(link => link.id === id);
  } catch { return fail("link_remove_failed", "The link retirement could not be read.", 503); }
  // A plain --force took this operation's receipt over and stopped (or died) before committing anything: the record is still
  // listed and its key still present, so the force removed nothing and this operation takes its receipt back and finishes
  // from its own evidence. Once the force has revoked the key or removed the record, the receipt stays the force's.
  if (receipt && receipt.operationId === undefined && receipt.formerOwner === operation.id && receipt.mode === removalMode(force, purge)
    && recordListed && (ctx.config.apiKeys ?? []).some(key => key.id === receipt!.link.apiKeyId)) {
    try {
      if (reownLinkRetirement(receipt, operation.id)) receipt = readLinkRetirement(id);
    } catch { return fail("link_remove_failed", "The link retirement could not be updated.", 503); }
  }
  // Another identity's receipt is left alone; replay then cannot settle committed while it is outstanding (recoverRevoke).
  if (!receipt || receipt.operationId !== operation.id || receipt.mode !== removalMode(force, purge)) return null;
  let releaseLink: (() => void) | null = null;
  if (reserve) {
    const { childOpsEngineFor } = await import("./link-child-ops-routes");
    releaseLink = childOpsEngineFor(state).reserve(id);
    if (!releaseLink) return fail("link_operation_in_progress", "A Child operation is running on this link; wait for it to finish, then remove the link.", 409);
  }
  try {
    const resumed = await removeReserved(ctx, state, id, receipt.link, receipt, force, purge, resumedRevokeJournal(ctx, operation.id, recordListed));
    if (resumed.status === 200) return null;
    try { await settleResumedRevoke(ctx, operation.id, resumed); } catch { /* the entry stays open: suspended, and replayed on repeat */ }
    return resumed;
  } finally { releaseLink?.(); }
}

/** The link a removal acts on: its retirement receipt (an interrupted removal) or its stored record. */
function readRemovalTarget(ctx: ManagementContext, id: string):
  | { record: LinkStore["links"][number]; receipt: ReturnType<typeof readLinkRetirement> }
  | { response: Response } {
  let receipt: ReturnType<typeof readLinkRetirement>;
  let found: LinkStore["links"][number] | undefined;
  try {
    receipt = readLinkRetirement(id);
    found = readStoreFor(ctx).links.find(link => link.id === id);
  } catch { return { response: fail("link_remove_failed", "The link retirement could not be read.", 503) }; }
  if (!found && !receipt) return { response: fail("link_not_found", "The link was not found.", 404) };
  if (receipt && found && JSON.stringify(found) !== JSON.stringify(receipt.link)) return { response: fail("link_changed", "The link changed during removal.", 409) };
  return { record: receipt?.link ?? { ...found! }, receipt };
}


// What each link-bound refusal means and what to do; fixed text, never the Child's own output.
const BOUND_REFUSAL_MESSAGES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  child_link_mismatch: "The Child refused because of who it belongs to or what state it is in, so nothing was disconnected and the link was kept. Do not disconnect it there. Check it with ocx connect status --json (on a lightweight Child, connect status --json of its planted ocx-child, ~/.cache/opencodex/bin/ocx-child, or in Command Prompt on Windows %LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe, or %USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe where LOCALAPPDATA is not set): if it shows another link, a hub or another Home, or no connection, revoke this link with --force once any enrollment of this link has finished. If it shows this link's id, a connect or key rotation of it may be in progress: let it finish on the Child, then revoke again; if the same answer comes back, revoke this link with --force once any enrollment of this link has finished. If its state cannot be read, repair it on the Child, then revoke again; if you cannot, or the machine cannot be reached, revoke this link with --force once any enrollment of this link has finished.",
  child_residual: "The lightweight Child keeps records it cannot restore, so nothing was disconnected and the link was kept. Do not run a plain ocx-child detach on it: an interrupted attach of another link can be what is left, and a plain detach would remove that link too. Revoke this link with --force.",
  child_disconnect_pending: "The Child has an unfinished disconnect it could not tie to this link and may be partly cleaned; the link was kept. Check it with ocx connect status --json, which cannot say whose disconnect it is: only if it shows no connection, finish it there with ocx disconnect, then revoke again. If it shows any link, a hub or another Home, if its state cannot be read, or if the machine cannot be reached, leave it and revoke this link with --force. If ocx disconnect refuses the receipt as unsafe, revoke with --force too.",
  expect_link_unsupported: "The Child runs an ocx or ocx-child older than --expect-link and another Home-initiated link of this Home may reach the same machine, so it was not disconnected without the link check; the link was kept. Update OpenCodex on a full install, then revoke again (an older planted ocx-child cannot be updated from this Home). Otherwise revoke this link with --force. Revoking the other link instead is no way out unless you mean to end it: no status check can show it is stale (an attach of it still in progress can show no link or an earlier one, and state that cannot be read shows none), under the same pinned host key its revoke is refused the same way, and through a shared route it disconnects the machine if the machine runs that link.",
});

// A forced revoke of an ephemeral Child refused for its tombstone. Either answer comes before this attempt revoked a key or
// removed a record, and a forced revoke never contacts the Child; an earlier attempt of a resumed revoke may have done more.
// At the commit-time check this attempt has already stopped the tunnel, so it names only the key, the record and the Child.
const tombstoneLimit = (): Response => fail("tombstone_limit", "Too many forced revokes are waiting for cleanup; this attempt revoked no key, removed no record and did not contact the Child. Recover them (ocx link recover --link-id <id>; ocx link recover --list shows them), or have a person on this Home run ocx link recover --forget --link-id <id> --yes for a machine that is gone or whose cleanup cannot be proven.", 409);
const tombstoneWriteFailed = (): Response => fail("tombstone_write_failed", "The tombstone a forced revoke of an ephemeral Child needs could not be written, so this attempt revoked no key and removed no record.", 503);

async function removeReserved(
  ctx: ManagementContext,
  state: LinkRouteState,
  id: string,
  record: LinkStore["links"][number],
  initialReceipt: ReturnType<typeof readLinkRetirement>,
  force: boolean,
  purge: boolean,
  journal: RevokeJournal,
): Promise<Response> {
  let receipt = initialReceipt;
  // A receipt is never evidence that the Child was cleaned up (#8416): while the record is listed the cleanup runs
  // again unless the owning journal entry recorded it (cleanupRecorded), as a removal on dev always runs it. Once the
  // record is gone the commit already followed a cleanup, and the receipt only drives the local post-commit work.
  let listed: boolean;
  try { listed = readStoreFor(ctx).links.some(link => link.id === id); } catch { return fail("link_remove_failed", "The link store could not be read.", 503); }
  const cleanupDone = receipt !== null && (!listed || cleanupRecorded(ctx, receipt));
  // A retry asking for another cleanup than the one the receipt stands for, where that cleanup will not run again, would
  // report success without it, so it is refused before anything is stopped. --force asks for no cleanup and is allowed.
  if (receipt && cleanupDone && !force && record.direction === "hub-initiated" && (receipt.mode ?? "force") !== removalMode(force, purge)) {
    return fail("link_retirement_mode_mismatch", `This link's removal was interrupted after its ${receipt.mode ?? "force"} cleanup; repeat it with the same options, or with --force, to finish it.`, 409);
  }
  // An intent that cannot be written stops the revoke before its effect, answered with the operation id.
  const journalFailed = (): Response => Response.json({
    error: { code: "operation_journal_failed", message: "The link operation journal could not be written; the step after it did not run." },
    ...(journal.operationId ? { operationId: journal.operationId } : {}),
  }, { status: 500, headers: { "cache-control": "no-store" } });
  const intend = (effect: "remote_cleanup" | "key_revoked" | "record_removed"): boolean => {
    try { journal.intent(effect); return true; } catch { return false; }
  };
  const cleanup = !cleanupDone && !force && record.direction === "hub-initiated";
  // A forced revoke leaves an ephemeral Child uncleaned. Its tombstone is durable before the first intent (key_revoked
  // for a force revoke) and before the tunnel stops, so ocx link recover can still reach and clean that machine;
  // without it, refuse with nothing touched.
  // Only a forced revoke that will remove a still-listed record writes one: a resumed retirement whose record is already
  // gone relies on the tombstone the original force wrote (#8416), and must not recreate one recover may have settled.
  const tombstoned = force && listed && record.direction === "hub-initiated" && record.childKind === "ephemeral" && Boolean(record.hostKeyFingerprint);
  // A revoke that does not commit keeps the link, so the tombstone it wrote must go too: beside a live link it would
  // only count toward the cap (recover refuses it as link_present). Only that exact tombstone, and only while the link
  // still exists: another process may have committed its own forced revoke. The finally below drops it on every way
  // out before the commit, a throw included.
  let written: LinkTombstone | null = null;
  let committed = false;
  const dropOwnTombstone = (): void => {
    if (!written) return;
    const own = written;
    try { withConfigMutationLockSync(() => { removeOwnTombstone(own, readStoreFor(ctx).links.some(link => link.id === id), tombstonesPath()); }); } catch { /* the link remains; recover refuses link_present */ }
  };
  // The tombstone this forced revoke needs when its record goes; the commit step makes sure one is there.
  let needed: LinkTombstone | null = null;
  if (tombstoned && record.hostKeyFingerprint) {
    const tombstone: LinkTombstone = {
      linkId: id, alias: record.alias, hostKeyFingerprint: record.hostKeyFingerprint,
      ...(record.remotePlatform ? { remotePlatform: record.remotePlatform } : {}),
      ...(record.routes ? { routes: [...record.routes] } : {}),
      ...(record.explicitRoute ? { explicitRoute: { ...record.explicitRoute } } : {}),
      ...(record.exclusive ? { exclusive: true as const } : {}),
      revokedAt: new Date((ctx.deps.now ?? Date.now)()).toISOString(),
      attempt: randomBytes(8).toString("hex"),
    };
    needed = tombstone;
    // A tombstone already there for this link (a forced revoke in flight in another runtime, or one that died) is kept,
    // and this attempt owns none: it then has nothing to drop if it does not commit.
    try { if (withConfigMutationLockSync(() => recordTombstone(tombstone, tombstonesPath())) === "recorded") written = tombstone; } catch (error) {
      if (error instanceof LinkTombstoneLimitError) {
        // No state claim: an earlier, interrupted attempt of a resumed revoke may already have revoked the key and stopped the tunnel,
        // and this one may have taken its receipt back (reownLinkRetirement), so it names only what this attempt left alone.
        return fail("tombstone_limit", "Too many forced revokes are waiting for cleanup; this attempt did not touch the link, its key or the Child. Recover them (ocx link recover --link-id <id>; ocx link recover --list shows them), or have a person on this Home run ocx link recover --forget --link-id <id> --yes for machines that are gone.", 409);
      }
      // The file may already be written (a chmod or the lock's COMMIT failed after it); the link stays, so this
      // attempt's tombstone, if any, goes too. Its random attempt token makes that removal touch nothing else.
      written = tombstone;
      dropOwnTombstone();
      return tombstoneWriteFailed();
    }
  }
  // The first intent (cleanup, or the key for a force revoke) is written before stopLink: a failed write leaves the
  // tunnel as it was and nothing has been touched.
  if (!intend(cleanup ? "remote_cleanup" : "key_revoked")) { dropOwnTombstone(); return journalFailed(); }
  // Taken inside the try, so a hold that throws is covered by the finally (the tombstone drop) like any later step.
  let release: (() => void) | undefined;
  // Set when this revoke restarts the tunnel itself after a cleanup that never ran; every other way out leaves it down.
  let restarted = false;
  try {
    release = state.supervisor.holdLink?.(id);
    if (listed) await state.supervisor.stopLink(id);
    const restartTunnel = async (): Promise<void> => {
      restarted = true;
      release?.();
      try {
        await state.supervisor.ensureStarted();
        await state.supervisor.reload();
      } catch (error) {
        console.warn(`[link] tunnel restart failed linkId=${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // A cleanup that failed before the Child's disconnect ran changed nothing there: the tunnel restarts (a journalled
    // revoke settles failed_clean). Any other failure (a timeout, a nonzero exit, no purge report) may have disconnected
    // or purged the Child, so a journalled revoke leaves the tunnel down, unknown, and the supervisor keeps it down until
    // the operation is resolved (revokeSuspendsLink). A plain revoke restarts the tunnel either way, as before.
    const cleanupFailed = async (failure: Response, attempted: boolean): Promise<Response> => {
      // A resumed retirement keeps the tunnel down even when this attempt never ran: an earlier one may have (keepsTunnelDown).
      if ((attempted || journal.keepsTunnelDown) && journal.operationId !== undefined) return failure;
      if (!attempted) journal.cleanupNotRun();
      await restartTunnel();
      return failure;
    };
    const disconnectFailed = (hint: string | undefined) => fail("remote_disconnect_failed", BOUND_REFUSAL_MESSAGES[hint ?? ""] ?? "The remote client could not be disconnected.", 502, hint);
    // True once the Child confirmed this link before cleaning (--expect-link). A revoke never settles a tombstone, bound or
    // not: beside a listed link one belongs to a forced revoke still in flight in another process (or one that died), and
    // removing it here could lose the only recovery evidence for a Child that revoke leaves attached. ocx link recover
    // settles it once the link is gone, under the alias lock and bound to the link.
    let linkBound = false;
    const unboundStillSafe = (): boolean => {
      const links = readStoreFor(ctx).links;
      const wanted = record.alias.toLowerCase();
      // Enrollment refuses a second link with this primary alias, so the machine another link may own now is found by
      // its pinned key (the same machine enrolled under another alias or address) or by a route naming this alias.
      return links.some(link => link.id === id)
        && !links.some(link => link.id !== id && link.direction === "hub-initiated" && (
          (Boolean(record.hostKeyFingerprint) && link.hostKeyFingerprint === record.hostKeyFingerprint)
          || [link.alias, ...effectiveLinkRoutes(link)].some(route => route.toLowerCase() === wanted)));
    };
    if (cleanup) {
      const runner = runnerFor(ctx);
      let platform: Awaited<ReturnType<typeof requireRemotePlatform>>;
      try { platform = record.remotePlatform ?? await requireRemotePlatform(runner, record.alias, record.explicitRoute ?? null, knownHostsFile(ctx)); } catch (error) {
        return cleanupFailed(disconnectFailed(sshRunnerErrorHint(error)), false);
      }
      if (purge) {
        let purged: Awaited<ReturnType<typeof purgeDisconnectRemote>>;
        try { purged = await purgeDisconnectRemote(runner, record.alias, record.explicitRoute ?? null, knownHostsFile(ctx), platform, record.childKind, id, unboundStillSafe); } catch (error) {
          return cleanupFailed(disconnectFailed(sshRunnerErrorHint(error)), true);
        }
        if (!purged.ok) return cleanupFailed(fail(purged.code, (purged.hint !== undefined ? BOUND_REFUSAL_MESSAGES[purged.hint] : undefined) ?? purged.message, purged.status, purged.hint), purged.notAttempted !== true);
        // purgeDisconnectRemote is ok only when the managed ocx-child reported purged:true over this link's route. The
        // receipt must be durable before the link goes; if it cannot be written, stop here (unknown) and leave the
        // tunnel down, since the Child it would reach is purged.
        try { journal.done("remote_cleanup", { purged: true, linkId: id }); } catch { return journalFailed(); }
      } else {
        const disconnectArgv = (bound: boolean) => buildExecArgv({ alias: record.alias, argv: remoteOcxArgv(bound ? ["disconnect", "--expect-link", id] : ["disconnect"], platform), knownHostsFile: knownHostsFile(ctx), route: record.explicitRoute ?? null });
        let result: Awaited<ReturnType<typeof runner.run>>;
        linkBound = true;
        try { result = await runner.run(disconnectArgv(true), { timeoutMs: 30_000 }); } catch (error) {
          return cleanupFailed(disconnectFailed(sshRunnerErrorHint(error)), true);
        }
        // An ocx or ocx-child older than --expect-link rejects it as a usage error (exit 2) before acting on the link.
        // The unbound retry is the old behaviour, so it runs only while no other Home-initiated link of this Home may
        // reach the same machine (same pinned key, or this alias among its routes; re-read now). The machine enrolled
        // with another Home, or under a new host key, stays outside what this Home can see.
        if (result.code === CHILD_USAGE_EXIT) {
          if (!unboundStillSafe()) return cleanupFailed(disconnectFailed("expect_link_unsupported"), false);
          linkBound = false;
          try { result = await runner.run(disconnectArgv(false), { timeoutMs: 30_000 }); } catch (error) {
            return cleanupFailed(disconnectFailed(sshRunnerErrorHint(error)), true);
          }
        }
        // A link-bound refusal recognised as one changed nothing on the Child: another link (or a hub, or no connection)
        // owns it now (5), or an ocx-child keeps state it cannot restore (6). The tunnel restarts and the link stays. An
        // unfinished disconnect the Child could not prove is this link's may have been partly cleaned by an earlier
        // attempt: a cleanup attempted, never failed_clean. Any other exit 5 or 6 falls through as attempted.
        const refusal = linkBound ? classifyBoundRefusal(result.code, result.stderr, id) : null;
        if (refusal === "pending") return cleanupFailed(disconnectFailed("child_disconnect_pending"), true);
        if (refusal === "mismatch" || refusal === "residual") return cleanupFailed(disconnectFailed(refusal === "mismatch" ? "child_link_mismatch" : "child_residual"), false);
        if (result.code !== 0) return cleanupFailed(disconnectFailed(sshFailureHint(result.stderr)), true);
        journal.done("remote_cleanup");
      }
    }
    if (cleanup && !intend("key_revoked")) return journalFailed();
    try {
      if (!receipt) {
        try { receipt = claimLinkRetirement(record, undefined, () => readStoreFor(ctx), removalMode(force, purge), journal.operationId); }
        catch {
          const latest = readStoreFor(ctx).links.find(link => link.id === id);
          if (!latest || JSON.stringify(latest) !== JSON.stringify(record)) {
            // A journalled revoke whose Child cleanup ran (or a resumed one) leaves the tunnel down: the Child may already be
            // disconnected or purged, and the revoke settles unknown, which keeps the link suspended. A plain revoke, or one
            // that ran no cleanup, restarts it as before.
            if (!((cleanup || journal.keepsTunnelDown) && journal.operationId !== undefined)) await restartTunnel();
            dropOwnTombstone();
            return fail("link_changed", "The link changed during removal.", 409);
          }
          dropOwnTombstone();
          return fail("link_remove_failed", "The link retirement could not be claimed.", 503);
        }
      }
      const owner = receipt;
      // The key revoke and the record removal commit in one locked step; the operation journal (its own writes take the
      // same, reentrant lock) records each intent before its effect and each completion after it.
      const result = withConfigMutationLockSync(() => {
        const currentReceipt = readLinkRetirement(id);
        if (!currentReceipt || currentReceipt.nonce !== owner.nonce || JSON.stringify(currentReceipt.link) !== JSON.stringify(owner.link)) return "changed" as const;
        const latest = readStoreFor(ctx);
        const active = latest.links.find(link => link.id === id);
        if (active && JSON.stringify(active) !== JSON.stringify(record)) return "changed" as const;
        // A tombstone this attempt kept may have been dropped since by its owner, a forced revoke that failed in another
        // runtime. Under the lock that removes the record, before the key goes, one must be there: else this attempt
        // writes its own (and owns it), or stops with the link and key intact; the tunnel is already stopped and this
        // attempt's retirement receipt stays claimed, so a repeat of this revoke resumes it.
        if (active && needed) {
          const own = needed;
          let present: boolean;
          try { present = readTombstones(tombstonesPath()).tombstones.some(t => t.linkId === id); } catch { return "tombstone_failed" as const; }
          if (!present) {
            // A write that throws after the file landed (its chmod) still leaves this attempt's tombstone: own it, so the
            // non-ok path drops it by its token.
            try { if (recordTombstone(own, tombstonesPath()) === "recorded") written = own; } catch (error) {
              if (error instanceof LinkTombstoneLimitError) return "tombstone_limit" as const;
              written = own;
              return "tombstone_failed" as const;
            }
          }
        }
        if (active && (ctx.config.apiKeys ?? []).some(key => key.id === record.apiKeyId) && !revokeKeyIdempotent(ctx, record.apiKeyId)) return "revoke_failed" as const;
        journal.done("key_revoked");
        if (!intend("record_removed")) return "journal_failed" as const;
        if (active) writeStoreFor(ctx, { ...latest, links: latest.links.filter(link => link.id !== id) });
        journal.done("record_removed");
        reconcileHomeRouteDevices(readStoreFor(ctx).links.map(link => link.id));
        return "ok" as const;
      });
      // A revoke that does not commit keeps the link, so the tombstone it wrote goes too (only while the link still exists).
      if (result !== "ok") dropOwnTombstone();
      if (result === "journal_failed") return journalFailed();
      if (result === "changed") return fail("link_changed", "The link changed during removal.", 409);
      if (result === "tombstone_failed") return tombstoneWriteFailed();
      if (result === "tombstone_limit") return tombstoneLimit();
      if (result === "revoke_failed") return fail("key_revoke_failed", "The link key could not be revoked.", 502);
      committed = true;
      // Same task as the commit: an open link WebSocket must not outlive its link (design T4 2.4).
      state.listener.closeLinkSockets?.(id);
      clearCompensationFailed(id, compensationPath());
      state.compensationFailures?.delete(id);
      await state.supervisor.reload();
      await reconcileLinkListener(ctx, state.listener);
      try { journal.beforeReceiptCleared?.(); } catch {
        return fail("operation_journal_failed", "The link removal finished, but its operation journal could not be updated; repeat the request.", 500);
      }
      if (!clearLinkRetirement(owner, undefined, () => !readStoreFor(ctx).links.some(link => link.id === id))) return fail("link_remove_failed", "The link retirement changed during removal.", 503);
    } catch {
      dropOwnTombstone();
      // The record can already be gone when a later step (route-intent reconciliation, the
      // listener) fails. Its sockets close then too, in this task, rather than at the next sweep.
      try { if (!readStoreFor(ctx).links.some(link => link.id === id)) state.listener.closeLinkSockets?.(id); }
      catch { /* the store is unreadable; the per-message reauthorization still refuses its frames */ }
      return fail("link_remove_failed", "The link record could not be removed.", 503);
    }
    return Response.json({ linkId: id });
  } finally {
    if (!committed) dropOwnTombstone();
    // The hold goes before finish writes the outcome. A revoke that leaves the tunnel down drops its live mark first, so a
    // reload in between already finds its open entry suspended (revokeSuspendsLink); this is synchronous, nothing interleaves.
    if (!restarted) journal.release();
    release?.();
  }
}

export async function handleLinkRoutes(ctx: ManagementContext, suppliedState?: LinkRouteState): Promise<Response | null> {
  const { url, req } = ctx;
  const path = url.pathname;
  if (!isLinkPath(path)) return null;
  if (ctx.guiSessionIssuance === "tailscale-identity") return fail("tailscale_session_refused", "Tailscale identity sessions cannot use link routes.", 403);
  if (url.pathname === "/api/link/join" && req.method === "POST") {
    // Joining durably redirects local client traffic, so a credentiallessly bootstrapped loopback
    // session is insufficient. Every refusal below runs before link state and before any SSH.
    const denied = auth(ctx, "paired");
    if (denied) return denied;
    if ((ctx.config.runtimeRole ?? "standalone") !== "standalone") return fail("standalone_required", "Client initiated links require standalone runtime mode.", 409);
    if (!joinPortMatches(ctx)) return fail("join_port_mismatch", "OpenCodex is not running on its configured port, so it cannot restart as a Child.", 409);
    const state = suppliedState ?? stateFor(ctx);
    if (!state) return fail("link_unavailable", "The link lifecycle is unavailable.", 503);
    return handleJoin(ctx, state);
  }
  // A file read that needs no link lifecycle, so a runtime whose link supervisor is unavailable
  // still shows what its tunnels recorded. Same authority as GET /api/link/status. A connected
  // Child serves the same read from src/client/machine-listener.ts.
  if (url.pathname === "/api/link/diagnostics" && req.method === "GET") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    return linkDiagnosticsResponse(url);
  }
  const state = suppliedState ?? stateFor(ctx);
  if (!state) return fail("link_unavailable", "The link lifecycle is unavailable.", 503);
  if (url.pathname === "/api/link/status" && req.method === "GET") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    const store = readStoreFor(ctx);
    const listenerStatus = state.listener.status();
    const supervisorStates = state.supervisor.status();
    const dto: LinkStatusDto = projectLinkStatus(
      store, supervisorStates, listenerStatus, ctx.config, readCompensation(),
      ctx.config.runtimeRole === "client" ? clientLinkTunnelStatus() : null,
      ctx.config.runtimeRole === "client" && ctx.config.client?.link ? clientLinkStatusIdentity(ctx.config.client.link.linkId) : null,
      linkId => homeLinkChildParity.get(linkId),
    );
    for (const link of dto.links) {
      const failure = state.compensationFailures?.get(link.id);
      if (failure) Object.assign(link, { state: "failed" as const, since: failure.since, reason: failure.reason });
    }
    if (dto.child && store.links[0]) {
      const failure = state.compensationFailures?.get(store.links[0].id);
      if (failure) Object.assign(dto.child, { state: "failed" as const, since: failure.since, reason: failure.reason });
    }
    // Opt-in: an older `ocx link status` validates the document key by key and would reject the
    // added fields, so only a caller that asks for compatibility gets `local` and `peer`.
    if (url.searchParams.get("compatibility") === "1") {
      attachLinkPeers(dto, localLinkPeer(packageVersion("0.0.0"), buildPeerFeatures()),
        linkId => state.listener.peerObservation?.(linkId) ?? { observed: null, refused: null });
    }
    // The same opt-in for the body bytes each link carried (#3023).
    if (url.searchParams.get("traffic") === "1") {
      const { attachLinkTrafficForState } = await import("./link-traffic-status");
      attachLinkTrafficForState(dto, state);
    }
    // The same opt-in for each Home-initiated tunnel's retry progress and last failure cause.
    if (url.searchParams.get("diagnostics") === "1") attachLinkTunnelDiagnostics(dto, supervisorStates);
    // The same opt-in for the route each multi-route link uses and why the others rest.
    if (url.searchParams.get("routes") === "1") attachLinkRoutes(dto, supervisorStates);
    // The same opt-in for each row's live link WebSocket counters and hold count (design 9.3).
    if (url.searchParams.get("transport") === "1") {
      attachLinkTransport(dto, linkId => state.listener.linkTransport?.(linkId) ?? null, linkId => {
        const held = state.listener.linkHolds?.(linkId) ?? null;
        return held ? held.holds.length + (held.unknown ? 1 : 0) : 0;
      });
    }
    // The same opt-in for each Home row's Child versions, catalog freshness, activity and operations.
    if (url.searchParams.get("children") === "1" && dto.role === "home") {
      const { attachLinkChildOpsForState } = await import("./link-child-ops-routes");
      attachLinkChildOpsForState(dto, state, store, (ctx.deps.now ?? Date.now)());
    }
    // A dashboard session also learns why it cannot join as a Child. The admin-token answer stays
    // the exact K16 document that `ocx link status` validates key by key.
    const denial = ctx.principal === "gui-session" ? joinDenied(ctx) : null;
    const body: LinkStatusDto & { joinAvailable?: boolean; joinDenied?: LinkJoinDenied | null; homeCodexSettingsDigest?: string } = ctx.principal === "gui-session"
      ? { ...dto, joinAvailable: denial === null, joinDenied: denial, homeCodexSettingsDigest: codexSettingsDigest(projectHomeCodexSettings(ctx.config, packageVersion("0.0.0")).settings) } : dto;
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/link/candidates" && req.method === "GET") {
    const denied = auth(ctx, "dashboard");
    if (denied) return denied;
    return candidates(ctx);
  }
  if (url.pathname === "/api/link/probe" && req.method === "POST") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    return probe(ctx, state);
  }
  if (url.pathname === "/api/link/confirm-host" && req.method === "POST") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    return confirmHost(ctx, state);
  }
  if (url.pathname === "/api/link/apply" && req.method === "POST") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    return apply(ctx, state);
  }
  if (url.pathname === "/api/link/issue" && req.method === "POST") {
    const denied = auth(ctx, "admin");
    if (denied) return denied;
    return issue(ctx);
  }
  // Before the DELETE matcher, which would read "operations" as a link id.
  if (path === "/api/link/operations" || path.startsWith("/api/link/operations/")) {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    const { handleLinkOperationRoutes } = await import("./link-operation");
    return handleLinkOperationRoutes(ctx);
  }
  if (url.pathname === "/api/link/recover" && req.method === "POST") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    const { handleLinkRecover } = await import("./link-recover-route");
    return handleLinkRecover(ctx, state);
  }
  if (url.pathname === "/api/link/recover" && req.method === "GET") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    const { handleLinkRecoverList } = await import("./link-recover-route");
    return handleLinkRecoverList();
  }
  // Before the reconnect and DELETE matchers, which would read "children" as a link id.
  if (path.startsWith("/api/link/children/")) {
    const { handleLinkChildOpsRoutes } = await import("./link-child-ops-routes");
    return handleLinkChildOpsRoutes(ctx, state);
  }
  const reconnectPath = req.method === "POST" ? /^\/api\/link\/([^/]+)\/reconnect$/.exec(path) : null;
  // Before the DELETE matcher, which would read "<id>/routes" as a link id.
  const routesPath = req.method === "GET" || req.method === "POST" ? /^\/api\/link\/([^/]+)\/routes$/.exec(path) : null;
  if (routesPath) {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    let id: string;
    try { id = decodeURIComponent(routesPath[1]!); } catch { return fail("invalid_link_id", "The link id is invalid.", 400); }
    const { handleLinkRouteEdit } = await import("./link-route-edit");
    return handleLinkRouteEdit(ctx, state, id);
  }
  if (reconnectPath) {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    let id: string;
    try { id = decodeURIComponent(reconnectPath[1]!); } catch { return fail("invalid_link_id", "The link id is invalid.", 400); }
    return reconnect(ctx, state, id);
  }
  if (req.method === "DELETE" && path.startsWith("/api/link/")) {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    let id: string;
    try { id = decodeURIComponent(path.slice("/api/link/".length)); } catch { return fail("invalid_link_id", "The link id is invalid.", 400); }
    return remove(ctx, state, id);
  }
  return null;
}
