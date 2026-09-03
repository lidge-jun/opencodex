/**
 * End-to-end cover for the two seams the parser and cache tests cannot reach: the SSE
 * observation that WRITES the quota, and the management route that READS it back.
 *
 * A green parser plus a green cache still leaves the feature able to record nothing --
 * that is exactly the gap an audit flagged here -- so these tests drive the real
 * inspector and the real route handler rather than the helpers underneath them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSseInspector } from "../src/server/relay";
import { handleOauthAccountRoutes } from "../src/server/management/oauth-account-routes";
import {
  clearAccountQuotaCache,
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  getCachedProviderAccountQuota,
  recordPassiveAccountQuota,
  resetProviderQuotaReconcileStateForTests,
} from "../src/providers/quota";
import {
  isMuseSubscriptionUsagePayload,
  MUSE_SUBSCRIPTION_USAGE_TYPE,
  parseMuseSubscriptionUsage,
} from "../src/providers/muse-subscription-usage";
import { captureConfigGeneration } from "../src/lib/state-store-sweeper";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let testDir = "";

const ACCOUNT_ID = "muse-acct-1";

function museConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "meta-muse",
    providers: {
      "meta-muse": { adapter: "openai-responses", baseUrl: "https://api.meta.ai/v1", authMode: "oauth" },
    },
  } as OcxConfig;
}

function writeMuseAccount(): void {
  writeFileSync(join(testDir, "auth.json"), JSON.stringify({
    "meta-muse": {
      activeAccountId: ACCOUNT_ID,
      accounts: [
        { id: ACCOUNT_ID, credential: { access: "LLM|1|k", refresh: "LLM|1|k", expires: 9999999999999, email: "muse@example.com", accountId: "muse-1" } },
      ],
    },
  }), { mode: 0o600 });
}

/** The frame Meta emits, wrapped as it arrives on the wire. */
function usageFrame(fiveHour: number, weekly: number): string {
  return `data: ${JSON.stringify({
    type: MUSE_SUBSCRIPTION_USAGE_TYPE,
    subscription: {
      tier: "27681393394859588",
      window: { used_percent: fiveHour, resets_at: 1788431188, window_duration_mins: 300 },
      weekly: { used_percent: weekly, resets_at: 1788739200 },
    },
  })}\n\n`;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-muse-observe-"));
  process.env.OPENCODEX_HOME = testDir;
  writeMuseAccount();
  clearAccountQuotaCache();
  // The provider-level report cache (5-minute TTL, module-wide) survives across tests in
  // this file and would hand one test the previous test's row.
  clearProviderQuotaCache();
  resetProviderQuotaReconcileStateForTests();
});

afterEach(() => {
  clearAccountQuotaCache();
  clearProviderQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

/**
 * Mirrors the handler core.ts installs on onParsedPayload. Kept in the test rather than
 * exported from core.ts so the assertion is about the OBSERVED BEHAVIOUR of the seam --
 * a frame in, a cache row out -- not about a helper's signature.
 */
function observePayload(payload: unknown, servingAccountId: string | null, generation: number): void {
  if (!isMuseSubscriptionUsagePayload(payload)) return;
  const quota = parseMuseSubscriptionUsage(payload);
  if (quota && servingAccountId) recordPassiveAccountQuota("meta-muse", servingAccountId, quota, generation);
}

describe("Muse subscription usage observed on the SSE seam", () => {
  test("a stream carrying the frame writes the serving account's quota", () => {
    const generation = captureConfigGeneration();
    const inspector = createSseInspector({
      onParsedPayload: payload => observePayload(payload, ACCOUNT_ID, generation),
    });
    const encoder = new TextEncoder();
    inspector.feed(encoder.encode(`data: ${JSON.stringify({ type: "response.created" })}\n\n`));
    inspector.feed(encoder.encode(usageFrame(12, 34)));
    inspector.feed(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`));
    inspector.finish();
    inspector.dispose();

    const quota = getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID);
    expect(quota?.fiveHourPercent).toBe(12);
    expect(quota?.weeklyPercent).toBe(34);
  });

  test("a stream without the frame writes nothing", () => {
    const generation = captureConfigGeneration();
    const inspector = createSseInspector({
      onParsedPayload: payload => observePayload(payload, ACCOUNT_ID, generation),
    });
    const encoder = new TextEncoder();
    inspector.feed(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`));
    inspector.feed(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`));
    inspector.finish();
    inspector.dispose();

    expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
  });

  test("the frame is observed even when no serving account is known", () => {
    const generation = captureConfigGeneration();
    const inspector = createSseInspector({
      onParsedPayload: payload => observePayload(payload, null, generation),
    });
    inspector.feed(new TextEncoder().encode(usageFrame(50, 60)));
    inspector.finish();
    inspector.dispose();
    // No attribution target: nothing is filed, and nothing throws.
    expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
  });

  /*
   * relay.ts wraps onParsedPayload in a try/catch so inspection can never throw into the
   * relay pump. Asserted here so a later refactor cannot quietly remove the guarantee
   * this feature relies on to be safe on a live request.
   */
  test("a throwing observer does not break the stream", () => {
    const inspector = createSseInspector({
      onParsedPayload: () => { throw new Error("observer exploded"); },
    });
    const encoder = new TextEncoder();
    expect(() => {
      inspector.feed(encoder.encode(usageFrame(1, 2)));
      inspector.feed(encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`));
      inspector.finish();
    }).not.toThrow();
    inspector.dispose();
  });
});

