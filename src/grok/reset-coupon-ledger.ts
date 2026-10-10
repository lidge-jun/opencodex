import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileStreamed } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { getConfigDir } from "../config/paths";

export type GrokResetCouponOperationKind = "execute" | "replay" | "identity-mismatch" | "token-mismatch" | "capacity";

export interface GrokResetCouponOperationIdentity {
  accountId: string;
  tokenId?: string;
  operationId: string;
}

export interface GrokResetCouponOperationRecord {
  kind: GrokResetCouponOperationKind;
  operationId: string;
  accountId?: string;
  tokenId?: string;
  /** Token expiry (ms) captured at claim time as journal metadata. Remaining
   * availability or expiry cannot establish this operation's outcome. */
  tokenValidityEnd?: number;
  /** When the attempt was marked (ms) — set only on an "attempted" replay so
   * the route can defer inspection while the attempt may still be in flight. */
  attemptedAt?: number;
  code?: string;
  settledAt?: number;
}

interface GrokResetCouponOperationState {
  accountId: string;
  tokenId?: string;
  // "attempted" sits between open and settled: the spend call may have fired,
  // so the operation must never execute again. Its replay carries no code —
  // the route reconciles it against upstream instead of trusting a status.
  status: "open" | "attempted" | "settled" | "failed";
  code?: string;
  tokenValidityEnd?: number;
  createdAt: number;
  updatedAt: number;
}

interface GrokResetCouponLedger {
  version: 2;
  operations: Record<string, GrokResetCouponOperationState>;
}

export function grokCouponJournalPath(customDir?: string): string {
  const dir = customDir ?? getConfigDir();
  return join(dir, "grok-reset-coupon-ledger.json");
}

function readGrokCouponLedger(filePath: string): GrokResetCouponLedger {
  let raw: string;
  try { raw = readFileSync(filePath, "utf-8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, operations: {} };
    throw new Error("Grok coupon ledger is unavailable; existing records were preserved.");
  }
  try {
    const parsed = JSON.parse(raw) as Omit<GrokResetCouponLedger, "version"> & { version: unknown };
    if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !parsed.operations
      || typeof parsed.operations !== "object" || Array.isArray(parsed.operations)) throw new Error();
    for (const op of Object.values(parsed.operations)) {
      if (!op || typeof op.accountId !== "string" || !op.accountId
        || !["open", "attempted", "settled", "failed"].includes(op.status)
        || !Number.isFinite(op.createdAt) || !Number.isFinite(op.updatedAt)
        || (op.tokenId !== undefined && typeof op.tokenId !== "string")
        || (op.code !== undefined && typeof op.code !== "string")
        || (op.tokenValidityEnd !== undefined && !Number.isFinite(op.tokenValidityEnd))) throw new Error();
    }
    if (parsed.version === 1) {
      for (const op of Object.values(parsed.operations)) {
        // Old opens (and transport failures recorded as failed) may already
        // have dispatched. Only version-two opens prove pre-dispatch state.
        if (op.status === "open" || (op.status === "failed" && op.code === "redeem_failed")) {
          op.status = "attempted";
          delete op.code;
        }
      }
    }
    return { version: 2, operations: parsed.operations };
  } catch {
    throw new Error("Grok coupon ledger is unreadable; existing records were preserved.");
  }
}

