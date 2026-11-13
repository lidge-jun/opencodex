/**
 * The management side of the operation journal (src/link/operations-journal.ts; structure/remote-link.md,
 * "Operation journal"): the per-alias lock around apply and revoke, the handle apply marks its effects through,
 * the replay of a recorded outcome, and the recovery of an entry whose process died before it finished.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { AliasLockError, withAliasLock } from "../../link/alias-lock";
import type { ExplicitRoute } from "../../link/explicit-route";
import { assertRoomForNewOperation, findOperation, hasEffect, isOperationId, markRevokeLive, OPERATION_JOURNAL_MAX_RECENT_SETTLED, OPERATION_JOURNAL_MAX_UNSETTLED, OperationsJournalFullError, openEnrollmentFor, operationDigest, operationsJournalPath, readOperationsJournal, resolveLinkOperation, updateOperationsJournal,
  type EnrollEffect, type LinkOperation, type OperationsJournal, type OperationState, type RevokeEffect } from "../../link/operations-journal";
import { readLinkRetirement, type LinkRetirement } from "../../link/retirement";
import { newLinkId } from "../../link/store";
import type { ManagementContext } from "./context";
import { compensateNewLink, fail, readStoreFor, revokeKeyIdempotent, type LinkRouteState } from "./link-route-state";
import type { RouteRequest } from "./link-route-request";

/** A damaged operations.json: nothing reads it as empty, so the answer names the way out. */
export function journalUnreadable(): Response {
  return fail("operation_journal_unreadable", "The link operation journal (<configDir>/link/operations.json) is damaged; keep a copy, move it aside, and retry. ocx link operations shows the same error; a revoke with --force still runs.", 500);
}

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
 * A revoke entry that still owns its link's retirement receipt is never pruned (#8416): its replay is the only path
 * that settles that receipt from its own evidence, recovery must not lose it between two effect marks, and a pruned
 * id could be reused by an unrelated operation. A receipt that cannot be read keeps the entry.
 */
export function ownsRetirement(op: LinkOperation): boolean {
  if (op.kind !== "revoke" || op.linkId === undefined) return false;
  // Its former owner too: every later plain force fences that entry, so it must outlive its retention while the receipt does.
  try {
    const receipt = readLinkRetirement(op.linkId);
    return receipt?.operationId === op.operationId || receipt?.formerOwner === op.operationId;
  } catch { return true; }
}

function retirementOutstanding(op: LinkOperation): boolean {
  if (op.linkId === undefined) return false;
  try { return readLinkRetirement(op.linkId) !== null; } catch { return true; }
}

/**
 * Whether the journal recorded the Child cleanup a receipt stands for (#8416): its owner (the revoke of that link under
 * the receipt's id) marked remote_cleanup done and, for a purge, holds the Child's purged:true for that link. This is
 * the evidence a replayed purge already answers from; the receipt alone is not. Unreadable is false.
 */
export function cleanupRecorded(ctx: ManagementContext, receipt: LinkRetirement): boolean {
  let owner: LinkOperation | undefined;
  try { owner = retirementOwner(readOperationsJournal(journalPathFor(ctx)), receipt); } catch { return false; }
  if (!owner || !hasEffect(owner, "remote_cleanup", "done")) return false;
  return receipt.mode !== "purge" || (owner.receipt?.purged === true && owner.receipt.linkId === receipt.link.id);
}

/**
 * The journalled owner of a retirement receipt: the revoke of that same link under the receipt's operation id. With
 * includeFormer, a receipt a plain --force disowned answers its former owner, which every later force fences too.
 */
export function retirementOwner(journal: OperationsJournal, receipt: LinkRetirement, includeFormer = false): LinkOperation | undefined {
  const id = receipt.operationId ?? (includeFormer ? receipt.formerOwner : undefined);
  if (id === undefined) return undefined;
  const op = findOperation(journal, id);
  return op && op.kind === "revoke" && op.linkId === receipt.link.id ? op : undefined;
}

