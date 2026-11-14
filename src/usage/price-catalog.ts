/**
 * Online price catalog: the two lowest tiers of price resolution (`src/usage/cost.ts`).
 *
 * Public price lists (models.dev, OpenRouter) are fetched into `<configDir>/price-catalog-cache.json`
 * and read synchronously, so a lookup never touches the network. A source that cannot be fetched
 * keeps its previous snapshot. A manually set price and a verified official price outrank every
 * row here; a catalog price is always an estimate and carries its source.
 *
 * Refresh paths (all background, never on a request path):
 * - daily: a source older than 24h is replaced wholesale (`refreshPriceCatalogs`);
 * - miss-driven: a model no tier could price is queued by `notePriceCatalogMiss`. The feeds are
 *   whole-table GETs (models.dev has no per-model endpoint), so one miss costs one request per
 *   source, but only the rows for the queued keys are MERGED into the existing snapshot;
 *   full replacement stays with the daily refresh. A key still unfound afterwards cools down for
 *   6h, and a source gets at most one miss-driven fetch per cooldown window.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { trackBackgroundWork } from "../lib/background-work";
import { isPassiveRead } from "../lib/passive-read";
import { capabilityInferenceKey } from "../providers/model-capability-inference";
import type { Cost4 } from "./expected-prices";
import { bumpPriceCatalogVersion } from "./price-catalog-version";
import { validCost4 } from "./user-cost-validation";

export { priceCatalogVersion } from "./price-catalog-version";

export type CatalogPriceSource = "models-dev" | "openrouter";
export interface CatalogPrice {
  source: CatalogPriceSource;
  cost4: Cost4;
  vendor: string;
  vendorModelId: string;
  fetchedAt: number;
  url: string;
}
export interface CatalogSourceStatus { ok: boolean; fetchedAt?: string; count?: number; error?: string }

interface Row { cost4: Cost4; vendor: string; vendorModelId: string; fetchedAt?: number }
interface Snapshot { fetchedAt: number; prices: Map<string, Row> }
interface CatalogFile {
  version: 1;
  sources: Partial<Record<CatalogPriceSource, { fetchedAt: number; prices: Record<string, Row> }>>;
  missCooldown?: Record<string, number>;
}
interface SourceDef { id: CatalogPriceSource; url: string; parse(raw: unknown): Map<string, Row> }

export const PRICE_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const PRICE_CATALOG_MISS_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 20_000;
const FILENAME = "price-catalog-cache.json";

/** Original vendors only: a reseller's listing is not the model's own price. */
const MODELS_DEV_VENDORS = ["anthropic", "openai", "google", "deepseek", "moonshotai", "minimax", "zai", "xai", "mistral", "xiaomi", "stepfun", "alibaba"];

