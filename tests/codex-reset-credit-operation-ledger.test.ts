import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { withConfigMutationLockSync } from "../src/config";
import {
  MAX_MANUAL_RESET_CREDIT_OPERATION_IDS,
  MAX_RESET_CREDIT_OPERATION_ACCOUNTS,
  RESET_CREDIT_MANUAL_OPERATION_ID_SCHEMA_SQL_FOR_TESTS,
  RESET_CREDIT_OPERATION_LEGACY_SCHEMA_SQL_FOR_TESTS,
  RESET_CREDIT_OPERATION_PRIOR_SCHEMA_SQL_FOR_TESTS,
  RESET_CREDIT_OPERATION_SCHEMA_SQL_FOR_TESTS,
  markManualResetCreditOperationAmbiguous,
  markResetCreditOperationAmbiguous,
  openManualResetCreditOperation,
  openResetCreditOperation,
  settleManualResetCreditOperation,
  settleResetCreditOperation,
} from "../src/codex/reset-credit-operation-ledger";
import {
  CodexResetCreditRecoveryCoordinator,
  resetCodexResetCreditRecoveryProcessStateForTests,
  type CodexReservedOperationId,
  type CodexResetCreditRecoveryGeneration,
} from "../src/codex/reset-credit-recovery";

const GENERATION: CodexResetCreditRecoveryGeneration = {
  accountId: "pool-a",
  credentialGeneration: 4,
  exhaustionGeneration: 9,
};

function databasePath(): string {
  return join(process.env.OPENCODEX_HOME!, "config-mutation.sqlite");
}

function corruptFirstRecord(): void {
  const database = new Database(databasePath());
  try {
    database.run("UPDATE reset_credit_operations SET operation_id = 'not-a-uuid'");
  } finally {
    database.close();
  }
}

function fixtureOperationId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function createLaxDuplicateLedger(): void {
  const database = new Database(databasePath(), { create: true });
  try {
    database.exec(`
      CREATE TABLE reset_credit_operations (
        account_key TEXT,
        credential_generation INTEGER,
        exhaustion_generation INTEGER,
        operation_id TEXT,
        state TEXT,
        code TEXT,
        created_at INTEGER,
        updated_at INTEGER
      )`);
    const key = createHash("sha256")
      .update(`codex-reset-credit-operation\0${GENERATION.accountId}`)
      .digest("hex");
    const insert = database.prepare(`
      INSERT INTO reset_credit_operations VALUES (?, ?, ?, ?, 'pending', NULL, 1, 1)`);
    insert.run(key, GENERATION.credentialGeneration, GENERATION.exhaustionGeneration,
      "00000000-0000-4000-8000-000000000001");
    insert.run(key, GENERATION.credentialGeneration, GENERATION.exhaustionGeneration,
      "00000000-0000-4000-8000-000000000002");
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  await resetCodexResetCreditRecoveryProcessStateForTests();
  const database = new Database(databasePath(), { create: true });
  try {
    database.exec(`
      DROP TABLE IF EXISTS reset_credit_manual_operation_ids;
      DROP TABLE IF EXISTS reset_credit_operations;
    `);
  }
  finally { database.close(); }
});

afterEach(async () => {
  await resetCodexResetCreditRecoveryProcessStateForTests();
});

