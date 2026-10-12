import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalogEntries } from "../../src/codex/catalog";
import {
  DISCOVERED_NATIVE_MAX_FILE_BYTES,
  DISCOVERED_NATIVE_MAX_ROW_BYTES,
  DISCOVERED_NATIVE_MAX_ROWS,
  DISCOVERED_NATIVE_RENEW_INTERVAL_MS,
  DISCOVERED_NATIVE_RETENTION_MS,
  discoveredNativeModelsGeneration,
  loadDiscoveredNativeModels,
  recordDiscoveredNativeModels,
  resetDiscoveredNativeModelsForTests,
  validateDiscoveredNativeRows,
} from "../../src/codex/catalog/discovered-natives";
import {
  ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
  NATIVE_OPENAI_MODELS,
  SUPPORTED_NATIVE_OPENAI_SLUGS,
  configuredNativeOpenAiModels,
  discoveredNativeOpenAiModels,
  resetConfiguredNativeOpenAiModelsForTests,
  setConfiguredNativeOpenAiModels,
} from "../../src/codex/catalog/native-models";
import {
  nativeOpenAiContextTier,
  nativeOpenAiContextWindow,
  nativeOpenAiSlugs,
  nativeReasoningEfforts,
  upstreamNativeEntry,
  mergeCatalogEntriesForSync,
} from "../../src/codex/catalog";
import { refreshConfigDerivedRegistries } from "../../src/config/derived-registries";
import {
  CODEX_ROSTER_DISCOVERY_CLIENT_VERSION,
  discoverCodexNativeRoster,
  resetCodexModelEntitlementCacheForTests,
  resetCodexNativeRosterDiscoveryForTests,
  resolveCodexModelEntitlements,
} from "../../src/codex/model-entitlements";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const FUTURE = "gpt-9-test";
let home: string;
let previousHome: string | undefined;
let path: string;

function row(slug = FUTURE, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug, display_name: "Future native's own name", description: "Its own upstream description",
    supported_in_api: true, visibility: "list", context_window: 123_000, max_context_window: 456_000,
    supported_reasoning_levels: [{ effort: "low", description: "Quick" }, { effort: "high", description: "Deep" }],
    default_reasoning_level: "high", model_messages: { instructions_template: "Upstream future instructions" },
    ...extra,
  };
}