function updateJournalPinned<T>(path: string, nowMs: number, change: (journal: OperationsJournal) => T): T {
  return updateOperationsJournal(path, nowMs, change, ownsRetirement);
}

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
  try { return await withAliasLock(alias, { ...ctx.deps.linkAliasLock, signal: ctx.req.signal }, action); } catch (error) {
    if (error instanceof AliasLockError) {
      if (error.code === "link_alias_lock_busy") return fail("link_operation_in_progress", "Another enrollment or revoke of this alias is running; try again when it ends.", 409);
      // The client went away while waiting: nothing ran, and nobody is left to read a longer answer.
      if (error.code === "link_alias_lock_aborted") return fail("link_operation_in_progress", "The request ended while it waited for this alias; nothing was changed.", 409);
      return fail("link_alias_lock_failed", "The alias lock could not be taken.", 500);
    }
    throw error;
  }
}

/** An open revoke entry of another operation for this link refuses every other revoke of it. */
export function openRevokeConflict(ctx: ManagementContext, linkId: string, except?: string, force = false): Response | null {
  if (!journalInUse(ctx)) return null;
  let open: LinkOperation | undefined;
  try { open = readOperationsJournal(journalPathFor(ctx)).operations.find(op => op.kind === "revoke" && op.state === "open" && op.linkId === linkId && op.operationId !== except); } catch {
    // --force is the escape hatch: it skips remote cleanup by design, so it must not be locked out by a damaged journal.
    if (force) { console.warn("[link] operation journal unreadable; force revoke proceeds without the open-entry check linkId=" + linkId); return null; }
    return journalUnreadable();
  }
  return open ? fail("link_operation_open", "An unfinished revoke holds this link; repeat it with its operation id to settle it.", 409) : null;
}

/** An open enroll entry of another operation for this alias refuses every other enrollment. */
export function openEnrollmentConflict(ctx: ManagementContext, alias: string, except?: string): Response | null {
  if (!journalInUse(ctx)) return null;
  let open: LinkOperation | undefined;
  try { open = openEnrollmentFor(readOperationsJournal(journalPathFor(ctx)), alias, except); } catch {
    return journalUnreadable();
  }
  return open ? fail("link_operation_open", "An unfinished enrollment holds this alias; repeat it with its operation id to settle it.", 409) : null;
}

function outcomeBody(op: LinkOperation): Record<string, unknown> {
  return { operationId: op.operationId, outcome: op.state };
}

/** The recorded outcome as a response: committed answers like the apply that committed. */
/** A new operation's entry could not be written: 409 when the journal is full, 500 otherwise. Nothing ran either way. */
export function journalOpenFailure(error: unknown): Response {
  if (!(error instanceof OperationsJournalFullError)) return fail("operation_journal_failed", "The link operation journal could not be written; nothing was changed.", 500);
  return error.bound === "unsettled"
    ? fail("operation_journal_full", "The link operation journal holds " + OPERATION_JOURNAL_MAX_UNSETTLED + " unsettled operations. Check the Child of each residual or unknown one and run ocx link operations resolve --operation-id <id> --yes; repeat an open one with its operation id first (ocx link operations lists them). Nothing was changed.", 409)
    : fail("operation_journal_full", "The link operation journal holds " + OPERATION_JOURNAL_MAX_RECENT_SETTLED + " operations that settled within the last day and three minutes; retry once the oldest of them is older than that. Nothing was changed.", 409);
}