describe("Codex reset-credit operation ledger", () => {
  test("migrates the exact prior recovery schema without changing durable state", () => {
    const database = new Database(databasePath(), { create: true });
    const key = createHash("sha256")
      .update(`codex-reset-credit-operation\0${GENERATION.accountId}`)
      .digest("hex");
    const operationId = fixtureOperationId(699);
    try {
      database.exec(RESET_CREDIT_OPERATION_LEGACY_SCHEMA_SQL_FOR_TESTS);
      database.prepare(`
        INSERT INTO reset_credit_operations VALUES (?, ?, ?, ?, 'ambiguous', NULL, 100, 200)
      `).run(key, GENERATION.credentialGeneration, GENERATION.exhaustionGeneration, operationId);
    } finally {
      database.close();
    }

    expect(openResetCreditOperation(GENERATION, 300)).toEqual({
      kind: "execute",
      operationId,
      resumed: true,
    });
    const migrated = new Database(databasePath(), { readonly: true });
    try {
      expect(migrated.query<{ sql: string }, []>(`
        SELECT sql FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_operations'
      `).get()?.sql).toBe(RESET_CREDIT_OPERATION_SCHEMA_SQL_FOR_TESTS);
      expect(migrated.query<{ name: string }, []>(`
        SELECT name FROM main.sqlite_schema
         WHERE name = 'reset_credit_operations_legacy_v1'
      `).get()).toBeNull();
      expect(migrated.query<Record<string, unknown>, []>(
        "SELECT * FROM reset_credit_operations",
      ).get()).toMatchObject({
        account_key: key,
        operation_kind: "recovery",
        credential_generation: GENERATION.credentialGeneration,
        exhaustion_generation: GENERATION.exhaustionGeneration,
        operation_id: operationId,
        state: "ambiguous",
        created_at: 100,
        updated_at: 200,
      });
    } finally {
      migrated.close();
    }
  });

  test("migrates the prior manual schema before persisting a joined retry id", () => {
    const original = fixtureOperationId(690);
    const joined = fixtureOperationId(691);
    const physicalAccount = "chatgpt-prior-manual";
    const key = createHash("sha256")
      .update(`codex-reset-credit-manual-physical\0${physicalAccount}`)
      .digest("hex");
    const database = new Database(databasePath(), { create: true });
    try {
      database.exec(RESET_CREDIT_OPERATION_PRIOR_SCHEMA_SQL_FOR_TESTS);
      database.prepare(`
        INSERT INTO reset_credit_operations VALUES (
          ?, 'manual', NULL, NULL, ?, 'ambiguous', NULL, 100, 200
        )
      `).run(key, original);
    } finally {
      database.close();
    }

    expect(openManualResetCreditOperation({
      accountId: "pool-prior-manual",
      chatgptAccountId: physicalAccount,
      operationId: joined,
    }, 300)).toEqual({ kind: "execute", operationId: original, resumed: true });

    const migrated = new Database(databasePath(), { readonly: true });
    try {
      expect(migrated.query<{ sql: string }, []>(`
        SELECT sql FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_operations'
      `).get()?.sql).toBe(RESET_CREDIT_OPERATION_SCHEMA_SQL_FOR_TESTS);
      expect(migrated.query<{ name: string }, []>(`
        SELECT name FROM main.sqlite_schema
         WHERE name = 'reset_credit_operations_legacy_v2'
      `).get()).toBeNull();
      expect(migrated.query<{ operation_id: string; joined_operation_id: string }, []>(`
        SELECT operation_id, joined_operation_id FROM reset_credit_operations
      `).get()).toEqual({ operation_id: original, joined_operation_id: joined });
      expect(migrated.query<{
        operation_id: string;
        canonical_operation_id: string;
        terminal_code: string | null;
      }, []>(`
        SELECT operation_id, canonical_operation_id, terminal_code
          FROM reset_credit_manual_operation_ids
         ORDER BY operation_id
      `).all()).toEqual([
        { operation_id: original, canonical_operation_id: original, terminal_code: null },
        { operation_id: joined, canonical_operation_id: original, terminal_code: null },
      ]);
    } finally {
      migrated.close();
    }
  });

  test("manual operations resume one intent and short-circuit its terminal result", () => {
    const identity = {
      accountId: "pool-manual",
      chatgptAccountId: "chatgpt-manual",
      operationId: fixtureOperationId(700),
    };
    expect(openManualResetCreditOperation(identity, 100)).toEqual({
      kind: "execute",
      operationId: identity.operationId,
      resumed: false,
    });
    expect(markManualResetCreditOperationAmbiguous(identity, 200)).toEqual({ kind: "updated" });
    expect(openManualResetCreditOperation(identity, 300)).toEqual({
      kind: "execute",
      operationId: identity.operationId,
      resumed: true,
    });
    expect(settleManualResetCreditOperation(
      identity,
      "not-a-reset-code" as never,
      350,
    )).toEqual({ kind: "mismatch" });
    expect(settleManualResetCreditOperation(identity, "already_redeemed", 400))
      .toEqual({ kind: "updated" });
    expect(openManualResetCreditOperation(identity, 500)).toEqual({
      kind: "terminal",
      operationId: identity.operationId,
      code: "already_redeemed",
    });
  });

  test("a distinct manual id after settlement opens one explicit new intent", () => {
    const first = {
      accountId: "pool-manual-new-intent",
      chatgptAccountId: "chatgpt-new-intent",
      operationId: fixtureOperationId(706),
    };
    expect(openManualResetCreditOperation(first, 100)).toMatchObject({ kind: "execute" });
    expect(settleManualResetCreditOperation(first, "reset", 200)).toEqual({ kind: "updated" });
    const second = { ...first, operationId: fixtureOperationId(707) };
    expect(openManualResetCreditOperation(second, 300)).toEqual({
      kind: "execute",
      operationId: second.operationId,
      resumed: false,
    });
    expect(openManualResetCreditOperation(second, 400)).toEqual({
      kind: "execute",
      operationId: second.operationId,
      resumed: true,
    });
  });

  test("an uppercase terminal id cannot reopen as a lowercase retry", () => {
    const identity = {
      accountId: "pool-manual-uppercase-terminal",
      chatgptAccountId: "chatgpt-uppercase-terminal",
      operationId: fixtureOperationId(708),
    };
    expect(openManualResetCreditOperation(identity, 100)).toMatchObject({ kind: "execute" });
    expect(settleManualResetCreditOperation(identity, "reset", 200)).toEqual({ kind: "updated" });
    const uppercase = identity.operationId.toUpperCase();
    const database = new Database(databasePath());
    try {
      database.prepare("UPDATE reset_credit_operations SET operation_id = ?").run(uppercase);
    } finally {
      database.close();
    }

    expect(openManualResetCreditOperation(identity, 300)).toEqual({ kind: "unavailable" });
    const stored = new Database(databasePath(), { readonly: true });
    try {
      expect(stored.query<{ operation_id: string; state: string; code: string }, []>(`
        SELECT operation_id, state, code FROM reset_credit_operations
      `).get()).toEqual({ operation_id: uppercase, state: "confirmed", code: "reset" });
    } finally {
      stored.close();
    }
  });

  test("fails closed when a manual id loses its canonical history mapping", () => {
    const identity = {
      accountId: "pool-manual-history-corrupt",
      chatgptAccountId: "chatgpt-manual-history-corrupt",
      operationId: fixtureOperationId(710),
    };
    expect(openManualResetCreditOperation(identity, 100)).toMatchObject({ kind: "execute" });
    const missingCanonical = fixtureOperationId(711);
    const database = new Database(databasePath());
    try {
      database.prepare(`
        UPDATE reset_credit_manual_operation_ids
           SET canonical_operation_id = ?
         WHERE operation_id = ?
      `).run(missingCanonical, identity.operationId);
    } finally {
      database.close();
    }

    expect(openManualResetCreditOperation(identity, 200)).toEqual({ kind: "unavailable" });
    const verifier = new Database(databasePath(), { readonly: true });
    try {
      expect(verifier.query<{ canonical_operation_id: string }, [string]>(`
        SELECT canonical_operation_id
          FROM reset_credit_manual_operation_ids
         WHERE operation_id = ?
      `).get(identity.operationId)?.canonical_operation_id).toBe(missingCanonical);
    } finally {
      verifier.close();
    }
  });

  test("manual operations preserve every joined caller id across later terminal intents", () => {
    const first = {
      accountId: "pool-manual-fence",
      chatgptAccountId: "chatgpt-a",
      operationId: fixtureOperationId(701),
    };
    const joined = { ...first, operationId: fixtureOperationId(702) };
    expect(openManualResetCreditOperation(first, 100)).toMatchObject({ kind: "execute" });
    expect(openManualResetCreditOperation(joined, 200))
      .toEqual({ kind: "execute", operationId: first.operationId, resumed: true });
    const secondJoined = {
      ...first,
      accountId: "pool-manual-alias",
      operationId: fixtureOperationId(703),
    };
    expect(openManualResetCreditOperation(secondJoined, 300))
      .toEqual({ kind: "execute", operationId: first.operationId, resumed: true });
    // A third alias advanced durable time to 300. Settlement remains valid if
    // the wall clock then moves backwards.
    expect(settleManualResetCreditOperation(first, "reset", 250)).toEqual({ kind: "updated" });
    expect(openManualResetCreditOperation(first, 360)).toEqual({
      kind: "terminal",
      operationId: first.operationId,
      code: "reset",
    });
    expect(openManualResetCreditOperation(joined, 370)).toEqual({
      kind: "terminal",
      operationId: first.operationId,
      code: "reset",
    });
    expect(openManualResetCreditOperation(secondJoined, 375)).toEqual({
      kind: "terminal",
      operationId: first.operationId,
      code: "reset",
    });
    const next = { ...first, operationId: fixtureOperationId(709) };
    expect(openManualResetCreditOperation(next, 380)).toEqual({
      kind: "execute",
      operationId: next.operationId,
      resumed: false,
    });
    expect(settleManualResetCreditOperation(next, "no_credit", 390)).toEqual({ kind: "updated" });
    expect(openManualResetCreditOperation(joined, 395)).toEqual({
      kind: "terminal",
      operationId: first.operationId,
      code: "reset",
    });
    expect(openManualResetCreditOperation(secondJoined, 396)).toEqual({
      kind: "terminal",
      operationId: first.operationId,
      code: "reset",
    });
    const otherPhysical = {
      ...first,
      chatgptAccountId: "chatgpt-b",
      operationId: fixtureOperationId(704),
    };
    expect(openManualResetCreditOperation(otherPhysical, 400))
      .toEqual({ kind: "execute", operationId: otherPhysical.operationId, resumed: false });
  });

  test("manual operations reject a caller UUID already owned by another physical account", () => {
    const operationId = fixtureOperationId(705);
    const first = {
      accountId: "pool-manual-first",
      chatgptAccountId: "chatgpt-first",
      operationId,
    };
    const second = {
      accountId: "pool-manual-second",
      chatgptAccountId: "chatgpt-second",
      operationId,
    };
    expect(openManualResetCreditOperation(first, 100)).toMatchObject({ kind: "execute" });
    expect(openManualResetCreditOperation(second, 200)).toEqual({ kind: "identity-mismatch" });
    expect(openManualResetCreditOperation(first, 300)).toEqual({
      kind: "execute",
      operationId,
      resumed: true,
    });
  });

  test("creates the exact canonical SQLite schema", () => {
    expect(openResetCreditOperation(GENERATION, 100))
      .toMatchObject({ kind: "execute", resumed: false });
    const database = new Database(databasePath(), { readonly: true });
    try {
      expect(database.query<{ sql: string }, []>(`
        SELECT sql FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_operations'
      `).get()?.sql).toBe(RESET_CREDIT_OPERATION_SCHEMA_SQL_FOR_TESTS);
      expect(database.query<{ sql: string }, []>(`
        SELECT sql FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_manual_operation_ids'
      `).get()?.sql).toBe(RESET_CREDIT_MANUAL_OPERATION_ID_SCHEMA_SQL_FOR_TESTS);
    } finally {
      database.close();
    }
  });

  test("durably reserves before dispatch and restores the same logical turn identity", async () => {
    const first = openResetCreditOperation(GENERATION, 100);
    expect(first).toMatchObject({ kind: "execute", resumed: false });
    if (first.kind !== "execute") throw new Error("reservation failed");

    const restarted = openResetCreditOperation(GENERATION, 200);
    expect(restarted).toEqual({ kind: "execute", operationId: first.operationId, resumed: true });
    const consumedOperationIds: string[] = [];
    const coordinator = new CodexResetCreditRecoveryCoordinator({
      coordinationScope: {},
      revalidate: async generation => ({ kind: "eligible", ...generation, availableCredits: 1 }),
      consume: async ({ operationId }) => {
        consumedOperationIds.push(operationId);
        return { code: "reset", operationId };
      },
    });
    const turn = coordinator.createLogicalTurnForOperation(first.operationId);
    const authorization = {
      enabled: true,
      isOutputExposed: () => false,
      rejection: {
        kind: "reset-eligible-exhaustion",
        status: 429,
        alternateRetryEligible: true,
        resetCreditEligible: true,
        semanticCode: "usage_limit_exceeded",
      },
    } as const;
    const firstAttempt = coordinator.recover(turn, GENERATION, authorization);
    const secondAttempt = coordinator.recover(turn, GENERATION, authorization);
    expect(secondAttempt).toBe(firstAttempt);
    expect(await firstAttempt).toEqual({ kind: "refresh-required", code: "reset" });
    expect(consumedOperationIds).toEqual([first.operationId]);
    expect(coordinator.terminalGenerationCountForTests()).toBe(1);
    // Automatic runtime wiring is intentionally out of scope: the coordinator
    // has fenced this generation, while the durable reservation remains pending
    // until its future adapter explicitly settles it.
    expect(openResetCreditOperation(GENERATION, 300)).toEqual({
      kind: "execute",
      operationId: first.operationId,
      resumed: true,
    });
    expect(settleResetCreditOperation(GENERATION, first.operationId, "reset", 400))
      .toEqual({ kind: "updated" });
    expect(openResetCreditOperation(GENERATION, 500)).toEqual({
      kind: "terminal",
      operationId: first.operationId,
      code: "reset",
    });
    expect(() => coordinator.createLogicalTurnForOperation("not-a-uuid" as CodexReservedOperationId))
      .toThrow("operationId must be an RFC 4122 version 4 UUID");
  });

  test("retains ambiguous operations and never allocates a replacement id", () => {
    const opened = openResetCreditOperation(GENERATION, 100);
    if (opened.kind !== "execute") throw new Error("reservation failed");
    expect(markResetCreditOperationAmbiguous(GENERATION, opened.operationId, 150)).toEqual({ kind: "updated" });
    expect(openResetCreditOperation(GENERATION, 200)).toEqual({
      kind: "execute",
      operationId: opened.operationId,
      resumed: true,
    });
    expect(openResetCreditOperation({ ...GENERATION, exhaustionGeneration: 10 })).toEqual({
      kind: "unresolved-prior-generation",
    });
  });

  test("keeps timestamps monotonic when the wall clock rolls back", () => {
    const opened = openResetCreditOperation(GENERATION, 200);
    if (opened.kind !== "execute") throw new Error("reservation failed");
    expect(markResetCreditOperationAmbiguous(GENERATION, opened.operationId, 100))
      .toEqual({ kind: "updated" });
    expect(openResetCreditOperation(GENERATION, 50)).toEqual({
      kind: "execute",
      operationId: opened.operationId,
      resumed: true,
    });
    expect(settleResetCreditOperation(GENERATION, opened.operationId, "reset", 50))
      .toEqual({ kind: "updated" });
    expect(openResetCreditOperation(GENERATION, 25)).toEqual({
      kind: "terminal",
      operationId: opened.operationId,
      code: "reset",
    });
  });

  test("returns terminal outcomes without another execution and permits a newer generation", () => {
    const opened = openResetCreditOperation(GENERATION, 100);
    if (opened.kind !== "execute") throw new Error("reservation failed");
    expect(settleResetCreditOperation(GENERATION, opened.operationId, "already_redeemed", 200))
      .toEqual({ kind: "updated" });
    expect(openResetCreditOperation(GENERATION)).toEqual({
      kind: "terminal",
      operationId: opened.operationId,
      code: "already_redeemed",
    });
    expect(openResetCreditOperation({ ...GENERATION, exhaustionGeneration: 10 }))
      .toMatchObject({ kind: "execute", resumed: false });
  });

  test("rejects stale generations and mismatched settlement", () => {
    const current = openResetCreditOperation(GENERATION);
    if (current.kind !== "execute") throw new Error("reservation failed");
    expect(openResetCreditOperation({ ...GENERATION, exhaustionGeneration: 8 }))
      .toEqual({ kind: "stale-generation" });
    expect(settleResetCreditOperation(GENERATION, "00000000-0000-4000-8000-000000000999", "reset"))
      .toEqual({ kind: "mismatch" });
  });

  test("fails closed for malformed durable rows without overwriting them", () => {
    const opened = openResetCreditOperation(GENERATION);
    if (opened.kind !== "execute") throw new Error("reservation failed");
    corruptFirstRecord();
    expect(openResetCreditOperation(GENERATION)).toEqual({ kind: "unavailable" });
    expect(markResetCreditOperationAmbiguous(GENERATION, opened.operationId)).toEqual({ kind: "unavailable" });
    expect(settleResetCreditOperation(GENERATION, opened.operationId, "reset"))
      .toEqual({ kind: "unavailable" });
    const database = new Database(databasePath(), { readonly: true });
    try {
      expect(database.query<{ operation_id: string }, []>(
        "SELECT operation_id FROM reset_credit_operations",
      ).get()?.operation_id).toBe("not-a-uuid");
    } finally {
      database.close();
    }
  });

  test("rejects a nonterminal row carrying any code without overwriting it", () => {
    const opened = openResetCreditOperation(GENERATION, 100);
    if (opened.kind !== "execute") throw new Error("reservation failed");
    const database = new Database(databasePath());
    try {
      database.run("UPDATE reset_credit_operations SET code = 'garbage'");
    } finally {
      database.close();
    }
    expect(openResetCreditOperation(GENERATION, 200)).toEqual({ kind: "unavailable" });
    expect(markResetCreditOperationAmbiguous(GENERATION, opened.operationId, 300))
      .toEqual({ kind: "unavailable" });
    const stored = new Database(databasePath(), { readonly: true });
    try {
      expect(stored.query<{ code: string }, []>(
        "SELECT code FROM reset_credit_operations",
      ).get()?.code).toBe("garbage");
    } finally {
      stored.close();
    }
  });

  test("fails closed for a noncanonical uppercase operation id", () => {
    const opened = openResetCreditOperation(GENERATION, 100);
    if (opened.kind !== "execute") throw new Error("reservation failed");
    const uppercase = opened.operationId.toUpperCase();
    const database = new Database(databasePath());
    try {
      database.prepare("UPDATE reset_credit_operations SET operation_id = ?").run(uppercase);
    } finally {
      database.close();
    }
    expect(openResetCreditOperation(GENERATION, 200)).toEqual({ kind: "unavailable" });
    expect(settleResetCreditOperation(GENERATION, opened.operationId, "reset", 300))
      .toEqual({ kind: "unavailable" });
    const stored = new Database(databasePath(), { readonly: true });
    try {
      expect(stored.query<{ operation_id: string }, []>(
        "SELECT operation_id FROM reset_credit_operations",
      ).get()?.operation_id).toBe(uppercase);
    } finally {
      stored.close();
    }
  });

  test("refuses a lax duplicate schema without choosing or replacing an operation", () => {
    createLaxDuplicateLedger();
    expect(openResetCreditOperation(GENERATION)).toEqual({ kind: "unavailable" });
    expect(markResetCreditOperationAmbiguous(
      GENERATION,
      "00000000-0000-4000-8000-000000000001",
    )).toEqual({ kind: "unavailable" });
    const database = new Database(databasePath(), { readonly: true });
    try {
      expect(database.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM reset_credit_operations",
      ).get()?.count).toBe(2);
    } finally {
      database.close();
    }
  });

  test("refuses a canonical ledger that reuses an operation id across accounts", () => {
    const first = openResetCreditOperation(GENERATION, 100);
    if (first.kind !== "execute") throw new Error("reservation failed");
    const database = new Database(databasePath());
    try {
      const secondKey = createHash("sha256")
        .update("codex-reset-credit-operation\0pool-b")
        .digest("hex");
      database.prepare(`
        INSERT INTO reset_credit_operations (
          account_key, operation_kind, credential_generation, exhaustion_generation, operation_id,
          state, code, created_at, updated_at
        ) VALUES (?, 'recovery', ?, ?, ?, 'pending', NULL, 1, 1)`)
        .run(
          secondKey,
          GENERATION.credentialGeneration,
          GENERATION.exhaustionGeneration,
          first.operationId,
        );
    } finally {
      database.close();
    }
    expect(openResetCreditOperation(GENERATION)).toEqual({ kind: "unavailable" });
    expect(openResetCreditOperation({ ...GENERATION, accountId: "pool-c" }))
      .toEqual({ kind: "unavailable" });
  });

  test("refuses a trigger without replacing the terminal reservation", () => {
    const first = openResetCreditOperation(GENERATION, 100);
    if (first.kind !== "execute") throw new Error("reservation failed");
    expect(settleResetCreditOperation(GENERATION, first.operationId, "reset", 200))
      .toEqual({ kind: "updated" });
    const database = new Database(databasePath());
    try {
      database.exec(`
        CREATE TRIGGER reset_credit_tamper AFTER UPDATE ON reset_credit_operations
        BEGIN
          DELETE FROM reset_credit_operations WHERE account_key = NEW.account_key;
        END`);
    } finally {
      database.close();
    }
    expect(openResetCreditOperation({ ...GENERATION, exhaustionGeneration: 10 }, 300))
      .toEqual({ kind: "unavailable" });
    const verifier = new Database(databasePath(), { readonly: true });
    try {
      expect(verifier.query<{ operation_id: string }, []>(
        "SELECT operation_id FROM reset_credit_operations",
      ).get()?.operation_id).toBe(first.operationId);
    } finally {
      verifier.close();
    }
  });

  test("fails fast under cross-process mutation contention without minting an id", () => {
    expect(openResetCreditOperation(GENERATION)).toMatchObject({ kind: "execute", resumed: false });
    const holder = new Database(databasePath());
    let transactionOpen = false;
    try {
      holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      transactionOpen = true;
      expect(openResetCreditOperation({ ...GENERATION, accountId: "pool-b" }))
        .toEqual({ kind: "unavailable" });
    } finally {
      try {
        if (transactionOpen) holder.exec("ROLLBACK");
      } finally {
        holder.close();
      }
    }
    expect(openResetCreditOperation({ ...GENERATION, accountId: "pool-b" }))
      .toMatchObject({ kind: "execute", resumed: false });
  });

  test("never authorizes execution from inside an uncommitted config transaction", () => {
    let nested: unknown;
    expect(() => withConfigMutationLockSync(() => {
      nested = openResetCreditOperation(GENERATION);
      expect(nested).toEqual({ kind: "unavailable" });
      throw new Error("roll back outer config transaction");
    })).toThrow("roll back outer config transaction");
    expect(openResetCreditOperation(GENERATION))
      .toMatchObject({ kind: "execute", resumed: false });
  });

  test("keeps terminal manual ids immutable and fails closed when identity history is full", () => {
    const first = {
      accountId: "pool-manual-history-cap",
      chatgptAccountId: "chatgpt-manual-history-cap",
      operationId: fixtureOperationId(9000),
    };
    expect(openManualResetCreditOperation(first, 100)).toMatchObject({ kind: "execute" });
    expect(settleManualResetCreditOperation(first, "reset", 200)).toEqual({ kind: "updated" });

    const database = new Database(databasePath());
    try {
      const insert = database.prepare(`
        INSERT INTO reset_credit_manual_operation_ids (
          operation_id, account_key, canonical_operation_id,
          terminal_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'no_credit', 1, 1)
      `);
      database.exec("BEGIN IMMEDIATE");
      for (let index = 1; index < MAX_MANUAL_RESET_CREDIT_OPERATION_IDS; index += 1) {
        const operationId = fixtureOperationId(9000 + index);
        const key = createHash("sha256")
          .update(`manual-history-cap-${index}`)
          .digest("hex");
        insert.run(operationId, key, operationId);
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve fixture error */ }
      throw error;
    } finally {
      database.close();
    }

    expect(openManualResetCreditOperation(first, 300)).toEqual({
      kind: "terminal",
      operationId: first.operationId,
      code: "reset",
    });
    expect(openManualResetCreditOperation({
      ...first,
      operationId: fixtureOperationId(15000),
    }, 400)).toEqual({ kind: "capacity" });
    const verifier = new Database(databasePath(), { readonly: true });
    try {
      expect(verifier.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM reset_credit_manual_operation_ids",
      ).get()?.count).toBe(MAX_MANUAL_RESET_CREDIT_OPERATION_IDS);
    } finally {
      verifier.close();
    }
  });

  test("admits existing accounts but refuses a new account at capacity", () => {
    expect(openResetCreditOperation({ ...GENERATION, accountId: "pool-0" }))
      .toMatchObject({ kind: "execute", resumed: false });
    const database = new Database(databasePath());
    try {
      const insert = database.prepare(`
        INSERT INTO reset_credit_operations (
          account_key, operation_kind, credential_generation, exhaustion_generation, operation_id,
          state, code, created_at, updated_at
        ) VALUES (?, 'recovery', ?, ?, ?, 'pending', NULL, 1, 1)`);
      database.exec("BEGIN IMMEDIATE");
      for (let index = 1; index < MAX_RESET_CREDIT_OPERATION_ACCOUNTS; index += 1) {
        const accountId = `pool-${index}`;
        const key = createHash("sha256")
          .update(`codex-reset-credit-operation\0${accountId}`)
          .digest("hex");
        const operationId = fixtureOperationId(index);
        insert.run(key, GENERATION.credentialGeneration, GENERATION.exhaustionGeneration, operationId);
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* surface the original fixture error */ }
      throw error;
    } finally {
      database.close();
    }
    expect(openResetCreditOperation({ ...GENERATION, accountId: "pool-over-cap" }))
      .toEqual({ kind: "capacity" });
    expect(openResetCreditOperation({ ...GENERATION, accountId: "pool-0" }))
      .toMatchObject({ kind: "execute", resumed: true });

    const overflow = new Database(databasePath());
    try {
      const key = createHash("sha256")
        .update("codex-reset-credit-operation\0pool-corrupt-over-cap")
        .digest("hex");
      overflow.prepare(`
        INSERT INTO reset_credit_operations (
          account_key, operation_kind, credential_generation, exhaustion_generation, operation_id,
          state, code, created_at, updated_at
        ) VALUES (?, 'recovery', ?, ?, ?, 'pending', NULL, 1, 1)`)
        .run(
          key,
          GENERATION.credentialGeneration,
          GENERATION.exhaustionGeneration,
          // SELECT_ALL intentionally reads MAX + 1 rows so the corrupt
          // over-capacity state cannot be mistaken for an ordinary full ledger.
          fixtureOperationId(MAX_RESET_CREDIT_OPERATION_ACCOUNTS + 1),
        );
    } finally {
      overflow.close();
    }
    expect(openResetCreditOperation({ ...GENERATION, accountId: "pool-0" }))
      .toEqual({ kind: "unavailable" });
    expect(openResetCreditOperation({ ...GENERATION, accountId: "pool-new" }))
      .toEqual({ kind: "unavailable" });
  });
});
