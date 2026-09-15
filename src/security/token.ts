import { randomBytes } from "node:crypto";
import { sha256 } from "../skills/hasher";
import { DEFAULT_SCOPE_TOKEN_TTL_SECONDS } from "./constants";
import type { ScopeToken } from "./types";
import type { SecurityDatabase } from "./db";

export function hashScopeToken(token: string): string {
  return sha256(token);
}

export function issueScopeToken(
  db: SecurityDatabase,
  input: {
    campaign_id: string;
    capability_id: string;
    actor_id: string;
    asset_id?: string;
    ttlSeconds?: number;
    now?: Date;
  },
): ScopeToken {
  const now = input.now ?? new Date();
  const token = randomBytes(24).toString("base64url");
  const row: ScopeToken = {
    id: `stk_${randomBytes(8).toString("hex")}`,
    token,
    token_hash: hashScopeToken(token),
    campaign_id: input.campaign_id,
    asset_id: input.asset_id,
    capability_id: input.capability_id,
    actor_id: input.actor_id,
    expires_at: new Date(now.getTime() + (input.ttlSeconds ?? DEFAULT_SCOPE_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    revoked: false,
    created_at: now.toISOString(),
  };
  const { token: _plain, ...stored } = row;
  db.insertScopeToken(stored);
  return row;
}

export function verifyScopeToken(
  db: SecurityDatabase,
  token: string,
  expected: { campaign_id: string; capability_id: string },
  now: Date = new Date(),
): { ok: true; record: Omit<ScopeToken, "token"> } | { ok: false; reason_code: string } {
  const record = db.getScopeTokenByHash(hashScopeToken(token));
  if (!record) return { ok: false, reason_code: "SCOPE_TOKEN_UNKNOWN" };
  if (record.revoked) return { ok: false, reason_code: "SCOPE_TOKEN_REVOKED" };
  if (Date.parse(record.expires_at) <= now.getTime()) return { ok: false, reason_code: "SCOPE_TOKEN_EXPIRED" };
  if (record.campaign_id !== expected.campaign_id) return { ok: false, reason_code: "SCOPE_TOKEN_CAMPAIGN_MISMATCH" };
  if (record.capability_id !== expected.capability_id) return { ok: false, reason_code: "SCOPE_TOKEN_CAPABILITY_MISMATCH" };
  return { ok: true, record };
}