export function replayResponse(op: LinkOperation): Response {
  if (op.state === "committed") {
    return Response.json(op.kind === "enroll" ? { linkId: op.reserved!.linkId, ...outcomeBody(op), ...(hasEffect(op, "plant", "done") ? { planted: true } : {}) }
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
    return journalUnreadable();
  }
  if (!op) return null;
  if (op.kind !== kind || op.digest !== request.digest) return fail("operation_mismatch", "This operation id was used with other parameters.", 409);
  if (op.state === "open") op = kind === "enroll" ? await recoverEnroll(ctx, state, op) : recoverRevoke(ctx, op);
  return replayResponse(op);
}

function settle(ctx: ManagementContext, operationId: string, outcome: OperationState, error?: { code: string; status: number }, childResidual = false): LinkOperation {
  return updateJournalPinned(journalPathFor(ctx), nowOf(ctx), journal => {
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
    // Which link is whose is unclear, so the outcome is unknown; but the reserved key id names only this operation's
    // key, and with no record carrying the reserved link id nothing depends on it.
    if (!store.links.some(link => link.id === reserved.linkId)) revokeKeyIdempotent(ctx, reserved.apiKeyId);
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
  // A retirement receipt still outstanding for the link means its post-commit work has not finished (#8416): this
  // revoke's own receipt was resumed before replay, so one left here belongs to another identity or is unreadable.
  const outstanding = retirementOutstanding(op);
  if (removed && removalStarted && !outstanding) return settle(ctx, op.operationId, "committed");
  // An outstanding receipt counts as touched: a removal was claimed and its outcome is not known to be nothing.
  const touched = removalStarted || outstanding || hasEffect(op, "remote_cleanup", "intent") || hasEffect(op, "key_revoked", "intent");
  return settle(ctx, op.operationId, removed || touched ? "unknown" : "failed_clean", { code: "operation_interrupted", status: 409 });
}

/** A plain --force's hold on the owner of the receipt it finishes (fenceRetirementOwnerForForce). */
export interface ForceTakeover {
  readonly operationId: string;
  /**
   * The journal the force's removal runs with: it writes no marks (the force claims nothing); its first intent, written just
   * before the tunnel is held and stopped, marks the takeover begun; the owner settles before the receipt is cleared; release
   * drops the owner's live mark with the tunnel hold.
   */
  readonly journal: RevokeJournal;
  /** Whether the force's removal reached the tunnel (its first intent). */
  readonly began: boolean;
  /** Drop the live mark and settle the owner unknown and unresolved: it is never credited with the force's removal. */
  settle(): void;
  /** The takeover never began its removal: drop the live mark and restore the owner exactly as it was. */
  abandon(): void;
}

/**
 * Before a plain --force finishes an owned receipt, fence its owner for the whole takeover (#8416). An open owner (its
 * process died; the force holds the alias lock and this runtime's per-alias set) or an unknown one is reopened as an
 * open, live revoke once that write is durable, so resolve refuses it while the force runs; the force's removal drops the
 * live mark in the same step that releases the tunnel hold, and settle() leaves the owner unknown and unresolved, so a
 * link the force could not remove stays suspended (revokeSuspendsLink). Null when there is no such owner to fence.
 */
export function fenceRetirementOwnerForForce(ctx: ManagementContext, receipt: LinkRetirement): ForceTakeover | null {
  const path = journalPathFor(ctx);
  // A receipt an earlier force disowned still fences its former owner: a later force could otherwise leave it resolvable.
  const owner = retirementOwner(readOperationsJournal(path), receipt, true);
  if (!owner || (owner.state !== "open" && owner.state !== "unknown")) return null;
  const operationId = owner.operationId;
  const prior = { state: owner.state, finishedAt: owner.finishedAt, resolvedAt: owner.resolvedAt, error: owner.error, updatedAt: owner.updatedAt };
  updateJournalPinned(path, nowOf(ctx), journal => {
    const op = findOperation(journal, operationId);
    if (!op) throw new Error("the revoke operation is no longer journalled");
    if (op.state !== "open") {
      op.state = "open";
      delete op.finishedAt;
      delete op.resolvedAt;
      delete op.error;
      op.updatedAt = iso(ctx);
    }
  });
  markRevokeLive(path, operationId, true);
  let live = true, began = false;
  const drop = (): void => { if (live) { live = false; markRevokeLive(path, operationId, false); } };
  const settleOwner = (): void => {
    const op = findOperation(readOperationsJournal(path), operationId);
    if (op?.state === "open") settle(ctx, operationId, "unknown", { code: "operation_interrupted", status: 409 });
  };
  return {
    operationId,
    get began() { return began; },
    journal: {
      intent() { began = true; }, done() {}, cleanupNotRun() {}, release: drop, finish: async response => response,
      // Settled before the receipt is cleared: a crash after the clear cannot leave the owner open with its own removal
      // intent and the record gone, which recovery would credit to it. A failed write keeps the receipt (and the owner).
      beforeReceiptCleared: () => { drop(); settleOwner(); },
    },
    settle() {
      drop();
      settleOwner();
    },
    abandon() {
      drop();
      if (prior.state === "open") return;
      updateJournalPinned(path, nowOf(ctx), journal => {
        const op = findOperation(journal, operationId);
        if (!op || op.state !== "open") return;
        op.state = prior.state;
        op.updatedAt = prior.updatedAt;
        if (prior.finishedAt !== undefined) op.finishedAt = prior.finishedAt;
        if (prior.resolvedAt !== undefined) op.resolvedAt = prior.resolvedAt;
        if (prior.error !== undefined) op.error = prior.error;
      });
    },
  };
}

/**
 * A recorded revoke whose interrupted retirement was just finished (#8416): its own removal intent preceded the
 * record's disappearance, so it committed, whatever its live response, an earlier recovery or a resolve recorded.
 * The check and the write run in one journal section, so a concurrent resolve cannot leave a committed entry that
 * still carries resolvedAt (which the journal refuses to parse).
 */
export function settleRevokeAfterRetirement(ctx: ManagementContext, operationId: string): void {
  updateJournalPinned(journalPathFor(ctx), nowOf(ctx), journal => {
    const current = findOperation(journal, operationId);
    // failed_clean too: a write failure right after the receipt claim can leave the owner recorded clean (#8416).
    if (!current || current.kind !== "revoke" || (current.state !== "open" && current.state !== "unknown" && current.state !== "failed_clean")) return;
    if (!hasEffect(current, "record_removed", "intent") || readStoreFor(ctx).links.some(link => link.id === current.linkId)) return;
    current.state = "committed";
    delete current.error;
    delete current.resolvedAt;
    current.updatedAt = iso(ctx);
    current.finishedAt = current.updatedAt;
  });
}

/**
 * The journal of a recorded revoke resuming its interrupted retirement (#8416): the resumed key revoke and record
 * removal are marked on that same entry, so a crash after the resumed removal still settles it as committed.
 * Used only while the link record is present, so a record another removal already took is never credited here.
 * The entry settles before the receipt is cleared: a crash between them leaves the receipt for the next repeat to
 * resume, never a finished removal whose entry stays unknown with nothing left to resume.
 */
export function resumedRevokeJournal(ctx: ManagementContext, operationId: string, markEffects: boolean): RevokeJournal {
  const path = journalPathFor(ctx);
  let reopened = false;
  // The resumed removal runs as an open, live revoke from its first intent (written before stopLink, whether or not the
  // Child cleanup is rerun): resolve refuses an open entry, so no resolution (earlier or concurrent) can cover a removal
  // whose outcome is pending; a resume that fails settles it unknown and unresolved (settleResumedRevoke), so the link
  // stays suspended (revokeSuspendsLink). The live mark is set only once that reopening write is durable.
  const mark = (effect: RevokeEffect, phase: "intent" | "done", receipt?: { purged: true; linkId: string }) => {
    if (!markEffects) return;
    const reopen = phase === "intent" && !reopened;
    updateJournalPinned(path, nowOf(ctx), journal => {
      const op = findOperation(journal, operationId);
      if (!op) throw new Error("the revoke operation is no longer journalled");
      // Recovery reads only whether a mark exists (hasEffect), so a mark already recorded is not appended again: repeated
      // resumes of a pinned entry cannot grow it past one intent and one completion per effect.
      if (!hasEffect(op, effect, phase)) op.effects.push({ effect, phase, at: iso(ctx) });
      if (receipt) op.receipt = receipt;
      op.updatedAt = iso(ctx);
      if (reopen && op.state !== "open") {
        op.state = "open";
        delete op.finishedAt;
        delete op.resolvedAt;
        delete op.error;
      }
    });
    if (reopen) {
      reopened = true;
      markRevokeLive(path, operationId, true);
    }
  };
  return {
    operationId,
    keepsTunnelDown: true,
    intent: effect => mark(effect, "intent"),
    // As for a fresh revoke: a completion is best effort unless it carries the Child's purge receipt.
    done: (effect, receipt) => {
      try { mark(effect, "done", receipt); } catch (error) {
        if (receipt) throw error;
        console.warn("[link] resumed revoke journal mark not written operation=" + operationId + " mark=" + effect + ":done");
      }
    },
    beforeReceiptCleared: () => settleRevokeAfterRetirement(ctx, operationId),
    cleanupNotRun: () => {},
    release: () => { if (reopened) markRevokeLive(path, operationId, false); },
    finish: async response => response,
  };
}

/**
 * A resumed retirement that did not finish (#8416): an owner it left open settles unknown, unresolved, with the
 * failure's code, as a fresh revoke's finish settles it; its live mark goes in the same step.
 */
export async function settleResumedRevoke(ctx: ManagementContext, operationId: string, response: Response): Promise<void> {
  const path = journalPathFor(ctx);
  // Dropped before anything awaits: an open entry that is not live is suspended until it settles.
  markRevokeLive(path, operationId, false);
  try {
    let code = "revoke_failed";
    try {
      const body = await response.clone().json() as { error?: { code?: unknown } };
      if (typeof body.error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(body.error.code)) code = body.error.code;
    } catch { /* keeps revoke_failed */ }
    const op = findOperation(readOperationsJournal(path), operationId);
    if (op?.state === "open") settle(ctx, operationId, "unknown", { code, status: response.status >= 400 && response.status <= 599 ? response.status : 500 });
  } finally { markRevokeLive(path, operationId, false); }
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
  updateJournalPinned(path, nowOf(ctx), journal => {
    assertRoomForNewOperation(journal, nowOf(ctx));
    journal.operations.push({
      operationId: request.id, kind: "enroll", alias, digest: request.digest, createdAt: iso(ctx), updatedAt: iso(ctx), state: "open",
      reserved: { linkId: reservedLinkId, apiKeyId: reservedKeyId, tunnelPort: null, ...route }, effects: [],
    });
  });
  const change = (edit: (op: LinkOperation) => void) => updateJournalPinned(path, nowOf(ctx), journal => {
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
      const planted = op.state === "committed" && hasEffect(op, "plant", "done");
      return Response.json({ ...body, ...outcomeBody(op), ...(kind ? { residual: true, residualKind: kind } : {}), ...(planted ? { planted: true } : {}) },
        { status: response.status, headers: response.headers });
    },
  };
}

export function revokeOperationDigest(params: { linkId: string; purge: boolean; force: boolean }): string {
  return operationDigest({ kind: "revoke", linkId: params.linkId, purge: params.purge, force: params.force });
}

export interface RevokeJournal {
  /** The journalled revoke this removal runs under; its retirement receipt names it. */
  readonly operationId?: string;
  /** Strict: a failed write throws before its effect runs. */
  intent(effect: RevokeEffect): void;
  /**
   * Best effort without a receipt: the effect has already happened and recovery reads an intent without its completion
   * as "may have happened". With a receipt (the Child's purged:true for this link id) it is strict and throws, because
   * the link must not be removed on evidence that a crash would lose.
   */
  done(effect: RevokeEffect, receipt?: { purged: true; linkId: string }): void;
  /** Runs after the post-commit cleanup and before the retirement receipt is cleared; a throw keeps the receipt. */
  beforeReceiptCleared?(): void;
  /**
   * A resumed retirement (#8416): an earlier cleanup attempt may already have reached the Child, so a failed cleanup never
   * restarts the tunnel, even one that provably did not run this time; the owner settles unknown and stays suspended.
   */
  readonly keepsTunnelDown?: boolean;
  /** The Child's cleanup failed before it ran (removeReserved): the outcome can be failed_clean despite its intent. */
  cleanupNotRun(): void;
  /** Drop this revoke's live registration; finish does too, this covers a revoke that threw before it. */
  release(): void;
  finish(response: Response): Promise<Response>;
}

export const NO_REVOKE_JOURNAL: RevokeJournal = { intent() {}, done() {}, cleanupNotRun() {}, release() {}, finish: async response => response };

/** Write the open revoke entry; a write failure throws before the revoke changes anything. */
export function openRevokeJournal(ctx: ManagementContext, request: OperationRequest, alias: string, linkId: string): RevokeJournal {
  const path = journalPathFor(ctx);
  updateJournalPinned(path, nowOf(ctx), journal => {
    assertRoomForNewOperation(journal, nowOf(ctx));
    journal.operations.push({ operationId: request.id, kind: "revoke", alias, linkId, digest: request.digest, createdAt: iso(ctx), updatedAt: iso(ctx), state: "open", effects: [] });
  });
  // Until finish, this entry is the running revoke's: the supervisor does not suspend its link for it (revokeSuspendsLink).
  markRevokeLive(path, request.id, true);
  let cleanupRan = true;
  const change = (edit: (op: LinkOperation) => void) => updateJournalPinned(path, nowOf(ctx), journal => {
    const op = findOperation(journal, request.id)!;
    edit(op);
    op.updatedAt = iso(ctx);
  });
  return {
    operationId: request.id,
    intent: effect => { ctx.deps.linkOperationMarkHook?.(effect, "intent"); change(op => { op.effects.push({ effect, phase: "intent", at: iso(ctx) }); }); },
    done: (effect, receipt) => {
      try {
        ctx.deps.linkOperationMarkHook?.(effect, "done");
        change(op => { op.effects.push({ effect, phase: "done", at: iso(ctx) }); if (receipt) op.receipt = receipt; });
      } catch (error) {
        if (receipt) throw error;
        console.warn("[link] revoke journal mark not written operation=" + request.id + " mark=" + effect + ":done");
      }
    },
    cleanupNotRun: () => { cleanupRan = false; },
    release: () => { markRevokeLive(path, request.id, false); },
    async finish(response) {
      try { return await settleRevoke(response); } finally { markRevokeLive(path, request.id, false); }
    },
  };
  async function settleRevoke(response: Response): Promise<Response> {
    let body: Record<string, unknown> = {};
    try { body = await response.clone().json() as Record<string, unknown>; } catch { /* keeps its status */ }
    const errorCode = typeof (body.error as { code?: unknown } | undefined)?.code === "string" ? (body.error as { code: string }).code : "revoke_failed";
    let current: LinkOperation | undefined;
    try { current = findOperation(readOperationsJournal(path), request.id); } catch { current = undefined; }
    // Clean only when nothing was touched: a cleanup on the Child, a key revoke or a record removal that started
    // (finished or not) may have changed something the failed response does not describe.
    const touched = !current || (cleanupRan && hasEffect(current, "remote_cleanup", "intent")) || hasEffect(current, "key_revoked", "intent") || hasEffect(current, "record_removed", "intent");
    const outcome: OperationState = response.status === 200 ? "committed" : touched ? "unknown" : "failed_clean";
    let op: LinkOperation;
    try { op = settle(ctx, request.id, outcome, { code: /^[a-z][a-z0-9_]{0,63}$/.test(errorCode) ? errorCode : "revoke_failed", status: response.status }); } catch { return response; }
    return Response.json({ ...body, ...outcomeBody(op), ...(op.state === "committed" && op.receipt ? { purged: true } : {}) }, { status: response.status, headers: response.headers });
  }
}

/** GET /api/link/operations[/{id}] and POST /api/link/operations/{id}/resolve (structure/remote-link.md, "Operation journal"). */
export function handleLinkOperationRoutes(ctx: ManagementContext): Response | null {
  const { url, req } = ctx;
  const read = () => readOperationsJournal(journalPathFor(ctx));
  const headers = { "cache-control": "no-store" };
  if (url.pathname === "/api/link/operations" && req.method === "GET") {
    try { return Response.json({ operations: read().operations }, { headers }); } catch {
      return journalUnreadable();
    }
  }
  const one = /^\/api\/link\/operations\/([^/]+)(\/resolve)?$/.exec(url.pathname);
  if (!one) return null;
  let id: string;
  try { id = decodeURIComponent(one[1]!); } catch { return fail("invalid_operation_id", "The operation id is invalid.", 400); }
  if (!isOperationId(id)) return fail("invalid_operation_id", "The operation id is invalid.", 400);
  if (!one[2] && req.method === "GET") {
    let op: LinkOperation | undefined;
    try { op = findOperation(read(), id); } catch { return journalUnreadable(); }
    return op ? Response.json(op, { headers }) : fail("operation_not_found", "No operation has this id.", 404);
  }
  if (one[2] && req.method === "POST") {
    let resolved: ReturnType<typeof resolveLinkOperation>;
    try { resolved = resolveLinkOperation(journalPathFor(ctx), id, nowOf(ctx), ownsRetirement); } catch {
      return fail("operation_journal_failed", "The link operation journal could not be written.", 500);
    }
    if (resolved === null) return fail("operation_not_found", "No operation has this id.", 404);
    if (resolved === "not_resolvable") return fail("operation_not_resolvable", "Only a residual or unknown operation can be resolved.", 409);
    // An unknown revoke past its Child cleanup suspended its link's tunnel (revokeSuspendsLink); resolving lifts that,
    // and an idle link is not retried on a tick, so the tunnels are reloaded. Best effort: the resolve is already stored.
    if (resolved.kind === "revoke") {
      void ctx.deps.linkSupervisor?.()?.reload().catch(() => console.warn("[link] operation resolved; tunnel reload failed"));
    }
    return Response.json(resolved, { headers });
  }
  return null;
}
