import type { Database } from "bun:sqlite";
import { hmacDigest, randomToken } from "./security";
import type { HubUser } from "./auth";

const MAX_BATCH_QUANTITY = 1_000;
const MAX_CREDIT_UNITS = 9_000_000_000_000;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface UserApiKey {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  status: "active" | "revoked";
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreatedUserApiKey extends UserApiKey {
  key: string;
}

export interface AdminUserDetails {
  user: {
    id: string;
    supportReference: string;
    role: HubUser["role"];
    status: HubUser["status"];
    createdAt: number;
    balanceUnits: number;
    reservedUnits: number;
  };
  keys: UserApiKey[];
  ledger: LedgerEntry[];
}

export interface RechargeCodeInventory {
  id: string;
  batchId: string;
  batchLabel: string;
  suffix: string;
  status: "available" | "redeemed" | "revoked" | "expired";
  redeemedBy: string | null;
  redeemedAt: number | null;
}

export interface LedgerEntry {
  id: string;
  kind: "recharge" | "reservation" | "settlement" | "release" | "refund" | "adjustment";
  amountUnits: number;
  idempotencyKey: string;
  referenceType: string;
  referenceId: string | null;
  reason: string;
  createdAt: number;
}

export interface RequestActivity {
  id: string;
  keyId: string;
  routePath: string | null;
  modelAlias: string | null;
  pricingVersion: string;
  reservedUnits: number;
  settledUnits: number | null;
  status: "pending" | "settled" | "released";
  upstreamStatus: number | null;
  createdAt: number;
  upstreamStartedAt: number | null;
  firstOutputAt: number | null;
  terminalAt: number | null;
  terminalReason: string | null;
}

export interface AdminMetrics {
  usersTotal: number;
  activeUsers: number;
  outstandingUnits: number;
  issuedUnits: number;
  settledUnits: number;
  activeBatches: number;
}

interface RechargeRow {
  id: string;
  status: "available" | "redeemed" | "revoked";
  batch_id: string;
  unit_amount: number;
  batch_status: "active" | "revoked";
  expires_at: number | null;
}

function validIntegerUnits(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_CREDIT_UNITS;
}

function normalizeName(value: unknown, max = 80): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().normalize("NFKC");
  return normalized.length >= 1 && normalized.length <= max ? normalized : null;
}

function mapKey(row: Record<string, unknown>): UserApiKey {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.display_prefix),
    suffix: String(row.display_suffix),
    status: row.status as UserApiKey["status"],
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  };
}

