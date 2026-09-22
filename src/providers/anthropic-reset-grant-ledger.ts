/**
 * Durable journal for Anthropic reset-grant claims.
 *
 * One dashboard confirmation is one operation. Its UUIDv4 id is also the
 * upstream `request_id`, so a retry of the same operation is the same claim to
 * Anthropic. The Claude Code client reuses an unsettled claim's request id for
 * ten minutes (`b5o = 600000`) and mints a new one afterwards; this journal keeps
 * the same window.
 *
 * Rules (devlog/_plan/260923_claude_reset_grants/010_plan.md, "Ledger contract"):
 * - Every read-modify-write runs synchronously inside a cross-process
 *   `BEGIN IMMEDIATE` lock on a sibling SQLite file; nothing awaits inside it,
 *   and the upstream claim always runs after the open record is on disk.
 * - An open record carries a lease; a second attempt inside it is refused.
 * - Settlement is never inferred. The first terminal settlement wins.
 * - An unreadable journal refuses the spend instead of starting from empty.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileStreamed } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";

export const ANTHROPIC_RESET_LEASE_MS = 90_000;
export const ANTHROPIC_RESET_RETRY_WINDOW_MS = 600_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_OPERATIONS = 256;

export type AnthropicResetLedgerErrorCode = "busy" | "unavailable" | "write_failed";

export class AnthropicResetLedgerError extends Error {
  constructor(readonly code: AnthropicResetLedgerErrorCode) {
    super(`Anthropic reset-grant journal ${code}`);
    this.name = "AnthropicResetLedgerError";
  }
}

interface OperationRecord {
  accountId: string;
  grantId: string;
  orgDigest: string;
  status: "open" | "settled";
  code?: string;
  resetsLeft?: number | null;
  attempts: number;
  leaseUntil: number;
  createdAt: number;
  updatedAt: number;
}

interface Journal {
  version: 1;
  operations: Record<string, OperationRecord>;
}

export interface AnthropicResetOperationIdentity {
  operationId: string;
  accountId: string;
  grantId: string;
  orgDigest: string;
}

export type AnthropicResetBegin =
  | { kind: "execute"; attempt: number }
  | { kind: "replay"; code: string; resetsLeft: number | null; settledAt: number }
  | { kind: "identity-mismatch" }
  | { kind: "in-flight" }
  | { kind: "expired" }
  | { kind: "unresolved-prior"; operationId: string }
  | { kind: "capacity" };

export interface AnthropicResetPendingOperation {
  operationId: string;
  grantId: string;
  createdAt: number;
  retryableUntil: number;
}

/** Digest so the journal never stores the raw organization UUID. */
export function anthropicOrgDigest(organizationUuid: string): string {
  return createHash("sha256").update(`opencodex-anthropic-reset-org\0${organizationUuid.toLowerCase()}`).digest("hex");
}

export function anthropicResetJournalPath(customDir?: string): string {
  return join(customDir ?? getConfigDir(), "anthropic-reset-grant-ledger.json");
}

function isRecordShape(value: unknown): value is OperationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.accountId === "string" && typeof record.grantId === "string"
    && typeof record.orgDigest === "string" && (record.status === "open" || record.status === "settled")
    && typeof record.attempts === "number" && typeof record.leaseUntil === "number"
    && typeof record.createdAt === "number" && typeof record.updatedAt === "number";
}

/** Missing file → empty journal. Present but unreadable → throws; never an empty fallback. */
function readJournal(filePath: string): Journal {
  if (!existsSync(filePath)) return { version: 1, operations: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    throw new AnthropicResetLedgerError("unavailable");
  }
  const journal = parsed as Partial<Journal> | null;
  if (!journal || journal.version !== 1 || !journal.operations || typeof journal.operations !== "object"
    || !Object.values(journal.operations).every(isRecordShape)) {
    throw new AnthropicResetLedgerError("unavailable");
  }
  return journal as Journal;
}

function writeJournal(filePath: string, journal: Journal, now: number): void {
  const cutoff = now - RETENTION_MS;
  journal.operations = Object.fromEntries(
    Object.entries(journal.operations).filter(([, record]) => record.updatedAt > cutoff),
  );
  const bytes = Buffer.from(JSON.stringify(journal, null, 2));
  try {
    // The streamed form fsyncs the temp file and the parent directory, so an
    // open record is on disk before the claim that depends on it is sent.
    atomicWriteFileStreamed(filePath, descriptor => {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    });
  } catch {
    throw new AnthropicResetLedgerError("write_failed");
  }
}

/**
 * Runs `fn` inside an OS-backed cross-process lock. `busy_timeout = 0` so a
 * contended request fails immediately instead of blocking the event loop, the
 * same trade-off src/config/mutation-lock.ts makes. `fn` must be synchronous.
 */
function withJournalLock<T>(filePath: string, fn: () => T): T {
  let database: Database | undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    database = new Database(`${filePath}.lock.sqlite`, { create: true });
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  } catch {
    try { database?.close(); } catch { /* acquisition already failed */ }
    throw new AnthropicResetLedgerError("busy");
  }
  try {
    const value = fn();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* closing releases the lock */ }
    throw error;
  } finally {
    database.close();
  }
}

export interface AnthropicResetLedgerOptions {
  now?: number;
  journalPath?: string;
}

