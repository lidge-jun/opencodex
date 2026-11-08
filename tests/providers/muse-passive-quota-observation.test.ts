/**
 * End-to-end cover for the two seams the parser and cache tests cannot reach: the SSE
 * observation that WRITES the quota, and the management route that READS it back.
 *
 * A green parser plus a green cache still leaves the feature able to record nothing --
 * that is exactly the gap an audit flagged here -- so these tests drive the real
 * inspector and the real route handler rather than the helpers underneath them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSseInspector } from "../../src/server/relay";
import { handleOauthAccountRoutes } from "../../src/server/management/oauth-account-routes";
import {
  clearAccountQuotaCache,
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  flushProviderQuotaObservationsForTests,
  getCachedProviderAccountQuota,
  recordPassiveAccountQuota as recordWithOwner,
  resetProviderQuotaReconcileStateForTests,
} from "../../src/providers/quota";
import {
  isMuseSubscriptionUsagePayload,
  MUSE_SUBSCRIPTION_USAGE_TYPE,
  parseMuseSubscriptionUsage,
} from "../../src/providers/muse-subscription-usage";
import { captureConfigGeneration, setStateStoreLiveConfigReader } from "../../src/lib/state-store-sweeper";
import { getAccountSet, saveAccountCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { heldProviderQuotaReports, isProviderQuotaReportCurrent, setProviderQuotaBeforeObservationForTests } from "../../src/providers/quota/report-cache";
import { fetchMuseKeyQuota, fetchPassiveProviderQuota } from "../../src/providers/quota/vendor-probes-oauth";
import { bindMuseQuotaConfig, captureMuseQuotaOwner, type MuseQuotaOwner } from "../../src/providers/quota/muse-owner";
import { resetMuseKeyQuotaBackoff } from "../../src/providers/muse-key-quota";
import { registerDecisionQuotaSink, type DecisionQuotaSink } from "../../src/lib/decision-quota-sink";
import { handleResponses } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { setQuotaResetSink } from "../../src/quota/reset-observer";
import { resetQuotaResetStoreForTests } from "../../src/quota/reset-seen-store";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearGenericFailoverHealth, preferredInitialAccount } from "../../src/oauth/generic-account-failover";
import { sweepExpiredProviderAccountQuotaRows } from "../../src/providers/quota/account-cache";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { reconcileLiveStateStores, setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { hasHeadroomEvidence, rankAccountsByHeadroom } from "../../src/oauth/account-quota-rank";
import { readPersistedAccountQuotas } from "../../src/providers/account-quota-disk";
import { ensureQuotaPoolIdentity } from "../../src/quota-pool/identity";
import { readQuotaPool } from "../../src/quota-pool/assemble";

const previousHome = process.env.OPENCODEX_HOME;
let testDir = "";

const ACCOUNT_ID = "muse-acct-1";

function recordPassiveAccountQuota(provider: string, id: string, quota: import("../../src/providers/quota-types").ProviderQuota,
  generation: number, owner: MuseQuotaOwner | null = bindMuseQuotaConfig(captureMuseQuotaOwner(provider, id), museConfig(), provider)): void {
  recordWithOwner(provider, id, quota, generation, owner);
}

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

function writeTwoAccounts(withToken = false): void {
  writeFileSync(join(testDir, "auth.json"), JSON.stringify({ "meta-muse": {
    activeAccountId: ACCOUNT_ID,
    accounts: [
      { id: ACCOUNT_ID, credential: { access: "a", refresh: "a", expires: 9999999999999,
        ...(withToken ? { muse: { oauthAccessToken: "account-token-a" } } : {}) } },
      { id: "account-b", credential: { access: "b", refresh: "b", expires: 9999999999999 } },
    ],
  } }), { mode: 0o600 });
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
  resetMuseKeyQuotaBackoff();
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
  test.each(["detached", "no-live", "late-adoption"] as const)("physical Muse observation cannot overwrite another configuration (%s)", async mode => {
    writeTwoAccounts();
    const config = museConfig(), originalFetch = globalThis.fetch;
    setLiveStateStoreConfig(config);
    const owner = bindMuseQuotaConfig(captureMuseQuotaOwner("meta-muse", ACCOUNT_ID), config, "meta-muse");
    recordWithOwner("meta-muse", ACCOUNT_ID, { fiveHourPercent: 40, updatedAt: Date.now() }, captureConfigGeneration(), owner);
    await Bun.sleep(400);
    if (mode !== "detached") { clearAccountQuotaCache(); setStateStoreLiveConfigReader(() => null); }
    const changed = structuredClone(config);
    changed.providers["meta-muse"]!.baseUrl = "https://other.example/v1";
    globalThis.fetch = (async () => new Response(usageFrame(80, 20) + 'data: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "meta-muse/muse-spark-1.3", stream: true, input: "hello" }),
      }), changed, { model: "", provider: "" });
      expect(response.status).toBe(200);
      if (mode === "late-adoption") setLiveStateStoreConfig(config);
      await response.text();
      if (mode === "no-live") setLiveStateStoreConfig(config);
      reconcileLiveStateStores();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
    } finally { release(); setLiveStateStoreConfig(config); globalThis.fetch = originalFetch; }
  });

  test("physical observations survive unrelated reconciliation for display, ranking, persistence and reset continuity", async () => {
    writeTwoAccounts();
    const config = museConfig(), events: unknown[] = [], original = globalThis.fetch;
    let percent = 95, resetAt = Math.floor(Date.now() / 1000) - 1;
    setLiveStateStoreConfig(config);
    resetQuotaResetStoreForTests();
    setQuotaResetSink(event => events.push(event));
    globalThis.fetch = (async () => new Response(`data: ${JSON.stringify({
      type: MUSE_SUBSCRIPTION_USAGE_TYPE,
      subscription: { window: { used_percent: percent, resets_at: resetAt, window_duration_mins: 300 } },
    })}\n\ndata: {"type":"response.completed","response":{"id":"resp-test","status":"completed","output":[]}}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const release = acquireOwnedSpendHome();
    const send = async () => {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "meta-muse/muse-spark-1.3", stream: true, input: "hello" }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
    };
    try {
      await send();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(95);
      await fetchProviderQuotaReports(config, true);
      await flushProviderQuotaObservationsForTests();
      expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
      reconcileLiveStateStores();
      percent = 90;
      await send();
      reconcileLiveStateStores();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(95);
      expect(getCachedProviderAccountQuota("meta-muse", "account-b")?.fiveHourPercent).toBe(90);
      const request = new Request("http://localhost/api/oauth/accounts?provider=meta-muse&quota=1");
      const accountResponse = await handleOauthAccountRoutes({ req: request, url: new URL(request.url), config, deps: {},
        convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }), syncClaudeAgentDefsBestEffort: async () => {} });
      const accountBody = await accountResponse!.json() as { accounts: Array<{ id: string; quota?: { fiveHourPercent?: number } }> };
      expect(accountBody.accounts.find(row => row.id === ACCOUNT_ID)?.quota?.fiveHourPercent).toBe(95);
      expect(accountBody.accounts.find(row => row.id === "account-b")?.quota?.fiveHourPercent).toBe(90);
      const ids = [ACCOUNT_ID, "account-b"];
      expect(hasHeadroomEvidence("meta-muse", ids)).toBe(true);
      expect(rankAccountsByHeadroom("meta-muse", ids)[0]).toBe("account-b");
      await Bun.sleep(400);
      expect(readPersistedAccountQuotas().get(`meta-muse\0${ACCOUNT_ID}`)?.fiveHourPercent).toBe(95);
      expect(readPersistedAccountQuotas().get("meta-muse\0account-b")?.fiveHourPercent).toBe(90);
      expect(await setActiveAccount("meta-muse", ACCOUNT_ID)).toBe(true);
      reconcileLiveStateStores();
      expect((await fetchProviderQuotaReports(config, true)).reports[0]?.quota.fiveHourPercent).toBe(95);
      percent = 2; resetAt = Math.floor(Date.now() / 1000) + 3600;
      await send();
      await fetchProviderQuotaReports(config, true);
      await flushProviderQuotaObservationsForTests();
      expect(events).toHaveLength(1);
    } finally {
      release(); globalThis.fetch = original; setQuotaResetSink(null); resetQuotaResetStoreForTests();
    }
  });
  test.each([false, true])("deferred pre-output reset binds quota to the delivering send (reset=%s)", async reset => {
    writeTwoAccounts();
    const config = museConfig();
    config.providers["meta-muse"]!.retryOnReset = {};
    const original = globalThis.fetch;
    let sends = 0;
    let failFirst!: () => void;
    const trigger = new Promise<void>(resolve => { failFirst = resolve; });
    globalThis.fetch = (async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer a");
      sends++;
      if (reset && sends === 1) return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await trigger;
          controller.error(Object.assign(new Error("fixture pre-output reset"), { code: "ECONNRESET" }));
        },
      }), { headers: { "content-type": "text/event-stream" } });
      return new Response(usageFrame(90, 20) + 'data: {"type":"response.completed","response":{"id":"resp-recovery","status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "meta-muse/muse-spark-1.3", stream: true, store: false, input: "hello" }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      failFirst();
      expect(await response.text()).toContain("resp-recovery");
      expect(sends).toBe(reset ? 2 : 1);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(90);
      expect(getCachedProviderAccountQuota("meta-muse", "account-b")).toBeNull();
    } finally { failFirst(); release(); globalThis.fetch = original; }
  });
  test.each(["selection", "authorization", "destination"])("deferred replacement preserves the %s ownership fence", async mutation => {
    writeTwoAccounts();
    const config = museConfig();
    config.providers["meta-muse"]!.retryOnReset = {};
    const original = globalThis.fetch;
    let sends = 0;
    let failFirst!: () => void;
    const trigger = new Promise<void>(resolve => { failFirst = resolve; });
    const unregister = registerUpstreamRewriter("muse-recovery-fence-test", target => {
      if (sends === 0) return;
      if (mutation === "authorization") target.headers.set("authorization", "Bearer synthetic-override");
      if (mutation === "destination") target.url = "https://other.example/v1/responses";
    });
    globalThis.fetch = (async () => {
      sends++;
      if (sends === 1) return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await trigger;
          controller.error(Object.assign(new Error("fixture pre-output reset"), { code: "ECONNRESET" }));
        },
      }), { headers: { "content-type": "text/event-stream" } });
      return new Response(usageFrame(90, 20) + 'data: {"type":"response.completed","response":{"id":"resp-recovery","status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "meta-muse/muse-spark-1.3", stream: true, store: false, input: "hello" }),
      }), config, { model: "", provider: "" });
      if (mutation === "selection") expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
      failFirst();
      const text = await response.text();
      expect(sends).toBe(mutation === "selection" ? 1 : 2);
      expect(text).toContain(mutation === "selection" ? "response.failed" : "resp-recovery");
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
      expect(getCachedProviderAccountQuota("meta-muse", "account-b")).toBeNull();
    } finally { failFirst(); unregister(); release(); globalThis.fetch = original; }
  });
  test("selection changed after the replacement send cannot publish its quota", async () => {
    writeTwoAccounts();
    const config = museConfig();
    config.providers["meta-muse"]!.retryOnReset = {};
    const original = globalThis.fetch;
    let sends = 0;
    let failFirst!: () => void, releaseReplacement!: () => void, replacementSent!: () => void;
    const trigger = new Promise<void>(resolve => { failFirst = resolve; });
    const gate = new Promise<void>(resolve => { releaseReplacement = resolve; });
    const sent = new Promise<void>(resolve => { replacementSent = resolve; });
    globalThis.fetch = (async () => {
      sends++;
      if (sends === 1) return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await trigger;
          controller.error(Object.assign(new Error("fixture pre-output reset"), { code: "ECONNRESET" }));
        },
      }), { headers: { "content-type": "text/event-stream" } });
      replacementSent();
      await gate;
      return new Response(usageFrame(90, 20) + 'data: {"type":"response.completed","response":{"id":"resp-recovery","status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "meta-muse/muse-spark-1.3", stream: true, store: false, input: "hello" }),
      }), config, { model: "", provider: "" });
      const body = response.text();
      failFirst();
      await sent;
      expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
      releaseReplacement();
      expect(await body).toContain("resp-recovery");
      expect(sends).toBe(2);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
      expect(getCachedProviderAccountQuota("meta-muse", "account-b")).toBeNull();
    } finally { failFirst(); releaseReplacement(); release(); globalThis.fetch = original; }
  });
  test("a quota frame on the original stream commits it before a reset", async () => {
    writeTwoAccounts();
    const config = museConfig();
    config.providers["meta-muse"]!.retryOnReset = {};
    const original = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends++;
      let emitted = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) { emitted = true; controller.enqueue(new TextEncoder().encode(usageFrame(40, 20))); }
          else controller.error(Object.assign(new Error("fixture post-frame reset"), { code: "ECONNRESET" }));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "meta-muse/muse-spark-1.3", stream: true, store: false, input: "hello" }),
      }), config, { model: "", provider: "" });
      expect(await response.text()).toContain("response.failed");
      expect(sends).toBe(1);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
      expect(getCachedProviderAccountQuota("meta-muse", "account-b")).toBeNull();
    } finally { release(); globalThis.fetch = original; }
  });
  test("affinity failover attributes the successful physical response to its serving account", async () => {
    writeTwoAccounts();
    clearGenericFailoverHealth();
    recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 10, updatedAt: Date.now() }, captureConfigGeneration());
    const config = museConfig();
    config.providers["meta-muse"]!.oauthAccountFailover = { enabled: true, sessionAffinity: "conversation" };
    const original = globalThis.fetch, sends: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      sends.push(auth);
      if (auth === "Bearer a") return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "60" } });
      return new Response(usageFrame(90, 20) + 'data: {"type":"response.completed","response":{"id":"resp-test","status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", "session-id": "muse-affinity-test" },
        body: JSON.stringify({ model: "meta-muse/muse-spark-1.3", stream: true, input: "hello" }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(sends).toEqual(["Bearer a", "Bearer b"]);
      expect((await import("../../src/oauth/store")).getAccountSet("meta-muse")?.activeAccountId).toBe(ACCOUNT_ID);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(10);
      expect(getCachedProviderAccountQuota("meta-muse", "account-b")?.fiveHourPercent).toBe(90);
    } finally { release(); globalThis.fetch = original; clearGenericFailoverHealth(); }
  });
  test.each(["configured header", "rewritten header", "rewritten destination"])("%s cannot attribute usage to the selected account", async kind => {
    const config = museConfig(), original = globalThis.fetch;
    if (kind === "configured header") config.providers["meta-muse"]!.headers = { Authorization: "Bearer synthetic-override" };
    const unregister = registerUpstreamRewriter("muse-ownership-test", target => {
      if (kind === "rewritten header") target.headers.set("authorization", "Bearer synthetic-override");
      if (kind === "rewritten destination") target.url = "https://other.example/v1/responses";
    });
    globalThis.fetch = (async () => new Response(usageFrame(40, 20) + 'data: {"type":"response.completed","response":{"id":"resp-test","status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "meta-muse/muse-spark-1.3", stream: true, input: "hello" }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
    } finally { unregister(); release(); globalThis.fetch = original; }
  });
  test.each([false, true])("real Responses dispatch checks account ABA (switch=%s)", async switched => {
    writeTwoAccounts();
    const original = globalThis.fetch;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    globalThis.fetch = (async () => new Response(stream, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "meta-muse/muse-spark-1.3", stream: true, input: "hello" }),
      }), museConfig(), { model: "", provider: "" });
      expect(response.status).toBe(200);
      if (switched) {
        expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
        expect(await setActiveAccount("meta-muse", ACCOUNT_ID)).toBe(true);
      }
      controller.enqueue(new TextEncoder().encode(usageFrame(40, 20) + 'data: {"type":"response.completed","response":{"id":"resp-test","status":"completed","output":[]}}\n\ndata: [DONE]\n\n'));
      controller.close();
      await response.text();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(switched ? undefined : 40);
    } finally { release(); globalThis.fetch = original; }
  });
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
  test.each(["live", "no-live"] as const)("Muse account ranking and pool reject a detached configuration (%s)", async mode => {
    writeTwoAccounts();
    const config = museConfig();
    config.oauthAccountFailover = { enabled: true };
    setLiveStateStoreConfig(config);
    for (const [id, percent] of [[ACCOUNT_ID, 100], ["account-b", 10]] as const) {
      await setActiveAccount("meta-muse", id);
      recordWithOwner("meta-muse", id, { fiveHourPercent: percent, updatedAt: Date.now() }, captureConfigGeneration(),
        bindMuseQuotaConfig(captureMuseQuotaOwner("meta-muse", id), config, "meta-muse"));
    }
    await setActiveAccount("meta-muse", ACCOUNT_ID);
    if (mode === "no-live") setStateStoreLiveConfigReader(() => null);
    const changed = structuredClone(config);
    changed.providers["meta-muse"]!.baseUrl = "https://other.example/v1";
    const ids = [ACCOUNT_ID, "account-b"];
    try {
      expect(hasHeadroomEvidence("meta-muse", ids, undefined, undefined, config)).toBe(true);
      expect(rankAccountsByHeadroom("meta-muse", ids, undefined, undefined, config)).toEqual(["account-b", ACCOUNT_ID]);
      expect(preferredInitialAccount(config, "meta-muse")).toBe("account-b");
      expect(hasHeadroomEvidence("meta-muse", ids, undefined, undefined, changed)).toBe(false);
      expect(rankAccountsByHeadroom("meta-muse", ids, undefined, undefined, changed)).toEqual(ids);
      expect(preferredInitialAccount(changed, "meta-muse")).toBeNull();
      ensureQuotaPoolIdentity();
      const pool = await readQuotaPool(changed);
      if (!pool.ok) throw new Error(pool.error);
      const row = pool.pool.providers.find(value => value.provider === "meta-muse")!;
      expect(row.accounts.map(account => account.windows)).toEqual([[], []]);
      expect(row.pooled.windows).toEqual([]);
      const request = new Request("http://localhost/api/oauth/accounts?provider=meta-muse&quota=1");
      const response = await handleOauthAccountRoutes({ req: request, url: new URL(request.url), config: changed, deps: {},
        convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }), syncClaudeAgentDefsBestEffort: async () => {} });
      const body = await response!.json() as { accounts: Array<{ quota?: unknown }> };
      expect(body.accounts.map(account => account.quota)).toEqual([undefined, undefined]);
      expect(hasHeadroomEvidence("meta-muse", ids, undefined, undefined, config)).toBe(true);
    } finally { setLiveStateStoreConfig(config); }
  });

  test("standalone passive fallback restores only a matching saved Muse configuration", async () => {
    writeTwoAccounts();
    const config = museConfig();
    setLiveStateStoreConfig(config);
    recordWithOwner("meta-muse", ACCOUNT_ID, { fiveHourPercent: 40, updatedAt: Date.now() }, captureConfigGeneration(),
      bindMuseQuotaConfig(captureMuseQuotaOwner("meta-muse", ACCOUNT_ID), config, "meta-muse"));
    try {
      await Bun.sleep(400);
      clearAccountQuotaCache(); setStateStoreLiveConfigReader(() => null);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
      const result = await fetchProviderQuotaReports(config, true);
      expect(result.reports.find(row => row.provider === "meta-muse")?.quota.fiveHourPercent).toBe(40);
    } finally { setLiveStateStoreConfig(config); }
  });

  test.each(["unchanged", "destination", "adapter", "auth"] as const)("persisted Muse quota requires matching provider configuration after restart (%s)", async change => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setLiveStateStoreConfig(config);
    globalThis.fetch = (async () => Response.json({ is_subs_active: true,
      subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } })) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      await Bun.sleep(400);
      clearAccountQuotaCache();
      const restarted = structuredClone(config);
      if (change === "destination") restarted.providers["meta-muse"]!.baseUrl = "https://other.example/v1";
      if (change === "adapter") restarted.providers["meta-muse"]!.adapter = "openai-chat";
      if (change === "auth") restarted.providers["meta-muse"]!.authMode = "key";
      setLiveStateStoreConfig(restarted);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent ?? null).toBe(change === "unchanged" ? 40 : null);
      reconcileLiveStateStores();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent ?? null).toBe(change === "unchanged" ? 40 : null);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("a hydrated Muse quota stays unknown until the live provider is established", async () => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setLiveStateStoreConfig(config);
    globalThis.fetch = (async () => Response.json({ is_subs_active: true,
      subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } })) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      await Bun.sleep(400);
      clearAccountQuotaCache();
      setStateStoreLiveConfigReader(() => null);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
      setLiveStateStoreConfig(config);
      reconcileLiveStateStores();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
    } finally { setLiveStateStoreConfig(config); globalThis.fetch = originalFetch; }
  });

  test.each(["no-live", "detached"] as const)("provider-level Muse fallback rejects a mismatched %s configuration", async mode => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setLiveStateStoreConfig(config);
    globalThis.fetch = (async () => Response.json({ is_subs_active: true,
      subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } })) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      await Bun.sleep(400);
      if (mode === "no-live") { clearAccountQuotaCache(); setStateStoreLiveConfigReader(() => null); }
      const changed = structuredClone(config);
      changed.providers["meta-muse"]!.baseUrl = "https://other.example/v1";
      const result = await fetchProviderQuotaReports(changed, true);
      expect(result.reports.find(row => row.provider === "meta-muse")).toBeUndefined();
      if (mode === "detached") expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
    } finally { setLiveStateStoreConfig(config); globalThis.fetch = originalFetch; }
  });

  test.each(["equivalent", "changed"] as const)("a successful detached Muse probe cannot replace the live quota (%s)", async mode => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setLiveStateStoreConfig(config);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ is_subs_active: true,
      subs_usage: { window: { used_percent: calls === 1 ? 40 : 80, window_duration_mins: 300 } } }); }) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      resetMuseKeyQuotaBackoff(); // Exercise an otherwise eligible successful probe after mint spacing.
      const detached = structuredClone(config);
      if (mode === "changed") detached.providers["meta-muse"]!.baseUrl = "https://other.example/v1";
      expect(await fetchMuseKeyQuota("meta-muse", detached)).toBeNull();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("a Muse probe cannot publish when a different live configuration is adopted while it waits", async () => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setStateStoreLiveConfigReader(() => null);
    let release!: (response: Response) => void, started!: () => void;
    const called = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = (() => { started(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
    try {
      const pending = fetchMuseKeyQuota("meta-muse", config);
      await called;
      setLiveStateStoreConfig(structuredClone(config));
      release(Response.json({ is_subs_active: true, subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } }));
      expect(await pending).toBeNull();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
    } finally { setLiveStateStoreConfig(config); globalThis.fetch = originalFetch; }
  });

  test("a no-live Muse probe cannot overwrite a persisted row owned by another configuration", async () => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setLiveStateStoreConfig(config);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ is_subs_active: true,
      subs_usage: { window: { used_percent: calls === 1 ? 40 : 80, window_duration_mins: 300 } } }); }) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      await Bun.sleep(400);
      clearAccountQuotaCache(); resetMuseKeyQuotaBackoff();
      setStateStoreLiveConfigReader(() => null);
      const changed = structuredClone(config);
      changed.providers["meta-muse"]!.baseUrl = "https://other.example/v1";
      expect(await fetchMuseKeyQuota("meta-muse", changed)).toBeNull();
      await Bun.sleep(400);
      clearAccountQuotaCache(); setLiveStateStoreConfig(config); reconcileLiveStateStores();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
    } finally { setLiveStateStoreConfig(config); globalThis.fetch = originalFetch; }
  });

  test("concurrent no-live Muse probes cannot join another configuration's published quota", async () => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setStateStoreLiveConfigReader(() => null);
    let release!: (response: Response) => void, started!: () => void;
    const called = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = (() => { started(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
    try {
      const first = fetchMuseKeyQuota("meta-muse", config);
      await called;
      const changed = structuredClone(config);
      changed.providers["meta-muse"]!.baseUrl = "https://other.example/v1";
      const second = fetchMuseKeyQuota("meta-muse", changed);
      release(Response.json({ is_subs_active: true, subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } }));
      const [a, b] = await Promise.all([first, second]);
      expect(a?.quota.fiveHourPercent).toBe(40);
      expect(b).toBeNull();
      setLiveStateStoreConfig(config);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
    } finally { setLiveStateStoreConfig(config); globalThis.fetch = originalFetch; }
  });

  test("a held passive Muse report rechecks the caller's configuration without retiring its live owner", async () => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setLiveStateStoreConfig(config);
    globalThis.fetch = (async () => Response.json({ is_subs_active: true,
      subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } })) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      const detached = structuredClone(config);
      const held = await fetchPassiveProviderQuota("meta-muse", detached);
      expect(held?.quota.fiveHourPercent).toBe(40);
      expect(isProviderQuotaReportCurrent(held!)).toBe(true);
      detached.providers["meta-muse"]!.baseUrl = "https://other.example/v1";
      expect(isProviderQuotaReportCurrent(held!)).toBe(false);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
    } finally { globalThis.fetch = originalFetch; }
  });

  test.each(["missing", "malformed"] as const)("a persisted Muse row with %s config binding is not restored", async kind => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setLiveStateStoreConfig(config);
    globalThis.fetch = (async () => Response.json({ is_subs_active: true,
      subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } })) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      await Bun.sleep(400);
      const path = join(testDir, "provider-account-quota-cache.json");
      const disk = JSON.parse(readFileSync(path, "utf8"));
      const row = disk.rows[`meta-muse\0${ACCOUNT_ID}`];
      expect(row.museConfigIdentity).toMatch(/^[a-f0-9]{64}$/);
      if (kind === "missing") delete row.museConfigIdentity; else row.museConfigIdentity = "invalid";
      writeFileSync(path, JSON.stringify(disk));
      clearAccountQuotaCache();
      reconcileLiveStateStores();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
    } finally { globalThis.fetch = originalFetch; }
  });

  test.each((["removed", "replaced", "disabled", "destination", "auth"] as const).flatMap(change =>
    [false, true].map(hydrated => ({ change, hydrated }))))("accepted bound row retires on $change, including after hydration=$hydrated", async ({ change, hydrated }) => {
    writeTwoAccounts(true);
    const config = museConfig(), original = globalThis.fetch;
    const provider = config.providers["meta-muse"]!;
    setLiveStateStoreConfig(config);
    globalThis.fetch = (async () => new Response(JSON.stringify({ is_subs_active: true,
      subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } }))) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      await Bun.sleep(400);
      if (hydrated) {
        clearAccountQuotaCache();
        reconcileLiveStateStores();
        expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
      }
      if (change === "removed") delete config.providers["meta-muse"];
      else if (change === "replaced") config.providers["meta-muse"] = { ...provider };
      else if (change === "disabled") provider.disabled = true;
      else if (change === "destination") provider.baseUrl = "https://elsewhere.example/v1";
      else provider.authMode = "api-key";
      reconcileLiveStateStores();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
      config.providers["meta-muse"] = provider;
      provider.disabled = false; provider.baseUrl = "https://api.meta.ai/v1"; provider.authMode = "oauth";
      reconcileLiveStateStores();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
      await Bun.sleep(400);
      clearAccountQuotaCache();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
    } finally { globalThis.fetch = original; }
  });

  test("unrelated reconciliation fences an in-flight production-bound key probe", async () => {
    writeTwoAccounts(true);
    const config = museConfig(), original = globalThis.fetch;
    setLiveStateStoreConfig(config);
    let release!: (response: Response) => void, started!: () => void;
    const called = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = (() => { started(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
    try {
      const pending = fetchMuseKeyQuota("meta-muse", config);
      await called;
      reconcileLiveStateStores();
      release(new Response(JSON.stringify({ is_subs_active: true,
        subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } })));
      expect(await pending).toBeNull();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
    } finally { globalThis.fetch = original; }
  });

  test("a production-bound observation cannot revive after managed credential ABA", async () => {
    writeTwoAccounts(true);
    const config = museConfig(), originalFetch = globalThis.fetch;
    setLiveStateStoreConfig(config);
    globalThis.fetch = (async () => new Response(JSON.stringify({ is_subs_active: true,
      subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } }))) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      await Bun.sleep(400);
      const credential = getAccountSet("meta-muse")!.accounts.find(row => row.id === ACCOUNT_ID)!.credential;
      await saveAccountCredential("meta-muse", ACCOUNT_ID, { ...credential, access: "replacement" });
      await saveAccountCredential("meta-muse", ACCOUNT_ID, credential);
      reconcileLiveStateStores();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
      await Bun.sleep(400);
      clearAccountQuotaCache();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
    } finally { globalThis.fetch = originalFetch; }
  });

  test("an observed provider mismatch remains retired after an in-place ABA", async () => {
    writeTwoAccounts(true);
    const config = museConfig(), provider = config.providers["meta-muse"]!, originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ is_subs_active: true,
      subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } }))) as typeof fetch;
    try {
      expect((await fetchMuseKeyQuota("meta-muse", config))?.quota.fiveHourPercent).toBe(40);
      provider.baseUrl = "https://elsewhere.example/v1";
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
      provider.baseUrl = "https://api.meta.ai/v1";
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
    } finally { globalThis.fetch = originalFetch; }
  });
  test("cached and held reports retire after an active-account switch", async () => {
    writeTwoAccounts();
    const config = museConfig();
    recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 21, updatedAt: Date.now() }, captureConfigGeneration());
    expect((await fetchProviderQuotaReports(config, true)).reports).toHaveLength(1);
    expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
    expect(heldProviderQuotaReports(config).reports).toEqual([]);
    expect((await fetchProviderQuotaReports(config)).reports).toEqual([]);
    expect(await setActiveAccount("meta-muse", ACCOUNT_ID)).toBe(true);
    expect(heldProviderQuotaReports(config).reports).toEqual([]);
    expect((await fetchProviderQuotaReports(config)).reports[0]?.quota.fiveHourPercent).toBe(21);
  });

  test("external credential replacement invalidates a held report without passive side effects", async () => {
    const config = museConfig();
    recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 21, updatedAt: Date.now() }, captureConfigGeneration());
    expect((await fetchProviderQuotaReports(config, true)).reports).toHaveLength(1);
    const path = join(testDir, "auth.json");
    const store = JSON.parse(readFileSync(path, "utf8"));
    store["meta-muse"].accounts[0].credential.access = "replacement";
    writeFileSync(path, JSON.stringify(store));
    const bytes = readFileSync(path, "utf8"), mode = statSync(path).mode;
    let sinkCalls = 0, fetchCalls = 0;
    const detach = registerDecisionQuotaSink(new Proxy({} as DecisionQuotaSink, { get: () => () => { sinkCalls++; } }));
    const original = globalThis.fetch;
    globalThis.fetch = (() => { fetchCalls++; throw new Error("unexpected network"); }) as typeof fetch;
    try {
      expect(heldProviderQuotaReports(config).reports).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(statSync(path).mode).toBe(mode);
      expect(sinkCalls).toBe(0);
      expect(fetchCalls).toBe(0);
    } finally { globalThis.fetch = original; detach(); }
  });

  test("an in-band observation captured before an ABA switch cannot write", async () => {
    writeTwoAccounts();
    const owner = captureMuseQuotaOwner("meta-muse", ACCOUNT_ID);
    expect(owner).not.toBeNull();
    expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
    expect(await setActiveAccount("meta-muse", ACCOUNT_ID)).toBe(true);
    recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 90, updatedAt: Date.now() }, captureConfigGeneration(), owner);
    expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
  });

  test("a delayed key probe cannot publish after selection or credential change", async () => {
    writeTwoAccounts(true);
    let release!: (response: Response) => void;
    let started!: () => void;
    const called = new Promise<void>(resolve => { started = resolve; });
    const original = globalThis.fetch;
    globalThis.fetch = (() => { started(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
    try {
      const pending = fetchMuseKeyQuota("meta-muse", museConfig());
      await called;
      expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
      expect(await setActiveAccount("meta-muse", ACCOUNT_ID)).toBe(true);
      release(new Response(JSON.stringify({ is_subs_active: true, subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } })));
      expect(await pending).toBeNull();
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
    } finally { globalThis.fetch = original; }
  });

  test("key probe checks replacement, disabled provider, and cache reset before writing", async () => {
    for (const change of ["credential", "disabled", "paused", "reset"] as const) {
      writeTwoAccounts(true);
      clearAccountQuotaCache();
      resetMuseKeyQuotaBackoff();
      const config = museConfig();
      let release!: (response: Response) => void;
      let started!: () => void;
      const called = new Promise<void>(resolve => { started = resolve; });
      const original = globalThis.fetch;
      globalThis.fetch = (() => { started(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
      try {
        const pending = fetchMuseKeyQuota("meta-muse", config);
        await called;
        if (change === "credential") {
          const path = join(testDir, "auth.json"), store = JSON.parse(readFileSync(path, "utf8"));
          store["meta-muse"].accounts[0].credential.muse.oauthAccessToken = "new-account-token";
          writeFileSync(path, JSON.stringify(store));
        } else if (change === "disabled") config.providers["meta-muse"]!.disabled = true;
        else if (change === "paused") await setAccountPaused("meta-muse", ACCOUNT_ID, true);
        else clearAccountQuotaCache("meta-muse");
        release(new Response(JSON.stringify({ is_subs_active: true, subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } })));
        expect(await pending).toBeNull();
        expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)).toBeNull();
      } finally { globalThis.fetch = original; }
    }
  });

  test("an unchanged key probe publishes a bound report and cached row", async () => {
    writeTwoAccounts(true);
    const config = museConfig(), original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ is_subs_active: true,
      subs_usage: { window: { used_percent: 40, window_duration_mins: 300 } } }))) as typeof fetch;
    try {
      const response = await fetchProviderQuotaReports(config, true);
      expect(response.reports[0]?.source).toBe("meta-muse:key-endpoint");
      expect(response.reports[0]?.quota.fiveHourPercent).toBe(40);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
      expect(JSON.stringify(response)).not.toContain("account-token-a");
      expect(heldProviderQuotaReports(config).reports).toHaveLength(1);
      expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
      expect(heldProviderQuotaReports(config).reports).toEqual([]);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(40);
    } finally { globalThis.fetch = original; }
  });

  test.each([false, true])("delayed reset observation checks its owner (switch=%s)", async switched => {
    writeTwoAccounts();
    const config = museConfig(), events: unknown[] = [];
    resetQuotaResetStoreForTests();
    setQuotaResetSink(event => events.push(event));
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    try {
      recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 95, fiveHourResetAt: Date.now() - 1000, updatedAt: Date.now() }, captureConfigGeneration());
      await fetchProviderQuotaReports(config, true);
      await flushProviderQuotaObservationsForTests();
      setProviderQuotaBeforeObservationForTests(async () => { started(); await waiting; });
      recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 2, fiveHourResetAt: Date.now() + 3600000, updatedAt: Date.now() }, captureConfigGeneration());
      await fetchProviderQuotaReports(config, true);
      await entered;
      if (switched) expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
      setProviderQuotaBeforeObservationForTests(null);
      release();
      await flushProviderQuotaObservationsForTests();
      expect(events).toHaveLength(switched ? 0 : 1);
    } finally {
      setProviderQuotaBeforeObservationForTests(null);
      setQuotaResetSink(null);
      resetQuotaResetStoreForTests();
    }
  });
  test("an evicted row cannot publish a delayed reset", async () => {
    const config = museConfig(), events: unknown[] = [];
    resetQuotaResetStoreForTests();
    setQuotaResetSink(event => events.push(event));
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    try {
      recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 95, fiveHourResetAt: Date.now() - 1000, updatedAt: Date.now() }, captureConfigGeneration());
      await fetchProviderQuotaReports(config, true);
      await flushProviderQuotaObservationsForTests();
      setProviderQuotaBeforeObservationForTests(async () => { started(); await waiting; });
      recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 2, fiveHourResetAt: Date.now() + 3600000, updatedAt: Date.now() }, captureConfigGeneration());
      await fetchProviderQuotaReports(config, true);
      await entered;
      sweepExpiredProviderAccountQuotaRows(Date.now() + 24 * 60 * 60_000);
      setProviderQuotaBeforeObservationForTests(null);
      release();
      await flushProviderQuotaObservationsForTests();
      expect(events).toEqual([]);
    } finally {
      setProviderQuotaBeforeObservationForTests(null);
      setQuotaResetSink(null);
      resetQuotaResetStoreForTests();
    }
  });
  test("an unchanged account retains its reset baseline across A to B to A", async () => {
    writeTwoAccounts();
    const config = museConfig(), events: unknown[] = [];
    resetQuotaResetStoreForTests();
    setQuotaResetSink(event => events.push(event));
    try {
      recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 95, fiveHourResetAt: Date.now() - 1000, updatedAt: Date.now() }, captureConfigGeneration());
      await fetchProviderQuotaReports(config, true);
      await flushProviderQuotaObservationsForTests();
      expect(await setActiveAccount("meta-muse", "account-b")).toBe(true);
      expect(await setActiveAccount("meta-muse", ACCOUNT_ID)).toBe(true);
      expect(getCachedProviderAccountQuota("meta-muse", ACCOUNT_ID)?.fiveHourPercent).toBe(95);
      recordPassiveAccountQuota("meta-muse", ACCOUNT_ID, { fiveHourPercent: 2, fiveHourResetAt: Date.now() + 3600000, updatedAt: Date.now() }, captureConfigGeneration());
      await fetchProviderQuotaReports(config, true);
      await flushProviderQuotaObservationsForTests();
      expect(events).toHaveLength(1);
    } finally {
      setQuotaResetSink(null);
      resetQuotaResetStoreForTests();
    }
  });
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
