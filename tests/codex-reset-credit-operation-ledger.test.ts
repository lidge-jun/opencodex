import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  NestedConfigMutationError,
  prepareConfigMutationDatabasePathForWrite,
  withConfigMutationLockSync,
} from "../src/config";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import {
  MAX_MANUAL_RESET_CREDIT_OPERATION_IDS,
  MAX_RESET_CREDIT_OPERATION_ACCOUNTS,
  markManualResetCreditOperationAmbiguous,
  markResetCreditOperationAmbiguous,
  openManualResetCreditOperation,
  openResetCreditOperation,
  setResetCreditOperationMigrationFaultForTests,
  settleManualResetCreditOperation,
  settleResetCreditOperation,
  type ManualResetCreditOperationIdentity,
} from "../src/codex/reset-credit-operation-ledger";
import {
  compareCodexResetCreditRecoveryGenerationOrder,
  isCodexResetCreditOperationId,
  type CodexResetCreditRecoveryGeneration,
} from "../src/codex/reset-credit-recovery";

const GENERATION: CodexResetCreditRecoveryGeneration = {
  accountId: "pool-a",
  credentialGeneration: 4,
  exhaustionGeneration: 9,
};
const CHILD_READY_TIMEOUT_MS = 10_000;
const CHILD_EXIT_TIMEOUT_MS = 5_000;
const CONTENTION_TEST_TIMEOUT_MS = 25_000;
const CONTENTION_FAIL_FAST_MS = 2_000;

const LEGACY_OPERATION_SCHEMA_SQL = `CREATE TABLE reset_credit_operations (
    account_key TEXT PRIMARY KEY,
    credential_generation INTEGER NOT NULL CHECK (credential_generation >= 0),
    exhaustion_generation INTEGER NOT NULL CHECK (exhaustion_generation >= 0),
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL,
    code TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT, WITHOUT ROWID`;

const PRIOR_OPERATION_SCHEMA_SQL = `CREATE TABLE reset_credit_operations (
    account_key TEXT PRIMARY KEY,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('recovery', 'manual')),
    credential_generation INTEGER,
    exhaustion_generation INTEGER,
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL,
    code TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK (
      (operation_kind = 'recovery'
        AND credential_generation IS NOT NULL AND credential_generation >= 0
        AND exhaustion_generation IS NOT NULL AND exhaustion_generation >= 0)
      OR
      (operation_kind = 'manual'
        AND credential_generation IS NULL AND exhaustion_generation IS NULL)
    )
  ) STRICT, WITHOUT ROWID`;

const CURRENT_OPERATION_SCHEMA_SHA256 =
  "dec4cc8c4871ab8bce2f259268f2a674a9064aa239441bb04abea91de1b7f9fd";
const CURRENT_MANUAL_ID_SCHEMA_SHA256 =
  "c3ceff1059417c22cd7a3984f49eef54cd125213631882eb998b223567ce741a";

function schemaHash(sql: string | undefined): string | undefined {
  return sql === undefined ? undefined : createHash("sha256").update(sql).digest("hex");
}

const originalOpenCodexHome = process.env.OPENCODEX_HOME;
let isolatedHome: string | undefined;

beforeAll(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), "ocx-reset-credit-ledger-"));
  process.env.OPENCODEX_HOME = isolatedHome;
});

