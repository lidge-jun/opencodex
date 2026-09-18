import { createHmac, randomBytes } from "node:crypto";
import type { CodexAuthContext } from "./auth-context";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { nativeUserIdClaims } from "./reserve-availability";

export type ContextSessionOwner = Readonly<
  | { kind: "stored"; accountId: string; physicalIdentity: string; userIdentity?: string;
      callerCredentialIdentity: string; ambiguous: boolean }
  | { kind: "caller"; physicalIdentity?: string; userIdentity?: string;
      callerCredentialIdentity: string; ambiguous: boolean }
>;

const TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 2048;
const MAX_BYTES = 1024 * 1024;
const salt = randomBytes(32);
type Entry = { owner: ContextSessionOwner; destination: string; touchedAt: number; bytes: number };
const owners = new Map<string, Entry>();
let totalBytes = 0;

function digest(domain: string, value: string): string {
  return createHmac("sha256", salt).update(domain).update("\0").update(value).digest("hex");
}

function validId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,512}$/.test(value);
}

function destinationIdentity(destination: string): string | undefined {
  if (!destination || destination.length > 4096) return undefined;
  try {
    const url = new URL(destination);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return undefined;
    return digest("destination", url.href.replace(/\/+$/, ""));
  } catch { return undefined; }
}

function physicalIdentity(headers: Headers): string | undefined {
  const account = headers.get("chatgpt-account-id");
  return validId(account) ? digest("physical-account", account) : undefined;
}

/**
 * The stable person behind an accepted credential, when the token says so.
 *
 * `chatgpt-account-id` names a WORKSPACE, and two people in one workspace send the same value.
 * Ownership therefore also binds the user claim carried by the credential that upstream actually
 * accepted. The claim is read without signature verification, which is why upstream acceptance
 * remains the evidence and a conflicting pair of claims fails closed instead of picking one.
 */
function stableUserIdentity(headers: Headers): { identity?: string; conflict: boolean } {
  const authorization = headers.get("authorization");
  if (!authorization || authorization.length > 32_768 || !/^Bearer [^\s]+$/i.test(authorization)) {
    return { conflict: false };
  }
  const claims = nativeUserIdClaims(authorization.slice(7));
  if (claims.conflict) return { conflict: true };
  return { ...(claims.userId ? { identity: digest("native-user", claims.userId) } : {}), conflict: false };
}

function callerCredentialIdentity(headers: Headers): string | undefined {
  const authorization = headers.get("authorization");
  if (!authorization || authorization.length > 32_768 || !/^Bearer [^\s]+$/i.test(authorization)) return undefined;
  const account = headers.get("chatgpt-account-id");
  if (account !== null && !validId(account)) return undefined;
  return digest("caller-credential", JSON.stringify([authorization.slice(7), account]));
}

/**
 * Whether two accepted observations describe the same owner.
 *
 * A proven stable user may present a refreshed credential. Without that proof on BOTH sides the
 * only continuity evidence left is the credential itself, because a workspace id is shared by
 * everyone in the organization and would otherwise let one member rebind another session.
 */
function sameOwnerIdentity(prior: ContextSessionOwner, next: ContextSessionOwner): boolean {
  if (prior.kind !== next.kind) return false;
  if (prior.physicalIdentity !== next.physicalIdentity) return false;
  return prior.userIdentity !== undefined && next.userIdentity !== undefined
    ? prior.userIdentity === next.userIdentity
    : prior.callerCredentialIdentity === next.callerCredentialIdentity;
}

function remove(key: string): void {
  const prior = owners.get(key);
  if (!prior) return;
  owners.delete(key);
  totalBytes -= prior.bytes;
}

function sweep(now: number): void {
  for (const [key, entry] of owners) {
    if (now < entry.touchedAt || now - entry.touchedAt >= TTL_MS) remove(key);
  }
}

