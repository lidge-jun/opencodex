/**
 * The management side of the operation journal (src/link/operations-journal.ts; structure/remote-link.md,
 * "Operation journal"): the per-alias lock around apply and revoke, the handle apply marks its effects through,
 * the replay of a recorded outcome, and the recovery of an entry whose process died before it finished.
 */
import { randomUUID } from "node:crypto";
import { AliasLockError, withAliasLock } from "../../link/alias-lock";
import type { ExplicitRoute } from "../../link/explicit-route";
import { findOperation, hasEffect, openEnrollmentFor, operationDigest, operationsJournalPath, readOperationsJournal, updateOperationsJournal,
  type EnrollEffect, type LinkOperation, type OperationState, type RevokeEffect } from "../../link/operations-journal";
import { newLinkId } from "../../link/store";
import type { ManagementContext } from "./context";
import { compensateNewLink, fail, readStoreFor, revokeKeyIdempotent, type LinkRouteState } from "./link-route-state";
import type { RouteRequest } from "./link-route-request";

/** Compensation that could not finish: whether anything this operation created remains is unknown. */
const UNKNOWN_CODES = new Set(["compensation_failed", "key_cleanup_failed", "link_cleanup_uncertain"]);
const RESIDUAL_RECOVERY = "The Child may still be enrolled; run ocx-child detach --purge (or ocx disconnect) on the Child before retrying.";

export interface OperationRequest { id: string; digest: string }

export function journalPathFor(ctx: ManagementContext): string {
  return ctx.deps.linkOperationsPath?.() ?? operationsJournalPath();
}

const nowOf = (ctx: ManagementContext) => (ctx.deps.now ?? Date.now)();
const iso = (ctx: ManagementContext) => new Date(nowOf(ctx)).toISOString();

export function enrollOperationDigest(params: { alias: string; fingerprint?: string; plant: boolean; route: RouteRequest; requireEphemeral: boolean }): string {
  return operationDigest({ kind: "enroll", alias: params.alias, fingerprint: params.fingerprint ?? null, plant: params.plant,
    explicitRoute: params.route.explicitRoute, exclusive: params.route.exclusive, requireEphemeral: params.requireEphemeral });
}

/** Every Home-initiated apply and revoke runs under its alias's lock; a holder past the wait answers 409. */
export async function underAliasLock(ctx: ManagementContext, alias: string, action: () => Promise<Response>): Promise<Response> {
  try { return await withAliasLock(alias, ctx.deps.linkAliasLock ?? {}, action); } catch (error) {
    if (error instanceof AliasLockError) {
      return error.code === "link_alias_lock_busy"
        ? fail("link_operation_in_progress", "Another enrollment or revoke of this alias is running; try again when it ends.", 409)
        : fail("link_alias_lock_failed", "The alias lock could not be taken.", 500);
    }
    throw error;
  }
}

/** An open enroll entry of another operation for this alias refuses every other enrollment. */
export function openEnrollmentConflict(ctx: ManagementContext, alias: string, except?: string): Response | null {
  let open: LinkOperation | undefined;
  try { open = openEnrollmentFor(readOperationsJournal(journalPathFor(ctx)), alias, except); } catch {
    return fail("operation_journal_unreadable", "The link operation journal could not be read.", 500);
  }
  return open ? fail("link_operation_open", "An unfinished enrollment holds this alias; repeat it with its operation id to settle it.", 409) : null;
}

function outcomeBody(op: LinkOperation): Record<string, unknown> {
  return { operationId: op.operationId, outcome: op.state };
}

/** The recorded outcome as a response: committed answers like the apply that committed. */
export function replayResponse(op: LinkOperation): Response {
  if (op.state === "committed") {
    return Response.json(op.kind === "enroll" ? { linkId: op.reserved!.linkId, ...outcomeBody(op) }
      : { linkId: op.linkId, ...outcomeBody(op), ...(op.receipt ? { purged: true } : {}) }, { status: op.kind === "enroll" ? 202 : 200 });
  }
  const error = op.error ?? { code: "operation_interrupted", status: 409 };
  return Response.json({
    error: { code: error.code, message: "The operation ended " + op.state + "; this is its recorded outcome." },
    ...outcomeBody(op),
    ...(op.state === "residual" ? { residual: true, recovery: RESIDUAL_RECOVERY } : {}),
  }, { status: error.status, headers: { "cache-control": "no-store" } });
}

/**
 * A repeat: the same id with the same digest reads its outcome; another digest or kind is refused. An entry
 * still open here belongs to a process that died (this caller holds the alias lock), so it is recovered first.
 * null when there is no entry.
 */