function mapLedger(row: Record<string, unknown>): LedgerEntry {
  return {
    id: String(row.id),
    kind: row.kind as LedgerEntry["kind"],
    amountUnits: Number(row.amount_units),
    idempotencyKey: String(row.idempotency_key),
    referenceType: String(row.reference_type),
    referenceId: row.reference_id === null ? null : String(row.reference_id),
    reason: String(row.reason),
    createdAt: Number(row.created_at),
  };
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapRequest(row: Record<string, unknown>): RequestActivity {
  return {
    id: String(row.id),
    keyId: String(row.api_key_id),
    routePath: row.route_path === null ? null : String(row.route_path),
    modelAlias: row.model_alias === null ? null : String(row.model_alias),
    pricingVersion: String(row.pricing_version),
    reservedUnits: Number(row.reserved_units),
    settledUnits: nullableNumber(row.settled_units),
    status: row.status as RequestActivity["status"],
    upstreamStatus: nullableNumber(row.upstream_status),
    createdAt: Number(row.created_at),
    upstreamStartedAt: nullableNumber(row.upstream_started_at),
    firstOutputAt: nullableNumber(row.first_output_at),
    terminalAt: nullableNumber(row.terminal_at),
    terminalReason: row.terminal_reason === null ? null : String(row.terminal_reason),
  };
}

export class HubBilling {
  constructor(private readonly db: Database, private readonly digestSecret: string) {}

  createApiKey(userId: string, nameValue: unknown, now = Date.now()): CreatedUserApiKey {
    const name = normalizeName(nameValue);
    if (!name) throw new Error("invalid_key_name");
    const key = randomToken("hub_live_");
    const id = crypto.randomUUID();
    const prefix = key.slice(0, 16);
    const suffix = key.slice(-4);
    this.db.query(`INSERT INTO hub_api_keys
      (id, user_id, name, key_digest, display_prefix, display_suffix, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(id, userId, name, hmacDigest(this.digestSecret, "api-key", key), prefix, suffix, now);
    return { id, name, key, prefix, suffix, status: "active", createdAt: now, lastUsedAt: null };
  }

  listApiKeys(userId: string): UserApiKey[] {
    return (this.db.query(`SELECT id, name, display_prefix, display_suffix, status, created_at, last_used_at
      FROM hub_api_keys WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as Record<string, unknown>[]).map(mapKey);
  }

  revokeApiKey(userId: string, keyId: string, now = Date.now()): boolean {
    const result = this.db.query(`UPDATE hub_api_keys SET status = 'revoked', revoked_at = ?
      WHERE id = ? AND user_id = ? AND status = 'active'`).run(now, keyId, userId);
    return result.changes === 1;
  }

  authenticateApiKey(key: string, now = Date.now()): { keyId: string; userId: string } | null {
    if (!key.startsWith("hub_live_")) return null;
    const digest = hmacDigest(this.digestSecret, "api-key", key);
    const row = this.db.query(`SELECT k.id AS key_id, k.user_id
      FROM hub_api_keys k JOIN hub_users u ON u.id = k.user_id
      WHERE k.key_digest = ? AND k.status = 'active' AND u.status = 'active'`).get(digest) as { key_id: string; user_id: string } | null;
    if (!row) return null;
    this.db.query("UPDATE hub_api_keys SET last_used_at = ? WHERE id = ?").run(now, row.key_id);
    return { keyId: row.key_id, userId: row.user_id };
  }

  balance(userId: string): { balanceUnits: number; reservedUnits: number; availableUnits: number } {
    const row = this.db.query("SELECT balance_units, reserved_units FROM hub_accounts WHERE user_id = ?").get(userId) as { balance_units: number; reserved_units: number } | null;
    if (!row) throw new Error("account_not_found");
    if (!Number.isSafeInteger(row.balance_units) || !Number.isSafeInteger(row.reserved_units)
      || row.balance_units < 0 || row.balance_units > MAX_CREDIT_UNITS
      || row.reserved_units < 0 || row.reserved_units > row.balance_units) {
      throw new Error("account_balance_invariant_failed");
    }
    return { balanceUnits: row.balance_units, reservedUnits: row.reserved_units, availableUnits: row.balance_units - row.reserved_units };
  }

  listLedger(userId: string, limit = 100): LedgerEntry[] {
    const bounded = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
    return (this.db.query(`SELECT * FROM hub_ledger_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(userId, bounded) as Record<string, unknown>[]).map(mapLedger);
  }

  listRequests(userId: string, limit = 100): RequestActivity[] {
    const bounded = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
    return (this.db.query(`SELECT id, api_key_id, route_path, model_alias, pricing_version,
      reserved_units, settled_units, status, upstream_status, created_at, upstream_started_at,
      first_output_at, terminal_at, terminal_reason
      FROM hub_request_reservations WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(userId, bounded) as Record<string, unknown>[]).map(mapRequest);
  }

  listAdminRequests(admin: HubUser, limit = 100): Array<RequestActivity & { supportReference: string }> {
    if (admin.role !== "admin") throw new Error("admin_required");
    const bounded = Number.isInteger(limit) ? Math.min(500, Math.max(1, limit)) : 100;
    return (this.db.query(`SELECT r.id, r.api_key_id, r.route_path, r.model_alias, r.pricing_version,
      r.reserved_units, r.settled_units, r.status, r.upstream_status, r.created_at, r.upstream_started_at,
      r.first_output_at, r.terminal_at, r.terminal_reason, u.support_reference
      FROM hub_request_reservations r JOIN hub_users u ON u.id = r.user_id
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(bounded) as Record<string, unknown>[])
      .map(row => ({ ...mapRequest(row), supportReference: String(row.support_reference) }));
  }

  reserveRequest(input: {
    userId: string;
    apiKeyId: string;
    requestId: string;
    clientIdempotencyKey: string | null;
    requestFingerprint: string;
    pricingVersion: string;
    routePath: string;
    modelAlias: string | null;
    units: number;
  }, now = Date.now()): void {
    if (!validIntegerUnits(input.units)) throw new Error("invalid_reservation_units");
    if (input.clientIdempotencyKey !== null && !IDEMPOTENCY_PATTERN.test(input.clientIdempotencyKey)) throw new Error("invalid_idempotency_key");
    if (!/^\/v1\/[a-z/]+$/.test(input.routePath) || input.routePath.length > 120) throw new Error("invalid_route_path");
    if (input.modelAlias !== null && (!normalizeName(input.modelAlias, 200) || input.modelAlias !== input.modelAlias.trim().normalize("NFKC"))) {
      throw new Error("invalid_model_alias");
    }
    const reserve = this.db.transaction(() => {
      if (input.clientIdempotencyKey) {
        const existing = this.db.query(`SELECT request_fingerprint FROM hub_request_reservations
          WHERE api_key_id = ? AND client_idempotency_key = ?`).get(input.apiKeyId, input.clientIdempotencyKey) as { request_fingerprint: string } | null;
        if (existing) {
          if (existing.request_fingerprint !== input.requestFingerprint) throw new Error("idempotency_conflict");
          throw new Error("request_replayed");
        }
      }
      const account = this.balance(input.userId);
      if (account.availableUnits < input.units) throw new Error("insufficient_credit");
      this.db.query(`INSERT INTO hub_request_reservations
        (id, user_id, api_key_id, client_idempotency_key, request_fingerprint, pricing_version, route_path, model_alias,
          reserved_units, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(input.requestId, input.userId, input.apiKeyId, input.clientIdempotencyKey, input.requestFingerprint,
          input.pricingVersion, input.routePath, input.modelAlias, input.units, now, now);
      this.db.query("UPDATE hub_accounts SET reserved_units = reserved_units + ?, updated_at = ? WHERE user_id = ?")
        .run(input.units, now, input.userId);
      this.db.query(`INSERT INTO hub_ledger_entries
        (id, user_id, kind, amount_units, idempotency_key, reference_type, reference_id, reason, created_at)
        VALUES (?, ?, 'reservation', ?, ?, 'request', ?, 'request_credit_reserved', ?)`)
        .run(crypto.randomUUID(), input.userId, -input.units, `reserve:${input.requestId}`, input.requestId, now);
    });
    reserve();
  }

  markUpstreamAccepted(requestId: string, upstreamStatus: number, now = Date.now()): boolean {
    if (!Number.isInteger(upstreamStatus) || upstreamStatus < 200 || upstreamStatus > 299) throw new Error("invalid_upstream_status");
    const result = this.db.query(`UPDATE hub_request_reservations
      SET upstream_status = ?, upstream_started_at = COALESCE(upstream_started_at, ?), updated_at = ?
      WHERE id = ? AND status = 'pending'`).run(upstreamStatus, now, now, requestId);
    return result.changes === 1;
  }

  markFirstOutput(requestId: string, now = Date.now()): boolean {
    const result = this.db.query(`UPDATE hub_request_reservations
      SET first_output_at = COALESCE(first_output_at, ?), updated_at = ?
      WHERE id = ? AND status = 'pending' AND upstream_started_at IS NOT NULL`).run(now, now, requestId);
    return result.changes === 1;
  }

  settleRequest(requestId: string, reason = "completed_request_settled", now = Date.now()): boolean {
    const safeReason = normalizeName(reason, 80);
    if (!safeReason) throw new Error("invalid_settlement_reason");
    const settle = this.db.transaction(() => {
      const row = this.db.query(`SELECT user_id, reserved_units FROM hub_request_reservations
        WHERE id = ? AND status = 'pending'`).get(requestId) as { user_id: string; reserved_units: number } | null;
      if (!row) return false;
      const reservationUpdate = this.db.query(`UPDATE hub_request_reservations
        SET status = 'settled', settled_units = reserved_units, terminal_reason = ?, terminal_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`).run(safeReason, now, now, requestId);
      const accountUpdate = this.db.query(`UPDATE hub_accounts
        SET balance_units = balance_units - ?, reserved_units = reserved_units - ?, updated_at = ?
        WHERE user_id = ? AND balance_units >= ? AND reserved_units >= ?`)
        .run(row.reserved_units, row.reserved_units, now, row.user_id, row.reserved_units, row.reserved_units);
      if (reservationUpdate.changes !== 1 || accountUpdate.changes !== 1) throw new Error("settlement_invariant_failed");
      this.db.query(`INSERT INTO hub_ledger_entries
        (id, user_id, kind, amount_units, idempotency_key, reference_type, reference_id, reason, created_at)
        VALUES (?, ?, 'settlement', ?, ?, 'request', ?, ?, ?)`)
        .run(crypto.randomUUID(), row.user_id, -row.reserved_units, `settle:${requestId}`, requestId, safeReason, now);
      return true;
    });
    return settle();
  }

  releaseRequest(requestId: string, reason = "request_failed_or_cancelled", now = Date.now(), upstreamStatus: number | null = null): boolean {
    const safeReason = normalizeName(reason, 80);
    if (!safeReason) throw new Error("invalid_release_reason");
    if (upstreamStatus !== null && (!Number.isInteger(upstreamStatus) || upstreamStatus < 100 || upstreamStatus > 599)) {
      throw new Error("invalid_upstream_status");
    }
    const release = this.db.transaction(() => {
      const row = this.db.query(`SELECT user_id, reserved_units FROM hub_request_reservations
        WHERE id = ? AND status = 'pending'`).get(requestId) as { user_id: string; reserved_units: number } | null;
      if (!row) return false;
      const reservationUpdate = this.db.query(`UPDATE hub_request_reservations
        SET status = 'released', settled_units = 0, upstream_status = COALESCE(?, upstream_status),
          terminal_reason = ?, terminal_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`)
        .run(upstreamStatus, safeReason, now, now, requestId);
      const accountUpdate = this.db.query("UPDATE hub_accounts SET reserved_units = reserved_units - ?, updated_at = ? WHERE user_id = ? AND reserved_units >= ?")
        .run(row.reserved_units, now, row.user_id, row.reserved_units);
      if (reservationUpdate.changes !== 1 || accountUpdate.changes !== 1) throw new Error("release_invariant_failed");
      this.db.query(`INSERT INTO hub_ledger_entries
        (id, user_id, kind, amount_units, idempotency_key, reference_type, reference_id, reason, created_at)
        VALUES (?, ?, 'release', ?, ?, 'request', ?, ?, ?)`)
        .run(crypto.randomUUID(), row.user_id, row.reserved_units, `release:${requestId}`, requestId, safeReason, now);
      return true;
    });
    return release();
  }

  recoverPendingReservations(now = Date.now()): number {
    const rows = this.db.query("SELECT id, upstream_started_at FROM hub_request_reservations WHERE status = 'pending' ORDER BY created_at, id")
      .all() as Array<{ id: string; upstream_started_at: number | null }>;
    let recovered = 0;
    for (const row of rows) {
      const resolved = row.upstream_started_at === null
        ? this.releaseRequest(row.id, "process_recovery_release", now)
        : this.settleRequest(row.id, "process_recovery_conservative_settlement", now);
      if (resolved) recovered += 1;
    }
    return recovered;
  }

  createRechargeBatch(
    admin: HubUser,
    input: { label?: unknown; unitAmount?: unknown; quantity?: unknown; expiresAt?: unknown },
    now = Date.now(),
  ): { batchId: string; codes: string[]; unitAmount: number; expiresAt: number | null } {
    if (admin.role !== "admin") throw new Error("admin_required");
    const label = normalizeName(input.label, 120);
    const quantity = input.quantity;
    const expiresAt = input.expiresAt === null || input.expiresAt === undefined ? null : Number(input.expiresAt);
    if (!label || !validIntegerUnits(input.unitAmount) || !Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > MAX_BATCH_QUANTITY) {
      throw new Error("invalid_recharge_batch");
    }
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now)) throw new Error("invalid_recharge_batch");
    const batchId = crypto.randomUUID();
    const codes = Array.from({ length: Number(quantity) }, () => randomToken("hub_rc_"));
    const create = this.db.transaction(() => {
      this.db.query(`INSERT INTO hub_recharge_batches
        (id, label, unit_amount, quantity, status, expires_at, created_by, created_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
        .run(batchId, label, input.unitAmount as number, quantity as number, expiresAt, admin.id, now);
      const insert = this.db.query(`INSERT INTO hub_recharge_codes
        (id, batch_id, code_digest, display_suffix, status) VALUES (?, ?, ?, ?, 'available')`);
      for (const code of codes) {
        insert.run(crypto.randomUUID(), batchId, hmacDigest(this.digestSecret, "recharge-code", code), code.slice(-4));
      }
      this.audit(admin.id, "recharge_batch.create", "recharge_batch", batchId, "success", now);
    });
    create();
    return { batchId, codes, unitAmount: input.unitAmount as number, expiresAt };
  }

  importRechargeBatch(
    admin: HubUser,
    input: { label?: unknown; unitAmount?: unknown; codes?: unknown; expiresAt?: unknown },
    now = Date.now(),
  ): { batchId: string; imported: number; unitAmount: number; expiresAt: number | null } {
    if (admin.role !== "admin") throw new Error("admin_required");
    const label = normalizeName(input.label, 120);
    const rawCodes = Array.isArray(input.codes) ? input.codes : [];
    const codes = rawCodes.map(value => typeof value === "string" ? value.trim().normalize("NFKC") : "");
    const expiresAt = input.expiresAt === null || input.expiresAt === undefined ? null : Number(input.expiresAt);
    if (!label || !validIntegerUnits(input.unitAmount) || codes.length < 1 || codes.length > MAX_BATCH_QUANTITY || codes.some(code => !code.startsWith("hub_rc_") || code.length < 16 || code.length > 128)) {
      throw new Error("invalid_recharge_batch");
    }
    if (new Set(codes).size !== codes.length || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now))) {
      throw new Error("invalid_recharge_batch");
    }
    const batchId = crypto.randomUUID();
    const create = this.db.transaction(() => {
      this.db.query(`INSERT INTO hub_recharge_batches
        (id, label, unit_amount, quantity, status, expires_at, created_by, created_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
        .run(batchId, label, input.unitAmount as number, codes.length, expiresAt, admin.id, now);
      const insert = this.db.query(`INSERT INTO hub_recharge_codes
        (id, batch_id, code_digest, display_suffix, status) VALUES (?, ?, ?, ?, 'available')`);
      for (const code of codes) insert.run(crypto.randomUUID(), batchId, hmacDigest(this.digestSecret, "recharge-code", code), code.slice(-4));
      this.audit(admin.id, "recharge_batch.import", "recharge_batch", batchId, "success", now);
    });
    try { create(); } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new Error("recharge_code_conflict");
      throw error;
    }
    return { batchId, imported: codes.length, unitAmount: input.unitAmount as number, expiresAt };
  }

  listRechargeBatches(admin: HubUser): Array<Record<string, unknown>> {
    if (admin.role !== "admin") throw new Error("admin_required");
    return this.db.query(`SELECT b.id, b.label, b.unit_amount AS unitAmount, b.quantity, b.status,
      b.expires_at AS expiresAt, b.created_at AS createdAt,
      sum(CASE WHEN c.status = 'available' THEN 1 ELSE 0 END) AS available,
      sum(CASE WHEN c.status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed
      FROM hub_recharge_batches b JOIN hub_recharge_codes c ON c.batch_id = b.id
      GROUP BY b.id ORDER BY b.created_at DESC LIMIT 200`).all() as Array<Record<string, unknown>>;
  }

  listRechargeCodes(admin: HubUser, batchId: string, now = Date.now()): RechargeCodeInventory[] {
    if (admin.role !== "admin") throw new Error("admin_required");
    return (this.db.query(`SELECT c.id, c.batch_id, b.label AS batch_label, c.display_suffix,
      CASE WHEN c.status = 'available' AND b.expires_at IS NOT NULL AND b.expires_at <= ?
        THEN 'expired' ELSE c.status END AS display_status,
      u.support_reference AS redeemed_by, c.redeemed_at
      FROM hub_recharge_codes c
      JOIN hub_recharge_batches b ON b.id = c.batch_id
      LEFT JOIN hub_users u ON u.id = c.redeemed_by
      WHERE c.batch_id = ? ORDER BY c.id LIMIT 1000`).all(now, batchId) as Record<string, unknown>[]).map(row => ({
        id: String(row.id),
        batchId: String(row.batch_id),
        batchLabel: String(row.batch_label),
        suffix: String(row.display_suffix),
        status: row.display_status as RechargeCodeInventory["status"],
        redeemedBy: row.redeemed_by === null ? null : String(row.redeemed_by),
        redeemedAt: nullableNumber(row.redeemed_at),
      }));
  }

  revokeRechargeBatch(admin: HubUser, batchId: string, now = Date.now()): boolean {
    if (admin.role !== "admin") throw new Error("admin_required");
    const revoke = this.db.transaction(() => {
      const result = this.db.query("UPDATE hub_recharge_batches SET status = 'revoked' WHERE id = ? AND status = 'active'").run(batchId);
      if (result.changes !== 1) return false;
      this.db.query("UPDATE hub_recharge_codes SET status = 'revoked' WHERE batch_id = ? AND status = 'available'").run(batchId);
      this.audit(admin.id, "recharge_batch.revoke", "recharge_batch", batchId, "success", now);
      return true;
    });
    return revoke();
  }

  listUsers(admin: HubUser): Array<Record<string, unknown>> {
    if (admin.role !== "admin") throw new Error("admin_required");
    return this.db.query(`SELECT u.id, u.support_reference AS supportReference, u.role, u.status, u.created_at AS createdAt,
      a.balance_units AS balanceUnits, a.reserved_units AS reservedUnits
      FROM hub_users u JOIN hub_accounts a ON a.user_id = u.id
      ORDER BY u.created_at DESC LIMIT 500`).all() as Array<Record<string, unknown>>;
  }

  adminUserDetails(admin: HubUser, userId: string, ledgerLimit = 100): AdminUserDetails {
    if (admin.role !== "admin") throw new Error("admin_required");
    const row = this.db.query(`SELECT u.id, u.support_reference AS supportReference, u.role, u.status,
      u.created_at AS createdAt, a.balance_units AS balanceUnits, a.reserved_units AS reservedUnits
      FROM hub_users u JOIN hub_accounts a ON a.user_id = u.id WHERE u.id = ?`).get(userId) as AdminUserDetails["user"] | null;
    if (!row) throw new Error("user_not_found");
    return { user: row, keys: this.listApiKeys(userId), ledger: this.listLedger(userId, ledgerLimit) };
  }

  revokeApiKeyAsAdmin(admin: HubUser, keyId: string, now = Date.now()): boolean {
    if (admin.role !== "admin") throw new Error("admin_required");
    const revoke = this.db.transaction(() => {
      const result = this.db.query(`UPDATE hub_api_keys SET status = 'revoked', revoked_at = ?
        WHERE id = ? AND status = 'active'`).run(now, keyId);
      if (result.changes !== 1) return false;
      this.audit(admin.id, "api_key.revoke", "api_key", keyId, "success", now);
      return true;
    });
    return revoke();
  }

  adminMetrics(admin: HubUser): AdminMetrics {
    if (admin.role !== "admin") throw new Error("admin_required");
    const row = this.db.query(`SELECT
      (SELECT count(*) FROM hub_users) AS users_total,
      (SELECT count(*) FROM hub_users WHERE status = 'active') AS active_users,
      (SELECT COALESCE(sum(balance_units), 0) FROM hub_accounts) AS outstanding_units,
      (SELECT COALESCE(sum(CASE
        WHEN kind IN ('recharge', 'refund') AND amount_units > 0 THEN amount_units
        WHEN kind = 'adjustment' AND amount_units > 0 THEN amount_units
        ELSE 0 END), 0) FROM hub_ledger_entries) AS issued_units,
      (SELECT COALESCE(sum(CASE WHEN kind = 'settlement' THEN -amount_units ELSE 0 END), 0)
        FROM hub_ledger_entries) AS settled_units,
      (SELECT count(*) FROM hub_recharge_batches WHERE status = 'active') AS active_batches`).get() as Record<string, number>;
    return {
      usersTotal: Number(row.users_total),
      activeUsers: Number(row.active_users),
      outstandingUnits: Number(row.outstanding_units),
      issuedUnits: Number(row.issued_units),
      settledUnits: Number(row.settled_units),
      activeBatches: Number(row.active_batches),
    };
  }

  setUserStatus(admin: HubUser, userId: string, status: unknown, now = Date.now()): boolean {
    if (admin.role !== "admin") throw new Error("admin_required");
    if (status !== "active" && status !== "disabled") throw new Error("invalid_user_status");
    if (admin.id === userId && status === "disabled") throw new Error("cannot_disable_self");
    const update = this.db.transaction(() => {
      const result = this.db.query("UPDATE hub_users SET status = ?, updated_at = ? WHERE id = ?").run(status, now, userId);
      if (result.changes !== 1) return false;
      if (status === "disabled") this.db.query("UPDATE hub_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, userId);
      this.audit(admin.id, "user.status", "user", userId, "success", now);
      return true;
    });
    return update();
  }

  adjustBalance(admin: HubUser, input: { userId?: unknown; amountUnits?: unknown; reason?: unknown; idempotencyKey?: unknown }, now = Date.now()): { balanceUnits: number; replayed: boolean } {
    if (admin.role !== "admin") throw new Error("admin_required");
    const userId = typeof input.userId === "string" ? input.userId : "";
    const amount = input.amountUnits;
    const reason = normalizeName(input.reason, 160);
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
    if (!userId || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_CREDIT_UNITS || !reason || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      throw new Error("invalid_adjustment");
    }
    const adjust = this.db.transaction(() => {
      const existing = this.db.query(`SELECT amount_units, reason, reference_type, reference_id
        FROM hub_ledger_entries WHERE user_id = ? AND idempotency_key = ?`)
        .get(userId, idempotencyKey) as { amount_units: number; reason: string; reference_type: string; reference_id: string | null } | null;
      if (existing) {
        if (existing.reference_type !== "admin" || existing.reference_id !== admin.id || existing.amount_units !== amount || existing.reason !== reason) {
          throw new Error("idempotency_conflict");
        }
        return { balanceUnits: this.balance(userId).balanceUnits, replayed: true };
      }
      const account = this.balance(userId);
      const nextBalance = account.balanceUnits + amount;
      if (!Number.isSafeInteger(nextBalance) || nextBalance > MAX_CREDIT_UNITS) throw new Error("credit_limit_exceeded");
      if (nextBalance < account.reservedUnits) throw new Error("insufficient_adjustable_balance");
      this.db.query("UPDATE hub_accounts SET balance_units = balance_units + ?, updated_at = ? WHERE user_id = ?")
        .run(amount, now, userId);
      this.db.query(`INSERT INTO hub_ledger_entries
        (id, user_id, kind, amount_units, idempotency_key, reference_type, reference_id, reason, created_at)
        VALUES (?, ?, 'adjustment', ?, ?, 'admin', ?, ?, ?)`)
        .run(crypto.randomUUID(), userId, amount, idempotencyKey, admin.id, reason, now);
      this.audit(admin.id, "ledger.adjust", "user", userId, "success", now);
      return { balanceUnits: this.balance(userId).balanceUnits, replayed: false };
    });
    return adjust();
  }

  listAudit(admin: HubUser): Array<Record<string, unknown>> {
    if (admin.role !== "admin") throw new Error("admin_required");
    return this.db.query(`SELECT id, actor_user_id AS actorUserId, action, target_type AS targetType,
      target_id AS targetId, outcome, created_at AS createdAt
      FROM hub_audit_events ORDER BY created_at DESC LIMIT 500`).all() as Array<Record<string, unknown>>;
  }

  recordAdminAudit(
    admin: HubUser,
    action: string,
    targetType: string,
    targetId: string | null,
    outcome: "success" | "denied" | "failed",
    now = Date.now(),
  ): void {
    if (admin.role !== "admin") throw new Error("admin_required");
    if (!/^[a-z0-9._:-]{1,80}$/.test(action) || !/^[a-z0-9._:-]{1,80}$/.test(targetType)) throw new Error("invalid_audit_event");
    this.audit(admin.id, action, targetType, targetId, outcome, now);
  }

  redeem(userId: string, code: unknown, idempotencyKey: string | null, now = Date.now()): { entry: LedgerEntry; balanceUnits: number; replayed: boolean } {
    if (typeof code !== "string" || !code.startsWith("hub_rc_") || code.length > 128) throw new Error("invalid_recharge_code");
    if (!idempotencyKey || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) throw new Error("invalid_idempotency_key");
    const digest = hmacDigest(this.digestSecret, "recharge-code", code);
    const redeem = this.db.transaction(() => {
      const existing = this.db.query("SELECT * FROM hub_ledger_entries WHERE user_id = ? AND idempotency_key = ?")
        .get(userId, idempotencyKey) as Record<string, unknown> | null;
      if (existing) {
        const entry = mapLedger(existing);
        const matching = this.db.query("SELECT id FROM hub_recharge_codes WHERE code_digest = ?").get(digest) as { id: string } | null;
        if (!matching || entry.referenceId !== matching.id) throw new Error("idempotency_conflict");
        return { entry, balanceUnits: this.balance(userId).balanceUnits, replayed: true };
      }
      const row = this.db.query(`SELECT c.id, c.status, c.batch_id, b.unit_amount, b.status AS batch_status, b.expires_at
        FROM hub_recharge_codes c JOIN hub_recharge_batches b ON b.id = c.batch_id WHERE c.code_digest = ?`)
        .get(digest) as RechargeRow | null;
      if (!row || row.status !== "available" || row.batch_status !== "active" || (row.expires_at !== null && row.expires_at <= now)) {
        throw new Error("recharge_unavailable");
      }
      const claimed = this.db.query(`UPDATE hub_recharge_codes SET status = 'redeemed', redeemed_by = ?, redeemed_at = ?
        WHERE id = ? AND status = 'available'`).run(userId, now, row.id);
      if (claimed.changes !== 1) throw new Error("recharge_unavailable");
      const entryId = crypto.randomUUID();
      this.db.query(`INSERT INTO hub_ledger_entries
        (id, user_id, kind, amount_units, idempotency_key, reference_type, reference_id, reason, created_at)
        VALUES (?, ?, 'recharge', ?, ?, 'recharge_code', ?, 'recharge_code_redeemed', ?)`)
        .run(entryId, userId, row.unit_amount, idempotencyKey, row.id, now);
      const credited = this.db.query(`UPDATE hub_accounts SET balance_units = balance_units + ?, updated_at = ?
        WHERE user_id = ? AND balance_units <= ?`).run(row.unit_amount, now, userId, MAX_CREDIT_UNITS - row.unit_amount);
      if (credited.changes !== 1) throw new Error("credit_limit_exceeded");
      const entry = this.db.query("SELECT * FROM hub_ledger_entries WHERE id = ?").get(entryId) as Record<string, unknown>;
      return { entry: mapLedger(entry), balanceUnits: this.balance(userId).balanceUnits, replayed: false };
    });
    return redeem();
  }

  private audit(actorUserId: string, action: string, targetType: string, targetId: string | null, outcome: "success" | "denied" | "failed", now: number): void {
    this.db.query(`INSERT INTO hub_audit_events(id, actor_user_id, action, target_type, target_id, outcome, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), actorUserId, action, targetType, targetId, outcome, now);
  }
}
