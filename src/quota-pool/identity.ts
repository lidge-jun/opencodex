/**
 * The install identity behind `ocx.quota-pool/1`: the Home's `homeId` and the secret that keys
 * every `accountRef`.
 *
 * Both live in `<OPENCODEX_HOME>/quota-pool-identity.json` (owner-only). The server creates the
 * file once, in the background after it starts listening (`ensureQuotaPoolIdentity`); the
 * `/api/quota-pool` read only reads it, so the read path never writes. A read that finds no
 * valid file reports the identity as unavailable instead of minting one.
 *
 * `accountRef` is `acct_` + base64url(HMAC-SHA256(secret, "ocx.quota-pool/1" NUL provider NUL
 * accountId)) truncated to 128 bits. It is stable across restarts because the secret is
 * persisted, distinct per provider, and not reversible: without the per-install secret a
 * recipient cannot confirm a guessed email or account id against it, and it never contains
 * either. Deleting the file rotates `homeId` and every `accountRef` together.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";

export const QUOTA_POOL_IDENTITY_FILE = "quota-pool-identity.json";

export interface QuotaPoolIdentity {
  homeId: string;
  secret: string;
}

const HOME_ID = /^home_[0-9a-f]{32}$/;
const SECRET = /^[0-9a-f]{64}$/;
let memo: { path: string; identity: QuotaPoolIdentity } | null = null;

export function quotaPoolIdentityPath(configDir = getConfigDir()): string {
  return join(configDir, QUOTA_POOL_IDENTITY_FILE);
}

function parseIdentity(text: string): QuotaPoolIdentity | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw?.version !== 1 || typeof raw.homeId !== "string" || typeof raw.secret !== "string") return null;
    if (!HOME_ID.test(raw.homeId) || !SECRET.test(raw.secret)) return null;
    return { homeId: raw.homeId, secret: raw.secret };
  } catch {
    return null;
  }
}

/** Read-only: the persisted identity, or null when it is missing or malformed. Never writes. */
export function readQuotaPoolIdentity(configDir = getConfigDir()): QuotaPoolIdentity | null {
  const path = quotaPoolIdentityPath(configDir);
  if (memo?.path === path) return memo.identity;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return null;
  } catch {
    return null;
  }
  let identity: QuotaPoolIdentity | null;
  try { identity = parseIdentity(readFileSync(path, "utf8")); } catch { return null; }
  if (identity) memo = { path, identity };
  return identity;
}

/** Create the identity once. Called off the request path (server startup); idempotent. */
export function ensureQuotaPoolIdentity(configDir = getConfigDir()): QuotaPoolIdentity {
  const existing = readQuotaPoolIdentity(configDir);
  if (existing) return existing;
  const identity: QuotaPoolIdentity = {
    homeId: `home_${randomUUID().replaceAll("-", "")}`,
    secret: randomBytes(32).toString("hex"),
  };
  atomicWriteFile(quotaPoolIdentityPath(configDir), `${JSON.stringify({ version: 1, ...identity })}\n`);
  memo = { path: quotaPoolIdentityPath(configDir), identity };
  return identity;
}

/** The opaque account reference: keyed by the install secret, never the raw id or an email. */
export function quotaPoolAccountRef(identity: QuotaPoolIdentity, provider: string, accountId: string): string {
  const digest = createHmac("sha256", Buffer.from(identity.secret, "hex"))
    .update(`ocx.quota-pool/1\0${provider}\0${accountId}`)
    .digest();
  return `acct_${digest.subarray(0, 16).toString("base64url")}`;
}

export function resetQuotaPoolIdentityMemoForTests(): void {
  memo = null;
}
