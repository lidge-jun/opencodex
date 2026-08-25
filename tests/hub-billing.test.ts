import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubAuth } from "../hub/src/auth";
import { HubBilling } from "../hub/src/billing";
import { HubDatabase } from "../hub/src/database";

const directories: string[] = [];
const DIGEST_SECRET = "test-only-billing-digest-secret-at-least-32-bytes";

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hubapi-billing-test-"));
  directories.push(directory);
  return join(directory, "hub.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixtures(path: string) {
  const database = new HubDatabase(path);
  const auth = new HubAuth(database.db, DIGEST_SECRET, 3600);
  const admin = await auth.bootstrapAdmin("admin@example.com", "a sufficiently long admin password");
  const user = (await auth.register("user@example.com", "correct horse battery staple")).user;
  const other = (await auth.register("other@example.com", "another correct horse password")).user;
  return { database, auth, admin, user, other, billing: new HubBilling(database.db, DIGEST_SECRET) };
}

describe("hub user API keys", () => {
  test("reveals key once, stores only a digest, and enforces owner revocation", async () => {
    const context = await fixtures(databasePath());
    const created = context.billing.createApiKey(context.user.id, "Production CLI");
    expect(created.key).toStartWith("hub_live_");
    expect(context.billing.listApiKeys(context.user.id)).toEqual([{ ...created, key: undefined }].map(({ key: _key, ...row }) => row));
    const stored = context.database.db.query("SELECT key_digest, display_prefix, display_suffix FROM hub_api_keys WHERE id = ?").get(created.id) as Record<string, string>;
    expect(stored.key_digest).not.toContain(created.key);
    expect(stored.display_prefix).not.toBe(created.key);
    expect(stored.display_suffix).toBe(created.key.slice(-4));
    expect(context.billing.authenticateApiKey(created.key)).toEqual({ keyId: created.id, userId: context.user.id });
    expect(context.billing.revokeApiKey(context.other.id, created.id)).toBe(false);
    expect(context.billing.authenticateApiKey(created.key)).not.toBeNull();
    expect(context.billing.revokeApiKey(context.user.id, created.id)).toBe(true);
    expect(context.billing.authenticateApiKey(created.key)).toBeNull();
    context.database.close();
  });
});

