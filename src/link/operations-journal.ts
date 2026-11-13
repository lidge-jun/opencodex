/**
 * The enrollment and revoke journal behind ocx link add|revoke --operation-id (structure/remote-link.md,
 * "Operation journal"). One entry per operation id: the identities its effects will create, reserved before any
 * effect; an intent and a completion mark around each effect; and an outcome. A repeat with the same id and
 * parameter digest reads it back instead of acting again.
 *
 * <configDir>/link/operations.json is a trust boundary like links.json: an unknown field is an error, a damaged
 * file is an error and never an empty journal, and every write replaces the file atomically (0600). It holds no
 * secret: key ids, link ids, ports and the public explicit route only. links.json is unchanged by it.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { parseExplicitRoute, type ExplicitRoute } from "./explicit-route";
import { isLinkPort } from "./ports";
import { linkDir } from "./paths";
import { ALIAS_LOCK_WAIT_MS } from "./alias-lock";
import { isSshAlias } from "./ssh-argv";

export type OperationKind = "enroll" | "revoke";
export type OperationState = "open" | "committed" | "failed_clean" | "residual" | "unknown";
export type EnrollEffect = "plant" | "key_issued" | "link_recorded" | "child_enrolled" | "relay_verified";
export type RevokeEffect = "remote_cleanup" | "key_revoked" | "record_removed";
export type OperationEffect = EnrollEffect | RevokeEffect;

export interface EffectMark { effect: OperationEffect; phase: "intent" | "done"; at: string }

export interface EnrollReservation {
  linkId: string;
  apiKeyId: string;
  /** Chosen by the Child; recorded before the first Home effect, null until then. */
  tunnelPort: number | null;
  explicitRoute?: ExplicitRoute;
  exclusive?: true;
}

export interface LinkOperation {
  operationId: string;
  kind: OperationKind;
  alias: string;
  /** sha256 of the operation's canonical parameters; a repeat with another digest is refused. */
  digest: string;
  createdAt: string;
  updatedAt: string;
  state: OperationState;
  /** enroll only. */
  reserved?: EnrollReservation;
  /** revoke only: the link it removes. */
  linkId?: string;
  effects: EffectMark[];
  /** The fixed code and status the operation ended with, when it did not commit. Never remote text. */
  error?: { code: string; status: number };
  /** revoke --purge: the Child reported purged:true for this link id over the link's pinned route. */
  receipt?: { purged: true; linkId: string };
  /** When the state became terminal. */
  finishedAt?: string;
  /** residual or unknown only: when O5 or a person resolved it. */
  resolvedAt?: string;
  /** enroll only: the Child may still hold an enrollment or a plant, whatever the outcome says about the Home's key. */
  childResidual?: true;
}

export interface OperationsJournal { version: 1; operations: LinkOperation[] }

export class OperationsJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationsJournalError";
  }
}

/** Committed and failed_clean entries, and resolved residual or unknown ones, stay this long. */
export const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * At most this many unsettled entries: open ones and residual or unknown ones nobody resolved yet. Only these need a
 * person (or O5) and only these refuse a new operation once the bound is reached; marks on existing entries are always
 * written. A provisioning hub caps disposable machines at 10 by default, each with a handful of operations, so 256 is far
 * past what a working fleet leaves unsettled.
 */
export const OPERATION_JOURNAL_MAX_UNSETTLED = 256;
/**
 * Settled entries (committed, failed_clean, and resolved residual or unknown ones) past this many are pruned before their
 * 30 days, oldest first (by when they finished or were resolved), but only once they are past OPERATION_PRUNE_FLOOR_MS:
 * a repeat with the same operation id and the same parameters (another set answers operation_mismatch) that reaches the
 * journal within 2 hours of the answer gets the recorded outcome
 * (status, code and outcome), whatever else ran meanwhile, except that a revoke whose own removal was interrupted (its
 * retirement receipt is outstanding) resumes it first and answers that attempt; the alias lock busy past its wait changes
 * nothing and is retried, and after an unreadable journal or a 5xx the caller repeats with the same id (neither proves
 * that nothing changed: a replay after a resumed removal can meet them once that removal finished). Later the id may be treated as a new operation: an
 * enrollment whose link is there meets link_exists and a revoke whose link is gone link_not_found, but an enrollment
 * whose link was removed meanwhile enrolls the machine again. Unsettled entries are never pruned and the 30-day
 * retention does not depend on this.
 */