/** Same-model key: `cn:` channel prefix, `vendor/` prefix, case, dot-vs-hyphen and `[...]` suffix are ignored. */
export function priceCatalogKey(modelId: string): string {
  return capabilityInferenceKey(modelId.replace(/^[a-z0-9_-]+:/i, ""));
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const rate = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** A key claimed by two rows with different prices answers nothing (the `addCandidate` rule of #8674). */
function addRow(out: Map<string, Row | null>, key: string, row: Row): void {
  if (!key) return;
  const existing = out.get(key);
  if (existing === undefined) out.set(key, row);
  else if (existing !== null && JSON.stringify(existing.cost4) !== JSON.stringify(row.cost4)) out.set(key, null);
}
function settle(out: Map<string, Row | null>): Map<string, Row> {
  const kept = new Map<string, Row>();
  for (const [key, row] of out) if (row && kept.size < MAX_ROWS) kept.set(key, row);
  return kept;
}
function priced(input?: number, output?: number, cacheRead?: number, cacheWrite?: number): Cost4 | undefined {
  if (input === undefined || output === undefined || (input === 0 && output === 0)) return undefined;
  const cost4 = { input, output, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 };
  return validCost4(cost4) ? cost4 : undefined;
}

const SOURCES: readonly SourceDef[] = [
  {
    id: "models-dev",
    url: "https://models.dev/api.json",
    parse(raw) {
      const out = new Map<string, Row | null>();
      const root = record(raw);
      for (const vendor of MODELS_DEV_VENDORS) {
        for (const [id, value] of Object.entries(record(record(root?.[vendor])?.models) ?? {})) {
          const cost = record(record(value)?.cost);
          const cost4 = priced(rate(cost?.input), rate(cost?.output), rate(cost?.cache_read), rate(cost?.cache_write));
          if (cost4 && id.length <= 256) addRow(out, priceCatalogKey(id), { cost4, vendor, vendorModelId: id });
        }
      }
      return settle(out);
    },
  },
  {
    id: "openrouter",
    url: "https://openrouter.ai/api/v1/models",
    parse(raw) {
      const out = new Map<string, Row | null>();
      const data = record(raw)?.data;
      const perMillion = (v: unknown) => { const n = rate(v); return n === undefined ? undefined : n * 1_000_000; };
      for (const value of Array.isArray(data) ? data : []) {
        const row = record(value);
        const id = row?.id;
        if (typeof id !== "string" || id.length > 256 || id.includes(":") || id.startsWith("openrouter/") || !id.includes("/")) continue;
        const p = record(row?.pricing);
        const cost4 = priced(perMillion(p?.prompt), perMillion(p?.completion), perMillion(p?.input_cache_read), perMillion(p?.input_cache_write));
        if (cost4) addRow(out, priceCatalogKey(id), { cost4, vendor: id.slice(0, id.indexOf("/")), vendorModelId: id });
      }
      return settle(out);
    },
  },
];

interface State {
  snapshots: Map<CatalogPriceSource, Snapshot>;
  inFlight: Map<CatalogPriceSource, { full: boolean; promise: Promise<CatalogSourceStatus> }>;
  retryAfter: Map<CatalogPriceSource, number>;
  lastMissFetch: Map<CatalogPriceSource, number>;
  cooldown: Map<string, number>;
  pendingMiss: Set<string>;
  missScheduled: boolean;
}
const states = new Map<string, State>();
let autoEnabled = false;
let testFetch: typeof fetch | null = null;

function loadFile(dir: string, s: State): void {
  try {
    const file = record(JSON.parse(readFileSync(join(dir, FILENAME), "utf8")));
    if (file?.version !== 1) return;
    for (const def of SOURCES) {
      const src = record(record(file.sources)?.[def.id]);
      if (!src || typeof src.fetchedAt !== "number" || !Number.isFinite(src.fetchedAt)) continue;
      const prices = new Map<string, Row>();
      for (const [key, v] of Object.entries(record(src.prices) ?? {})) {
        const r = record(v);
        const c = r?.cost4 as Cost4 | undefined;
        if (prices.size >= MAX_ROWS || !r || typeof r.vendor !== "string" || typeof r.vendorModelId !== "string" || !validCost4(c)) continue;
        prices.set(key, {
          cost4: { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite },
          vendor: r.vendor,
          vendorModelId: r.vendorModelId,
          ...(typeof r.fetchedAt === "number" ? { fetchedAt: r.fetchedAt } : {}),
        });
      }
      s.snapshots.set(def.id, { fetchedAt: src.fetchedAt, prices });
    }
    for (const [key, until] of Object.entries(record(file.missCooldown) ?? {})) {
      if (typeof until === "number" && until > Date.now()) s.cooldown.set(key, until);
    }
  } catch { /* Missing or corrupt cache: no catalog, today's behavior. */ }
}

function stateFor(dir: string): State {
  let s = states.get(dir);
  if (!s) {
    s = { snapshots: new Map(), inFlight: new Map(), retryAfter: new Map(), lastMissFetch: new Map(), cooldown: new Map(), pendingMiss: new Set(), missScheduled: false };
    states.set(dir, s);
    loadFile(dir, s);
  }
  return s;
}

function persist(dir: string, s: State): void {
  const file: CatalogFile = { version: 1, sources: {} };
  for (const [id, snap] of s.snapshots) file.sources[id] = { fetchedAt: snap.fetchedAt, prices: Object.fromEntries(snap.prices) };
  const now = Date.now();
  const live = [...s.cooldown].filter(([, until]) => until > now).slice(-500);
  if (live.length) file.missCooldown = Object.fromEntries(live);
  try { atomicWriteFile(join(dir, FILENAME), JSON.stringify(file) + "\n"); } catch { /* Memory still serves lookups. */ }
}

/** Synchronous lookup: the first source in registry order that holds the key. */
export function lookupCatalogPrice(modelId: string, dir = getConfigDir()): CatalogPrice | null {
  const key = priceCatalogKey(modelId);
  if (!key) return null;
  const s = stateFor(dir);
  for (const def of SOURCES) {
    const snap = s.snapshots.get(def.id);
    const row = snap?.prices.get(key);
    if (snap && row) {
      return { source: def.id, cost4: row.cost4, vendor: row.vendor, vendorModelId: row.vendorModelId, fetchedAt: row.fetchedAt ?? snap.fetchedAt, url: def.url };
    }
  }
  return null;
}

/** Lookup for the resolver: on a miss, queue a background fetch for this key. Never blocks. */
export function resolveCatalogPrice(modelId: string): CatalogPrice | null {
  const found = lookupCatalogPrice(modelId);
  if (!found) notePriceCatalogMiss(modelId);
  return found;
}

function autoAllowed(): boolean {
  return (testFetch !== null || process.env["NODE_ENV"] !== "test") && !isPassiveRead();
}

/** Record a key no tier could price and schedule one coalesced background refresh. */
export function notePriceCatalogMiss(modelId: string): void {
  if (!autoEnabled || !autoAllowed()) return;
  const key = priceCatalogKey(modelId);
  const dir = getConfigDir();
  const s = stateFor(dir);
  if (!key || s.pendingMiss.has(key) || (s.cooldown.get(key) ?? 0) > Date.now()) return;
  s.pendingMiss.add(key);
  if (s.missScheduled) return;
  s.missScheduled = true;
  setTimeout(() => { trackBackgroundWork("price-catalog-miss", flushMisses(dir, s).catch(() => undefined)); }, 0);
}

async function flushMisses(dir: string, s: State): Promise<void> {
  const keys = new Set(s.pendingMiss);
  s.pendingMiss.clear();
  s.missScheduled = false;
  const now = Date.now();
  let fetched = false;
  for (const def of SOURCES) {
    const snap = s.snapshots.get(def.id);
    const due = !snap || now - snap.fetchedAt >= PRICE_CATALOG_TTL_MS;
    if (!due && now - (s.lastMissFetch.get(def.id) ?? 0) < PRICE_CATALOG_MISS_COOLDOWN_MS) continue;
    const status = await refreshSource(dir, s, def, due ? { full: true } : { full: false, keys });
    if (status.ok) {
      fetched = true;
      if (!due) s.lastMissFetch.set(def.id, Date.now());
    }
  }
  if (!fetched) return;
  const until = Date.now() + PRICE_CATALOG_MISS_COOLDOWN_MS;
  for (const key of keys) if (!lookupCatalogPrice(key, dir)) s.cooldown.set(key, until);
  persist(dir, s);
}

async function fetchFeed(def: SourceDef): Promise<Map<string, Row>> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await (testFetch ?? fetch)(def.url, {
    headers: { accept: "application/json", "user-agent": "opencodex-price-catalog" },
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const body = await readBoundedResponseBytes(response, { maxBytes: MAX_FEED_BYTES, signal });
  if (body.oversized) throw new Error("too_large");
  const parsed = def.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)));
  if (parsed.size === 0) throw new Error("empty");
  return parsed;
}

