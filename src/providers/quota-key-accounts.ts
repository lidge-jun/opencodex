/** Isolated, process-local API-key quota rows. Never publishes provider/routing caches. */
import { createHash } from "node:crypto";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { apiKeyPoolEntryId } from "./api-keys";
import { resolveProviderApiKey } from "./key-store";
import type { ProviderQuota } from "./quota-types";
import { ACCOUNT_QUOTA_TTL_MS } from "./quota-wire";

const MAX_ENTRIES = 256;
const LAST_GOOD_MS = 30 * 60_000;
type Entry = { ts: number; quota: ProviderQuota | null; unavailable?: true };
export type KeyQuotaProbeOutcome =
  | { kind: "quota"; quota: ProviderQuota }
  | { kind: "empty" | "terminal" | "unavailable" };
export interface ProviderApiKeyQuota {
  keyId: string;
  quota: ProviderQuota | null;
  unavailable?: true;
  /** Server-only, non-enumerable; call immediately before the safe DTO join. */
  isCurrent: () => boolean;
}
const cache = new Map<string, Entry>();
const flights = new Map<string, Promise<Entry>>();
let epoch = 0;

export function clearProviderApiKeyQuotaCache(): void {
  epoch += 1;
  cache.clear();
  flights.clear();
}

/**
 * Cached-only, synchronous per-key quota. Never probes, never awaits, never schedules a read.
 *
 * The selector that calls this sits on the first-attempt path, where a network read would be a
 * worse defect than the one it is there to fix. A miss is simply "no evidence".
 *
 * An `unavailable` row is a miss too, and that is the whole point of the check. `readEntry`
 * keeps a last-good quota attached for up to LAST_GOOD_MS after a probe starts failing, so
 * returning `entry.quota` on any hit would rank on a number up to half an hour stale -- and
 * rank it ABOVE a key with no row at all. Last-good is a display value, not a selection input.
 *
 * A SUCCESSFUL row expires too, on exactly `readEntry`'s freshness predicate. Checking only
 * `unavailable` was not enough: nothing on the selection path probes or sweeps, so once a
 * dashboard or CLI read had populated the cache, a row could outlive ACCOUNT_QUOTA_TTL_MS and
 * keep a "roomy" ten-minute-old measurement ranked above a key with no evidence at all --
 * until some unrelated write happened to sweep it. Expired is no evidence, same as absent.
 */
export function cachedApiKeyQuota(
  name: string,
  provider: OcxProviderConfig,
  keyId: string,
  key: string,
): ProviderQuota | null {
  let resolved: string | undefined;
  // resolveProviderApiKey swallows its own failures; the catch is belt-and-braces because this
  // runs on the dispatch path and must not throw there under any future change.
  try { resolved = resolveProviderApiKey(key)?.trim(); } catch { return null; }
  if (!resolved) return null;
  const entry = cache.get(identity(name, provider, keyId, resolved));
  if (!entry || entry.unavailable || !entry.quota) return null;
  const now = Date.now();
  if (now - entry.ts >= ACCOUNT_QUOTA_TTL_MS) return null;
  if (now - entry.quota.updatedAt >= LAST_GOOD_MS) return null;
  return entry.quota;
}

/** Test seam: keyed on identity(), so it takes the raw key rather than an account id. */
export function setCachedProviderApiKeyQuotaForTests(
  name: string,
  provider: OcxProviderConfig,
  keyId: string,
  key: string,
  quota: ProviderQuota | null,
  unavailable?: true,
): void {
  const resolved = resolveProviderApiKey(key)?.trim();
  if (!resolved) return;
  remember(identity(name, provider, keyId, resolved), { ts: Date.now(), quota, ...(unavailable ? { unavailable } : {}) });
}

/** Four workers per roster, not a process-wide network limit. */
export async function mapQuotaRoster<T, R>(rows: readonly T[], read: (row: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      out[index] = await read(rows[index]!);
    }
  }));
  return out;
}

function roster(provider: OcxProviderConfig) {
  return provider.apiKeyPool?.length ? provider.apiKeyPool
    : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
}