function persisted(): { version: number; models: Array<{ slug: string; row: Record<string, unknown>; firstSeenAt: number; lastSeenAt: number; clientVersion: string }> } {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function fetchRoster(models: unknown, now = Date.now(), status = 200) {
  resetCodexModelEntitlementCacheForTests();
  return resolveCodexModelEntitlements({}, {
    now, clientVersion: "0.160.0",
    credentials: [{ accountId: "future-test", accessToken: "fixture-token", credentialIdentity: "fixture-generation" }],
    fetcher: (() => Promise.resolve(Response.json({ models }, { status }))) as typeof fetch,
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-discovered-native-"));
  process.env.OPENCODEX_HOME = home;
  path = join(home, "discovered-native-models.json");
  resetDiscoveredNativeModelsForTests();
  resetConfiguredNativeOpenAiModelsForTests();
  resetCodexModelEntitlementCacheForTests();
});

afterEach(() => {
  resetDiscoveredNativeModelsForTests();
  resetConfiguredNativeOpenAiModelsForTests();
  resetCodexModelEntitlementCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("authenticated native discovery", () => {
  test("a future model returned only by the roster persists and builds with its own capabilities", async () => {
    const now = Date.now();
    const snapshot = await fetchRoster([row("gpt-6.1-sol"), row()], now);
    expect(snapshot.modelsByAccount.get("future-test")?.has(FUTURE)).toBe(true);
    expect(persisted()).toMatchObject({ version: 1, models: [{ slug: FUTURE, row: row(), firstSeenAt: now, lastSeenAt: now, clientVersion: "0.160.0" }] });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(true);
    expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(FUTURE)).toBe(false);
    expect(nativeOpenAiSlugs()).toContain(FUTURE);
    expect(nativeReasoningEfforts(FUTURE)).toEqual(["low", "high"]);
    const built = buildCatalogEntries(null, [...NATIVE_OPENAI_MODELS], []);
    const future = built.find(entry => entry.slug === FUTURE)!;
    expect(future).toMatchObject({ display_name: row().display_name, description: row().description,
      supported_reasoning_levels: row().supported_reasoning_levels, default_reasoning_level: "high",
      context_window: 123_000, max_context_window: 123_000, base_instructions: "Upstream future instructions" });
    expect(built.filter(entry => entry.slug === FUTURE)).toHaveLength(1);
    expect(nativeOpenAiContextTier(FUTURE)).toEqual({ defaultWindow: 123_000, longWindow: 456_000 });
    expect(nativeOpenAiContextWindow(FUTURE, { modelWindows: { [FUTURE]: 1_000_000 } })).toBe(456_000);
  });

  test("built-in, retired, reserve, hidden, unsupported and malformed rows are rejected", () => {
    const invalid = [row("gpt-6.1-sol"), row("gpt-5.4"), row("gpt-5.3-codex-spark"), row("gpt-reserve"),
      row("openai/gpt-9-test"), row(FUTURE, { visibility: "hide" }), row(FUTURE, { supported_in_api: false }),
      row(FUTURE, { display_name: 9 }), row(FUTURE, { supported_reasoning_levels: null }),
      row(FUTURE, { supported_reasoning_levels: [null] }), row(FUTURE, { supported_reasoning_levels: ["high"] }),
      row(FUTURE, { description: "invalid \uD800 surrogate" }),
      row(FUTURE, { model_messages: { "invalid\uDC00key": "nested metadata" } }),
      row(FUTURE, { available_access_programs: { cyber: ["invalid\uD800value"] } }),
      row(FUTURE, { context_window: -1 }), row(FUTURE, { description: "x".repeat(DISCOVERED_NATIVE_MAX_ROW_BYTES) }), null];
    expect(validateDiscoveredNativeRows(invalid)).toEqual([]);
    expect(validateDiscoveredNativeRows([row(FUTURE, { description: "valid pair \uD83D\uDE80" })])).toHaveLength(1);
    expect(validateDiscoveredNativeRows({ models: [row()] })).toEqual([]);
    recordDiscoveredNativeModels(invalid, "0.160.0");
    expect(discoveredNativeOpenAiModels()).toEqual([]);
    expect(NATIVE_OPENAI_MODELS.filter(slug => slug === "gpt-6.1-sol")).toHaveLength(1);
  });

  test("failed or empty roster fetches cannot register models", async () => {
    await fetchRoster([row()], Date.now(), 500);
    expect(discoveredNativeOpenAiModels()).toEqual([]);
    await fetchRoster([]);
    expect(discoveredNativeOpenAiModels()).toEqual([]);
  });

  test("config activation reloads persisted rows; corrupt and oversized files are empty", () => {
    recordDiscoveredNativeModels([row()], "0.160.0");
    resetDiscoveredNativeModelsForTests();
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(false);
    refreshConfigDerivedRegistries({ providers: {} } as OcxConfig);
    expect(upstreamNativeEntry(FUTURE)?.display_name).toBe(row().display_name);
    writeFileSync(path, "{corrupt");
    loadDiscoveredNativeModels();
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(false);
    expect(upstreamNativeEntry(FUTURE)).toBeNull();
    writeFileSync(path, " ".repeat(DISCOVERED_NATIVE_MAX_FILE_BYTES + 1));
    loadDiscoveredNativeModels();
    expect(discoveredNativeOpenAiModels()).toEqual([]);
  });

  test("latest row wins, preserves first seen, updates generation and refreshes an existing catalog row", () => {
    const now = Date.now();
    recordDiscoveredNativeModels([row()], "0.160.0", now);
    const before = discoveredNativeModelsGeneration();
    const changed = row(FUTURE, { display_name: "Updated upstream name", context_window: 200_000 });
    recordDiscoveredNativeModels([changed], "0.161.0", now + 1);
    expect(persisted().models[0]).toMatchObject({ firstSeenAt: now, lastSeenAt: now + 1, clientVersion: "0.161.0", row: changed });
    expect(discoveredNativeModelsGeneration()).toBeGreaterThan(before);
    expect(nativeOpenAiContextWindow(FUTURE)).toBe(200_000);
    const entries = buildCatalogEntries(null, [FUTURE], []);
    expect(entries[0]?.display_name).toBe("Updated upstream name");
    const merged = mergeCatalogEntriesForSync([row()], [], new Map(), [], false);
    expect(merged.find(entry => entry.slug === FUTURE)?.display_name).toBe("Updated upstream name");
    const unchanged = discoveredNativeModelsGeneration();
    recordDiscoveredNativeModels([changed], "0.161.0", now + 2);
    expect(discoveredNativeModelsGeneration()).toBe(unchanged);
  });

  test("pruning unregisters rows and cleans metadata, including the last persisted row", () => {
    const now = Date.now();
    recordDiscoveredNativeModels([row()], "0.160.0", now);
    recordDiscoveredNativeModels([], "0.160.0", now + DISCOVERED_NATIVE_RETENTION_MS + 1);
    expect(persisted().models).toEqual([]);
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(false);
    expect(upstreamNativeEntry(FUTURE)).toBeNull();
    expect(nativeOpenAiContextWindow(FUTURE)).toBeUndefined();
  });

  test("configured and discovered membership is unioned; real capabilities replace the configured template", () => {
    setConfiguredNativeOpenAiModels([FUTURE]);
    recordDiscoveredNativeModels([row()], "0.160.0");
    expect(NATIVE_OPENAI_MODELS.filter(slug => slug === FUTURE)).toHaveLength(1);
    expect(nativeReasoningEfforts(FUTURE)).toEqual(["low", "high"]);
    expect(upstreamNativeEntry(FUTURE)?.display_name).toBe(row().display_name);
    setConfiguredNativeOpenAiModels([]);
    expect(configuredNativeOpenAiModels()).toEqual([]);
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(true);
    setConfiguredNativeOpenAiModels([FUTURE]);
    recordDiscoveredNativeModels([], "0.160.0", Date.now() + DISCOVERED_NATIVE_RETENTION_MS + 1);
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(true);
    expect(upstreamNativeEntry(FUTURE)?.display_name).toBe("GPT-9-Test");
  });

  test("bounds discoveries and falls back only for omitted context metadata", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`gpt-9-test-${i}`, { context_window: undefined, max_context_window: undefined }));
    recordDiscoveredNativeModels(rows, "0.160.0");
    expect(persisted().models).toHaveLength(DISCOVERED_NATIVE_MAX_ROWS);
    expect(statSync(path).size).toBeLessThanOrEqual(DISCOVERED_NATIVE_MAX_FILE_BYTES);
    expect(nativeOpenAiContextTier("gpt-9-test-0")).toEqual({ defaultWindow: 272_000, longWindow: 872_000 });
  });

  test("an explicitly empty reasoning ladder stays empty rather than borrowing a family default", () => {
    recordDiscoveredNativeModels([row(FUTURE, { supported_reasoning_levels: [], default_reasoning_level: null })], "0.160.0");
    expect(nativeReasoningEfforts(FUTURE)).toEqual([]);
    expect(buildCatalogEntries(null, [FUTURE], [])[0]?.supported_reasoning_levels).toEqual([]);
  });

  test("expired persisted rows and built-in rows from an older store do not register on load", () => {
    const now = Date.now();
    const entry = (slug: string, lastSeenAt: number) => ({ slug, row: row(slug),
      firstSeenAt: 0, lastSeenAt, clientVersion: "0.160.0" });
    writeFileSync(path, JSON.stringify({ version: 1, models: [
      entry(FUTURE, now - DISCOVERED_NATIVE_RETENTION_MS - 1), entry("gpt-6.1-sol", now),
    ] }));
    loadDiscoveredNativeModels(now);
    expect(discoveredNativeOpenAiModels()).toEqual([]);
    expect(upstreamNativeEntry("gpt-6.1-sol")?.display_name).toBe("GPT-6.1-Sol");
    expect(NATIVE_OPENAI_MODELS.filter(slug => slug === "gpt-6.1-sol")).toHaveLength(1);
  });

  test("a persistence failure cannot turn a successful entitlement into a request failure", async () => {
    mkdirSync(path);
    const snapshot = await fetchRoster([row()]);
    expect(snapshot.modelsByAccount.get("future-test")?.has(FUTURE)).toBe(true);
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(true);
    expect(upstreamNativeEntry(FUTURE)?.display_name).toBe(row().display_name);
  });

  test("account-specific grants and availability prompts never become shared capability metadata", () => {
    recordDiscoveredNativeModels([row(FUTURE, { available_access_programs: { cyber: ["fixture"] }, availability_nux: { message: "pool-only prompt" } })], "0.160.0");
    const entry = upstreamNativeEntry(FUTURE)!;
    expect(entry.available_access_programs).toBeUndefined();
    expect(entry.availability_nux).toBeUndefined();
  });
});

