/**
 * Server-side thought-signature replay store (issue #1735 follow-up).
 *
 * Gemini issues a thoughtSignature on the function-call part of a response and requires it
 * back when the same call is replayed in a later request. The Responses wire carries the
 * signature in extra_content.google.thought_signature, and a conforming client echoes it on
 * the replay. Real clients (codex-rs 0.144.x, Codex desktop) do NOT echo extra_content:
 * they replay history as bare function_call / custom_tool_call items keyed by call_id.
 * Without the signature Gemini rejects the replayed part with
 * "Function call is missing a thought_signature in functionCall parts".
 *
 * This module is the proxy-side fallback: remember the signature we handed out and re-attach
 * it on replay even when the client never echoes it. Values stay opaque (never parsed or
 * re-encoded) and are bounded like the wire metadata.
 *
 * SCOPE: a client-visible `call_id` is NOT unique across conversations, accounts, providers
 * or models. Keying on it alone let one thread's signature overwrite another's, and let a
 * lookup hand a signature from a different account's turn to the current one. The key is the
 * same identity the in-process reasoning cache already uses — thread plus exact provider
 * destination, adapter, model and credential — so a signature can only ever be replayed into
 * the turn that produced it.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFileAsync, getConfigDir } from "../config";
import type { OcxProviderOpaqueToolCallMetadata, OcxReasoningReplayScopeRef } from "../types";
import { isCarryableSignature, responsesExtraContentFromProviderMetadata } from "./provider-opaque-metadata";

const STORE_FILE_NAME = "thought-signature-replay.json";
const SALT_FILE_NAME = "thought-signature-replay.salt";
/**
 * Bumped whenever `keyFor` changes shape. v3 added the durable destination identity; v4
 * added the salted durable credential identity (#1926), so a v3 file's keys can never
 * match and are dropped on load instead of aging out invisibly. v3 rows carried no
 * credential information, so they are not upgradable — the next Gemini turn re-accumulates
 * its signatures (bounded, best-effort loss identical to the pre-store status quo).
 */
const STORE_VERSION = 4;

/** Bound on remembered entries; real signatures are a few hundred bytes, so this stays small. */
const MAX_ENTRIES = 16_384;
/**
 * Total bytes of remembered signature material.
 *
 * An entry count alone is not a memory bound: a single signature may be 64KiB, so 16,384
 * entries is a ~1GiB ceiling. This is the bound that actually holds.
 */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** A signature is needed for the immediate next turn; a long TTL also covers resumed threads. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type StoredEntry = { sig: string; savedAt: number };

/** Outcome of a remember attempt. `conflict` is a real signal, not a no-op. */
export type ThoughtSignatureRememberResult =
  | "stored"
  | "already-equal"
  | "conflict"
  | "unscoped"
  | "ignored";

let entries = new Map<string, StoredEntry>();
let totalBytes = 0;
let loaded = false;
let persistChain: Promise<void> = Promise.resolve();

function storePath(): string {
  return join(getConfigDir(), STORE_FILE_NAME);
}

function saltPath(): string {
  return join(getConfigDir(), SALT_FILE_NAME);
}

let cachedSalt: Buffer | undefined;
let saltLoaded = false;

/**
 * Installation-local salt for the durable credential identity (#1926). Created once and
 * persisted beside the store; losing it invalidates every stored key (the entries then
 * never match and age out), which is safe — signatures re-accumulate per turn.
 */
