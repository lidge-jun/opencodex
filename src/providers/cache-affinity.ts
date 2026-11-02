/**
 * Provider cache affinity: keep a conversation on the key-pool credential that
 * served its last turn, so that credential's upstream prompt cache is read again
 * instead of rebuilt on another key.
 *
 * Modeled on Magpie's gateway affinity design, expressed in this codebase's
 * terms: conversations are session lanes (server/request-log-conversation),
 * credentials are key-pool entries identified by their pool entry id (never key
 * material), and outcomes are recorded from attempt finalization, where every
 * adapter's cache usage is already normalized into cache-read / cache-creation
 * token counts.
 *
 * Affinity is a preference inside eligibility, never an override: this module
 * only answers "which entry served this lane last, and is that worth
 * preferring?". Whether that entry may serve right now (disabled, cooling,
 * pacing) is decided by the caller in key-failover, which owns those rules.
 *
 * The store is process-local, following the combo session-recall precedent:
 * a restart forgets every binding and the first post-restart turn of a
 * conversation is placed by ordinary selection again.
 *
 * Lane ids are client-supplied, so a client that churns them can fill the
 * store and evict other conversations' bindings. The blast radius is lost
 * cache locality only — no correctness or credential exposure — and the
 * count/byte bounds below are the mitigation.
 */
import type { CacheAffinityMode, OcxProviderConfig } from "../types";
import type { GenerationContext } from "../lib/state-store-sweeper";

/** Tokens read from or written to an upstream cache that make a binding worth keeping across turns. */
export const CACHE_AFFINITY_WORTH_TOKENS = 1024;
/** How long an ordinary (5-minute-retention) cache stays warm after the turn that built it. */
export const CACHE_AFFINITY_COLD_MS = 5 * 60_000;
/** How long a long-retention (1-hour) cache write stays warm. */
export const CACHE_AFFINITY_COLD_LONG_MS = 60 * 60_000;
/** Hard expiry for a binding, however warm: past this the conversation is placed fresh. */
export const CACHE_AFFINITY_TTL_MS = 24 * 60 * 60_000;
const CAPACITY = 512;
/** Per-entry byte cap over the retained strings, mirroring combo session recall. */
const ENTRY_BYTES_MAX = 1024;
/** Aggregate byte cap across every retained binding. */
const TOTAL_BYTES_MAX = 64 * 1024;

export type CacheAffinityReason =
  | "cache" // kept: measured cache worth keeping and still warm (auto)
  | "session" // kept: session mode prefers the bound credential while eligible
  | "turn" // kept: turn mode, detected continuation of the in-progress turn
  | "continuation"; // kept: detected continuation of the in-progress turn (auto)

export interface CacheAffinityHit {
  entryId: string;
  reason: CacheAffinityReason;
}

interface Binding {
  providerName: string;
  entryId: string;
  model: string;
  cacheRead: number;
  cacheWrite: number;
  longRetention: boolean;
  at: number;
}

const bindings = new Map<string, Binding>();
let lastReconciledGeneration = 0;
let bindingsBytes = 0;

function bindingBytes(lane: string, binding: Binding): number {
  return Buffer.byteLength(lane) + Buffer.byteLength(binding.providerName)
    + Buffer.byteLength(binding.entryId) + Buffer.byteLength(binding.model);
}

function deleteBinding(lane: string): void {
  const binding = bindings.get(lane);
  if (!binding) return;
  bindings.delete(lane);
  bindingsBytes -= bindingBytes(lane, binding);
}

export function cacheAffinityMode(provider: Pick<OcxProviderConfig, "cacheAffinity">): CacheAffinityMode {
  return provider.cacheAffinity ?? "auto";
}

export function cacheAffinityApplies(provider: OcxProviderConfig): boolean {
  if (cacheAffinityMode(provider) === "off") return false;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return false;
  return (provider.apiKeyPool?.length ?? 0) >= 2;
}

export interface ConsultProviderCacheAffinityInput {
  lane: string | undefined;
  providerName: string;
  provider: OcxProviderConfig;
  model: string;
  /** The request continues the lane's in-progress turn (tool results being returned). */
  continuation?: boolean;
  now?: number;
}

/**
 * The bound credential for this lane, when affinity says to prefer it.
 * Purely a preference: the caller must still validate the entry against the
 * live pool (present, enabled, not cooling) before sending with it.
 */
