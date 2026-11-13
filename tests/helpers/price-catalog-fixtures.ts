import { afterEach, beforeEach, setSystemTime } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPriceCatalogForTests, setPriceCatalogFetchForTests } from "../../src/usage/price-catalog";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import { removeTreeWithRetry } from "./remove-tree";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

/** Hand-written miniature of the models.dev feed: fake ids, one row per rule under test. */
export function modelsDevFeed(): Record<string, unknown> {
  return {
    deepseek: { models: {
      "zephyr-flash-2": { cost: { input: 0.1, output: 0.4, cache_read: 0.01, cache_write: 0.2 } },
      "twin-1": { cost: { input: 1, output: 2 } },
      "same-1": { cost: { input: 5, output: 6 } },
    } },
    moonshotai: { models: { "moon-pro-3.1": { cost: { input: 1.5, output: 6 } } } },
    xai: { models: { "Grok-Quill-5.5": { cost: { input: 2, output: 8, cache_read: 0.5 } } } },
    google: { models: {
      "gem-free-4": { cost: { input: 0, output: 0 } },
      "gem-nocost-4": { name: "no cost block" },
      "gem-badrate-4": { cost: { input: -1, output: 2 } },
    } },
    alibaba: { models: {
      "acme/twin-1": { cost: { input: 3, output: 4 } },
      "acme/same-1": { cost: { input: 5, output: 6 } },
    } },
    resellerhub: { models: {
      "zephyr-flash-2": { cost: { input: 9, output: 9 } },
      "reseller-only-1": { cost: { input: 7, output: 7 } },
    } },
  };
}

/** Hand-written miniature of the OpenRouter feed (USD per token, as strings). */
export function openRouterFeed(): Record<string, unknown> {
  return { data: [
    { id: "deepseek/zephyr-flash-2", pricing: { prompt: "0.0000003", completion: "0.0000012" } },
    { id: "acme/orb-only-7", pricing: { prompt: "0.0000005", completion: "0.000002", input_cache_read: "0.0000001", input_cache_write: "0.00000125" } },
    { id: "deepseek/zephyr-flash-2:free", pricing: { prompt: "0", completion: "0" } },
    { id: "acme/free-only-1:free", pricing: { prompt: "0.000001", completion: "0.000002" } },
    { id: "openrouter/auto", pricing: { prompt: "0.000001", completion: "0.000002" } },
    { id: "acme/negative-1", pricing: { prompt: "-0.000001", completion: "-0.000002" } },
    { id: "acme/dup-2", pricing: { prompt: "0.000001", completion: "0.000002" } },
    { id: "other/dup-2", pricing: { prompt: "0.000009", completion: "0.000002" } },
  ] };
}

export interface FeedFetch {
  readonly fetch: typeof fetch;
  /** Every requested URL, in order. */
  readonly calls: string[];
  callsTo(url: string): number;
  /** URLs that fail with a network error. */
  readonly failing: Set<string>;
  /** Replace the body served for a URL. */
  serve(url: string, body: unknown): void;
  /** Hold every response until the returned function is called. */
  hold(): () => void;
}

export function feedFetch(): FeedFetch {
  const bodies = new Map<string, unknown>([[MODELS_DEV_URL, modelsDevFeed()], [OPENROUTER_URL, openRouterFeed()]]);
  const calls: string[] = [];
  const failing = new Set<string>();
  let gate: Promise<void> | null = null;
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (gate) await gate;
    if (failing.has(url)) throw new TypeError("network down");
    if (!bodies.has(url)) return new Response("not found", { status: 404 });
    const body = bodies.get(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    fetch: impl as unknown as typeof fetch,
    calls,
    callsTo: url => calls.filter(call => call === url).length,
    failing,
    serve: (url, body) => { bodies.set(url, body); },
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>(resolve => { release = resolve; });
      return () => { release(); gate = null; };
    },
  };
}

/**
 * Per-test sandbox: a private config dir for the catalog cache file, a clean catalog state and
 * no leftover user overlays, multipliers or frozen clock. Registers its own hooks.
 */
export function installCatalogSandbox(): { readonly dir: string; readonly feeds: FeedFetch } {
  let home = "";
  let previousHome: string | undefined;
  let feeds = feedFetch();
  beforeEach(() => {
    previousHome = process.env["OPENCODEX_HOME"];
    home = mkdtempSync(join(tmpdir(), "ocx-price-catalog-"));
    process.env["OPENCODEX_HOME"] = home;
    resetPriceCatalogForTests();
    feeds = feedFetch();
    setPriceCatalogFetchForTests(feeds.fetch);
  });
  afterEach(() => {
    setSystemTime();
    resetPriceCatalogForTests();
    refreshUserCostOverlays({ port: 0, defaultProvider: "none", providers: {} });
    if (previousHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = previousHome;
    removeTreeWithRetry(home);
  });
  return {
    get dir() { return home; },
    get feeds() { return feeds; },
  };
}

/** One macrotask: lets a `setTimeout(0)` miss flush start, then the caller settles background work. */
export const nextTick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));