export const OPERATION_JOURNAL_MAX_SETTLED = 256;
/** The replay guarantee, however many operations follow an entry: 2 hours, far past any caller's retry of a lost answer. */
export const OPERATION_REPLAY_MIN_MS = 2 * 60 * 60 * 1000;
/**
 * The age before which a settled entry is never pruned early: the 2-hour replay window, plus the longest alias-lock wait
 * and a minute, so a retry that started within the window and then waited on the lock still finds its entry.
 */
export const OPERATION_PRUNE_FLOOR_MS = OPERATION_REPLAY_MIN_MS + ALIAS_LOCK_WAIT_MS + 60_000;
/**
 * At this many entries settled within OPERATION_PRUNE_FLOOR_MS (2 hours and three minutes) a new operation is refused
 * until the oldest is older. That is a throughput limit as much as a runaway guard: a burst of 1024, and about 500
 * journalled operations per hour sustained (1024 / 2.05 h). Churn, not machine count, decides whether it is reached: ten
 * disposable machines that each live ten minutes make about 120 add and revoke operations per hour, about 246 inside the
 * window, a quarter of the bound. A runaway loop that retries with a fresh id after each failure is held for at most that
 * window instead of locking the Home out for 30 days. With the three bounds the file holds about 256 unsettled plus
 * 256 older settled entries (about 0.5 MiB at roughly 1 KiB each), and at most about 1.5 MiB at the limit, plus the
 * entries an outstanding retirement receipt pins (at most two per readable receipt, every revoke entry of a link whose
 * receipt cannot be read; receipts have no cap of their own), so every
 * whole-file rewrite under the config mutation lock stays small while receipts are settled.
 */
export const OPERATION_JOURNAL_MAX_RECENT_SETTLED = 1024;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const API_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const STATES: readonly OperationState[] = ["open", "committed", "failed_clean", "residual", "unknown"];
const EFFECTS: Readonly<Record<OperationKind, readonly OperationEffect[]>> = {
  enroll: ["plant", "key_issued", "link_recorded", "child_enrolled", "relay_verified"],
  revoke: ["remote_cleanup", "key_revoked", "record_removed"],
};
const ENTRY_KEYS = new Set(["operationId", "kind", "alias", "digest", "createdAt", "updatedAt", "state", "reserved", "linkId", "effects", "error", "receipt", "finishedAt", "resolvedAt", "childResidual"]);
const RESERVED_KEYS = new Set(["linkId", "apiKeyId", "tunnelPort", "explicitRoute", "exclusive"]);

export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID.test(value);
}

export function operationsJournalPath(configDir?: string): string {
  return join(linkDir(configDir), "operations.json");
}

/** A stable digest of an operation's parameters: keys sorted at every level, undefined dropped. */
export function operationDigest(params: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(params))).digest("hex");
}

export function hasEffect(operation: LinkOperation, effect: OperationEffect, phase: "intent" | "done"): boolean {
  return operation.effects.some(mark => mark.effect === effect && mark.phase === phase);
}

const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

