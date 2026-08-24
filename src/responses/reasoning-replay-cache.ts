/**
 * In-process fallback store pairing raw reasoning text with the tool call it
 * preceded (issue #950).
 *
 * DeepSeek thinking mode requires the assistant's original `reasoning_content`
 * to be replayed on every continuation of a tool-call turn. The bridge records
 * the raw reasoning here when it closes a reasoning block and a tool call
 * follows; the openai-chat adapter re-attaches it when a `tool_calls`
 * assistant message is about to serialize without thinking parts (compacted
 * history, lost assistant turn, orphan-repaired tool results).
 *
 * Entries require a conversation identity in addition to the call id:
 * provider-generated ids like `call_1` are not globally unique, so an
 * unscoped process-wide key would let one conversation's reasoning bleed into
 * another when ids collide (CodeRabbit P1 on #971).
 *
 * Privacy: entries hold reasoning text in memory only — never logged,
 * serialized, or exported. Bounded by entry count, total bytes, and TTL, so a
 * long-lived proxy cannot grow without limit.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type {
  OcxProviderConfig,
  OcxReasoningReplayIdentity,
  OcxReasoningReplayScopeRef,
} from "../types";

const MAX_ENTRIES = 64;
const MAX_TOTAL_BYTES = 256 * 1024;
const TTL_MS = 60 * 60 * 1000;
const OPAQUE_BLOB_REJECTION_TTL_MS = 5 * 60 * 1000;
const replayIdentityKey = randomBytes(32);
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "api-key",
  "chatgpt-account-id",
  "cookie",
  "openai-organization",
  "openai-project",
  "proxy-authorization",
  "x-api-key",
  "x-api-token",
  "x-auth-token",
  "x-goog-api-key",
  "x-openai-organization",
  "x-openai-project",
]);

interface CacheEntry {
  text: string;
  bytes: number;
  at: number;
}

interface ServingIdentityEntry {
  identity: string;
  bytes: number;
  at: number;
}

interface OpaqueBlobRejectionEntry {
  bytes: number;
  at: number;
}

const entries = new Map<string, CacheEntry>();
const servingIdentities = new Map<string, ServingIdentityEntry>();
const opaqueBlobRejections = new Map<string, OpaqueBlobRejectionEntry>();
let totalBytes = 0;
let servingIdentityTotalBytes = 0;
let opaqueBlobRejectionTotalBytes = 0;
let clockForTests: (() => number) | null = null;

const now = (): number => clockForTests?.() ?? Date.now();

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type ReasoningReplayIdentityTuple = readonly [string, string, string, string, string];

function tupleForIdentity(
  identity: Readonly<OcxReasoningReplayIdentity> | undefined,
): ReasoningReplayIdentityTuple | undefined {
  if (
    !nonEmpty(identity?.providerName)
    || !nonEmpty(identity?.providerDestinationIdentity)
    || !nonEmpty(identity?.adapterName)
    || !nonEmpty(identity?.modelId)
    || !nonEmpty(identity?.credentialIdentity)
  ) return undefined;
  return [
    identity.providerName,
    identity.providerDestinationIdentity,
    identity.adapterName,
    identity.modelId,
    identity.credentialIdentity,
  ];
}

function tupleForServingIdentity(
  identity: Readonly<OcxReasoningReplayIdentity> | undefined,
): ReasoningReplayIdentityTuple | undefined {
  if (
    !nonEmpty(identity?.providerName)
    || !nonEmpty(identity?.providerDestinationDurableIdentity)
    || !nonEmpty(identity?.adapterName)
    || !nonEmpty(identity?.modelId)
    || !nonEmpty(identity?.credentialDurableIdentity)
  ) return undefined;
  return [
    identity.providerName,
    identity.providerDestinationDurableIdentity,
    identity.adapterName,
    identity.modelId,
    identity.credentialDurableIdentity,
  ];
}

function keyFor(callId: string, scope: OcxReasoningReplayScopeRef | undefined): string | undefined {
  const identity = tupleForIdentity(scope?.current);
  if (!nonEmpty(callId) || !nonEmpty(scope?.clientThreadId) || !identity) return undefined;
  return JSON.stringify([
    scope.clientThreadId,
    ...identity,
    callId,
  ]);
}

function deleteServingIdentity(threadId: string): void {
  const entry = servingIdentities.get(threadId);
  if (!entry) return;
  servingIdentities.delete(threadId);
  servingIdentityTotalBytes -= entry.bytes;
}

function sweepExpiredServingIdentities(at: number): void {
  for (const [threadId, entry] of servingIdentities) {
    if (at - entry.at >= TTL_MS) deleteServingIdentity(threadId);
  }
}

function servingIdentityFor(
  scope: OcxReasoningReplayScopeRef | undefined,
): { threadId: string; identity: string } | undefined {
  const threadId = scope?.clientThreadId;
  const identityTuple = tupleForServingIdentity(scope?.current);
  if (!nonEmpty(threadId) || !identityTuple) return undefined;
  return { threadId, identity: JSON.stringify(identityTuple) };
}

function opaqueBlobRejectionKeyFor(
  scope: OcxReasoningReplayScopeRef | undefined,
): string | undefined {
  const current = servingIdentityFor(scope);
  return current ? JSON.stringify([current.threadId, current.identity]) : undefined;
}

function deleteOpaqueBlobRejection(key: string): void {
  const entry = opaqueBlobRejections.get(key);
  if (!entry) return;
  opaqueBlobRejections.delete(key);
  opaqueBlobRejectionTotalBytes -= entry.bytes;
}

function sweepExpiredOpaqueBlobRejections(at: number): void {
  for (const [key, entry] of opaqueBlobRejections) {
    if (at - entry.at >= OPAQUE_BLOB_REJECTION_TTL_MS) deleteOpaqueBlobRejection(key);
  }
}

/**
 * Compare this request's route with the last successfully serving route for its conversation.
 * A live mismatch means replayed opaque reasoning was minted by another backend and must not be
 * forwarded to this one. Comparison deliberately does not refresh or replace the recorded route:
 * a failed candidate request did not serve the conversation.
 *
 * Serving provenance uses restart-stable destination and credential dimensions so token
 * generations and other volatile credential material cannot create false route changes. Missing
 * durable identity, expired, or evicted state is deliberately unknown rather than a mismatch.
 * This store is process-local, so a backend switch spanning a proxy restart is not detected.
 */
