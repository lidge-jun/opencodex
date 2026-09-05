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