function parseEntry(value: unknown, index: number): LinkOperation {
  const fail = (field: string): never => { throw new OperationsJournalError("operations[" + index + "]." + field + " is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperationsJournalError("operations[" + index + "] is not an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) throw new OperationsJournalError("operations[" + index + "] has an unknown field " + JSON.stringify(key));
  if (!isOperationId(raw.operationId)) fail("operationId");
  if (raw.kind !== "enroll" && raw.kind !== "revoke") fail("kind");
  const kind = raw.kind as OperationKind;
  if (typeof raw.alias !== "string" || !isSshAlias(raw.alias)) fail("alias");
  if (typeof raw.digest !== "string" || !DIGEST.test(raw.digest)) fail("digest");
  if (!isTime(raw.createdAt)) fail("createdAt");
  if (!isTime(raw.updatedAt)) fail("updatedAt");
  if (!STATES.includes(raw.state as OperationState)) fail("state");
  const state = raw.state as OperationState;
  let reserved: EnrollReservation | undefined;
  if (kind === "enroll") {
    const r = raw.reserved;
    if (!r || typeof r !== "object" || Array.isArray(r)) fail("reserved");
    const res = r as Record<string, unknown>;
    for (const key of Object.keys(res)) if (!RESERVED_KEYS.has(key)) fail("reserved");
    if (typeof res.linkId !== "string" || !LINK_ID.test(res.linkId)) fail("reserved.linkId");
    if (typeof res.apiKeyId !== "string" || !API_KEY_ID.test(res.apiKeyId)) fail("reserved.apiKeyId");
    if (res.tunnelPort !== null && !isLinkPort(res.tunnelPort)) fail("reserved.tunnelPort");
    if (res.exclusive !== undefined && res.exclusive !== true) fail("reserved.exclusive");
    const route = res.explicitRoute === undefined ? undefined : parseExplicitRoute(res.explicitRoute);
    if (route === null || (route && res.exclusive !== true)) fail("reserved.explicitRoute");
    reserved = { linkId: res.linkId as string, apiKeyId: res.apiKeyId as string, tunnelPort: res.tunnelPort as number | null,
      ...(route ? { explicitRoute: route } : {}), ...(res.exclusive === true ? { exclusive: true as const } : {}) };
    if (raw.linkId !== undefined || raw.receipt !== undefined) fail("linkId");
  } else {
    if (raw.reserved !== undefined) fail("reserved");
    if (typeof raw.linkId !== "string" || !LINK_ID.test(raw.linkId)) fail("linkId");
  }
  if (!Array.isArray(raw.effects)) fail("effects");
  const effects = (raw.effects as unknown[]).map((mark, at): EffectMark => {
    if (!mark || typeof mark !== "object" || Array.isArray(mark)) fail("effects[" + at + "]");
    const m = mark as Record<string, unknown>;
    if (Object.keys(m).sort().join(",") !== "at,effect,phase" || !EFFECTS[kind].includes(m.effect as OperationEffect)
      || (m.phase !== "intent" && m.phase !== "done") || !isTime(m.at)) fail("effects[" + at + "]");
    return { effect: m.effect as OperationEffect, phase: m.phase as "intent" | "done", at: m.at as string };
  });
  let error: LinkOperation["error"];
  if (raw.error !== undefined) {
    const e = raw.error as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || Object.keys(e).sort().join(",") !== "code,status" || typeof e.code !== "string" || !CODE.test(e.code)
      || typeof e.status !== "number" || !Number.isInteger(e.status) || e.status < 400 || e.status > 599) fail("error");
    error = { code: e!.code as string, status: e!.status as number };
  }
  let receipt: LinkOperation["receipt"];
  if (raw.receipt !== undefined) {
    const p = raw.receipt as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || Object.keys(p).sort().join(",") !== "linkId,purged" || p.purged !== true || p.linkId !== raw.linkId) fail("receipt");
    receipt = { purged: true, linkId: p!.linkId as string };
  }
  if (raw.finishedAt !== undefined && !isTime(raw.finishedAt)) fail("finishedAt");
  if ((state === "open") !== (raw.finishedAt === undefined)) fail("finishedAt");
  if (raw.resolvedAt !== undefined && (!isTime(raw.resolvedAt) || (state !== "residual" && state !== "unknown"))) fail("resolvedAt");
  if (raw.childResidual !== undefined && (raw.childResidual !== true || kind !== "enroll")) fail("childResidual");
  return {
    operationId: raw.operationId as string, kind, alias: raw.alias as string, digest: raw.digest as string,
    createdAt: raw.createdAt as string, updatedAt: raw.updatedAt as string, state,
    ...(reserved ? { reserved } : {}), ...(kind === "revoke" ? { linkId: raw.linkId as string } : {}),
    effects, ...(error ? { error } : {}), ...(receipt ? { receipt } : {}),
    ...(raw.finishedAt !== undefined ? { finishedAt: raw.finishedAt as string } : {}),
    ...(raw.resolvedAt !== undefined ? { resolvedAt: raw.resolvedAt as string } : {}),
    ...(raw.childResidual === true ? { childResidual: true as const } : {}),
  };
}

export function parseOperationsJournal(text: string): OperationsJournal {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new OperationsJournalError("operations.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OperationsJournalError("operations.json is not an object");
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "operations,version" || body.version !== 1 || !Array.isArray(body.operations)) {
    throw new OperationsJournalError("operations.json has an unsupported shape");
  }
  const operations = body.operations.map(parseEntry);
  if (new Set(operations.map(op => op.operationId)).size !== operations.length) throw new OperationsJournalError("operations.json has duplicate operation ids");
  return { version: 1, operations };
}

/** A missing file is an empty journal; a damaged one is an error. */
export function readOperationsJournal(path: string = operationsJournalPath()): OperationsJournal {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if (isMissingPathError(error)) return { version: 1, operations: [] };
    throw error;
  }
  return parseOperationsJournal(text);
}