describe("GET /api/oauth/accounts?quota=1 for a passive provider", () => {
  async function getAccounts(query: string): Promise<{ status: number; body: { accounts?: Array<{ id: string; quota?: { fiveHourPercent?: number } | null; quotaUnavailable?: boolean }> } }> {
    const request = new Request(`http://localhost/api/oauth/accounts?${query}`);
    const response = await handleOauthAccountRoutes({
      req: request,
      url: new URL(request.url),
      config: museConfig(),
      deps: {},
      convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    return { status: response!.status, body: await response!.json() as never };
  }

  test("returns the observed quota without probing", async () => {
    recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 21, updatedAt: Date.now() }, captureConfigGeneration());
    const { status, body } = await getAccounts("provider=meta-muse&quota=1");
    expect(status).toBe(200);
    expect(body.accounts?.[0]?.quota?.fiveHourPercent).toBe(21);
  });

  test("refresh=1 is a no-op rather than an error: there is nothing to refresh", async () => {
    recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 21, updatedAt: Date.now() }, captureConfigGeneration());
    const { status, body } = await getAccounts("provider=meta-muse&quota=1&refresh=1");
    expect(status).toBe(200);
    expect(body.accounts?.[0]?.quota?.fiveHourPercent).toBe(21);
  });

  /*
   * No observation is not a failed probe. `quotaUnavailable` would claim an attempt that
   * never happened, and the dashboard renders it as a warning.
   */
  test("an account with no observation carries no quota and no unavailable flag", async () => {
    const { status, body } = await getAccounts("provider=meta-muse&quota=1");
    expect(status).toBe(200);
    expect(body.accounts?.[0]?.quota).toBeUndefined();
    expect(body.accounts?.[0]?.quotaUnavailable).toBeUndefined();
  });

  test("the plain list is unchanged when quota is not requested", async () => {
    recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 21, updatedAt: Date.now() }, captureConfigGeneration());
    const { status, body } = await getAccounts("provider=meta-muse");
    expect(status).toBe(200);
    expect(body.accounts?.[0]?.quota).toBeUndefined();
  });
});

describe("provider-level quota row for a passive provider", () => {
  test("carries the active account's observation with its observation time", async () => {
    const observedAt = Date.now() - 12 * 60_000;
    recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 21, weeklyPercent: 8, updatedAt: observedAt }, captureConfigGeneration());

    const response = await fetchProviderQuotaReports(museConfig(), true);
    const report = response.reports.find(row => row.provider === "meta-muse");

    expect(report?.quota?.fiveHourPercent).toBe(21);
    expect(report?.quota?.weeklyPercent).toBe(8);
    expect(report?.source).toBe("meta-muse:subscription-observation");
    // The observation time IS the report time; both GUI surfaces render it as the age.
    expect(report?.updatedAt).toBe(observedAt);
  });

  /*
   * The defining constraint of a passive provider: reading the provider row must never
   * contact upstream, even when the GUI's refresh button passes refresh=1. Stubbing
   * fetch to throw proves no code path reaches the network.
   */
  test("reads the row without any network call, including under refresh=1", async () => {
    recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 33, updatedAt: Date.now() }, captureConfigGeneration());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("upstream contact forbidden for a passive provider"))) as typeof fetch;
    try {
      const response = await fetchProviderQuotaReports(museConfig(), true);
      const report = response.reports.find(row => row.provider === "meta-muse");
      expect(report?.quota?.fiveHourPercent).toBe(33);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("no observation means no row, not an empty one", async () => {
    const response = await fetchProviderQuotaReports(museConfig(), true);
    expect(response.reports.find(row => row.provider === "meta-muse")).toBeUndefined();
  });

  /*
   * The provider row answers for the account IN USE, like fetchAnthropicQuota and
   * fetchKiroQuota do. A fresher observation on an inactive account must not leak into
   * the row the user reads as "my current usage".
   */
  test("never promotes an inactive account's observation", async () => {
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      "meta-muse": {
        activeAccountId: ACCOUNT_ID,
        accounts: [
          { id: ACCOUNT_ID, credential: { access: "LLM|1|k", refresh: "LLM|1|k", expires: 9999999999999, email: "muse@example.com", accountId: "muse-1" } },
          { id: "acct-muse-2", credential: { access: "LLM|2|k", refresh: "LLM|2|k", expires: 9999999999999, email: "two@example.com", accountId: "muse-2" } },
        ],
      },
    }), { mode: 0o600 });
    recordPassiveAccountQuota("meta-muse", "acct-muse-2", { fiveHourPercent: 77, updatedAt: Date.now() }, captureConfigGeneration());

    const response = await fetchProviderQuotaReports(museConfig(), true);
    expect(response.reports.find(row => row.provider === "meta-muse")).toBeUndefined();
  });
});