export function thoughtSignatureReplaySalt(): Buffer | undefined {
  if (saltLoaded) return cachedSalt;
  saltLoaded = true;
  try {
    const raw = readFileSync(saltPath());
    if (raw.length >= 16) {
      // Re-assert owner-only permissions on every load: a pre-existing file may have
      // been created before this guard or loosened by external tooling.
      try { chmodSync(saltPath(), 0o600); } catch { /* best effort on exotic filesystems */ }
      cachedSalt = raw;
      return cachedSalt;
    }
  } catch {
    // fall through to mint
  }
  try {
    const minted = randomBytes(32);
    writeFileSync(saltPath(), minted, { mode: 0o600 });
    cachedSalt = minted;
  } catch {
    // Unwritable config dir: no durable credential identity this process; the durable
    // store fails closed (keyFor returns undefined) rather than keying under a shared id.
    cachedSalt = undefined;
  }
  return cachedSalt;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Durable key for one call, or `undefined` when the scope is incomplete.
 *
 * Incomplete scope means "do not remember" rather than "remember globally": a partially
 * identified entry is exactly the cross-thread collision this store exists to prevent.
 * The reasoning cache's identities are process-local HMACs, so this key deliberately uses
 * only the stable, non-secret fields that survive a restart.
 */
function keyFor(callId: string, scope: OcxReasoningReplayScopeRef | undefined): string | undefined {
  const identity = scope?.current;
  if (
    !nonEmpty(callId)
    || !nonEmpty(scope?.clientThreadId)
    || !nonEmpty(identity?.providerName)
    || !nonEmpty(identity?.adapterName)
    || !nonEmpty(identity?.modelId)
    // v4 (#1926): a missing durable credential identity means we cannot isolate this
    // entry per credential across restarts. Refusing the key is the fail-closed choice —
    // "credential:unknown" would let two different credentials share one durable slot.
    || !nonEmpty(identity?.credentialDurableIdentity)
  ) return undefined;
  return JSON.stringify([
    scope.clientThreadId,
    identity.providerName,
    // Destination, unlike the credential identity, has a restart-stable form: it is a
    // configured endpoint rather than a secret, so a plain digest works where the
    // reasoning cache's randomBytes-keyed HMAC cannot. Without it, one provider NAME
    // serving two endpoints shares signatures across both.
    identity.providerDestinationDurableIdentity ?? "destination:unknown",
    identity.credentialDurableIdentity,
    identity.adapterName,
    identity.modelId,
    callId,
  ]);
}

function load(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(storePath(), "utf8");
  } catch {
    return; // First run or unreadable file: start empty.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) {
      return;
    }
    // The version was written but never read, so a key-shape change could not be
    // announced — old entries simply went dead and aged out on TTL, which is silent and
    // indistinguishable from a store that is not working. Reading it makes a shape change
    // an explicit drop: entries keyed by an older scheme are discarded on load rather than
    // lingering as permanent misses.
    if ((parsed as { version?: unknown }).version !== STORE_VERSION) return;
    const nowMs = Date.now();
    for (const entry of (parsed as { entries: unknown[] }).entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { key, sig, savedAt } = entry as { key?: unknown; sig?: unknown; savedAt?: unknown };
      if (typeof key !== "string" || typeof sig !== "string" || typeof savedAt !== "number") continue;
      if (savedAt <= nowMs - TTL_MS) continue;
      if (!isCarryableSignature(sig)) continue;
      entries.set(key, { sig, savedAt });
      totalBytes += sig.length;
    }
  } catch {
    // Corrupt store: ignore it; a later remember() rewrites a clean snapshot.
  }
  // A loaded snapshot can already exceed the bounds if they were lowered, so enforce them
  // here rather than waiting for the next write.
  prune(Date.now());
}

function prune(nowMs: number): void {
  for (const [key, entry] of entries) {
    if (nowMs - entry.savedAt > TTL_MS) {
      entries.delete(key);
      totalBytes -= entry.sig.length;
    }
  }
  if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) return;
  const sorted = [...entries.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
  for (const [key, entry] of sorted) {
    if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break;
    entries.delete(key);
    totalBytes -= entry.sig.length;
  }
}

function persist(): Promise<void> {
  persistChain = persistChain
    .then(async () => {
      const snapshot = JSON.stringify({
        version: STORE_VERSION,
        entries: [...entries].map(([key, entry]) => ({ key, sig: entry.sig, savedAt: entry.savedAt })),
      });
      await atomicWriteFileAsync(storePath(), snapshot);
    })
    .catch(() => {
      // Best-effort persistence: the in-memory store still serves the running process.
    });
  return persistChain;
}

/**
 * Record the signature that left the proxy on a function-call response item.
 *
 * Returns the outcome so a caller can await durability before exposing the item, and so a
 * genuine conflict is observable instead of silently overwriting. A different signature under
 * the SAME complete key means two different upstream turns claimed one identity: that is a
 * corruption signal, and keeping the first value is the fail-closed choice.
 */