function writeGrokCouponLedger(filePath: string, ledger: GrokResetCouponLedger, now = Date.now()): void {
  // Prune every record past the 30-day window — including "open" and
  // "attempted". Idempotency retention is explicitly bounded to 30 days;
  // operations are not retry authorities after that window.
  const retentionCutoff = now - 30 * 24 * 60 * 60_000;
  ledger.operations = Object.fromEntries(
    Object.entries(ledger.operations).filter(([, op]) => op.updatedAt > retentionCutoff),
  );
  atomicWriteFileStreamed(filePath, descriptor => writeFileSync(descriptor, JSON.stringify(ledger, null, 2)), {
    afterRename: target => {
      // The shared streamed writer flushes the temp. A spend claim must also
      // refuse on a POSIX directory-sync failure before dispatch, rather than
      // relying on that writer's best-effort parent sync. Windows has no
      // portable directory descriptor and retains the writer's platform contract.
      if (process.platform === "win32") return;
      const descriptor = openSync(dirname(target), "r");
      try { fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
    },
  });
}

const MAX_GROK_RESET_COUPON_OPERATION_IDS = 256;

/** Resolve an omitted-account retry from its durable identity, within retention. */
export function getGrokResetCouponOperationAccountId(
  operationId: string,
  now = Date.now(),
  journalPath?: string,
): string | undefined {
  return withConfigMutationLockSync(() => {
    const record = readGrokCouponLedger(journalPath ?? grokCouponJournalPath()).operations[operationId];
    if (!record || record.updatedAt <= now - 30 * 24 * 60 * 60_000) return undefined;
    return record.accountId;
  });
}

export function openGrokResetCouponOperation(
  identity: GrokResetCouponOperationIdentity,
  now = Date.now(),
  journalPath?: string,
): GrokResetCouponOperationRecord {
  // Read→decide→write under the shared config mutation lock: two concurrent
  // coupon requests on the same home must not lose an operation record — the
  // ledger exists precisely to make an irreversible spend replay-safe.
  return withConfigMutationLockSync(() => {
    const filePath = journalPath ?? grokCouponJournalPath();
    const ledger = readGrokCouponLedger(filePath);

    // Prune BEFORE the capacity check: expiry is enforced on write, so a ledger
    // full of stale records would otherwise reject every new operation forever
    // (the prune path inside writeGrokCouponLedger is never reached when all
    // openings are rejected).
    const retentionCutoff = now - 30 * 24 * 60 * 60_000;
    ledger.operations = Object.fromEntries(
      Object.entries(ledger.operations).filter(([, op]) => op.updatedAt > retentionCutoff),
    );

    const existing = ledger.operations[identity.operationId];
    if (existing) {
      if (existing.accountId !== identity.accountId) {
        return { kind: "identity-mismatch", operationId: identity.operationId };
      }
      if (identity.tokenId !== undefined && existing.tokenId !== undefined && existing.tokenId !== identity.tokenId) {
        return { kind: "token-mismatch", operationId: identity.operationId };
      }
      if (existing.status !== "open") {
        // Non-open: replay the recorded outcome. "attempted" records carry no
        // code — the caller must reconcile them against upstream, never re-run.
        return {
          kind: "replay",
          operationId: identity.operationId,
          accountId: existing.accountId,
          tokenId: existing.tokenId,
          tokenValidityEnd: existing.tokenValidityEnd,
          attemptedAt: existing.status === "attempted" ? existing.updatedAt : undefined,
          code: existing.code,
          settledAt: existing.updatedAt,
        };
      }
      return {
        kind: "execute",
        operationId: identity.operationId,
        accountId: existing.accountId,
        tokenId: existing.tokenId,
      };
    }

    if (Object.keys(ledger.operations).length >= MAX_GROK_RESET_COUPON_OPERATION_IDS) {
      return { kind: "capacity", operationId: identity.operationId };
    }

    ledger.operations[identity.operationId] = {
      accountId: identity.accountId,
      ...(identity.tokenId === undefined ? {} : { tokenId: identity.tokenId }),
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    writeGrokCouponLedger(filePath, ledger, now);
    return {
      kind: "execute",
      operationId: identity.operationId,
      accountId: identity.accountId,
      tokenId: identity.tokenId,
    };
  });
}

/**
 * Flip an open operation to `attempted` BEFORE the upstream spend call. The
 * write happens while nothing is irreversible yet: if it throws, the caller
 * aborts without spending; if a later settle write dies instead, the
 * operation still refuses blind re-execution — the next open returns a
 * code-less replay the route resolves via the upstream remaining-resets list.
 */
export function markGrokResetCouponAttempt(
  operationId: string,
  tokenId: string,
  now = Date.now(),
  journalPath?: string,
  tokenValidityEnd?: number,
): boolean {
  return withConfigMutationLockSync(() => {
    const filePath = journalPath ?? grokCouponJournalPath();
    const ledger = readGrokCouponLedger(filePath);
    const existing = ledger.operations[operationId];
    if (!existing || existing.status !== "open"
      || (existing.tokenId !== undefined && existing.tokenId !== tokenId)) return false;
    existing.status = "attempted";
    existing.tokenId = tokenId;
    if (tokenValidityEnd !== undefined) existing.tokenValidityEnd = tokenValidityEnd;
    existing.updatedAt = now;
    writeGrokCouponLedger(filePath, ledger, now);
    return true;
  });
}

type GrokResetCouponSettlement = { operationId: string; accountId: string; code: string } & (
  | { tokenId?: string; status: "failed"; expectedStatus: "open" }
  | { tokenId: string; status: "success"; expectedStatus: "attempted" }
);

type GrokResetCouponPreflightResult =
  | { kind: "recorded" | "changed" }
  | { kind: "replay"; code: string; tokenId?: string; settledAt: number };

const UNRESOLVED_COUPON_CODES = new Set(["redeem_failed", "attempt_unresolved", "attempt_in_progress", "attempt_reconcile_failed", "operation_state_changed"]);

/** The durable definitive outcome for this account and token, if the operation has one. */
function terminalReplay(
  ledger: GrokResetCouponLedger, operationId: string, accountId: string, tokenId: string | undefined,
): Extract<GrokResetCouponPreflightResult, { kind: "replay" }> | null {
  const existing = ledger.operations[operationId];
  if (!existing || existing.accountId !== accountId) return null;
  if (tokenId !== undefined && existing.tokenId !== undefined && existing.tokenId !== tokenId) return null;
  if ((existing.status !== "settled" && existing.status !== "failed") || !existing.code || UNRESOLVED_COUPON_CODES.has(existing.code)) return null;
  return { kind: "replay", code: existing.code, tokenId: existing.tokenId, settledAt: existing.updatedAt };
}

/** Settle a refusal or inspect its winner without releasing the mutation transaction. */
export function settleGrokResetCouponPreflightRefusal(
  settlement: Extract<GrokResetCouponSettlement, { status: "failed" }>,
  now = Date.now(),
  journalPath?: string,
): GrokResetCouponPreflightResult {
  return withConfigMutationLockSync(() => {
    const filePath = journalPath ?? grokCouponJournalPath();
    const ledger = readGrokCouponLedger(filePath);
    if (recordSettlement(ledger, filePath, settlement, now)) return { kind: "recorded" };
    return terminalReplay(ledger, settlement.operationId, settlement.accountId, settlement.tokenId) ?? { kind: "changed" };
  });
}

/**
 * After a lost claim: the definitive winner to replay, or null while the
 * operation is still unresolved. Terminal states never revert, so reading after
 * the failed claim cannot replay an outcome that is later replaced.
 */
export function readGrokResetCouponTerminalReplay(
  operationId: string, accountId: string, tokenId?: string, journalPath?: string,
): Extract<GrokResetCouponPreflightResult, { kind: "replay" }> | null {
  return withConfigMutationLockSync(() => {
    const filePath = journalPath ?? grokCouponJournalPath();
    return terminalReplay(readGrokCouponLedger(filePath), operationId, accountId, tokenId);
  });
}

/** A preflight refusal cannot replace a claim or a terminal result. */
export function recordGrokResetCouponSettlement(
  settlement: GrokResetCouponSettlement,
  now = Date.now(),
  journalPath?: string,
): boolean {
  return withConfigMutationLockSync(() => {
    const filePath = journalPath ?? grokCouponJournalPath();
    const ledger = readGrokCouponLedger(filePath);
    return recordSettlement(ledger, filePath, settlement, now);
  });
}

function recordSettlement(
  ledger: GrokResetCouponLedger, filePath: string, settlement: GrokResetCouponSettlement, now: number,
): boolean {
  const existing = ledger.operations[settlement.operationId];
  if (!existing || existing.status !== settlement.expectedStatus
    || existing.accountId !== settlement.accountId
    || (settlement.tokenId !== undefined && existing.tokenId !== undefined && existing.tokenId !== settlement.tokenId)
    || (settlement.status === "success" && existing.tokenId !== settlement.tokenId)) return false;

  existing.status = settlement.status === "success" ? "settled" : "failed";
  existing.code = settlement.code;
  if (settlement.tokenId !== undefined) existing.tokenId = settlement.tokenId;
  existing.updatedAt = now;

  writeGrokCouponLedger(filePath, ledger, now);
  return true;
}