afterAll(() => {
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  if (isolatedHome) {
    Bun.gc(true);
    rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

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

const MIGRATION_REJECTION_FIXTURES = [
  {
    label: "legacy recovery",
    kind: "legacy" as const,
    schema: LEGACY_OPERATION_SCHEMA_SQL,
    backupTable: "reset_credit_operations_legacy_v1",
  },
  {
    label: "prior manual",
    kind: "prior" as const,
    schema: PRIOR_OPERATION_SCHEMA_SQL,
    backupTable: "reset_credit_operations_legacy_v2",
  },
] as const;
const MIGRATION_REJECTION_CASES = ["malformed row", "duplicate operation id", "over capacity"] as const;

function seedRejectedMigration(
  kind: "legacy" | "prior",
  rejection: (typeof MIGRATION_REJECTION_CASES)[number],
): Record<string, unknown>[] {
  const database = new Database(databasePath(), { create: true });
  try {
    database.exec(kind === "legacy" ? LEGACY_OPERATION_SCHEMA_SQL : PRIOR_OPERATION_SCHEMA_SQL);
    const insert = kind === "legacy"
      ? database.prepare(`
          INSERT INTO reset_credit_operations VALUES (?, ?, ?, ?, 'pending', NULL, 1, 1)
        `)
      : database.prepare(`
          INSERT INTO reset_credit_operations VALUES (
            ?, 'manual', NULL, NULL, ?, 'pending', NULL, 1, 1
          )
        `);
    const rowCount = rejection === "over capacity"
      ? MAX_RESET_CREDIT_OPERATION_ACCOUNTS + 1
      : rejection === "duplicate operation id" ? 2 : 1;
    const duplicatedOperationId = fixtureOperationId(0x22000);
    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < rowCount; index += 1) {
      const key = createHash("sha256")
        .update(`migration-rejection-${kind}-${rejection}-${index}`)
        .digest("hex");
      const operationId = rejection === "malformed row"
        ? "not-a-uuid"
        : rejection === "duplicate operation id"
          ? duplicatedOperationId
          : fixtureOperationId(0x23000 + index);
      if (kind === "legacy") {
        insert.run(key, GENERATION.credentialGeneration, GENERATION.exhaustionGeneration, operationId);
      } else {
        insert.run(key, operationId);
      }
    }
    database.exec("COMMIT");
    return database.query<Record<string, unknown>, []>(
      "SELECT * FROM reset_credit_operations ORDER BY account_key",
    ).all();
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the fixture error */ }
    throw error;
  } finally {
    database.close();
  }
}

function seedValidMigration(kind: "legacy" | "prior"): Record<string, unknown>[] {
  const database = new Database(databasePath(), { create: true });
  try {
    database.exec(kind === "legacy" ? LEGACY_OPERATION_SCHEMA_SQL : PRIOR_OPERATION_SCHEMA_SQL);
    const key = createHash("sha256").update(`valid-migration-${kind}`).digest("hex");
    const operationId = fixtureOperationId(kind === "legacy" ? 0x24100 : 0x24101);
    if (kind === "legacy") {
      database.prepare(`
        INSERT INTO reset_credit_operations VALUES (?, ?, ?, ?, 'ambiguous', NULL, 100, 200)
      `).run(key, GENERATION.credentialGeneration, GENERATION.exhaustionGeneration, operationId);
    } else {
      database.prepare(`
        INSERT INTO reset_credit_operations VALUES (
          ?, 'manual', NULL, NULL, ?, 'ambiguous', NULL, 100, 200
        )
      `).run(key, operationId);
    }
    return database.query<Record<string, unknown>, []>(
      "SELECT * FROM reset_credit_operations ORDER BY account_key",
    ).all();
  } finally {
    database.close();
  }
}

function appendTerminalManualHistory(startIndex: number, count: number): void {
  const database = new Database(databasePath());
  try {
    const insert = database.prepare(`
      INSERT INTO reset_credit_manual_operation_ids (
        operation_id, account_key, canonical_operation_id,
        terminal_code, created_at, updated_at
      ) VALUES (?, ?, ?, 'no_credit', 1, 1)
    `);
    database.exec("BEGIN IMMEDIATE");
    for (let offset = 0; offset < count; offset += 1) {
      const operationId = fixtureOperationId(startIndex + offset);
      const key = createHash("sha256")
        .update(`synthetic-terminal-manual-history-${startIndex + offset}`)
        .digest("hex");
      insert.run(operationId, key, operationId);
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the fixture error */ }
    throw error;
  } finally {
    database.close();
  }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + CHILD_READY_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function terminateChild(child: Bun.Subprocess): Promise<void> {
  child.kill();
  let exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(CHILD_EXIT_TIMEOUT_MS).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(CHILD_EXIT_TIMEOUT_MS).then(() => false),
    ]);
  }
  if (!exited) throw new Error("reset-credit ledger lock child did not exit");
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