export function reasoningReplayServingIdentityChanged(
  scope: OcxReasoningReplayScopeRef | undefined,
): boolean {
  const current = servingIdentityFor(scope);
  if (!current) return false;
  const at = now();
  sweepExpiredServingIdentities(at);
  const previous = servingIdentities.get(current.threadId);
  return previous !== undefined && previous.identity !== current.identity;
}

/** Record the route only after it has successfully served the conversation. */
export function commitReasoningReplayServingIdentity(
  scope: OcxReasoningReplayScopeRef | undefined,
): void {
  const current = servingIdentityFor(scope);
  if (!current) return;
  const at = now();
  sweepExpiredServingIdentities(at);
  const previous = servingIdentities.get(current.threadId);
  const { threadId, identity } = current;
  const bytes = Buffer.byteLength(JSON.stringify([threadId, identity]), "utf8");
  if (bytes > MAX_TOTAL_BYTES) {
    deleteServingIdentity(threadId);
    return;
  }

  if (previous) deleteServingIdentity(threadId);
  servingIdentities.set(threadId, { identity, bytes, at });
  servingIdentityTotalBytes += bytes;
  while (
    (servingIdentityTotalBytes > MAX_TOTAL_BYTES || servingIdentities.size > MAX_ENTRIES)
    && servingIdentities.size > 1
  ) {
    let oldestThreadId: string | undefined;
    let oldestAt = Infinity;
    for (const [candidateThreadId, entry] of servingIdentities) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestThreadId = candidateThreadId;
      }
    }
    if (oldestThreadId === undefined) break;
    deleteServingIdentity(oldestThreadId);
  }
}

/**
 * Whether this exact conversation and durable serving identity previously rejected opaque replay.
 *
 * The five serving dimensions deliberately match the serving record. Missing durable destination
 * or credential identity is unknown and never falls back to process-local dimensions. The five
 * minute TTL is shorter than the serving record's hour: a stale memo silently degrades reasoning,
 * while expiry costs one visible recovery round trip and can safely re-establish the memo.
 */
export function reasoningReplayOpaqueBlobRejectionMemoized(
  scope: OcxReasoningReplayScopeRef | undefined,
): boolean {
  const key = opaqueBlobRejectionKeyFor(scope);
  if (!key) return false;
  const at = now();
  sweepExpiredOpaqueBlobRejections(at);
  return opaqueBlobRejections.has(key);
}

/** Record only after a blobless retry succeeded for this durable serving identity. */
export function rememberReasoningReplayOpaqueBlobRejection(
  scope: OcxReasoningReplayScopeRef | undefined,
): void {
  const key = opaqueBlobRejectionKeyFor(scope);
  if (!key) return;
  const bytes = Buffer.byteLength(key, "utf8");
  if (bytes > MAX_TOTAL_BYTES) return;
  const at = now();
  sweepExpiredOpaqueBlobRejections(at);
  if (opaqueBlobRejections.has(key)) deleteOpaqueBlobRejection(key);
  opaqueBlobRejections.set(key, { bytes, at });
  opaqueBlobRejectionTotalBytes += bytes;
  while (
    (opaqueBlobRejectionTotalBytes > MAX_TOTAL_BYTES || opaqueBlobRejections.size > MAX_ENTRIES)
    && opaqueBlobRejections.size > 1
  ) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [candidateKey, entry] of opaqueBlobRejections) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey === undefined) break;
    deleteOpaqueBlobRejection(oldestKey);
  }
}