describe("hub recharge codes and integer ledger", () => {
  test("stores no plaintext code and idempotent retry credits only once", async () => {
    const context = await fixtures(databasePath());
    const batch = context.billing.createRechargeBatch(context.admin, {
      label: "Launch batch",
      unitAmount: 25_000,
      quantity: 2,
      expiresAt: Date.now() + 60_000,
    });
    expect(batch.codes).toHaveLength(2);
    const stored = context.database.db.query("SELECT code_digest, display_suffix FROM hub_recharge_codes WHERE batch_id = ? ORDER BY id LIMIT 1")
      .get(batch.batchId) as Record<string, string>;
    expect(batch.codes.every(code => stored.code_digest !== code)).toBe(true);
    expect(JSON.stringify(context.database.db.query("SELECT * FROM hub_recharge_codes WHERE batch_id = ?").all(batch.batchId)))
      .not.toContain(batch.codes[0]!);

    const first = context.billing.redeem(context.user.id, batch.codes[0], "redeem-attempt-0001");
    const replay = context.billing.redeem(context.user.id, batch.codes[0], "redeem-attempt-0001");
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.entry.id).toBe(first.entry.id);
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: 25_000, reservedUnits: 0, availableUnits: 25_000 });
    expect(context.billing.listLedger(context.user.id)).toHaveLength(1);
    context.database.close();
  });

  test("allows only one claimant for a code and rolls back the losing transaction", async () => {
    const path = databasePath();
    const context = await fixtures(path);
    const batch = context.billing.createRechargeBatch(context.admin, { label: "One code", unitAmount: 10_000, quantity: 1 });
    const secondDatabase = new HubDatabase(path);
    const secondBilling = new HubBilling(secondDatabase.db, DIGEST_SECRET);
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => context.billing.redeem(context.user.id, batch.codes[0], "claim-user-0001")),
      Promise.resolve().then(() => secondBilling.redeem(context.other.id, batch.codes[0], "claim-other-0001")),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    const totalBalance = context.billing.balance(context.user.id).balanceUnits + context.billing.balance(context.other.id).balanceUnits;
    expect(totalBalance).toBe(10_000);
    expect(context.database.db.query("SELECT count(*) AS count FROM hub_ledger_entries").get()).toEqual({ count: 1 });
    secondDatabase.close();
    context.database.close();
  });

  test("rejects idempotency-key reuse for a different code", async () => {
    const context = await fixtures(databasePath());
    const batch = context.billing.createRechargeBatch(context.admin, { label: "Two codes", unitAmount: 1_000, quantity: 2 });
    context.billing.redeem(context.user.id, batch.codes[0], "same-key-0001");
    expect(() => context.billing.redeem(context.user.id, batch.codes[1], "same-key-0001")).toThrow("idempotency_conflict");
    expect(context.billing.balance(context.user.id).balanceUnits).toBe(1_000);
    context.database.close();
  });

  test("refuses cumulative credit beyond the safe account limit without consuming the code", async () => {
    const context = await fixtures(databasePath());
    const maximum = 9_000_000_000_000;
    context.billing.adjustBalance(context.admin, {
      userId: context.user.id,
      amountUnits: maximum,
      reason: "account limit boundary",
      idempotencyKey: "account-limit-fund-0001",
    });
    const batch = context.billing.createRechargeBatch(context.admin, { label: "Overflow guard", unitAmount: 1, quantity: 1 });

    expect(() => context.billing.redeem(context.user.id, batch.codes[0], "account-limit-redeem-0001"))
      .toThrow("credit_limit_exceeded");
    expect(() => context.billing.adjustBalance(context.admin, {
      userId: context.user.id,
      amountUnits: 1,
      reason: "must not overflow account limit",
      idempotencyKey: "account-limit-adjust-0001",
    })).toThrow("credit_limit_exceeded");
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: maximum, reservedUnits: 0, availableUnits: maximum });
    expect(context.database.db.query("SELECT status FROM hub_recharge_codes WHERE batch_id = ?").get(batch.batchId)).toEqual({ status: "available" });
    context.database.close();
  });

  test("releases unforwarded crash reservations and conservatively settles accepted ones", async () => {
    const context = await fixtures(databasePath());
    const key = context.billing.createApiKey(context.user.id, "Crash recovery");
    const batch = context.billing.createRechargeBatch(context.admin, { label: "Recovery credit", unitAmount: 1_000, quantity: 1 });
    context.billing.redeem(context.user.id, batch.codes[0], "recovery-fund-0001");
    context.billing.reserveRequest({
      userId: context.user.id,
      apiKeyId: key.id,
      requestId: "recovery-request-0001",
      clientIdempotencyKey: "recovery-client-0001",
      requestFingerprint: "recovery-fingerprint",
      pricingVersion: "test-v1",
      routePath: "/v1/responses",
      modelAlias: "test-model",
      units: 100,
    });
    expect(context.billing.balance(context.user.id).reservedUnits).toBe(100);
    expect(context.billing.recoverPendingReservations(2_000)).toBe(1);
    expect(context.billing.recoverPendingReservations(2_001)).toBe(0);
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: 1_000, reservedUnits: 0, availableUnits: 1_000 });
    expect(context.billing.listLedger(context.user.id).find(entry => entry.kind === "release")?.reason).toBe("process_recovery_release");

    context.billing.reserveRequest({
      userId: context.user.id,
      apiKeyId: key.id,
      requestId: "recovery-request-0002",
      clientIdempotencyKey: "recovery-client-0002",
      requestFingerprint: "recovery-fingerprint-2",
      pricingVersion: "test-v1",
      routePath: "/v1/responses",
      modelAlias: "test-model",
      units: 100,
    });
    context.billing.markUpstreamAccepted("recovery-request-0002", 200, 3_000);
    expect(context.billing.recoverPendingReservations(3_001)).toBe(1);
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: 900, reservedUnits: 0, availableUnits: 900 });
    expect(context.billing.listRequests(context.user.id)[0]).toEqual(expect.objectContaining({
      id: "recovery-request-0002",
      routePath: "/v1/responses",
      modelAlias: "test-model",
      status: "settled",
      upstreamStatus: 200,
      terminalReason: "process_recovery_conservative_settlement",
    }));
    context.database.close();
  });
});

