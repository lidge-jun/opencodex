/**
 * The management side of the operation journal (src/link/operations-journal.ts; structure/remote-link.md,
 * "Operation journal"): the per-alias lock around apply and revoke, the handle apply marks its effects through,
 * the replay of a recorded outcome, and the recovery of an entry whose process died before it finished.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { AliasLockError, withAliasLock } from "../../link/alias-lock";
import type { ExplicitRoute } from "../../link/explicit-route";
import { findOperation, hasEffect, isOperationId, openEnrollmentFor, operationDigest, operationsJournalPath, readOperationsJournal, resolveLinkOperation, updateOperationsJournal,
  type EnrollEffect, type LinkOperation, type OperationState, type RevokeEffect } from "../../link/operations-journal";
import { newLinkId } from "../../link/store";
import type { ManagementContext } from "./context";
import { compensateNewLink, fail, readStoreFor, revokeKeyIdempotent, type LinkRouteState } from "./link-route-state";
import type { RouteRequest } from "./link-route-request";

/** Compensation that could not finish: whether anything this operation created remains is unknown. */
const UNKNOWN_CODES = new Set(["compensation_failed", "key_cleanup_failed", "link_cleanup_uncertain", "key_issue_uncertain"]);
const RESIDUAL_RECOVERY = "The Child may still be enrolled; run ocx disconnect and ocx restart on the Child (ocx-child detach for an ocx-child) before retrying.";
// Only the managed binary's purge removes a plant; a disconnect would leave it in place. Both managed locations.
const PLANT_RECOVERY = "The Child may still hold the planted ocx-child; run its managed copy with detach --purge before retrying: "
  + "~/.cache/opencodex/bin/ocx-child detach --purge on macOS or Linux; on Windows, in Command Prompt, \"%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe\" detach --purge, "
  + "or \"%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe\" detach --purge where LOCALAPPDATA is not set.";

/** The Child's side of a residual, as a closed word a client maps to its own guidance. */
function residualKind(op: LinkOperation): "plant" | "enrollment" | undefined {
  if (op.state !== "residual" && !op.childResidual) return undefined;
  return hasEffect(op, "plant", "intent") ? "plant" : "enrollment";
}

export interface OperationRequest { id: string; digest: string }

export function journalPathFor(ctx: ManagementContext): string {
  return ctx.deps.linkOperationsPath?.() ?? operationsJournalPath();
}

const nowOf = (ctx: ManagementContext) => (ctx.deps.now ?? Date.now)();
const iso = (ctx: ManagementContext) => new Date(nowOf(ctx)).toISOString();

/**
 * The parameters that name an enrollment. plant is left out: it follows from what the probe found, and a repeat
 * replays without probing, so it cannot restate it.
 */
export function enrollOperationDigest(params: { alias: string; fingerprint?: string; route: RouteRequest; requireEphemeral: boolean }): string {
  return operationDigest({ kind: "enroll", alias: params.alias, fingerprint: params.fingerprint ?? null,
    explicitRoute: params.route.explicitRoute, exclusive: params.route.exclusive, requireEphemeral: params.requireEphemeral });
}

/**
 * Has this Home ever journalled an operation? Until it has, an apply or revoke without an operation id behaves
 * exactly as before: no lock file, no journal read, no new refusal.
 */
export function journalInUse(ctx: ManagementContext): boolean {
  return existsSync(journalPathFor(ctx));
}

/**
 * Apply and revoke run under their alias's lock when required (an operation id, or a Home that has a journal); a
 * holder past the wait answers 409. Not required: the action runs as it always did.
 */
export async function underAliasLock(ctx: ManagementContext, alias: string, required: boolean, action: () => Promise<Response>): Promise<Response> {
  if (!required) return await action();
  try { return await withAliasLock(alias, ctx.deps.linkAliasLock ?? {}, action); } catch (error) {
    if (error instanceof AliasLockError) {
      return error.code === "link_alias_lock_busy"
        ? fail("link_operation_in_progress", "Another enrollment or revoke of this alias is running; try again when it ends.", 409)
        : fail("link_alias_lock_failed", "The alias lock could not be taken.", 500);
    }
    throw error;
  }
}

