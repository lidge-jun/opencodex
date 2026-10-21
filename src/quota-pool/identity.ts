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
import { closeSync, constants as fsConstants, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
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

const NOFOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;

/** Write a whole new owner-only file; fails if anything (a symlink included) already exists. */
function createExclusive(path: string, content: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  try { writeSync(fd, content); } finally { closeSync(fd); }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * Create the identity once. Called off the request path (server startup); idempotent.
 *
 * Publication is exclusive and never follows a link: the secret is written to a private temp
 * file and hard-linked into place, which fails if anything already sits at the path. Two servers
 * starting on one fresh home therefore cannot each keep a different identity: the loser re-reads
 * and adopts the winner's. A symlink or a malformed file at the path is refused and left alone
 * (the read keeps reporting the identity as unavailable until an operator removes it); it is never
 * overwritten.
 */
export function ensureQuotaPoolIdentity(configDir = getConfigDir()): QuotaPoolIdentity {
  const existing = readQuotaPoolIdentity(configDir);
  if (existing) return existing;
  const path = quotaPoolIdentityPath(configDir);
  let present = true;
  try { lstatSync(path); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; present = false; }
  if (present) throw new Error("quota-pool identity file is not a valid regular file; remove it to rotate the identity");
  const identity: QuotaPoolIdentity = {
    homeId: `home_${randomUUID().replaceAll("-", "")}`,
    secret: randomBytes(32).toString("hex"),
  };
  const content = `${JSON.stringify({ version: 1, ...identity })}\n`;
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let published = false;
  try {
    createExclusive(temp, content);
    try {
      linkSync(temp, path);
      published = true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") {
        const winner = readQuotaPoolIdentity(configDir);
        if (winner) return winner;
        throw new Error("quota-pool identity was created concurrently but is not readable yet");
      }
      // No hard links on this filesystem: exclusive create in place is still never a replacement.
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") throw error;
    }
  } finally {
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
  if (!published) {
    try {
      createExclusive(path, content);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const winner = readQuotaPoolIdentity(configDir);
      if (winner) return winner;
      throw error;
    }
  }
  memo = { path, identity };
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