describe("hub administrator controls", () => {
  test("returns operational user state without exposing login emails", async () => {
    const context = await fixtures(databasePath());
    const users = context.billing.listUsers(context.admin);
    expect(users).toHaveLength(3);
    expect(users.every(row => typeof row.id === "string" && typeof row.supportReference === "string" && typeof row.balanceUnits === "number")).toBe(true);
    expect(new Set(users.map(row => row.supportReference)).size).toBe(users.length);
    expect(JSON.stringify(users)).not.toContain("@example.com");
    expect(users.every(row => !("email" in row))).toBe(true);
    context.database.close();
  });

  test("imports digest-only codes, revokes remaining inventory, and records audit events", async () => {
    const context = await fixtures(databasePath());
    const codes = ["hub_rc_imported-code-000000000001", "hub_rc_imported-code-000000000002"];
    const imported = context.billing.importRechargeBatch(context.admin, { label: "Imported", unitAmount: 5_000, codes });
    expect(imported.imported).toBe(2);
    expect(JSON.stringify(context.database.db.query("SELECT * FROM hub_recharge_codes WHERE batch_id = ?").all(imported.batchId))).not.toContain(codes[0]!);
    context.billing.redeem(context.user.id, codes[0], "import-redeem-0001");
    expect(context.billing.revokeRechargeBatch(context.admin, imported.batchId)).toBe(true);
    const statuses = context.database.db.query("SELECT status FROM hub_recharge_codes WHERE batch_id = ? ORDER BY status").all(imported.batchId) as Array<{ status: string }>;
    expect(statuses.map(row => row.status)).toEqual(["redeemed", "revoked"]);
    expect(context.billing.listRechargeCodes(context.admin, imported.batchId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ suffix: codes[0]!.slice(-4), status: "redeemed", redeemedBy: context.user.supportReference }),
      expect.objectContaining({ suffix: codes[1]!.slice(-4), status: "revoked", redeemedBy: null }),
    ]));
    expect(context.billing.listAudit(context.admin).map(row => row.action)).toContain("recharge_batch.import");
    expect(context.billing.listAudit(context.admin).map(row => row.action)).toContain("recharge_batch.revoke");
    context.database.close();
  });

  test("adjusts only through an idempotent ledger entry and prevents disabling self", async () => {
    const context = await fixtures(databasePath());
    const first = context.billing.adjustBalance(context.admin, {
      userId: context.user.id,
      amountUnits: 12_345,
      reason: "support-approved launch credit",
      idempotencyKey: "admin-adjustment-0001",
    });
    const replay = context.billing.adjustBalance(context.admin, {
      userId: context.user.id,
      amountUnits: 12_345,
      reason: "support-approved launch credit",
      idempotencyKey: "admin-adjustment-0001",
    });
    expect(first).toEqual({ balanceUnits: 12_345, replayed: false });
    expect(replay).toEqual({ balanceUnits: 12_345, replayed: true });
    expect(context.billing.listLedger(context.user.id).filter(entry => entry.kind === "adjustment")).toHaveLength(1);
    expect(() => context.billing.adjustBalance(context.admin, {
      userId: context.user.id,
      amountUnits: 1,
      reason: "different adjustment payload",
      idempotencyKey: "admin-adjustment-0001",
    })).toThrow("idempotency_conflict");
    expect(() => context.billing.adjustBalance(context.admin, {
      userId: context.user.id,
      amountUnits: -20_000,
      reason: "invalid negative balance",
      idempotencyKey: "admin-adjustment-0002",
    })).toThrow("insufficient_adjustable_balance");
    expect(() => context.billing.setUserStatus(context.admin, context.admin.id, "disabled")).toThrow("cannot_disable_self");
    const activeSession = await context.auth.login("user@example.com", "correct horse battery staple");
    expect(context.billing.setUserStatus(context.admin, context.user.id, "disabled")).toBe(true);
    expect(context.auth.authenticate(activeSession.token)).toBeNull();
    context.database.close();
  });

  test("lets an administrator inspect only masked user details and revoke an active key", async () => {
    const context = await fixtures(databasePath());
    const key = context.billing.createApiKey(context.user.id, "Support-visible key");
    context.billing.adjustBalance(context.admin, {
      userId: context.user.id,
      amountUnits: 500,
      reason: "support-approved credit",
      idempotencyKey: "admin-details-credit-0001",
    });
    const details = context.billing.adminUserDetails(context.admin, context.user.id);
    expect(details.user.supportReference).toBe(context.user.supportReference);
    expect(details.keys).toEqual([expect.objectContaining({ id: key.id, prefix: key.prefix, suffix: key.suffix })]);
    expect(details.ledger).toEqual([expect.objectContaining({ kind: "adjustment", amountUnits: 500 })]);
    expect(JSON.stringify(details)).not.toContain("user@example.com");
    expect(JSON.stringify(details)).not.toContain(key.key);
    expect(context.billing.revokeApiKeyAsAdmin(context.admin, key.id)).toBe(true);
    expect(context.billing.authenticateApiKey(key.key)).toBeNull();
    expect(context.billing.listAudit(context.admin)).toContainEqual(expect.objectContaining({ action: "api_key.revoke", targetId: key.id, outcome: "success" }));
    context.database.close();
  });

  test("reports cumulative issuance separately from outstanding and settled credit", async () => {
    const context = await fixtures(databasePath());
    const batch = context.billing.createRechargeBatch(context.admin, { label: "Metrics", unitAmount: 1_000, quantity: 1 });
    context.billing.redeem(context.user.id, batch.codes[0], "metrics-fund-0001");
    const key = context.billing.createApiKey(context.user.id, "Metrics client");
    context.billing.reserveRequest({
      userId: context.user.id,
      apiKeyId: key.id,
      requestId: "metrics-request-0001",
      clientIdempotencyKey: "metrics-request-key-0001",
      requestFingerprint: "metrics-fingerprint",
      pricingVersion: "test-v1",
      routePath: "/v1/responses",
      modelAlias: "metrics-model",
      units: 100,
    });
    context.billing.markUpstreamAccepted("metrics-request-0001", 200);
    context.billing.settleRequest("metrics-request-0001");
    expect(context.billing.adminMetrics(context.admin)).toEqual({
      usersTotal: 3,
      activeUsers: 3,
      outstandingUnits: 900,
      issuedUnits: 1_000,
      settledUnits: 100,
      activeBatches: 1,
    });
    expect(context.billing.listAdminRequests(context.admin, 1)[0]).toEqual(expect.objectContaining({
      supportReference: context.user.supportReference,
      modelAlias: "metrics-model",
      status: "settled",
    }));
    context.database.close();
  });
});
