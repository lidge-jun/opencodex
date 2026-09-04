/**
 * A passively observed provider row must be distinguishable on the wire from a probed one.
 *
 * Both the GUI and this module apply a 30-minute last-good bound, which is correct for a
 * PROBED provider: past it, the probe is failing and the number is dead. `meta-muse`
 * publishes no quota endpoint at all — usage arrives only inside a streaming
 * `response.subscription_usage` frame — so its last observation is the only measurement
 * that exists, and applying the probed rule to it deletes the row instead of aging it out.
 * The `observed` marker is what lets every consumer tell the two apart.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../src/oauth/store";
import {
  clearAccountQuotaCache,
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  recordPassiveAccountQuota,
} from "../src/providers/quota";
import { captureConfigGeneration } from "../src/lib/state-store-sweeper";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import type { OcxConfig } from "../src/types";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;

/** The exact age measured on the live proxy when the missing-Meta-usage defect was reported. */
const OBSERVED_AGE_MS = 5.39 * 60 * 60_000;

function config(): OcxConfig {
  return {
    defaultProvider: "meta-muse",
    providers: {
      "meta-muse": {
        adapter: "openai-responses",
        authMode: "oauth",
        baseUrl: "https://api.meta.ai/v1",
      },
    },
  } as unknown as OcxConfig;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-observed-marker-"));
  process.env.OPENCODEX_HOME = home;
  clearProviderQuotaCache();
  clearAccountQuotaCache("meta-muse");
  // No probe may run for a passive provider; a call here is itself a failure.
  globalThis.fetch = (async () => {
    throw new Error("no upstream call may be made for a passive provider");
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  clearAccountQuotaCache("meta-muse");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

async function seedObservation(ageMs: number): Promise<void> {
  await saveCredential("meta-muse", {
    access: "access-muse",
    refresh: "refresh-muse",
    expires: Number.MAX_SAFE_INTEGER,
    accountId: "muse-account",
    email: "muse@example.test",
  });
  const { getAccountSet } = await import("../src/oauth/store");
  const accountId = getAccountSet("meta-muse")!.accounts[0]!.id;
  recordPassiveAccountQuota("meta-muse", accountId, {
    fiveHourPercent: 1,
    weeklyPercent: 1,
    updatedAt: Date.now() - ageMs,
  }, captureConfigGeneration());
}

test("a passive report is marked observed and keeps its observation timestamp", async () => {
  await seedObservation(OBSERVED_AGE_MS);
  const response = await fetchProviderQuotaReports(config());
  const row = response.reports.find(report => report.provider === "meta-muse");

  expect(row).toBeDefined();
  expect(row?.observed).toBe(true);
  expect(row?.source).toBe("meta-muse:subscription-observation");
  // The age is the point: it is reported, not hidden and not re-stamped as now.
  expect(Date.now() - row!.updatedAt).toBeGreaterThan(30 * 60_000);
});

test("an observed row does not defeat the cache fast path for every other provider", async () => {
  await seedObservation(OBSERVED_AGE_MS);
  // The first call builds and commits the cache, returning the freshly built response
  // rather than the committed copy. The fast path is what the SUBSEQUENT reads take.
  await fetchProviderQuotaReports(config());
  const second = await fetchProviderQuotaReports(config());
  const third = await fetchProviderQuotaReports(config());

  // Same object identity means the cached response was served rather than re-probed.
  // Before the exemption, one configured passive provider made `cacheFresh` permanently
  // false, so every dashboard poll re-probed every other provider upstream.
  expect(third).toBe(second);
  expect(third.generatedAt).toBe(second.generatedAt);
  expect(third.reports.some(report => report.provider === "meta-muse")).toBe(true);
});

test("the row survives repeated reads instead of aging out of the merge", async () => {
  await seedObservation(OBSERVED_AGE_MS);
  await fetchProviderQuotaReports(config());
  // Forced reads bypass the cache and re-run the previous/fresh merge each time.
  const forced = await fetchProviderQuotaReports(config(), true);
  const again = await fetchProviderQuotaReports(config(), true);

  expect(forced.reports.some(report => report.provider === "meta-muse")).toBe(true);
  expect(again.reports.some(report => report.provider === "meta-muse")).toBe(true);
});
