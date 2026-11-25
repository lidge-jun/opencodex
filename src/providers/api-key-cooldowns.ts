import { createHash } from "node:crypto";
import type { ApiKeyCooldownHold, ApiKeyCooldownPersistence } from "./api-key-cooldown-store";

/**
 * Cooldown state shared by selection validation and key failover.
 *
 * The map is the authority for every check. A running server attaches a persistence sink
 * (`api-key-cooldown-store.ts`) so a confirmed hold survives a restart until it expires; without
 * one (unit tests, detached tools) the state stays in memory. Expiry checks and sweeps only drop
 * local rows: an expired local copy must never erase a row another process sharing the home extended.
 */
type KeyCooldown = { cooldownUntil: number; generation?: string };
const keyCooldowns = new Map<string, KeyCooldown>();
let persistence: ApiKeyCooldownPersistence | undefined;

function cooldownKey(providerName: string, keyId: string): string {
  return `${providerName}\0${keyId}`;
}

/**
 * The persisted generation of one pool entry: a truncated hash of the entry's key, so a key
 * replaced under the same id starts with no hold. It is unsalted on purpose; a per-file salt
 * would race between processes sharing a home. A key fingerprint is the only generation an API
 * key has (see `adapters/anthropic/per-message-effort.ts`).
 */
export function apiKeyCooldownGeneration(providerName: string, keyId: string, credential: string): string {
  return createHash("sha256")
    .update(`ocx-api-key-cooldown/v1\0${providerName}\0${keyId}\0${credential}`)
    .digest("hex")
    .slice(0, 24);
}

export function setKeyCooldown(providerName: string, keyId: string, cooldownUntil: number, credential?: string): void {
  const key = cooldownKey(providerName, keyId);
  const generation = credential === undefined ? undefined : apiKeyCooldownGeneration(providerName, keyId, credential);
  const prior = keyCooldowns.get(key);
  // A hold recorded against a different key under the same id belongs to that old key.
  const sameKey = prior !== undefined && (generation === undefined || prior.generation === undefined || prior.generation === generation);
  const until = sameKey ? Math.max(prior.cooldownUntil, cooldownUntil) : cooldownUntil;
  const kept = generation ?? (sameKey ? prior.generation : undefined);
  keyCooldowns.set(key, kept === undefined ? { cooldownUntil: until } : { cooldownUntil: until, generation: kept });
  // Only a hold bound to the key that just failed is written, and only for a key the store accepts.
  if (persistence && generation !== undefined && credential !== undefined && persistence.persists(credential)) {
    persistence.record({ provider: providerName, keyId, generation, cooldownUntil: until });
  }
}

export function isKeyInCooldown(providerName: string, keyId: string, now = Date.now()): boolean {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    keyCooldowns.delete(cooldownKey(providerName, keyId));
    return false;
  }
  return true;
}

export function getKeyCooldownUntil(providerName: string, keyId: string, now = Date.now()): number | null {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return null;
  return entry.cooldownUntil > now ? entry.cooldownUntil : null;
}

export function sweepExpiredApiKeyCooldowns(now = Date.now()): number {
  let removed = 0;
  for (const [key, cooldown] of keyCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    keyCooldowns.delete(key);
    removed += 1;
  }
  return removed;
}

/** Manual key management clears this provider's cooldowns, on disk too so a restart cannot revive them. */
export function clearKeyCooldowns(providerName?: string): void {
  persistence?.clear(providerName);
  if (!providerName) {
    keyCooldowns.clear();
    return;
  }
  const prefix = `${providerName}\0`;
  for (const key of keyCooldowns.keys()) {
    if (key.startsWith(prefix)) keyCooldowns.delete(key);
  }
}

/**
 * Forget holds in memory without writing: every hold when the config home changes, or one
 * provider's (or every provider's) when another process sharing the home cleared them.
 */
export function resetLocalApiKeyCooldowns(providerName?: string): void {
  if (providerName === undefined) {
    keyCooldowns.clear();
    return;
  }
  const prefix = `${providerName}\0`;
  for (const key of keyCooldowns.keys()) if (key.startsWith(prefix)) keyCooldowns.delete(key);
}

/** Route later cooldown writes and clears to a store. Returns a detach that only removes this sink. */
export function attachApiKeyCooldownPersistence(sink: ApiKeyCooldownPersistence): () => void {
  persistence = sink;
  return () => { if (persistence === sink) persistence = undefined; };
}

/**
 * Adopt rows a store loaded; the caller has already matched their generation to the current keys,
 * so a row replaces a local hold of any other generation and extends one of the same generation.
 */
export function restoreApiKeyCooldowns(rows: readonly ApiKeyCooldownHold[], now = Date.now()): number {
  let restored = 0;
  for (const row of rows) {
    if (row.cooldownUntil <= now) continue;
    const key = cooldownKey(row.provider, row.keyId);
    const prior = keyCooldowns.get(key);
    if (prior && (prior.generation === undefined || prior.generation === row.generation) && prior.cooldownUntil >= row.cooldownUntil) continue;
    keyCooldowns.set(key, { cooldownUntil: row.cooldownUntil, generation: row.generation });
    restored += 1;
  }
  return restored;
}

type KeyPools = Record<string, { apiKeyPool?: ReadonlyArray<{ id: string; key: string }> } | undefined>;

/** Drop holds whose pool entry is gone or now carries a different key. Local only. */
export function reconcileApiKeyCooldownGenerations(providers: KeyPools | undefined): number {
  if (!providers) return 0;
  let removed = 0;
  for (const [key, cooldown] of keyCooldowns) {
    if (cooldown.generation === undefined) continue;
    const separator = key.indexOf("\0");
    const providerName = key.slice(0, separator);
    const keyId = key.slice(separator + 1);
    const entry = providers[providerName]?.apiKeyPool?.find(candidate => candidate.id === keyId);
    if (entry && apiKeyCooldownGeneration(providerName, keyId, entry.key) === cooldown.generation) continue;
    keyCooldowns.delete(key);
    removed += 1;
  }
  return removed;
}