function processLocalIdentity(domain: string, material: string): string {
  return createHmac("sha256", replayIdentityKey)
    .update(domain)
    .update("\0")
    .update(material)
    .digest("hex");
}

function credentialHeaderOverrides(headers: Record<string, string> | undefined): [string, string][] {
  return Object.entries(headers ?? {})
    .filter(([name, value]) => CREDENTIAL_HEADER_NAMES.has(name.trim().toLowerCase()) && nonEmpty(value))
    .map(([name, value]) => [name.trim().toLowerCase(), value] as [string, string])
    .sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    ));
}

/** Produce a non-reversible process-local identity for an exact upstream destination. */
export function reasoningReplayDestinationIdentity(baseUrl: string | undefined): string | undefined {
  if (!nonEmpty(baseUrl)) return undefined;
  const canonical = baseUrl.trim().replace(/\/+$/, "");
  return `destination:${processLocalIdentity("destination", canonical)}`;
}

/**
 * The same destination identity, but stable across restarts.
 *
 * The process-local form above is keyed by `randomBytes(32)` minted at module load, which
 * is correct for an in-memory cache and fatal for a durable one: every key would change on
 * restart and the store would silently stop matching anything. A plain digest of the same
 * canonical URL is equally non-reversible for this purpose — the input is a configured
 * endpoint, not a secret — and needs no persisted salt or new on-disk state.
 */
export function durableReplayDestinationIdentity(baseUrl: string | undefined): string | undefined {
  if (!nonEmpty(baseUrl)) return undefined;
  const canonical = baseUrl.trim().replace(/\/+$/, "");
  return `destination:${createHash("sha256").update("destination\0").update(canonical).digest("hex")}`;
}

/**
 * Restart-stable credential identity for the DURABLE thought-signature store (#1926).
 *
 * Unlike the destination, credential material may be secret (an API key), so a plain
 * unsalted digest would turn the store file into an offline verifier for candidate keys.
 * The identity is therefore an HMAC under a random salt persisted NEXT TO the store: the
 * salt is not a secret escrow (it holds no credential material) but it makes every digest
 * useless outside this installation. Full 256-bit output — no truncation.
 *
 * OAuth accounts use the persisted account-slot id (not the rotating token/generation):
 * relinking a slot to a different upstream account keeps the id, but the upstream then
 * validates signatures against the new credential and rejects stale ones — the same
 * fail-closed backstop the destination identity relies on. Credential-scoped header
 * overrides participate so two provider entries sharing one key but different
 * authorization headers stay distinct, mirroring the process-local identity.
 */
export function durableReplayCredentialIdentity(
  kind: "key" | "oauth" | "codex",
  material: string | undefined,
  headers: Record<string, string> | undefined,
  salt: Buffer | undefined,
): string | undefined {
  if (!nonEmpty(material) || !salt || salt.length < 16) return undefined;
  const overrides = credentialHeaderOverrides(headers);
  return `credential:${createHmac("sha256", salt)
    .update(`credential\0${kind}\0`)
    .update(JSON.stringify([material, overrides]))
    .digest("hex")}`;
}

/** Produce a non-reversible process-local identity for credential material. */
export function reasoningReplayCredentialIdentity(
  kind: "key" | "oauth" | "codex",
  material: string | undefined,
  headers?: Record<string, string>,
): string | undefined {
  if (!nonEmpty(material)) return undefined;
  const overrides = credentialHeaderOverrides(headers);
  return `${kind}:${processLocalIdentity(`credential:${kind}`, JSON.stringify([material, overrides]))}`;
}

/** Bind Codex forwarding to the effective bearer/account and selected physical pool slot. */
export function reasoningReplayCodexCredentialIdentity(args: {
  authorization?: string | null;
  chatgptAccountId?: string | null;
  accountId?: string | null;
  credentialGeneration?: number | string | null;
  writerGeneration?: number | string | null;
  headers?: Record<string, string>;
}): string | undefined {
  const configuredAuthorization = credentialHeaderOverrides(args.headers)
    .find(([name]) => name === "authorization")?.[1];
  const authorization = nonEmpty(args.authorization) ? args.authorization : configuredAuthorization;
  if (!authorization) return undefined;
  const material = JSON.stringify([
    authorization,
    nonEmpty(args.chatgptAccountId) ? args.chatgptAccountId : "",
    nonEmpty(args.accountId) ? args.accountId : "",
    args.credentialGeneration === null || args.credentialGeneration === undefined
      ? ""
      : String(args.credentialGeneration),
    args.writerGeneration === null || args.writerGeneration === undefined
      ? ""
      : String(args.writerGeneration),
  ]);
  return reasoningReplayCredentialIdentity("codex", material, args.headers);
}