export function rememberThoughtSignatureForReplay(
  callId: string,
  signature: string,
  scope: OcxReasoningReplayScopeRef | undefined,
): { result: ThoughtSignatureRememberResult; durable: Promise<void> } {
  if (!callId || !isCarryableSignature(signature)) {
    return { result: "ignored", durable: Promise.resolve() };
  }
  const key = keyFor(callId, scope);
  if (key === undefined) return { result: "unscoped", durable: Promise.resolve() };
  load();
  const existing = entries.get(key);
  if (existing) {
    if (existing.sig === signature) return { result: "already-equal", durable: Promise.resolve() };
    return { result: "conflict", durable: Promise.resolve() };
  }
  entries.set(key, { sig: signature, savedAt: Date.now() });
  totalBytes += signature.length;
  prune(Date.now());
  return { result: "stored", durable: persist() };
}

/**
 * Serialize provider metadata onto an outbound Responses function_call item AND remember the
 * signature server-side, so a client that replays the call without echoing extra_content can
 * still be served from the store.
 */
export function rememberAndSerializeExtraContent(
  callId: string,
  metadata: OcxProviderOpaqueToolCallMetadata | undefined,
  scope: OcxReasoningReplayScopeRef | undefined,
): {
  extra?: { extra_content: { google: { thought_signature: string } } };
  durable: Promise<void>;
} {
  const extra = responsesExtraContentFromProviderMetadata(metadata);
  if (!extra) return { durable: Promise.resolve() };
  const { durable } = rememberThoughtSignatureForReplay(
    callId,
    extra.extra_content.google.thought_signature,
    scope,
  );
  return { extra, durable };
}

/**
 * Remember the signature without serializing it onto the item. Used for freeform tools, whose
 * Responses items are custom_tool_call blocks that cannot carry extra_content — the signature
 * still must be stored so the replayed call (which comes back as custom_tool_call and never
 * echoes metadata) can be re-signed server-side.
 */
export function rememberExtraContentForReplay(
  callId: string,
  metadata: OcxProviderOpaqueToolCallMetadata | undefined,
  scope: OcxReasoningReplayScopeRef | undefined,
): Promise<void> {
  const extra = responsesExtraContentFromProviderMetadata(metadata);
  if (!extra) return Promise.resolve();
  return rememberThoughtSignatureForReplay(
    callId,
    extra.extra_content.google.thought_signature,
    scope,
  ).durable;
}

/** Look up a signature previously handed out for this call in THIS scope, if still fresh. */
export function lookupReplayThoughtSignature(
  callId: string,
  scope: OcxReasoningReplayScopeRef | undefined,
): string | undefined {
  const key = keyFor(callId, scope);
  if (key === undefined) return undefined;
  load();
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.savedAt > TTL_MS) {
    entries.delete(key);
    totalBytes -= entry.sig.length;
    return undefined;
  }
  return entry.sig;
}

/** Drop a remembered signature for a specific callId and scope (e.g. when upstream rejects it). */
export function forgetThoughtSignatureForReplay(
  callId: string,
  scope: OcxReasoningReplayScopeRef | undefined,
): boolean {
  const key = keyFor(callId, scope);
  if (key === undefined) return false;
  load();
  const entry = entries.get(key);
  if (!entry) return false;
  entries.delete(key);
  totalBytes -= entry.sig.length;
  prune(Date.now());
  void persist();
  return true;
}

/** Test seams: clear in-memory state and the loaded flag without touching the file. */
export function resetThoughtSignatureReplayForTests(): void {
  entries = new Map();
  totalBytes = 0;
  loaded = false;
  persistChain = Promise.resolve();
  cachedSalt = undefined;
  saltLoaded = false;
}

export function thoughtSignatureReplayCountForTests(): number {
  return entries.size;
}

/** Test seam: resolve after the queued snapshot write settles. */
export function flushThoughtSignatureReplayForTests(): Promise<void> {
  return persistChain;
}

/**
 * Bounded commit barrier (#1926 gap 2). All durable writes serialize onto
 * `persistChain`, so awaiting it (with a cap) before a turn's terminal frame becomes
 * externally visible bounds the restart window in which a handed-out signature could
 * be lost. Bounded BEST EFFORT: on timeout the turn proceeds — availability wins, and
 * the miss cost is one turn's re-accumulation (the pre-store status quo). The
 * in-memory map is updated synchronously at remember() time, so within one process
 * lifetime replay never races this barrier at all.
 */
export function awaitThoughtSignatureDurability(capMs = 250): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>(resolve => {
    timer = setTimeout(resolve, capMs);
  });
  return Promise.race([persistChain, cap]).then(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
