import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_AUTO_REFRESH_DEFAULT_INTERVAL_MS,
  CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS,
  getConfigPath,
  getDefaultConfig,
  isCatalogAutoRefreshEnabled,
  loadConfig,
  resolveCatalogAutoRefreshIntervalMs,
  validateConfigCandidate,
} from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-catalog-auto-refresh-config-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function candidate(catalogAutoRefresh: unknown) {
  return {
    ...getDefaultConfig(),
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        note: "keep me",
      },
    },
    catalogAutoRefresh,
  };
}

test("resolveCatalogAutoRefreshIntervalMs defaults to the hourly cadence", () => {
  // Absence is the feature's only default state: no section and no intervalMinutes both
  // resolve to the same hourly pass, so an operator who writes only { enabled: true }
  // gets the documented cadence.
  expect(resolveCatalogAutoRefreshIntervalMs({})).toBe(CATALOG_AUTO_REFRESH_DEFAULT_INTERVAL_MS);
  expect(resolveCatalogAutoRefreshIntervalMs({ catalogAutoRefresh: {} }))
    .toBe(CATALOG_AUTO_REFRESH_DEFAULT_INTERVAL_MS);
  expect(resolveCatalogAutoRefreshIntervalMs({ catalogAutoRefresh: { enabled: true } }))
    .toBe(CATALOG_AUTO_REFRESH_DEFAULT_INTERVAL_MS);
});

test("resolveCatalogAutoRefreshIntervalMs honours 0 as configured-but-dormant", () => {
  // 0 is a real configuration, not a missing one: the operator asked for the section to
  // exist with no timer, and clamping it up to the floor would start work they declined.
  expect(resolveCatalogAutoRefreshIntervalMs({ catalogAutoRefresh: { intervalMinutes: 0 } }))
    .toBe(0);
});

test("resolveCatalogAutoRefreshIntervalMs clamps below the floor and honours values above it", () => {
  // Below the floor a refresh buys no freshness — upstream provider caches have not moved —
  // and only multiplies rate-limit exposure, so the resolver lifts it rather than failing.
  expect(resolveCatalogAutoRefreshIntervalMs({ catalogAutoRefresh: { intervalMinutes: 1 } }))
    .toBe(CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS);
  expect(resolveCatalogAutoRefreshIntervalMs({ catalogAutoRefresh: { intervalMinutes: 14 } }))
    .toBe(CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS);
  expect(resolveCatalogAutoRefreshIntervalMs({ catalogAutoRefresh: { intervalMinutes: 15 } }))
    .toBe(CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS);
  expect(resolveCatalogAutoRefreshIntervalMs({ catalogAutoRefresh: { intervalMinutes: 120 } }))
    .toBe(120 * 60_000);
});

test("isCatalogAutoRefreshEnabled reads true only for an explicit enabled:true", () => {
  // The house === true idiom keeps an absent key, an explicit false, and a hand-edited
  // truthy string all reading off, so a malformed edit cannot start a live timer.
  expect(isCatalogAutoRefreshEnabled({})).toBe(false);
  expect(isCatalogAutoRefreshEnabled({ catalogAutoRefresh: {} })).toBe(false);
  expect(isCatalogAutoRefreshEnabled({ catalogAutoRefresh: { enabled: false } })).toBe(false);
  expect(isCatalogAutoRefreshEnabled({ catalogAutoRefresh: { enabled: "yes" as never } })).toBe(false);
  expect(isCatalogAutoRefreshEnabled({ catalogAutoRefresh: { enabled: true } })).toBe(true);
});

test("validateConfigCandidate rejects a malformed section naming the field", () => {
  const result = validateConfigCandidate(candidate({ enabled: "yes" }));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error).toContain("schema_invalid: catalogAutoRefresh.enabled");

  const outOfRange = validateConfigCandidate(candidate({ intervalMinutes: -5 }));
  expect(outOfRange.ok).toBe(false);
  if (outOfRange.ok) throw new Error("unreachable");
  expect(outOfRange.error).toContain("schema_invalid: catalogAutoRefresh.intervalMinutes");

  // .strict() like its neighbours: a typo'd key must surface as a rejected write rather
  // than a silently ignored key that leaves the operator believing they enabled something.
  const typo = validateConfigCandidate(candidate({ enabled: true, intervlaMinutes: 30 }));
  expect(typo.ok).toBe(false);
});

test("validateConfigCandidate accepts a well-formed section", () => {
  expect(validateConfigCandidate(candidate({ enabled: true, intervalMinutes: 30 })).ok).toBe(true);
  expect(validateConfigCandidate(candidate({ intervalMinutes: 0 })).ok).toBe(true);
  expect(validateConfigCandidate(candidate(undefined)).ok).toBe(true);
});

test("load drops only a malformed section and preserves the rest of the config", () => {
  // Same silent-in-the-wrong-direction failure as quotaResetNotify: discarding the whole
  // file over a bad optional section would cost the operator their providers, while
  // dropping only the section leaves a working config and a visible warning.
  writeFileSync(getConfigPath(), JSON.stringify(candidate({ enabled: "yes" })), "utf8");

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const loaded = loadConfig();
    expect(loaded.catalogAutoRefresh).toBeUndefined();
    expect(loaded.providers.xai.note).toBe("keep me");
    const messages = warn.mock.calls.flat().join("\n");
    expect(messages).toContain("catalogAutoRefresh.enabled ignored");
  } finally {
    warn.mockRestore();
  }
});

test("load keeps a well-formed section intact", () => {
  writeFileSync(getConfigPath(), JSON.stringify(candidate({ enabled: true, intervalMinutes: 45 })), "utf8");
  const loaded = loadConfig();
  expect(loaded.catalogAutoRefresh).toEqual({ enabled: true, intervalMinutes: 45 });
});