describe("discovery-only roster", () => {
  const credential = { accountId: "future-test", accessToken: "fixture-token", chatgptAccountId: "", credentialIdentity: "fixture-generation" };

  test("asks as a newer client, records an unpinned row, and leaves the entitlement cache alone", async () => {
    resetCodexNativeRosterDiscoveryForTests();
    const urls: string[] = [];
    const fetcher = ((url: string | URL) => {
      urls.push(String(url));
      return Promise.resolve(Response.json({ models: [row()] }, { headers: { etag: "W/\"roster-1\"" } }));
    }) as typeof fetch;
    expect(await discoverCodexNativeRoster({}, { credentials: [credential], fetcher })).toBe("recorded");
    expect(new URL(urls[0]!).searchParams.get("client_version")).toBe(CODEX_ROSTER_DISCOVERY_CLIENT_VERSION);
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(true);
    expect(persisted().models.map(model => model.slug)).toEqual([FUTURE]);
    // A discovery roster must never answer an entitlement question for another client version.
    // Resolving under the discovery version must still fetch, proving no entry was cached.
    let entitlementFetches = 0;
    await resolveCodexModelEntitlements({}, {
      clientVersion: CODEX_ROSTER_DISCOVERY_CLIENT_VERSION,
      credentials: [credential],
      fetcher: (() => {
        entitlementFetches += 1;
        return Promise.resolve(Response.json({ models: [row()] }));
      }) as typeof fetch,
    });
    expect(entitlementFetches).toBe(1);
  });

  test("a discovery whose scheduler generation ended does not publish", async () => {
    resetCodexNativeRosterDiscoveryForTests();
    const fetcher = (() => Promise.resolve(Response.json({ models: [row()] }))) as typeof fetch;
    expect(await discoverCodexNativeRoster({}, { credentials: [credential], fetcher, isCurrent: () => false })).toBe("unavailable");
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(false);
  });

  test("revalidates with the last ETag and treats 304 as unchanged", async () => {
    resetCodexNativeRosterDiscoveryForTests();
    const seen: Array<string | null> = [];
    let calls = 0;
    const fetcher = ((_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("if-none-match"));
      calls += 1;
      return Promise.resolve(calls === 1
        ? Response.json({ models: [row()] }, { headers: { etag: "\"roster-2\"" } })
        : new Response(null, { status: 304 }));
    }) as typeof fetch;
    expect(await discoverCodexNativeRoster({}, { credentials: [credential], fetcher })).toBe("recorded");
    expect(await discoverCodexNativeRoster({}, { credentials: [credential], fetcher })).toBe("not-modified");
    expect(seen).toEqual([null, "\"roster-2\""]);
  });

  test("a real-sized row carrying its instructions twice is admitted", () => {
    // GPT-6.1 Sol's live row was 87,183 bytes: base_instructions plus the same text as a template.
    const instructions = "x".repeat(44_000);
    const large = row(FUTURE, { base_instructions: instructions, model_messages: { instructions_template: instructions } });
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(64 * 1024);
    expect(validateDiscoveredNativeRows([large]).map(model => model.slug)).toEqual([FUTURE]);
  });

  test("an upstream failure is unavailable and registers nothing", async () => {
    resetCodexNativeRosterDiscoveryForTests();
    const fetcher = (() => Promise.resolve(new Response("nope", { status: 503 }))) as typeof fetch;
    expect(await discoverCodexNativeRoster({}, { credentials: [credential], fetcher })).toBe("unavailable");
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(FUTURE)).toBe(false);
  });
});