function statusOf(s: State, def: SourceDef): CatalogSourceStatus {
  const snap = s.snapshots.get(def.id);
  return snap ? { ok: true, fetchedAt: new Date(snap.fetchedAt).toISOString(), count: snap.prices.size } : { ok: true, count: 0 };
}

type Mode = { full: true; force?: boolean } | { full: false; keys: ReadonlySet<string> };

async function refreshSource(dir: string, s: State, def: SourceDef, mode: Mode): Promise<CatalogSourceStatus> {
  const flight = s.inFlight.get(def.id);
  if (flight) {
    const joined = await flight.promise;
    if (flight.full || !mode.full) return joined;
  }
  const now = Date.now();
  const snap = s.snapshots.get(def.id);
  const forced = mode.full && mode.force === true;
  if (!forced && now < (s.retryAfter.get(def.id) ?? 0)) return { ok: false, error: "backoff" };
  if (mode.full && !forced && snap && now - snap.fetchedAt < PRICE_CATALOG_TTL_MS) return statusOf(s, def);
  const promise = (async (): Promise<CatalogSourceStatus> => {
    try {
      const parsed = await fetchFeed(def);
      const at = Date.now();
      const before = s.snapshots.get(def.id);
      if (mode.full) {
        s.snapshots.set(def.id, { fetchedAt: at, prices: parsed });
        bumpPriceCatalogVersion();
      } else {
        const next = new Map(before?.prices ?? []);
        let added = 0;
        for (const key of mode.keys) {
          const row = parsed.get(key);
          if (row && !next.has(key)) {
            next.set(key, { ...row, fetchedAt: at });
            added++;
          }
        }
        // No snapshot yet: fetchedAt 0 keeps the source due for its full daily refresh.
        if (added) {
          s.snapshots.set(def.id, { fetchedAt: before?.fetchedAt ?? 0, prices: next });
          bumpPriceCatalogVersion();
        }
      }
      persist(dir, s);
      return statusOf(s, def);
    } catch (error) {
      s.retryAfter.set(def.id, Date.now() + FAILURE_BACKOFF_MS);
      const message = error instanceof Error ? error.message : "";
      const code = /^(http_\d+|too_large|empty)$/.test(message) ? message : error instanceof SyntaxError ? "bad_json" : "fetch_failed";
      return { ok: false, error: code };
    }
  })();
  s.inFlight.set(def.id, { full: mode.full, promise });
  try { return await promise; } finally { if (s.inFlight.get(def.id)?.promise === promise) s.inFlight.delete(def.id); }
}