beforeEach(() => {
  const database = new Database(databasePath(), { create: true });
  try {
    database.exec(`
      DROP TABLE IF EXISTS reset_credit_manual_operation_ids;
      DROP TABLE IF EXISTS reset_credit_operations;
      DROP TABLE IF EXISTS reset_credit_operations_legacy_v1;
      DROP TABLE IF EXISTS reset_credit_operations_legacy_v2;
    `);
  }
  finally { database.close(); }
});

afterEach(() => {
  setResetCreditOperationMigrationFaultForTests(null);
});

describe("Codex reset-credit operation ledger", () => {
  test("exports strict operation-id, generation-order, and nested-mutation contracts", () => {
    const operationId = fixtureOperationId(0xabc);
    expect(isCodexResetCreditOperationId(operationId)).toBeTrue();
    expect(isCodexResetCreditOperationId(operationId.toUpperCase())).toBeFalse();
    expect(isCodexResetCreditOperationId("00000000-0000-5000-8000-000000000001")).toBeFalse();
    expect(isCodexResetCreditOperationId("00000000-0000-4000-7000-000000000001")).toBeFalse();
    expect(isCodexResetCreditOperationId(` ${operationId}`)).toBeFalse();
    expect(isCodexResetCreditOperationId("00000000-0000-0000-0000-000000000000")).toBeFalse();
    expect(isCodexResetCreditOperationId(null)).toBeFalse();
    expect(compareCodexResetCreditRecoveryGenerationOrder(GENERATION, GENERATION)).toBe(0);
    expect(compareCodexResetCreditRecoveryGenerationOrder(
      { ...GENERATION, credentialGeneration: GENERATION.credentialGeneration + 1 },
      GENERATION,
    )).toBe(1);
    expect(compareCodexResetCreditRecoveryGenerationOrder(
      { ...GENERATION, exhaustionGeneration: GENERATION.exhaustionGeneration - 1 },
      GENERATION,
    )).toBe(-1);
    expect(prepareConfigMutationDatabasePathForWrite()).toBe(databasePath());
    expect(() => withConfigMutationLockSync(() => prepareConfigMutationDatabasePathForWrite()))
      .toThrow(NestedConfigMutationError);
  });

  test("bootstraps the canonical ledger when its config directory and database are absent", () => {
    const path = databasePath();
    if (!isolatedHome) throw new Error("isolated home was not initialized");
    rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    expect(existsSync(isolatedHome)).toBeFalse();
    expect(existsSync(path)).toBeFalse();

    expect(openResetCreditOperation(GENERATION, 100))
      .toMatchObject({ kind: "execute", resumed: false });
    expect(existsSync(path)).toBeTrue();
  });

  test("fails closed when the primary ledger table is missing but manual identity state remains", () => {
    const opened = openResetCreditOperation(GENERATION, 100);
    if (opened.kind !== "execute") throw new Error("reservation failed");
    const database = new Database(databasePath());
    try {
      database.exec("DROP TABLE reset_credit_operations");
    } finally {
      database.close();
    }

    expect(openResetCreditOperation(GENERATION, 200)).toEqual({ kind: "unavailable" });
    const verifier = new Database(databasePath(), { readonly: true });
    try {
      expect(verifier.query<{ name: string }, []>(`
        SELECT name FROM main.sqlite_schema
         WHERE type = 'table' AND name LIKE 'reset_credit_%'
         ORDER BY name
      `).all()).toEqual([{ name: "reset_credit_manual_operation_ids" }]);
    } finally {
      verifier.close();
    }
  });

  test("fails closed when the manual identity table is missing from an existing ledger", () => {
    const opened = openResetCreditOperation(GENERATION, 100);
    if (opened.kind !== "execute") throw new Error("reservation failed");
    const database = new Database(databasePath());
    try {
      database.exec("DROP TABLE reset_credit_manual_operation_ids");
    } finally {
      database.close();
    }

    expect(openResetCreditOperation(GENERATION, 200)).toEqual({ kind: "unavailable" });
    const verifier = new Database(databasePath(), { readonly: true });
    try {
      expect(verifier.query<{ operation_id: string }, []>(
        "SELECT operation_id FROM reset_credit_operations",
      ).get()?.operation_id).toBe(opened.operationId);
      expect(verifier.query<{ name: string }, []>(`
        SELECT name FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_manual_operation_ids'
      `).get()).toBeNull();
    } finally {
      verifier.close();
    }
  });

  test("snapshots recovery generations once and rejects inherited fields", () => {
    let credentialReads = 0;
    const accessorGeneration = {
      accountId: GENERATION.accountId,
      get credentialGeneration() {
        credentialReads += 1;
        return credentialReads === 1 ? GENERATION.credentialGeneration : GENERATION.credentialGeneration + 1;
      },
      exhaustionGeneration: GENERATION.exhaustionGeneration,
    };

    const opened = openResetCreditOperation(accessorGeneration, 100);
    expect(opened).toMatchObject({ kind: "execute", resumed: false });
    expect(credentialReads).toBe(1);
    if (opened.kind !== "execute") throw new Error("reservation failed");
    expect(markResetCreditOperationAmbiguous(accessorGeneration, opened.operationId, 200))
      .toEqual({ kind: "mismatch" });
    expect(credentialReads).toBe(2);

    const inheritedGeneration = Object.create(GENERATION) as CodexResetCreditRecoveryGeneration;
    expect(() => openResetCreditOperation(inheritedGeneration, 300))
      .toThrow("generation fields must be own properties");
    expect(() => markResetCreditOperationAmbiguous(inheritedGeneration, opened.operationId, 300))
      .toThrow("generation fields must be own properties");
    expect(() => settleResetCreditOperation(inheritedGeneration, opened.operationId, "reset", 300))
      .toThrow("generation fields must be own properties");
  });

  test("snapshots manual identities once and rejects inherited fields", () => {
    const recovery = openResetCreditOperation(GENERATION, 100);
    if (recovery.kind !== "execute") throw new Error("recovery reservation failed");
    const callerOperationId = fixtureOperationId(0xdef);
    let accountReads = 0;
    let credentialReads = 0;
    let operationReads = 0;
    const accessorIdentity = {
      get accountId() {
        accountReads += 1;
        return "pool-manual-snapshot";
      },
      get chatgptAccountId() {
        credentialReads += 1;
        return "chatgpt-manual-snapshot";
      },
      get operationId() {
        operationReads += 1;
        return operationReads <= 2 ? callerOperationId : recovery.operationId;
      },
    };

    expect(openManualResetCreditOperation(accessorIdentity, 200)).toEqual({
      kind: "execute",
      operationId: callerOperationId,
      resumed: false,
    });
    expect({ accountReads, credentialReads, operationReads }).toEqual({
      accountReads: 1,
      credentialReads: 1,
      operationReads: 1,
    });
    const database = new Database(databasePath(), { readonly: true });
    try {
      const rows = database.query<{ operation_id: string }, []>(
        "SELECT operation_id FROM reset_credit_operations ORDER BY operation_id",
      ).all();
      expect(rows.map(row => row.operation_id)).toEqual([
        callerOperationId,
        recovery.operationId,
      ].sort());
    } finally {
      database.close();
    }

    const inheritedIdentity = Object.create({
      accountId: "pool-manual-inherited",
      chatgptAccountId: "chatgpt-manual-inherited",
      operationId: fixtureOperationId(0xeee),
    }) as ManualResetCreditOperationIdentity;
    expect(() => openManualResetCreditOperation(inheritedIdentity, 300))
      .toThrow("manual reset-credit identity fields must be own properties");
    expect(() => markManualResetCreditOperationAmbiguous(inheritedIdentity, 300))
      .toThrow("manual reset-credit identity fields must be own properties");
    expect(() => settleManualResetCreditOperation(inheritedIdentity, "reset", 300))
      .toThrow("manual reset-credit identity fields must be own properties");
  });

  test("migrates the exact prior recovery schema without changing durable state", () => {
    const database = new Database(databasePath(), { create: true });
    const key = createHash("sha256")
      .update(`codex-reset-credit-operation\0${GENERATION.accountId}`)
      .digest("hex");
    const operationId = fixtureOperationId(699);
    try {
      database.exec(LEGACY_OPERATION_SCHEMA_SQL);
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
      expect(schemaHash(migrated.query<{ sql: string }, []>(`
        SELECT sql FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_operations'
      `).get()?.sql)).toBe(CURRENT_OPERATION_SCHEMA_SHA256);
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
      database.exec(PRIOR_OPERATION_SCHEMA_SQL);
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
      expect(schemaHash(migrated.query<{ sql: string }, []>(`
        SELECT sql FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_operations'
      `).get()?.sql)).toBe(CURRENT_OPERATION_SCHEMA_SHA256);
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

  for (const fixture of MIGRATION_REJECTION_FIXTURES) {
    test(`rolls back ${fixture.label} migration after the first schema write`, () => {
      const before = seedValidMigration(fixture.kind);
      setResetCreditOperationMigrationFaultForTests("after_first_write");
      const result = fixture.kind === "legacy"
        ? openResetCreditOperation({ ...GENERATION, accountId: "pool-migration-fault" }, 300)
        : openManualResetCreditOperation({
            accountId: "pool-migration-fault",
            chatgptAccountId: "chatgpt-migration-fault",
            operationId: fixtureOperationId(0x24102),
          }, 300);
      expect(result).toEqual({ kind: "unavailable" });

      const verifier = new Database(databasePath(), { readonly: true });
      try {
        expect(schemaHash(verifier.query<{ sql: string }, []>(`
          SELECT sql FROM main.sqlite_schema
           WHERE type = 'table' AND name = 'reset_credit_operations'
        `).get()?.sql)).toBe(schemaHash(fixture.schema));
        expect(verifier.query<Record<string, unknown>, []>(
          "SELECT * FROM reset_credit_operations ORDER BY account_key",
        ).all()).toEqual(before);
        expect(verifier.query<{ name: string }, []>(`
          SELECT name FROM main.sqlite_schema
           WHERE type = 'table' AND name LIKE 'reset_credit_%'
           ORDER BY name
        `).all()).toEqual([{ name: "reset_credit_operations" }]);
      } finally {
        verifier.close();
      }
    });

    for (const rejection of MIGRATION_REJECTION_CASES) {
      test(`refuses ${fixture.label} migration with ${rejection} without rewriting state`, () => {
        const before = seedRejectedMigration(fixture.kind, rejection);
        const result = fixture.kind === "legacy"
          ? openResetCreditOperation({ ...GENERATION, accountId: "pool-migration-probe" }, 300)
          : openManualResetCreditOperation({
              accountId: "pool-migration-probe",
              chatgptAccountId: "chatgpt-migration-probe",
              operationId: fixtureOperationId(0x24000),
            }, 300);
        expect(result).toEqual({ kind: "unavailable" });

        const verifier = new Database(databasePath(), { readonly: true });
        try {
          expect(schemaHash(verifier.query<{ sql: string }, []>(`
            SELECT sql FROM main.sqlite_schema
             WHERE type = 'table' AND name = 'reset_credit_operations'
          `).get()?.sql)).toBe(schemaHash(fixture.schema));
          expect(verifier.query<Record<string, unknown>, []>(
            "SELECT * FROM reset_credit_operations ORDER BY account_key",
          ).all()).toEqual(before);
          expect(verifier.query<{ name: string }, [string, string]>(`
            SELECT name FROM main.sqlite_schema
             WHERE name = ? OR name = ?
             ORDER BY name
          `).all(fixture.backupTable, "reset_credit_manual_operation_ids")).toEqual([]);
        } finally {
          verifier.close();
        }
      });
    }
  }

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
      expect(schemaHash(database.query<{ sql: string }, []>(`
        SELECT sql FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_operations'
      `).get()?.sql)).toBe(CURRENT_OPERATION_SCHEMA_SHA256);
      expect(schemaHash(database.query<{ sql: string }, []>(`
        SELECT sql FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_manual_operation_ids'
      `).get()?.sql)).toBe(CURRENT_MANUAL_ID_SCHEMA_SHA256);
    } finally {
      database.close();
    }
  });

  test("durably reserves before dispatch and restores the same operation identity", () => {
    const first = openResetCreditOperation(GENERATION, 100);
    expect(first).toMatchObject({ kind: "execute", resumed: false });
    if (first.kind !== "execute") throw new Error("reservation failed");

    const restarted = openResetCreditOperation(GENERATION, 200);
    expect(restarted).toEqual({ kind: "execute", operationId: first.operationId, resumed: true });
    expect(settleResetCreditOperation(GENERATION, first.operationId, "reset", 400))
      .toEqual({ kind: "updated" });
    expect(openResetCreditOperation(GENERATION, 500)).toEqual({
      kind: "terminal",
      operationId: first.operationId,
      code: "reset",
    });
  });

  test("supports durable recovery generations for the main account", () => {
    const generation = { ...GENERATION, accountId: MAIN_CODEX_ACCOUNT_ID };
    const first = openResetCreditOperation(generation, 100);
    expect(first).toMatchObject({ kind: "execute", resumed: false });
    if (first.kind !== "execute") throw new Error("reservation failed");

    expect(openResetCreditOperation(generation, 200)).toEqual({
      kind: "execute",
      operationId: first.operationId,
      resumed: true,
    });
    expect(settleResetCreditOperation(generation, first.operationId, "already_redeemed", 300))
      .toEqual({ kind: "updated" });
    expect(openResetCreditOperation(generation, 400)).toEqual({
      kind: "terminal",
      operationId: first.operationId,
      code: "already_redeemed",
    });
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

  test("persists every recovery terminal code without reopening execution", () => {
    for (const [index, code] of (["nothing_to_reset", "no_credit"] as const).entries()) {
      const generation = {
        accountId: `pool-terminal-code-${index}`,
        credentialGeneration: 1,
        exhaustionGeneration: 1,
      };
      const opened = openResetCreditOperation(generation, 100);
      if (opened.kind !== "execute") throw new Error("reservation failed");
      expect(settleResetCreditOperation(generation, opened.operationId, code, 200))
        .toEqual({ kind: "updated" });
      expect(openResetCreditOperation(generation, 300)).toEqual({
        kind: "terminal",
        operationId: opened.operationId,
        code,
      });
    }
  });

  test("terminal recovery and manual operations reject late ambiguity and conflicting settlement", () => {
    const recovery = openResetCreditOperation(GENERATION, 100);
    if (recovery.kind !== "execute") throw new Error("reservation failed");
    expect(settleResetCreditOperation(GENERATION, recovery.operationId, "reset", 200))
      .toEqual({ kind: "updated" });
    expect(markResetCreditOperationAmbiguous(GENERATION, recovery.operationId, 300))
      .toEqual({ kind: "mismatch" });
    expect(settleResetCreditOperation(GENERATION, recovery.operationId, "no_credit", 400))
      .toEqual({ kind: "mismatch" });
    expect(openResetCreditOperation(GENERATION, 500)).toEqual({
      kind: "terminal",
      operationId: recovery.operationId,
      code: "reset",
    });

    const manual = {
      accountId: "pool-manual-terminal-fence",
      chatgptAccountId: "chatgpt-manual-terminal-fence",
      operationId: fixtureOperationId(709),
    };
    expect(openManualResetCreditOperation(manual, 100)).toMatchObject({ kind: "execute" });
    expect(settleManualResetCreditOperation(manual, "reset", 200)).toEqual({ kind: "updated" });
    expect(markManualResetCreditOperationAmbiguous(manual, 300)).toEqual({ kind: "mismatch" });
    expect(settleManualResetCreditOperation(manual, "no_credit", 400))
      .toEqual({ kind: "mismatch" });
    expect(openManualResetCreditOperation(manual, 500)).toEqual({
      kind: "terminal",
      operationId: manual.operationId,
      code: "reset",
    });
  });

  test("rejects stale generations and mismatched settlement", () => {
    const current = openResetCreditOperation(GENERATION);
    if (current.kind !== "execute") throw new Error("reservation failed");
    expect(openResetCreditOperation({ ...GENERATION, exhaustionGeneration: 8 }))
      .toEqual({ kind: "stale-generation" });
    const reauthenticated = {
      ...GENERATION,
      credentialGeneration: GENERATION.credentialGeneration + 1,
      exhaustionGeneration: 0,
    };
    expect(openResetCreditOperation(reauthenticated))
      .toEqual({ kind: "unresolved-prior-generation" });
    expect(markResetCreditOperationAmbiguous(reauthenticated, current.operationId))
      .toEqual({ kind: "mismatch" });
    expect(settleResetCreditOperation(reauthenticated, current.operationId, "reset"))
      .toEqual({ kind: "mismatch" });
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

  test("isolates recovery validation from unrelated manual history but rejects cross-table id reuse", () => {
    const manual = {
      accountId: "pool-manual-isolation",
      chatgptAccountId: "chatgpt-manual-isolation",
      operationId: fixtureOperationId(0x25000),
    };
    expect(openManualResetCreditOperation(manual, 100)).toMatchObject({ kind: "execute" });
    expect(settleManualResetCreditOperation(manual, "no_credit", 200)).toEqual({ kind: "updated" });

    const database = new Database(databasePath());
    try {
      const unrelated = fixtureOperationId(0x25001);
      database.prepare(`
        INSERT INTO reset_credit_manual_operation_ids (
          operation_id, account_key, canonical_operation_id,
          terminal_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'no_credit', 1, 1)
      `).run(
        unrelated,
        createHash("sha256").update("unrelated-corrupt-manual-history").digest("hex"),
        fixtureOperationId(0x25002),
      );
    } finally {
      database.close();
    }

    const generation = { ...GENERATION, accountId: "pool-recovery-isolation" };
    const opened = openResetCreditOperation(generation, 300);
    expect(opened).toMatchObject({ kind: "execute", resumed: false });
    if (opened.kind !== "execute") throw new Error("recovery reservation failed");

    const duplicate = new Database(databasePath());
    try {
      duplicate.prepare(`
        INSERT INTO reset_credit_manual_operation_ids (
          operation_id, account_key, canonical_operation_id,
          terminal_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'no_credit', 1, 1)
      `).run(
        opened.operationId,
        createHash("sha256").update("cross-table-duplicate-recovery-id").digest("hex"),
        opened.operationId,
      );
    } finally {
      duplicate.close();
    }
    expect(openResetCreditOperation(generation, 400)).toEqual({ kind: "unavailable" });
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

  test("fails fast under cross-process mutation contention and recovers after abrupt exit", async () => {
    expect(openResetCreditOperation(GENERATION)).toMatchObject({ kind: "execute", resumed: false });
    const readyPath = join(process.env.OPENCODEX_HOME!, "ledger-lock-ready");
    const child = Bun.spawn([process.execPath, "-e", `
      import { writeFileSync } from "node:fs";
      import { Database } from "bun:sqlite";
      const database = new Database(process.env.OCX_LEDGER_DB_PATH);
      database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      writeFileSync(process.env.OCX_LEDGER_READY_PATH, "ready");
      while (true) Bun.sleepSync(50);
    `], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OCX_LEDGER_DB_PATH: databasePath(),
        OCX_LEDGER_READY_PATH: readyPath,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitForPath(readyPath);
      const startedAt = performance.now();
      const blocked = openResetCreditOperation({ ...GENERATION, accountId: "pool-b" });
      const elapsedMs = performance.now() - startedAt;
      expect(blocked).toEqual({ kind: "unavailable" });
      expect(elapsedMs).toBeLessThan(CONTENTION_FAIL_FAST_MS);
    } finally {
      await terminateChild(child);
    }
    expect(openResetCreditOperation({ ...GENERATION, accountId: "pool-b" }))
      .toMatchObject({ kind: "execute", resumed: false });
  }, CONTENTION_TEST_TIMEOUT_MS);

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
    expect(openResetCreditOperation({
      ...GENERATION,
      accountId: "pool-recovery-at-manual-history-cap",
    }, 500)).toMatchObject({ kind: "execute", resumed: false });
    const verifier = new Database(databasePath(), { readonly: true });
    try {
      expect(verifier.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM reset_credit_manual_operation_ids",
      ).get()?.count).toBe(MAX_MANUAL_RESET_CREDIT_OPERATION_IDS);
    } finally {
      verifier.close();
    }
  });

  test("refuses a new alias for an active manual operation when identity history is full", () => {
    const canonical = {
      accountId: "pool-manual-active-cap",
      chatgptAccountId: "chatgpt-manual-active-cap",
      operationId: fixtureOperationId(0x27000),
    };
    expect(openManualResetCreditOperation(canonical, 100)).toEqual({
      kind: "execute",
      operationId: canonical.operationId,
      resumed: false,
    });
    appendTerminalManualHistory(0x28000, MAX_MANUAL_RESET_CREDIT_OPERATION_IDS - 1);

    expect(openManualResetCreditOperation(canonical, 200)).toEqual({
      kind: "execute",
      operationId: canonical.operationId,
      resumed: true,
    });
    const alias = { ...canonical, operationId: fixtureOperationId(0x27001) };
    expect(openManualResetCreditOperation(alias, 300)).toEqual({ kind: "capacity" });

    const verifier = new Database(databasePath(), { readonly: true });
    try {
      expect(verifier.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM reset_credit_manual_operation_ids",
      ).get()?.count).toBe(MAX_MANUAL_RESET_CREDIT_OPERATION_IDS);
      expect(verifier.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM reset_credit_manual_operation_ids WHERE operation_id = ?
      `).get(alias.operationId)?.count).toBe(0);
      expect(verifier.query<{ joined_operation_id: string | null; updated_at: number }, []>(`
        SELECT joined_operation_id, updated_at FROM reset_credit_operations
      `).get()).toEqual({ joined_operation_id: null, updated_at: 100 });
    } finally {
      verifier.close();
    }
    expect(settleManualResetCreditOperation(canonical, "reset", 400)).toEqual({ kind: "updated" });
  });

  test("fails closed without rewriting manual identity history at max plus one", () => {
    const manual = {
      accountId: "pool-manual-over-cap",
      chatgptAccountId: "chatgpt-manual-over-cap",
      operationId: fixtureOperationId(0x29000),
    };
    expect(openManualResetCreditOperation(manual, 100)).toMatchObject({ kind: "execute" });
    expect(settleManualResetCreditOperation(manual, "reset", 200)).toEqual({ kind: "updated" });
    const recoveryGeneration = { ...GENERATION, accountId: "pool-recovery-over-manual-cap" };
    expect(openResetCreditOperation(recoveryGeneration, 300))
      .toMatchObject({ kind: "execute", resumed: false });

    const before = new Database(databasePath(), { readonly: true });
    let operationRows: Record<string, unknown>[];
    try {
      operationRows = before.query<Record<string, unknown>, []>(
        "SELECT * FROM reset_credit_operations ORDER BY account_key",
      ).all();
    } finally {
      before.close();
    }
    appendTerminalManualHistory(0x2a000, MAX_MANUAL_RESET_CREDIT_OPERATION_IDS);

    expect(openManualResetCreditOperation(manual, 400)).toEqual({ kind: "unavailable" });
    expect(openResetCreditOperation(recoveryGeneration, 500)).toEqual({ kind: "unavailable" });

    const verifier = new Database(databasePath(), { readonly: true });
    try {
      expect(verifier.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM reset_credit_manual_operation_ids",
      ).get()?.count).toBe(MAX_MANUAL_RESET_CREDIT_OPERATION_IDS + 1);
      expect(verifier.query<Record<string, unknown>, []>(
        "SELECT * FROM reset_credit_operations ORDER BY account_key",
      ).all()).toEqual(operationRows);
      expect(schemaHash(verifier.query<{ sql: string }, []>(`
        SELECT sql FROM main.sqlite_schema
         WHERE type = 'table' AND name = 'reset_credit_manual_operation_ids'
      `).get()?.sql)).toBe(CURRENT_MANUAL_ID_SCHEMA_SHA256);
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
