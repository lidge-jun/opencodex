import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  clearPendingResetCreditOperation,
  reservePendingResetCreditOperation,
  RESET_CREDIT_PENDING_SCHEMA_SQL_FOR_TESTS,
} from "../src/cli/reset-credit-pending";

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

function databasePath(): string {
  return join(home, "config-mutation.sqlite");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-reset-credit-pending-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test("reserve reuses one FULL-synchronous SQLite operation until an exact terminal clear", () => {
  const first = reservePendingResetCreditOperation("__main__");
  const database = new Database(databasePath());
  try {
    const schema = database.query<{ sql: string }, []>(`
      SELECT sql FROM main.sqlite_schema
       WHERE type = 'table' AND name = 'reset_credit_cli_pending'
    `).get();
    expect(schema?.sql).toBe(RESET_CREDIT_PENDING_SCHEMA_SQL_FOR_TESTS);
    expect(database.query<{ account_key: string; operation_id: string }, []>(`
      SELECT account_key, operation_id FROM main.reset_credit_cli_pending
    `).get()).toEqual({
      account_key: createHash("sha256").update("__main__").digest("hex"),
      operation_id: first,
    });
  } finally {
    database.close();
  }

  expect(reservePendingResetCreditOperation("__main__")).toBe(first);
  expect(clearPendingResetCreditOperation("__main__", "123e4567-e89b-42d3-a456-426614174000")).toBe(false);
  expect(reservePendingResetCreditOperation("__main__")).toBe(first);
  expect(clearPendingResetCreditOperation("__main__", first)).toBe(true);
  expect(reservePendingResetCreditOperation("__main__")).not.toBe(first);
});

test("separate accounts never share a pending operation", () => {
  expect(reservePendingResetCreditOperation("pool-a")).not.toBe(
    reservePendingResetCreditOperation("pool-b"),
  );
});

test("contention fails closed without replacing the durable operation", () => {
  const first = reservePendingResetCreditOperation("pool-a");
  const holder = new Database(databasePath());
  try {
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    expect(() => reservePendingResetCreditOperation("pool-a")).toThrow();
  } finally {
    if (holder.inTransaction) holder.exec("ROLLBACK");
    holder.close();
  }
  expect(reservePendingResetCreditOperation("pool-a")).toBe(first);
});

test("a non-canonical retry table is rejected without replacement", () => {
  const database = new Database(databasePath(), { create: true });
  try {
    database.exec("CREATE TABLE reset_credit_cli_pending (account_key TEXT PRIMARY KEY, operation_id TEXT)");
  } finally {
    database.close();
  }
  expect(() => reservePendingResetCreditOperation("pool-a")).toThrow(
    "Reset-credit retry state schema is invalid",
  );
  const reopened = new Database(databasePath());
  try {
    expect(reopened.query<{ sql: string }, []>(`
      SELECT sql FROM main.sqlite_schema WHERE name = 'reset_credit_cli_pending'
    `).get()?.sql).toBe(
      "CREATE TABLE reset_credit_cli_pending (account_key TEXT PRIMARY KEY, operation_id TEXT)",
    );
  } finally {
    reopened.close();
  }
});