/** Called only after a model attempt was accepted by its actual destination. */
export function recordContextSessionOwner(
  principalId: string | undefined, inboundHeaders: Headers, destination: string, auth: CodexAuthContext,
  outboundHeaders: Headers, substituteMainCredential: boolean, now = Date.now(),
): void {
  // Ownership is partitioned per admission principal. Without one there is no caller identity to
  // own anything, so nothing is recorded rather than creating an entry any local process matches.
  if (!principalId || !Number.isFinite(now)) return;
  // A malformed explicit parent must not fall back to an unrelated local session.
  const root = inboundHeaders.get("x-codex-parent-thread-id") ?? inboundHeaders.get("session-id");
  if (!validId(root)) return;
  const destinationKey = destinationIdentity(destination);
  const credential = callerCredentialIdentity(outboundHeaders);
  if (!destinationKey || !credential) return;
  const physical = physicalIdentity(outboundHeaders);
  const user = stableUserIdentity(outboundHeaders);
  if (user.conflict) {
    // An accepted credential naming two different users is evidence of nobody. Whatever entry
    // this session already had stops being trustworthy at that moment.
    markContextSessionAmbiguous(principalId, root, now);
    return;
  }
  let owner: ContextSessionOwner;
  if (auth.kind !== "main" || substituteMainCredential) {
    if (!physical) return;
    if (auth.kind !== "main" && (!validId(auth.accountId)
      || auth.chatgptAccountId !== outboundHeaders.get("chatgpt-account-id"))) return;
    // Direct proxy-bearer substitution has no token snapshot in its `main` context;
    // its accepted outbound identity is still evidence for the stored main slot.
    owner = { kind: "stored", accountId: auth.kind === "main" ? MAIN_CODEX_ACCOUNT_ID : auth.accountId,
      physicalIdentity: physical, ...(user.identity ? { userIdentity: user.identity } : {}),
      callerCredentialIdentity: credential, ambiguous: false };
  } else {
    owner = { kind: "caller", ...(physical ? { physicalIdentity: physical } : {}),
      ...(user.identity ? { userIdentity: user.identity } : {}),
      callerCredentialIdentity: credential, ambiguous: false };
  }
  sweep(now);
  const key = digest("root-session", `${principalId}\u0000${root}`);
  const prior = owners.get(key);
  if (prior) {
    // Same workspace, different person is exactly the case a workspace id cannot see, and a
    // credential proving nobody must not inherit an entry just by sharing that id.
    if (prior.owner.ambiguous || prior.destination !== destinationKey
      || !sameOwnerIdentity(prior.owner, owner)) {
      owner = { ...prior.owner, ambiguous: true };
    }
  }
  const ownerDestination = prior?.destination ?? destinationKey;
  const bytes = Buffer.byteLength(JSON.stringify([key, ownerDestination, owner]), "utf8");
  remove(key);
  owners.set(key, { owner: Object.freeze(owner), destination: ownerDestination, touchedAt: now, bytes });
  totalBytes += bytes;
  while (owners.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldest = owners.keys().next().value;
    if (oldest === undefined) break;
    remove(oldest);
  }
}

/** Missing/expired/evicted ownership is unknown; never infer it from active routing. */
export function getContextSessionOwner(
  principalId: string | undefined, sessionId: string, destination: string, now = Date.now(),
): ContextSessionOwner | undefined {
  if (!principalId || !validId(sessionId) || !Number.isFinite(now)) return undefined;
  const destinationKey = destinationIdentity(destination);
  if (!destinationKey) return undefined;
  sweep(now);
  const key = digest("root-session", `${principalId}\u0000${sessionId}`);
  const entry = owners.get(key);
  if (!entry || entry.destination !== destinationKey) return undefined;
  owners.delete(key);
  entry.touchedAt = now;
  owners.set(key, entry);
  return entry.owner;
}

/** Compare only already-materialized headers; this function never reads credentials. */
export function contextSessionOwnerMatches(owner: ContextSessionOwner, headers: Headers): boolean {
  if (owner.ambiguous) return false;
  const user = stableUserIdentity(headers);
  if (user.conflict) return false;
  if (owner.physicalIdentity !== physicalIdentity(headers)) return false;
  if (owner.userIdentity !== user.identity) return false;
  // A stored credential was minted by this proxy for the account it selected, so a proven user
  // may present a refreshed token. A caller-supplied bearer is not ours: it becomes this
  // session credential only when a model turn was accepted with it, so history has to present
  // exactly that credential rather than any token carrying the same claims.
  return owner.kind === "stored" && owner.userIdentity !== undefined
    ? true
    : owner.callerCredentialIdentity === callerCredentialIdentity(headers);
}

/** Poison an entry whose accepted evidence stopped being coherent. */
function markContextSessionAmbiguous(principalId: string, root: string | null, now: number): void {
  if (!validId(root)) return;
  const key = digest("root-session", principalId + "\u0000" + root);
  const prior = owners.get(key);
  if (!prior || prior.owner.ambiguous) return;
  owners.set(key, { ...prior, owner: Object.freeze({ ...prior.owner, ambiguous: true }), touchedAt: now });
}

export function clearContextSessionOwnersForTests(): void {
  owners.clear(); totalBytes = 0;
}
