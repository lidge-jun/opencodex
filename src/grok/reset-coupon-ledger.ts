import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
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
  /** Token expiry (ms) captured when the attempt was marked, if known — used
   * at reconcile time to tell a consumed coupon from one that merely lapsed. */
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
  version: 1;
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, operations: {} };
    throw new Error("Grok coupon ledger is unavailable; existing records were preserved.");
  }
  try {
    const parsed = JSON.parse(raw) as GrokResetCouponLedger;
    if (!parsed || parsed.version !== 1 || !parsed.operations
      || typeof parsed.operations !== "object" || Array.isArray(parsed.operations)) throw new Error();
    for (const op of Object.values(parsed.operations)) {
      if (!op || typeof op.accountId !== "string" || !op.accountId
        || !["open", "attempted", "settled", "failed"].includes(op.status)
        || !Number.isFinite(op.createdAt) || !Number.isFinite(op.updatedAt)
        || (op.tokenId !== undefined && typeof op.tokenId !== "string")
        || (op.code !== undefined && typeof op.code !== "string")
        || (op.tokenValidityEnd !== undefined && !Number.isFinite(op.tokenValidityEnd))) throw new Error();
    }
    return parsed;
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
  atomicWriteFile(filePath, JSON.stringify(ledger, null, 2));
}

const MAX_GROK_RESET_COUPON_OPERATION_IDS = 256;

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

export function recordGrokResetCouponSettlement(
  settlement: { operationId: string; tokenId?: string; code: string; status: "success" | "failed" },
  now = Date.now(),
  journalPath?: string,
): void {
  withConfigMutationLockSync(() => {
  const filePath = journalPath ?? grokCouponJournalPath();
  const ledger = readGrokCouponLedger(filePath);
  const existing = ledger.operations[settlement.operationId];
  if (!existing) return;

  existing.status = settlement.status === "success" ? "settled" : "failed";
  existing.code = settlement.code;
  if (settlement.tokenId !== undefined) existing.tokenId = settlement.tokenId;
  existing.updatedAt = now;

  writeGrokCouponLedger(filePath, ledger, now);
  });
}