export async function replayOperation(ctx: ManagementContext, state: LinkRouteState, request: OperationRequest, kind: LinkOperation["kind"]): Promise<Response | null> {
  let op: LinkOperation | undefined;
  try { op = findOperation(readOperationsJournal(journalPathFor(ctx)), request.id); } catch {
    return fail("operation_journal_unreadable", "The link operation journal could not be read.", 500);
  }
  if (!op) return null;
  if (op.kind !== kind || op.digest !== request.digest) return fail("operation_mismatch", "This operation id was used with other parameters.", 409);
  if (op.state === "open") op = kind === "enroll" ? await recoverEnroll(ctx, state, op) : recoverRevoke(ctx, op);
  return replayResponse(op);
}

function settle(ctx: ManagementContext, operationId: string, outcome: OperationState, error?: { code: string; status: number }): LinkOperation {
  return updateOperationsJournal(journalPathFor(ctx), nowOf(ctx), journal => {
    const op = findOperation(journal, operationId)!;
    op.state = outcome;
    op.updatedAt = iso(ctx);
    if (outcome !== "open") op.finishedAt = op.updatedAt;
    if (error && outcome !== "committed") op.error = error;
    return structuredClone(op);
  });
}

/**
 * Recovery by reserved id. A completed relay verification committed; only its outcome write was lost. Otherwise
 * whatever carries this operation's reserved link id or key id is undone; another link for the alias is not this
 * operation's and makes the outcome unknown, as does compensation that does not finish. A Child that was asked to
 * enroll, or given a plant, may still hold it: residual.
 */
async function recoverEnroll(ctx: ManagementContext, state: LinkRouteState, op: LinkOperation): Promise<LinkOperation> {
  const reserved = op.reserved!;
  const interrupted = { code: "operation_interrupted", status: 409 };
  if (hasEffect(op, "relay_verified", "done")) return settle(ctx, op.operationId, "committed");
  const store = readStoreFor(ctx), wanted = op.alias.toLowerCase();
  if (store.links.some(link => link.direction === "hub-initiated" && link.alias.toLowerCase() === wanted && link.id !== reserved.linkId)) {
    return settle(ctx, op.operationId, "unknown", interrupted);
  }
  const record = store.links.find(link => link.id === reserved.linkId);
  if (record) {
    if (await compensateNewLink(ctx, state, record)) return settle(ctx, op.operationId, "unknown", interrupted);
  } else if (!revokeKeyIdempotent(ctx, reserved.apiKeyId)) {
    return settle(ctx, op.operationId, "unknown", interrupted);
  }
  const childTouched = hasEffect(op, "child_enrolled", "intent") || hasEffect(op, "plant", "intent");
  return settle(ctx, op.operationId, childTouched ? "residual" : "failed_clean", interrupted);
}

/** A revoke whose process died: what it reached is unknown until someone looks; the link state says the rest. */
function recoverRevoke(ctx: ManagementContext, op: LinkOperation): LinkOperation {
  const removed = !readStoreFor(ctx).links.some(link => link.id === op.linkId);
  const cleanupAsked = hasEffect(op, "remote_cleanup", "intent"), cleanupDone = hasEffect(op, "remote_cleanup", "done");
  if (removed && (!cleanupAsked || cleanupDone)) return settle(ctx, op.operationId, "committed");
  return settle(ctx, op.operationId, removed || cleanupAsked ? "unknown" : "failed_clean", { code: "operation_interrupted", status: 409 });
}

export interface EnrollJournal {
  readonly reservedLinkId?: string;
  readonly reservedKeyId?: string;
  intent(effect: EnrollEffect): void;
  done(effect: EnrollEffect): void;
  port(tunnelPort: number): void;
  /** Record the outcome of the live response and add operationId and outcome to it. */
  finish(response: Response): Promise<Response>;
}

export const NO_ENROLL_JOURNAL: EnrollJournal = {
  intent() {}, done() {}, port() {}, finish: async response => response,
};