export function consultProviderCacheAffinity(input: ConsultProviderCacheAffinityInput): CacheAffinityHit | null {
  const { lane, providerName, provider, model } = input;
  if (!lane || !cacheAffinityApplies(provider)) return null;
  const binding = bindings.get(lane);
  if (!binding) return null;
  const now = input.now ?? Date.now();
  if (now - binding.at >= CACHE_AFFINITY_TTL_MS) {
    deleteBinding(lane);
    return null;
  }
  if (binding.providerName !== providerName || binding.model !== model) return null;
  const mode = cacheAffinityMode(provider);
  const age = now - binding.at;
  const warmMs = binding.longRetention ? CACHE_AFFINITY_COLD_LONG_MS : CACHE_AFFINITY_COLD_MS;
  if (mode === "session") return { entryId: binding.entryId, reason: "session" };
  if (input.continuation === true) {
    if (age > warmMs) return null;
    return { entryId: binding.entryId, reason: mode === "turn" ? "turn" : "continuation" };
  }
  if (mode === "turn") return null;
  // auto, across turns: only measured-worth bindings that are still warm.
  if (age > warmMs) return null;
  const worth = binding.cacheRead + binding.cacheWrite;
  return worth >= CACHE_AFFINITY_WORTH_TOKENS ? { entryId: binding.entryId, reason: "cache" } : null;
}

export interface RecordProviderCacheAffinityInput {
  lane: string | undefined;
  providerName: string;
  entryId: string | undefined;
  model: string;
  cacheRead?: number;
  cacheWrite?: number;
  /** Portion of the cache write kept at long (1-hour) retention, when the adapter reports it. */
  cacheWriteLong?: number;
  inputTokens?: number;
  now?: number;
}

/**
 * Remember who served a completed turn. A turn with no cache telemetry at all
 * counts its sent prompt as written (silent-cache vendors such as Ollama
 * Cloud): the prompt the vendor cached is the prompt that was sent.
 */
export function recordProviderCacheAffinity(input: RecordProviderCacheAffinityInput): void {
  const { lane, providerName, entryId, model } = input;
  if (!lane || !entryId) return;
  const cacheRead = input.cacheRead ?? 0;
  // No write counter reported — reads-only reporters (OpenAI Chat reports
  // reads, never writes) and fully silent vendors alike: the prompt that was
  // sent is what the vendor cached, so it counts as written. An explicitly
  // reported write count, zero included, is believed as-is.
  const cacheWrite = input.cacheWrite ?? input.inputTokens ?? 0;
  const binding: Binding = {
    providerName,
    entryId,
    model,
    cacheRead,
    cacheWrite,
    longRetention: (input.cacheWriteLong ?? 0) > 0,
    at: input.now ?? Date.now(),
  };
  if (bindingBytes(lane, binding) > ENTRY_BYTES_MAX) return;
  // Re-insert so eviction drops the least recently recorded lane first.
  deleteBinding(lane);
  bindings.set(lane, binding);
  bindingsBytes += bindingBytes(lane, binding);
  while (bindings.size > CAPACITY || bindingsBytes > TOTAL_BYTES_MAX) {
    const oldest = bindings.keys().next().value;
    if (oldest === undefined || oldest === lane) break;
    deleteBinding(oldest);
  }
}

export function releaseProviderCacheAffinity(
  lane: string | undefined,
  providerName?: string,
  entryId?: string,
): boolean {
  if (!lane) return false;
  const binding = bindings.get(lane);
  if (!binding) return false;
  if ((providerName !== undefined && binding.providerName !== providerName)
    || (entryId !== undefined && binding.entryId !== entryId)) return false;
  deleteBinding(lane);
  return true;
}

/** The entry a lane is currently bound to, if any (finalization log attribution). */
export function boundEntryIdForLane(lane: string | undefined): string | undefined {
  return lane ? bindings.get(lane)?.entryId : undefined;
}

/** Periodic expiry for the state-store sweeper; expiry is also evaluated on consult. */
export function sweepExpiredProviderCacheAffinity(now: number): number {
  let removed = 0;
  for (const [lane, binding] of bindings) {
    if (now - binding.at >= CACHE_AFFINITY_TTL_MS) {
      deleteBinding(lane);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Drop bindings whose provider left the live configuration, was disabled, or
 * lost the bound credential, on a configuration generation change. Consult
 * re-validates against the live pool on every request regardless; this keeps
 * unconsulted lanes from lingering.
 */
export function reconcileProviderCacheAffinity(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  lastReconciledGeneration = context.generation;
  let removed = 0;
  for (const [lane, binding] of bindings) {
    const entryIds = context.providerKeyEntryIds?.get(binding.providerName);
    if (!context.providerNames.has(binding.providerName)
      || context.disabledProviderNames?.has(binding.providerName)
      || (entryIds !== undefined && !entryIds.has(binding.entryId))) {
      deleteBinding(lane);
      removed += 1;
    }
  }
  return removed;
}

export function clearProviderCacheAffinityForTests(): void {
  bindings.clear();
  bindingsBytes = 0;
  lastReconciledGeneration = 0;
}