export function writeOperationsJournal(path: string, journal: OperationsJournal): void {
  const normalized = parseOperationsJournal(JSON.stringify(journal));
  const dir = dirname(path);
  assertNotRealHomeUnderTest(dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  atomicWriteFile(path, JSON.stringify(normalized, null, 2) + "\n");
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/**
 * Drop what has outlived retention: a committed or failed_clean entry 30 days after it finished, a residual or
 * unknown one only 30 days after it was resolved. An open entry, and an unresolved residual or unknown one, stays.
 * Past OPERATION_JOURNAL_MAX_SETTLED settled entries, the oldest settled ones older than OPERATION_PRUNE_FLOOR_MS go too.
 */
export function pruneOperations(journal: OperationsJournal, nowMs: number, keep?: (op: LinkOperation) => boolean): OperationsJournal {
  const expired = (at: string | undefined) => at !== undefined && nowMs - Date.parse(at) > OPERATION_RETENTION_MS;
  const retained = journal.operations.filter(op => {
    // A caller-pinned entry stays past retention: a revoke that still owns a retirement receipt (#8416).
    if (keep?.(op)) return true;
    if (op.state === "committed" || op.state === "failed_clean") return !expired(op.finishedAt);
    if (op.state === "residual" || op.state === "unknown") return !expired(op.resolvedAt);
    return true;
  });
  const settled = retained.filter(isSettled);
  if (settled.length <= OPERATION_JOURNAL_MAX_SETTLED) return { version: 1, operations: retained };
  // A stable sort: entries settled at the same moment go in journal order.
  const candidates = settled.map((op, index) => ({ op, index })).filter(item => !keep?.(item.op) && nowMs - settledAt(item.op) > OPERATION_PRUNE_FLOOR_MS)
    .sort((a, b) => settledAt(a.op) - settledAt(b.op) || a.index - b.index);
  const dropped = new Set(candidates.slice(0, settled.length - OPERATION_JOURNAL_MAX_SETTLED).map(item => item.op));
  return { version: 1, operations: retained.filter(op => !dropped.has(op)) };
}

function settledAt(op: LinkOperation): number {
  return Date.parse(op.resolvedAt ?? op.finishedAt ?? op.updatedAt);
}

/** Committed, failed_clean, or residual or unknown and resolved: nothing about it waits on anyone. */
function isSettled(op: LinkOperation): boolean {
  return op.state === "committed" || op.state === "failed_clean" || ((op.state === "residual" || op.state === "unknown") && op.resolvedAt !== undefined);
}

/**
 * Read, change and write the journal in one section of the config mutation lock, pruning on the way. Writes only
 * when the change or the prune altered the journal: a read that finds nothing to do (an unknown id, a state that
 * cannot be resolved) never rewrites the file, and never creates it, because its mere existence makes every plain
 * apply and revoke take the alias lock (journalInUse). keep pins entries against pruning.
 */
export function updateOperationsJournal<T>(path: string, nowMs: number, change: (journal: OperationsJournal) => T, keep?: (op: LinkOperation) => boolean): T {
  return withConfigMutationLockSync(() => {
    const journal = readOperationsJournal(path);
    const before = JSON.stringify(journal);
    const result = change(journal);
    const next = pruneOperations(journal, nowMs, keep);
    if (JSON.stringify(next) !== before) writeOperationsJournal(path, next);
    return result;
  });
}

export class OperationsJournalFullError extends Error {
  /** unsettled: too many open or unresolved entries; recent: too many settled within OPERATION_PRUNE_FLOOR_MS. */
  constructor(readonly bound: "unsettled" | "recent") {
    super(bound === "unsettled"
      ? "operations.json holds " + OPERATION_JOURNAL_MAX_UNSETTLED + " unsettled entries"
      : "operations.json holds " + OPERATION_JOURNAL_MAX_RECENT_SETTLED + " entries settled within 2 hours and three minutes");
    this.name = "OperationsJournalFullError";
  }
}

/** Throws before a new entry is added at OPERATION_JOURNAL_MAX_UNSETTLED unsettled or OPERATION_JOURNAL_MAX_RECENT_SETTLED recently settled entries. */
export function assertRoomForNewOperation(journal: OperationsJournal, nowMs: number): void {
  const kept = pruneOperations(journal, nowMs).operations;
  if (kept.filter(op => !isSettled(op)).length >= OPERATION_JOURNAL_MAX_UNSETTLED) throw new OperationsJournalFullError("unsettled");
  if (kept.filter(op => isSettled(op) && nowMs - settledAt(op) <= OPERATION_PRUNE_FLOOR_MS).length >= OPERATION_JOURNAL_MAX_RECENT_SETTLED) throw new OperationsJournalFullError("recent");
}

export function findOperation(journal: OperationsJournal, operationId: string): LinkOperation | undefined {
  return journal.operations.find(op => op.operationId === operationId);
}

/** An open enroll entry for this alias, in any case: no other enrollment may create an object for it meanwhile. */
export function openEnrollmentFor(journal: OperationsJournal, alias: string, except?: string): LinkOperation | undefined {
  const wanted = alias.toLowerCase();
  return journal.operations.find(op => op.kind === "enroll" && op.state === "open" && op.operationId !== except && op.alias.toLowerCase() === wanted);
}

/**
 * Mark a residual or unknown entry resolved: O5 proved the Child clean, or a person accepted the loss. Its 30 days
 * of retention start now. An entry in any other state is not resolvable; a missing one is null.
 */
export function resolveLinkOperation(path: string, operationId: string, nowMs: number, keep?: (op: LinkOperation) => boolean): LinkOperation | "not_resolvable" | null {
  return updateOperationsJournal(path, nowMs, journal => {
    const op = findOperation(journal, operationId);
    if (!op) return null;
    if (op.state !== "residual" && op.state !== "unknown") return "not_resolvable";
    if (op.resolvedAt === undefined) {
      op.resolvedAt = new Date(nowMs).toISOString();
      op.updatedAt = op.resolvedAt;
    }
    return structuredClone(op);
  }, keep);
}

/**
 * Revokes running in this process, by journal path and operation id. While one runs, its entry is open and the tunnel
 * decisions are its own: a failed cleanup restarts the tunnel. An open entry no process runs belongs to a revoke that died.
 */
const liveRevokes = new Set<string>();

export function markRevokeLive(path: string, operationId: string, live: boolean): void {
  if (live) liveRevokes.add(path + "\0" + operationId);
  else liveRevokes.delete(path + "\0" + operationId);
}

/**
 * A revoke that reached the Child's cleanup and has not settled suspends its link's tunnel: the Child may be purged or
 * disconnected, so the supervisor must not reconnect to it on a reload or after a restart. That is an unresolved unknown
 * entry past its `remote_cleanup` intent (a cleanup that provably never ran settles failed_clean instead, and its revoke
 * restarts the tunnel), and an open one no process in this Home runs (it died). Resolving the entry, or a revoke that
 * removes the link, lifts it.
 */
export function revokeSuspendsLink(journal: OperationsJournal, linkId: string, isLive: (operationId: string) => boolean): boolean {
  return suspendingRevoke(journal, linkId, isLive) !== undefined;
}

function suspendingRevoke(journal: OperationsJournal, linkId: string, isLive: (operationId: string) => boolean): LinkOperation | undefined {
  return journal.operations.find(op => op.kind === "revoke" && op.linkId === linkId && op.resolvedAt === undefined
    && hasEffect(op, "remote_cleanup", "intent")
    && (op.state === "open" ? !isLive(op.operationId) : op.state === "unknown"));
}

/** The revoke that keeps a link down: its id, whether it is open (the process died) or unknown, and since when. */
export interface LinkSuspension { operationId: string; state: "open" | "unknown"; since: string }

/** Like linkSuspendedByRevoke, naming the revoke; null when the link is not suspended or the journal is unreadable. */
export function revokeSuspendingLink(path: string, linkId: string): LinkSuspension | null {
  return revokeSuspensions(path)(linkId);
}

/** One read of the journal, then a lookup per link: a status snapshot reads the file once. */
export function revokeSuspensions(path: string): (linkId: string) => LinkSuspension | null {
  if (!existsSync(path)) return () => null;
  let journal: OperationsJournal;
  try { journal = readOperationsJournal(path); } catch { return () => null; }
  return linkId => {
    const op = suspendingRevoke(journal, linkId, id => liveRevokes.has(path + "\0" + id));
    return op ? { operationId: op.operationId, state: op.state === "open" ? "open" : "unknown", since: op.finishedAt ?? op.updatedAt } : null;
  };
}

/**
 * The supervisor's check: one stat on a Home that never journalled. A damaged journal suspends nothing (a tunnel toward
 * a purged Child serves nothing without its key, and stopping every tunnel would be worse); its readers report it.
 */
export function linkSuspendedByRevoke(path: string, linkId: string): boolean {
  return revokeSuspendingLink(path, linkId) !== null;
}