/** Write the open entry with its reserved identities; any write failure throws before an effect runs. */
export function openEnrollJournal(ctx: ManagementContext, request: OperationRequest, alias: string, route: { explicitRoute?: ExplicitRoute; exclusive?: true }): EnrollJournal {
  const path = journalPathFor(ctx), reservedLinkId = newLinkId(), reservedKeyId = randomUUID();
  updateOperationsJournal(path, nowOf(ctx), journal => {
    journal.operations.push({
      operationId: request.id, kind: "enroll", alias, digest: request.digest, createdAt: iso(ctx), updatedAt: iso(ctx), state: "open",
      reserved: { linkId: reservedLinkId, apiKeyId: reservedKeyId, tunnelPort: null, ...route }, effects: [],
    });
  });
  const change = (edit: (op: LinkOperation) => void) => updateOperationsJournal(path, nowOf(ctx), journal => {
    const op = findOperation(journal, request.id)!;
    edit(op);
    op.updatedAt = iso(ctx);
  });
  return {
    reservedLinkId, reservedKeyId,
    intent: effect => change(op => { op.effects.push({ effect, phase: "intent", at: iso(ctx) }); }),
    done: effect => change(op => { op.effects.push({ effect, phase: "done", at: iso(ctx) }); }),
    port: tunnelPort => change(op => { op.reserved!.tunnelPort = tunnelPort; }),
    async finish(response) {
      let body: Record<string, unknown> = {};
      try { body = await response.clone().json() as Record<string, unknown>; } catch { /* a body that is not JSON keeps its status */ }
      const errorCode = typeof (body.error as { code?: unknown } | undefined)?.code === "string" ? (body.error as { code: string }).code : "apply_failed";
      // A plant that timed out may have installed the binary anyway; the response cannot say, so neither can this.
      let plantUnsettled = false;
      try { const op = findOperation(readOperationsJournal(path), request.id); plantUnsettled = !!op && hasEffect(op, "plant", "intent") && !hasEffect(op, "plant", "done"); } catch { plantUnsettled = true; }
      const outcome: OperationState = response.status === 202 ? "committed"
        : UNKNOWN_CODES.has(errorCode) ? "unknown"
          : body.residual === true || (plantUnsettled && errorCode === "remote_plant_timeout") ? "residual" : "failed_clean";
      let op: LinkOperation;
      try { op = settle(ctx, request.id, outcome, { code: /^[a-z][a-z0-9_]{0,63}$/.test(errorCode) ? errorCode : "apply_failed", status: response.status }); } catch {
        // The live outcome stands; the open entry is recovered by the next repeat.
        return response;
      }
      return Response.json({ ...body, ...outcomeBody(op) }, { status: response.status, headers: response.headers });
    },
  };
}

export function revokeOperationDigest(params: { linkId: string; purge: boolean; force: boolean }): string {
  return operationDigest({ kind: "revoke", linkId: params.linkId, purge: params.purge, force: params.force });
}

export interface RevokeJournal {
  intent(effect: RevokeEffect): void;
  /** remote_cleanup done with the Child's purged:true for this link id records the receipt. */
  done(effect: RevokeEffect, receipt?: { purged: true; linkId: string }): void;
  finish(response: Response): Promise<Response>;
}

export const NO_REVOKE_JOURNAL: RevokeJournal = { intent() {}, done() {}, finish: async response => response };

/** Write the open revoke entry; a write failure throws before the revoke changes anything. */
export function openRevokeJournal(ctx: ManagementContext, request: OperationRequest, alias: string, linkId: string): RevokeJournal {
  const path = journalPathFor(ctx);
  updateOperationsJournal(path, nowOf(ctx), journal => {
    journal.operations.push({ operationId: request.id, kind: "revoke", alias, linkId, digest: request.digest, createdAt: iso(ctx), updatedAt: iso(ctx), state: "open", effects: [] });
  });
  const change = (edit: (op: LinkOperation) => void) => updateOperationsJournal(path, nowOf(ctx), journal => {
    const op = findOperation(journal, request.id)!;
    edit(op);
    op.updatedAt = iso(ctx);
  });
  return {
    intent: effect => change(op => { op.effects.push({ effect, phase: "intent", at: iso(ctx) }); }),
    done: (effect, receipt) => change(op => { op.effects.push({ effect, phase: "done", at: iso(ctx) }); if (receipt) op.receipt = receipt; }),
    async finish(response) {
      let body: Record<string, unknown> = {};
      try { body = await response.clone().json() as Record<string, unknown>; } catch { /* keeps its status */ }
      const errorCode = typeof (body.error as { code?: unknown } | undefined)?.code === "string" ? (body.error as { code: string }).code : "revoke_failed";
      let current: LinkOperation | undefined;
      try { current = findOperation(readOperationsJournal(path), request.id); } catch { current = undefined; }
      // Clean only when neither the Child nor the record was touched: a cleanup that started (finished or not) or a
      // record removal that started may have changed something the failed response does not describe.
      const touched = !current || hasEffect(current, "remote_cleanup", "intent") || hasEffect(current, "record_removed", "intent");
      const outcome: OperationState = response.status === 200 ? "committed" : touched ? "unknown" : "failed_clean";
      let op: LinkOperation;
      try { op = settle(ctx, request.id, outcome, { code: /^[a-z][a-z0-9_]{0,63}$/.test(errorCode) ? errorCode : "revoke_failed", status: response.status }); } catch { return response; }
      return Response.json({ ...body, ...outcomeBody(op), ...(op.state === "committed" && op.receipt ? { purged: true } : {}) }, { status: response.status, headers: response.headers });
    },
  };
}