/**
 * Daily refresh of every source: skip a fresh one unless `force`, coalesce concurrent callers,
 * keep the previous snapshot when a fetch fails. `force` also clears miss cooldowns.
 */
export async function refreshPriceCatalogs(options: { force?: boolean; configDir?: string } = {}): Promise<Record<CatalogPriceSource, CatalogSourceStatus>> {
  const dir = options.configDir ?? getConfigDir();
  const s = stateFor(dir);
  if (options.force) {
    s.cooldown.clear();
    s.lastMissFetch.clear();
  }
  const out = {} as Record<CatalogPriceSource, CatalogSourceStatus>;
  await Promise.all(SOURCES.map(async def => { out[def.id] = await refreshSource(dir, s, def, { full: true, force: options.force }); }));
  if (options.force) persist(dir, s);
  return out;
}

/** Called from GET /api/models and GET /api/usage: arms miss-driven fetching and refreshes a stale source. */
export function triggerPriceCatalogRefresh(): void {
  if (!autoAllowed()) return;
  autoEnabled = true;
  trackBackgroundWork("price-catalog-refresh", refreshPriceCatalogs().catch(() => undefined));
}

/** Test seam: inject the feed fetcher (also lifts the NODE_ENV=test no-network guard). */
export function setPriceCatalogFetchForTests(impl: typeof fetch | null): void {
  testFetch = impl;
  autoEnabled = impl !== null;
}

export function resetPriceCatalogForTests(): void {
  states.clear();
  testFetch = null;
  autoEnabled = false;
}