function identity(name: string, provider: OcxProviderConfig, id: string, key: string): string {
  return createHash("sha256").update(JSON.stringify([
    "quota-key", name, provider.adapter, provider.baseUrl, provider.authMode ?? "key",
    provider.disabled === true, id, key,
  ])).digest("hex");
}

function remember(key: string, entry: Entry): void {
  cache.delete(key);
  for (const [id, row] of cache) if (Date.now() - row.ts >= LAST_GOOD_MS) cache.delete(id);
  while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
}

async function readEntry(
  key: string,
  force: boolean,
  isCurrent: () => boolean,
  probe: () => Promise<KeyQuotaProbeOutcome>,
): Promise<Entry> {
  const previous = cache.get(key);
  if (!force && previous && Date.now() - previous.ts < ACCOUNT_QUOTA_TTL_MS
    && (!previous.quota || Date.now() - previous.quota.updatedAt < LAST_GOOD_MS)) {
    cache.delete(key);
    cache.set(key, previous);
    return previous;
  }
  const running = flights.get(key);
  if (running) return running;
  const lastGood = previous?.quota && Date.now() - previous.quota.updatedAt < LAST_GOOD_MS
    ? previous.quota : null;
  if (flights.size >= MAX_ENTRIES) return { ts: Date.now(), quota: lastGood, unavailable: true };
  const flight = (async (): Promise<Entry> => {
    let result: KeyQuotaProbeOutcome;
    try { result = await probe(); } catch { result = { kind: "unavailable" }; }
    const entry: Entry = result.kind === "quota"
      ? { ts: Date.now(), quota: result.quota }
      : result.kind === "empty"
        ? { ts: Date.now(), quota: null }
        : {
            ts: Date.now(),
            quota: result.kind !== "terminal" && lastGood && Date.now() - lastGood.updatedAt < LAST_GOOD_MS ? lastGood : null,
            unavailable: true,
          };
    if (isCurrent()) remember(key, entry);
    return entry;
  })().finally(() => { if (flights.get(key) === flight) flights.delete(key); });
  flights.set(key, flight);
  return flight;
}

export async function readProviderApiKeyQuotas(
  config: OcxConfig,
  name: string,
  force: boolean,
  probe: (provider: OcxProviderConfig, config: OcxConfig) => Promise<KeyQuotaProbeOutcome>,
): Promise<ProviderApiKeyQuota[]> {
  const liveProvider = config.providers[name];
  if (!liveProvider) return [];
  const providerSnapshot = { ...liveProvider };
  const rows = roster(liveProvider).map(row => ({ ...row }));
  const generation = epoch;
  return mapQuotaRoster(rows, async row => {
    let resolved: string | undefined;
    try { resolved = resolveProviderApiKey(row.key)?.trim(); } catch { /* unavailable */ }
    const key = resolved ? identity(name, providerSnapshot, row.id, resolved) : null;
    const isCurrent = () => {
      if (epoch !== generation || !key) return false;
      const current = config.providers[name];
      if (!current) return false;
      const entry = roster(current).find(candidate => candidate.id === row.id);
      if (!entry) return false;
      try {
        const currentKey = resolveProviderApiKey(entry.key)?.trim();
        return !!currentKey && identity(name, current, row.id, currentKey) === key;
      } catch { return false; }
    };
    const entry = key && resolved && isCurrent()
      ? await readEntry(key, force, isCurrent, () => {
          const isolatedProvider = { ...providerSnapshot, apiKey: resolved, apiKeyPool: undefined };
          const isolatedConfig = { ...config, providers: { [name]: isolatedProvider } };
          return probe(isolatedProvider, isolatedConfig);
        })
      : { ts: Date.now(), quota: null, unavailable: true as const };
    const result = {
      keyId: row.id,
      quota: isCurrent() ? entry.quota : null,
      ...(!isCurrent() || entry.unavailable ? { unavailable: true as const } : {}),
    };
    return Object.defineProperty(result, "isCurrent", { value: isCurrent }) as ProviderApiKeyQuota;
  });
}
