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
import { closeSync, constants as fsConstants, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
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
/** How long a loser waits for a concurrent winner's file to become readable before giving up. */
const PUBLISHED_READ_ATTEMPTS = 50;
const PUBLISHED_READ_INTERVAL_MS = 10;

/** Test seams for the publication windows; production never sets them. */
export interface QuotaPoolIdentityTestHooks {
  /** After the first read found no identity, before the existence check. */
  afterAbsentRead?: (path: string) => void;
  /** After a file was exclusively created, before its bytes are written. */
  afterCreate?: (path: string) => void;
  /** Replace `linkSync` (to force the in-place fallback). */
  link?: (existing: string, target: string) => void;
  /** Override the bounded wait for a concurrent winner. */
  publishedReadAttempts?: number;
}
let hooks: QuotaPoolIdentityTestHooks = {};

export function setQuotaPoolIdentityHooksForTests(next: QuotaPoolIdentityTestHooks = {}): void {
  hooks = next;
}

/** Write a whole new owner-only file, flushed to disk; fails if anything (a symlink included) already exists. */
function createExclusive(path: string, content: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  try {
    hooks.afterCreate?.(path);
    writeSync(fd, content);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * Make the new directory entry durable too: fsyncing the file alone can lose the entry on power
 * loss, and a lost entry would mint a new identity and rotate every accountRef on the next start.
 * Best effort; Windows cannot open a directory for fsync.
 */
function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(dirname(path), fsConstants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* the file itself is flushed; a directory fsync is an extra guarantee */ }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Something already sits at the path: adopt it once it reads as a valid identity.
 *
 * A concurrent winner's file is complete the moment it appears when it was hard-linked, but the
 * in-place fallback creates the file before writing it, so a loser can briefly see it empty. The
 * wait is bounded; an invalid result is never returned or memoized. A symlink, or a file that stays
 * invalid past the bound, is refused and left alone.
 */
function adoptPublishedIdentity(configDir: string, path: string): QuotaPoolIdentity {
  const attempts = hooks.publishedReadAttempts ?? PUBLISHED_READ_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      stat = null;
    }
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) break;
    const identity = readQuotaPoolIdentity(configDir);
    if (identity) return identity;
    if (attempt + 1 < attempts) pause(PUBLISHED_READ_INTERVAL_MS);
  }
  throw new Error("quota-pool identity file is not a valid regular file; remove it to rotate the identity");
}

/**
 * Create the identity once. Called off the request path (server startup); idempotent.
 *
 * Publication is exclusive and never follows a link: the secret is written and flushed to a
 * private temp file, then hard-linked into place, which fails if anything already sits at the path.
 * Where hard links are unavailable it is created in place exclusively. Two servers starting on one
 * fresh home therefore cannot each keep a different identity: a loser, including one that finds
 * the winner's file appear between its own checks, re-reads within a bound and adopts the winner's.
 * A symlink or a persistently malformed file at the path is refused and left alone (the read keeps
 * reporting the identity as unavailable until an operator removes it); it is never overwritten.
 */
export function ensureQuotaPoolIdentity(configDir = getConfigDir()): QuotaPoolIdentity {
  const existing = readQuotaPoolIdentity(configDir);
  if (existing) return existing;
  const path = quotaPoolIdentityPath(configDir);
  hooks.afterAbsentRead?.(path);
  let present = true;
  try { lstatSync(path); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; present = false; }
  if (present) return adoptPublishedIdentity(configDir, path);
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
      (hooks.link ?? linkSync)(temp, path);
      published = true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") return adoptPublishedIdentity(configDir, path);
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
      return adoptPublishedIdentity(configDir, path);
    }
  }
  syncParentDirectory(path);
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