/** Bind OAuth replay to one persisted credential slot and exact token generation. */
export function reasoningReplayOAuthCredentialIdentity(
  snapshot: Readonly<{ accountId: string; generation: string }> | undefined,
  headers?: Record<string, string>,
): string | undefined {
  if (!snapshot || !nonEmpty(snapshot.accountId) || !nonEmpty(snapshot.generation)) return undefined;
  return reasoningReplayCredentialIdentity(
    "oauth",
    `${snapshot.accountId}\0${snapshot.generation}`,
    headers,
  );
}

/** Bind key-auth provider material without putting raw secrets in the replay key. */
export function reasoningReplayKeyCredentialIdentity(
  provider: Pick<OcxProviderConfig, "apiKey" | "headers">,
): string | undefined {
  const apiKey = nonEmpty(provider.apiKey) ? provider.apiKey : undefined;
  // Public/static headers do not establish a physical credential boundary.
  // Header-only/key-optional providers therefore fail closed for replay.
  if (!apiKey) return undefined;
  return reasoningReplayCredentialIdentity("key", apiKey, provider.headers);
}

/** Replace only the holder snapshot so parsed-request copies observe rotations. */
export function bindReasoningReplayScope(
  scope: OcxReasoningReplayScopeRef | undefined,
  identity: OcxReasoningReplayIdentity | undefined,
): void {
  if (!scope) return;
  if (!identity || !keyFor("binding-check", { ...scope, current: identity })) {
    delete scope.current;
    return;
  }
  scope.current = { ...identity };
}

/**
 * Record the raw reasoning text that preceded the given tool call.
 *
 * Expired entries are swept on insert so the TTL bound holds even when a call
 * id is never read again.
 */
export function rememberReasoningForCall(
  callId: string,
  text: string,
  scope?: OcxReasoningReplayScopeRef,
): void {
  // Never fall back to a process-wide namespace. Call ids are supplied by
  // clients/providers and are therefore neither unique nor trustworthy; an
  // unscoped entry could be recovered by an unrelated request that reuses the
  // same id.
  // Empty provider deltas are absence of new reasoning, not a request to erase a candidate.
  const key = keyFor(callId, scope);
  if (!key || typeof text !== "string" || text.length === 0) return;
  const bytes = Buffer.byteLength(text, "utf8");
  // A single entry larger than the whole budget would immediately evict itself.
  if (bytes > MAX_TOTAL_BYTES) return;
  const at = now();
  // Delete every due entry first so expired reasoning cannot linger until a
  // later peek or capacity eviction.
  for (const [key, entry] of entries) {
    if (at - entry.at >= TTL_MS) {
      entries.delete(key);
      totalBytes -= entry.bytes;
    }
  }
  const previous = entries.get(key);
  if (previous) totalBytes -= previous.bytes;
  entries.set(key, { text, bytes, at });
  totalBytes += bytes;
  // Evict oldest-first until both caps hold (never evict the entry just written
  // while it is the only one — the loop guards on size > 1).
  while ((totalBytes > MAX_TOTAL_BYTES || entries.size > MAX_ENTRIES) && entries.size > 1) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [candidateKey, entry] of entries) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey === undefined) break;
    const evicted = entries.get(oldestKey)!;
    totalBytes -= evicted.bytes;
    entries.delete(oldestKey);
  }
}

/**
 * Read the recorded reasoning for a call id without removing it: retries after
 * a failed continuation reuse the same fallback.
 */
export function peekReasoningForCall(
  callId: string,
  scope?: OcxReasoningReplayScopeRef,
): string | undefined {
  const key = keyFor(callId, scope);
  if (!key) return undefined;
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (now() - entry.at >= TTL_MS) {
    entries.delete(key);
    totalBytes -= entry.bytes;
    return undefined;
  }
  return entry.text;
}

/** Test-only: reset the cache and optionally pin the clock. */
export function clearReasoningReplayCacheForTests(clock?: (() => number) | null): void {
  entries.clear();
  servingIdentities.clear();
  opaqueBlobRejections.clear();
  totalBytes = 0;
  servingIdentityTotalBytes = 0;
  opaqueBlobRejectionTotalBytes = 0;
  clockForTests = clock ?? null;
}