describe("discovery store under concurrency and repeated fetches", () => {
  test("a model another process recorded survives this process's next write", () => {
    const now = Date.now();
    recordDiscoveredNativeModels([row()], "0.160.0", now);
    const other = persisted();
    other.models.push({ slug: "gpt-9-other", row: row("gpt-9-other"), firstSeenAt: now, lastSeenAt: now, clientVersion: "0.160.0" });
    writeFileSync(path, JSON.stringify(other));
    recordDiscoveredNativeModels([row("gpt-9-third")], "0.160.0", now + 1);
    expect(persisted().models.map(model => model.slug).sort()).toEqual(["gpt-9-other", FUTURE, "gpt-9-third"]);
  });

  test("an unchanged row renews on disk at most hourly", () => {
    const now = Date.now() - 3 * DISCOVERED_NATIVE_RENEW_INTERVAL_MS;
    recordDiscoveredNativeModels([row()], "0.160.0", now);
    recordDiscoveredNativeModels([row()], "0.160.0", now + 60_000);
    expect(persisted().models[0]!.lastSeenAt).toBe(now);
    recordDiscoveredNativeModels([row()], "0.160.0", now + DISCOVERED_NATIVE_RENEW_INTERVAL_MS);
    expect(persisted().models[0]!.lastSeenAt).toBe(now + DISCOVERED_NATIVE_RENEW_INTERVAL_MS);
  });

  test("a day-old ETag is not sent, so a full fetch renews what a 304 cannot", async () => {
    resetCodexNativeRosterDiscoveryForTests();
    const credential = { accountId: "future-test", accessToken: "fixture-token", chatgptAccountId: "", credentialIdentity: "fixture-generation" };
    const seen: Array<string | null> = [];
    const fetcher = ((_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("if-none-match"));
      return Promise.resolve(Response.json({ models: [row()] }, { headers: { etag: "\"roster-3\"" } }));
    }) as typeof fetch;
    const start = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await discoverCodexNativeRoster({}, { credentials: [credential], fetcher, now: start });
    await discoverCodexNativeRoster({}, { credentials: [credential], fetcher, now: start + 25 * 60 * 60 * 1000 });
    expect(seen).toEqual([null, null]);
  });
});