/** An open revoke entry of another operation for this link refuses every other revoke of it. */
export function openRevokeConflict(ctx: ManagementContext, linkId: string, except?: string): Response | null {
  if (!journalInUse(ctx)) return null;
  let open: LinkOperation | undefined;
  try { open = readOperationsJournal(journalPathFor(ctx)).operations.find(op => op.kind === "revoke" && op.state === "open" && op.linkId === linkId && op.operationId !== except); } catch {
    return fail("operation_journal_unreadable", "The link operation journal could not be read.", 500);
  }
  return open ? fail("link_operation_open", "An unfinished revoke holds this link; repeat it with its operation id to settle it.", 409) : null;
}

/** An open enroll entry of another operation for this alias refuses every other enrollment. */
export function openEnrollmentConflict(ctx: ManagementContext, alias: string, except?: string): Response | null {
  if (!journalInUse(ctx)) return null;
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
    ...(residualKind(op) ? { residual: true, residualKind: residualKind(op), recovery: residualKind(op) === "plant" ? PLANT_RECOVERY : RESIDUAL_RECOVERY } : {}),
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

function settle(ctx: ManagementContext, operationId: string, outcome: OperationState, error?: { code: string; status: number }, childResidual = false): LinkOperation {
  return updateOperationsJournal(journalPathFor(ctx), nowOf(ctx), journal => {
    const op = findOperation(journal, operationId)!;
    op.state = outcome;
    if (childResidual && op.kind === "enroll") op.childResidual = true;
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
  const childTouched = hasEffect(op, "child_enrolled", "intent") || hasEffect(op, "plant", "intent");
  if (store.links.some(link => link.direction === "hub-initiated" && link.alias.toLowerCase() === wanted && link.id !== reserved.linkId)) {
    return settle(ctx, op.operationId, "unknown", interrupted, childTouched);
  }
  const record = store.links.find(link => link.id === reserved.linkId);
  if (record) {
    if (await compensateNewLink(ctx, state, record)) return settle(ctx, op.operationId, "unknown", interrupted, childTouched);
  } else if (!revokeKeyIdempotent(ctx, reserved.apiKeyId)) {
    return settle(ctx, op.operationId, "unknown", interrupted, childTouched);
  }
  return settle(ctx, op.operationId, childTouched ? "residual" : "failed_clean", interrupted);
}

/**
 * A revoke whose process died, settled from its own marks only. Its link counts as removed by it only after its own
 * removal intent: every other revoke of the link was refused while this entry was open, so a record gone after that
 * mark went by this operation's write, and a record gone before it went some other way (unknown). With the record
 * still there, any started effect (cleanup on the Child, the key revoke, the removal) leaves it unknown.
 */
function recoverRevoke(ctx: ManagementContext, op: LinkOperation): LinkOperation {
  const removed = !readStoreFor(ctx).links.some(link => link.id === op.linkId);
  const removalStarted = hasEffect(op, "record_removed", "intent");
  if (removed && removalStarted) return settle(ctx, op.operationId, "committed");
  const touched = removalStarted || hasEffect(op, "remote_cleanup", "intent") || hasEffect(op, "key_revoked", "intent");
  return settle(ctx, op.operationId, removed || touched ? "unknown" : "failed_clean", { code: "operation_interrupted", status: 409 });
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
      // A plant that did not report completion may have installed the binary anyway (a timeout, a lost connection, an
      // exit after the install). Only the script's own refusal before installing (hash_tool_unavailable) proves none.
      let plantUnsettled = false;
      try { const op = findOperation(readOperationsJournal(path), request.id); plantUnsettled = !!op && hasEffect(op, "plant", "intent") && !hasEffect(op, "plant", "done"); } catch { plantUnsettled = true; }
      const hint = (body.error as { hint?: unknown } | undefined)?.hint;
      const outcome: OperationState = response.status === 202 ? "committed"
        : UNKNOWN_CODES.has(errorCode) ? "unknown"
          : body.residual === true || (plantUnsettled && hint !== "hash_tool_unavailable") ? "residual" : "failed_clean";
      let op: LinkOperation;
      // The Child's side is kept apart from the outcome: an unknown key and a plant whose rollback failed are both true.
      const childResidual = outcome !== "committed" && (body.residual === true || plantUnsettled && hint !== "hash_tool_unavailable");
      try { op = settle(ctx, request.id, outcome, { code: /^[a-z][a-z0-9_]{0,63}$/.test(errorCode) ? errorCode : "apply_failed", status: response.status }, childResidual); } catch {
        // The live outcome stands; the open entry is recovered by the next repeat.
        return response;
      }
      const kind = residualKind(op);
      return Response.json({ ...body, ...outcomeBody(op), ...(kind ? { residual: true, residualKind: kind } : {}) }, { status: response.status, headers: response.headers });
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
      // Clean only when nothing was touched: a cleanup on the Child, a key revoke or a record removal that started
      // (finished or not) may have changed something the failed response does not describe.
      const touched = !current || hasEffect(current, "remote_cleanup", "intent") || hasEffect(current, "key_revoked", "intent") || hasEffect(current, "record_removed", "intent");
      const outcome: OperationState = response.status === 200 ? "committed" : touched ? "unknown" : "failed_clean";
      let op: LinkOperation;
      try { op = settle(ctx, request.id, outcome, { code: /^[a-z][a-z0-9_]{0,63}$/.test(errorCode) ? errorCode : "revoke_failed", status: response.status }); } catch { return response; }
      return Response.json({ ...body, ...outcomeBody(op), ...(op.state === "committed" && op.receipt ? { purged: true } : {}) }, { status: response.status, headers: response.headers });
    },
  };
}

/** GET /api/link/operations[/{id}] and POST /api/link/operations/{id}/resolve (structure/remote-link.md, "Operation journal"). */
export function handleLinkOperationRoutes(ctx: ManagementContext): Response | null {
  const { url, req } = ctx;
  const read = () => readOperationsJournal(journalPathFor(ctx));
  const headers = { "cache-control": "no-store" };
  if (url.pathname === "/api/link/operations" && req.method === "GET") {
    try { return Response.json({ operations: read().operations }, { headers }); } catch {
      return fail("operation_journal_unreadable", "The link operation journal could not be read.", 500);
    }
  }
  const one = /^\/api\/link\/operations\/([^/]+)(\/resolve)?$/.exec(url.pathname);
  if (!one) return null;
  let id: string;
  try { id = decodeURIComponent(one[1]!); } catch { return fail("invalid_operation_id", "The operation id is invalid.", 400); }
  if (!isOperationId(id)) return fail("invalid_operation_id", "The operation id is invalid.", 400);
  if (!one[2] && req.method === "GET") {
    let op: LinkOperation | undefined;
    try { op = findOperation(read(), id); } catch { return fail("operation_journal_unreadable", "The link operation journal could not be read.", 500); }
    return op ? Response.json(op, { headers }) : fail("operation_not_found", "No operation has this id.", 404);
  }
  if (one[2] && req.method === "POST") {
    let resolved: ReturnType<typeof resolveLinkOperation>;
    try { resolved = resolveLinkOperation(journalPathFor(ctx), id, nowOf(ctx)); } catch {
      return fail("operation_journal_failed", "The link operation journal could not be written.", 500);
    }
    if (resolved === null) return fail("operation_not_found", "No operation has this id.", 404);
    if (resolved === "not_resolvable") return fail("operation_not_resolvable", "Only a residual or unknown operation can be resolved.", 409);
    return Response.json(resolved, { headers });
  }
  return null;
}
