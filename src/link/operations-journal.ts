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
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { parseExplicitRoute, type ExplicitRoute } from "./explicit-route";
import { isLinkPort } from "./ports";
import { linkDir } from "./paths";
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
 */
export function pruneOperations(journal: OperationsJournal, nowMs: number): OperationsJournal {
  const expired = (at: string | undefined) => at !== undefined && nowMs - Date.parse(at) > OPERATION_RETENTION_MS;
  return { version: 1, operations: journal.operations.filter(op => {
    if (op.state === "committed" || op.state === "failed_clean") return !expired(op.finishedAt);
    if (op.state === "residual" || op.state === "unknown") return !expired(op.resolvedAt);
    return true;
  }) };
}

/** Read, change and write the journal in one section of the config mutation lock, pruning on the way. */
export function updateOperationsJournal<T>(path: string, nowMs: number, change: (journal: OperationsJournal) => T): T {
  return withConfigMutationLockSync(() => {
    const journal = readOperationsJournal(path);
    const result = change(journal);
    writeOperationsJournal(path, pruneOperations(journal, nowMs));
    return result;
  });
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
export function resolveLinkOperation(path: string, operationId: string, nowMs: number): LinkOperation | "not_resolvable" | null {
  return updateOperationsJournal(path, nowMs, journal => {
    const op = findOperation(journal, operationId);
    if (!op) return null;
    if (op.state !== "residual" && op.state !== "unknown") return "not_resolvable";
    if (op.resolvedAt === undefined) {
      op.resolvedAt = new Date(nowMs).toISOString();
      op.updatedAt = op.resolvedAt;
    }
    return structuredClone(op);
  });
}