/** True when the operation already has a record. Lock-free read for routing only. */
export function anthropicResetOperationExists(operationId: string, options: AnthropicResetLedgerOptions = {}): boolean {
  return readJournal(options.journalPath ?? anthropicResetJournalPath()).operations[operationId] !== undefined;
}

/**
 * Opens (or re-opens for a same-id retry) one claim attempt. On `execute` the
 * record is durably open and leased before this returns; the caller may then
 * send the claim with `operationId` as its request id.
 */
export function beginAnthropicResetOperation(
  identity: AnthropicResetOperationIdentity,
  options: AnthropicResetLedgerOptions = {},
): AnthropicResetBegin {
  const now = options.now ?? Date.now();
  const filePath = options.journalPath ?? anthropicResetJournalPath();
  return withJournalLock(filePath, () => {
    const journal = readJournal(filePath);
    const existing = journal.operations[identity.operationId];
    if (existing) {
      if (existing.accountId !== identity.accountId || existing.grantId !== identity.grantId
        || existing.orgDigest !== identity.orgDigest) {
        return { kind: "identity-mismatch" };
      }
      if (existing.status === "settled") {
        return { kind: "replay", code: existing.code ?? "unavailable", resetsLeft: existing.resetsLeft ?? null, settledAt: existing.updatedAt };
      }
      if (existing.leaseUntil > now) return { kind: "in-flight" };
      if (now - existing.createdAt >= ANTHROPIC_RESET_RETRY_WINDOW_MS) return { kind: "expired" };
      existing.attempts += 1;
      existing.leaseUntil = now + ANTHROPIC_RESET_LEASE_MS;
      existing.updatedAt = now;
      writeJournal(filePath, journal, now);
      return { kind: "execute", attempt: existing.attempts };
    }
    for (const [operationId, record] of Object.entries(journal.operations)) {
      if (record.status === "open" && record.accountId === identity.accountId && record.grantId === identity.grantId
        && record.orgDigest === identity.orgDigest && now - record.createdAt < ANTHROPIC_RESET_RETRY_WINDOW_MS) {
        return { kind: "unresolved-prior", operationId };
      }
    }
    if (Object.keys(journal.operations).length >= MAX_OPERATIONS) return { kind: "capacity" };
    journal.operations[identity.operationId] = {
      accountId: identity.accountId,
      grantId: identity.grantId,
      orgDigest: identity.orgDigest,
      status: "open",
      attempts: 1,
      leaseUntil: now + ANTHROPIC_RESET_LEASE_MS,
      createdAt: now,
      updatedAt: now,
    };
    writeJournal(filePath, journal, now);
    return { kind: "execute", attempt: 1 };
  });
}

export interface AnthropicResetSettlement {
  code: string;
  resetsLeft: number | null;
}

/**
 * Records a terminal answer and returns the settlement the journal now holds.
 * First settlement wins: a later answer for an already-settled operation gets the
 * stored one back, so the caller reports what the journal says. A missing record
 * throws, because an answer with no journal entry cannot be reported as durable.
 */
export function settleAnthropicResetOperation(
  settlement: { operationId: string; code: string; resetsLeft: number | null },
  options: AnthropicResetLedgerOptions = {},
): AnthropicResetSettlement {
  const now = options.now ?? Date.now();
  const filePath = options.journalPath ?? anthropicResetJournalPath();
  return withJournalLock(filePath, () => {
    const journal = readJournal(filePath);
    const existing = journal.operations[settlement.operationId];
    if (!existing) throw new AnthropicResetLedgerError("unavailable");
    if (existing.status === "settled") return { code: existing.code ?? "unavailable", resetsLeft: existing.resetsLeft ?? null };
    existing.status = "settled";
    existing.code = settlement.code;
    existing.resetsLeft = settlement.resetsLeft;
    existing.leaseUntil = 0;
    existing.updatedAt = now;
    writeJournal(filePath, journal, now);
    return { code: settlement.code, resetsLeft: settlement.resetsLeft };
  });
}

/**
 * Ends this process's attempt on an unknown outcome so an explicit same-id retry
 * does not wait out the whole lease. The record stays open.
 */
export function releaseAnthropicResetLease(operationId: string, options: AnthropicResetLedgerOptions = {}): void {
  const now = options.now ?? Date.now();
  const filePath = options.journalPath ?? anthropicResetJournalPath();
  withJournalLock(filePath, () => {
    const journal = readJournal(filePath);
    const existing = journal.operations[operationId];
    if (!existing || existing.status !== "open") return;
    existing.leaseUntil = now;
    existing.updatedAt = now;
    writeJournal(filePath, journal, now);
  });
}

/** Open operation for this account still inside its retry window, if any. */
export function pendingAnthropicResetOperation(
  accountId: string,
  options: AnthropicResetLedgerOptions = {},
): AnthropicResetPendingOperation | null {
  const now = options.now ?? Date.now();
  const journal = readJournal(options.journalPath ?? anthropicResetJournalPath());
  let pending: AnthropicResetPendingOperation | null = null;
  for (const [operationId, record] of Object.entries(journal.operations)) {
    if (record.status !== "open" || record.accountId !== accountId) continue;
    const retryableUntil = record.createdAt + ANTHROPIC_RESET_RETRY_WINDOW_MS;
    if (retryableUntil <= now) continue;
    if (!pending || record.createdAt > pending.createdAt) {
      pending = { operationId, grantId: record.grantId, createdAt: record.createdAt, retryableUntil };
    }
  }
  return pending;
}
