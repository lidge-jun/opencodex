/**
 * The web-search sidecar is a rotation site of its own, and it reaches Anthropic through the
 * shared 429 hook rather than the main response loop. A pool that is switched off must still
 * recover there: `anthropicAccountPool.enabled: false` declines PROACTIVE routing, not the
 * reactive retry that runs only after upstream has already refused the request.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../../../src/adapters/base";
import type { AttemptRecoveryKind } from "../../../src/usage/log";
import { clearAnthropicAccountPoolState } from "../../../src/oauth/anthropic-routing";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { clearAccountQuotaCache, getCachedProviderAccountQuota, resetProviderQuotaReconcileStateForTests } from "../../../src/providers/quota";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";
let releaseSpendHome: (() => void) | undefined;
let handleResponses: typeof import("../../../src/server/responses")["handleResponses"];
let observedKeys: string[] = [];
let sidecarMode = false;
let restoreModuleMocks: (() => void) | undefined;

function fixtureAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "anthropic",
    buildRequest() {
      return {
        url: provider.baseUrl,
        method: "POST",
        headers: { authorization: `Bearer ${provider.apiKey ?? ""}` },
        body: "{}",
      };
    },
    async *parseStream() {
      yield { type: "done" as const };
    },
  };
}

beforeAll(async () => {
  // Capture values: Bun's module namespaces are live and mock.restore() only restores spies.
  const actualResolver = { ...await import("../../../src/server/adapter-resolve") };
  const actualWebSearch = { ...await import("../../../src/web-search") };
  restoreModuleMocks = () => {
    mock.module("../../../src/server/adapter-resolve", () => actualResolver);
    mock.module("../../../src/web-search", () => actualWebSearch);
  };
  const actualResolveAdapter = actualResolver.resolveAdapter;
  mock.module("../../../src/server/adapter-resolve", () => ({
    ...actualResolver,
    resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
      if (provider.adapter === "test-anthropic-sidecar") return fixtureAdapter(provider);
      return actualResolveAdapter(provider, cacheRetention);
    },
  }));

  mock.module("../../../src/web-search", () => ({
    buildWebSearchTool: () => ({
      name: "web_search",
      parameters: { type: "object", properties: {} },
    }),
    planWebSearch: () => sidecarMode
      ? {
          backend: "anthropic",
          hostedTool: { type: "web_search" },
          settings: { model: "claude-haiku-4-5", reasoning: "low", timeoutMs: 1_000 },
          maxSearches: 1,
        }
      : undefined,
    shouldResolveOpenAiWebSearchSidecar: () => false,
    runWithWebSearch: async (args: {
      parsed: OcxParsedRequest;
      adapter: ProviderAdapter;
      incomingMeta: IncomingMeta;
      fetchForRequest: (request: AdapterRequest, parsed: OcxParsedRequest, adapter: ProviderAdapter,
        recovery: AttemptRecoveryKind | undefined, onPhysicalDispatch: () => void) => typeof fetch;
      on429?: (retryAfter: string | null, headers: Headers, parsed: OcxParsedRequest, response: Response) => Promise<
        { adapter: ProviderAdapter; recoveryKind: AttemptRecoveryKind } | null
      >;
    }) => {
      // This is a dispatch seam test. The real loop is covered in anthropic-quota-dispatch.
      let adapter = args.adapter;
      for (let attempt = 0; attempt < 8; attempt++) {
        const request = await adapter.buildRequest(args.parsed, args.incomingMeta);
        const response = await args.fetchForRequest(request, args.parsed, adapter, undefined, () => {})(request.url, {
          method: request.method, headers: request.headers, body: request.body,
        });
        if (response.ok) return response;
        const rotated = await args.on429?.(response.headers.get("retry-after"), response.headers, args.parsed, response);
        if (!rotated) return response;
        await response.body?.cancel();
        expect(rotated.recoveryKind).toBe("anthropic-oauth-429");
        adapter = rotated.adapter;
      }
      throw new Error("Anthropic sidecar exceeded bounded fixture roster");
    },
  }));

  ({ handleResponses } = await import("../../../src/server/responses"));
});

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-oauth-429-boundaries-"));
  process.env.OPENCODEX_HOME = testHome;
  observedKeys = [];
  sidecarMode = false;
  clearAnthropicAccountPoolState();
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  // Released before the directory below is removed: an open lease inside a directory being
  // deleted fails the removal on Windows and leaves an unlinked live database on POSIX.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearAnthropicAccountPoolState();
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  removeTreeWithRetry(testHome);
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  mock.restore();
  restoreModuleMocks?.();
});

test.each([new Error("Synthetic rotation failure"), new DOMException("Synthetic cancellation", "AbortError")])(
  "Anthropic sidecar refunds unused hop and rethrows %s", async error => {
    sidecarMode = true;
    for (let index = 0; index < 2; index++) await saveCredential("anthropic", {
      access: `anthropic-access-${index}`, refresh: `anthropic-refresh-${index}`,
      expires: Date.now() + 3_600_000, accountId: `anthropic-account-${index}`,
    });
    await setActiveAccount("anthropic", getAccountSet("anthropic")!.accounts[0]!.id);
    const { createRequestExecutionBudget } = await import("../../../src/lib/request-execution-budget");
    const sendBudget = createRequestExecutionBudget({ maxTotalModelSends: 2, baseSendAllowance: 1,
      finalRecoveryAllowance: 1, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
    const refusal = await import("../../../src/oauth/anthropic-account-refusal");
    const rotation = spyOn(refusal, "rotateAnthropicAccountOnResponseForInstance").mockImplementation(async () => {
      expect(sendBudget.used).toBe(2);
      expect(sendBudget.reserveSpent).toBe(true);
      throw error;
    });
    const config = {
      port: 0, defaultProvider: "anthropic",
      anthropicAccountPool: { enabled: false, strategy: "round-robin" },
      providers: { anthropic: {
        adapter: "test-anthropic-sidecar", baseUrl: "https://anthropic-sidecar.test/v1",
        authMode: "oauth", models: ["model"],
        fetch: (async (_input, init) => {
          observedKeys.push(new Headers(init?.headers).get("authorization") ?? "");
          return new Response("rate limited", { status: 429 });
        }) as typeof fetch,
      } },
    } as unknown as OcxConfig;
    try {
      await expect(handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/model", input: "search", stream: true,
          tools: [{ type: "web_search" }] }),
      }), config, { model: "", provider: "" }, { sendBudget })).rejects.toBe(error);
      expect(rotation).toHaveBeenCalledTimes(1);
      expect(observedKeys).toEqual(["Bearer anthropic-access-0"]);
      expect(sendBudget.used).toBe(1);
      expect(sendBudget.reserveSpent).toBe(false);
    } finally { rotation.mockRestore(); }
  },
);

test.each([[2, false], [6, false], [8, false], [6, true]] as const)("Anthropic sidecar snapshots %i accounts, spent budget=%s", async (count, spent) => {
  sidecarMode = true;
  for (let index = 0; index < count; index += 1) {
    await saveCredential("anthropic", {
      access: `anthropic-access-${index}`,
      refresh: `anthropic-refresh-${index}`,
      expires: Date.now() + 3_600_000,
      accountId: `anthropic-account-${index}`,
    });
  }
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);

  const config = {
    port: 0,
    defaultProvider: "anthropic",
    anthropicAccountPool: { enabled: false, strategy: "round-robin" },
    providers: {
      anthropic: {
        adapter: "test-anthropic-sidecar",
        baseUrl: "https://anthropic-sidecar.test/v1",
        authMode: "oauth",
        models: ["model"],
        fetch: (async (_input, init) => {
          observedKeys.push(new Headers(init?.headers).get("authorization") ?? "");
          if (count === 8 || observedKeys.length < (count === 6 ? 5 : 2)) {
            return new Response("rate limited", {
              status: 429,
              headers: {
                "retry-after": "30",
                "anthropic-ratelimit-unified-5h-status": "rejected",
                "anthropic-ratelimit-unified-5h-utilization": "1",
                "anthropic-ratelimit-unified-7d-utilization": "0.61",
              },
            });
          }
          expect(observedKeys).toHaveLength(count === 6 ? 5 : 2);
          expect(getCachedProviderAccountQuota("anthropic", ids[0]!)).toMatchObject({ fiveHourPercent: 100, weeklyPercent: 61 });
          return new Response("sidecar-ok", {
            headers: {
              "anthropic-ratelimit-unified-5h-utilization": "0.23",
              "anthropic-ratelimit-unified-7d-utilization": "0.47",
            },
          });
        }) as typeof fetch,
      },
    },
  } as unknown as OcxConfig;

  const { createRequestExecutionBudget } = await import("../../../src/lib/request-execution-budget");
  const sendBudget = spent ? createRequestExecutionBudget({ maxTotalModelSends: 1, baseSendAllowance: 1,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 }) : undefined;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/model",
      input: "search",
      stream: true,
      tools: [{ type: "web_search" }],
    }),
  }), config, { model: "", provider: "" }, { sendBudget });

  expect(response.status).toBe(count === 8 || spent ? 429 : 200);
  expect(await response.text()).toBe(count === 8 || spent ? "rate limited" : "sidecar-ok");
  const expectedSends = spent ? 1 : count === 8 ? 6 : count === 6 ? 5 : 2;
  expect(observedKeys).toEqual(Array.from({ length: expectedSends }, (_, index) => `Bearer anthropic-access-${index}`));
  expect(getCachedProviderAccountQuota("anthropic", ids[0]!)).toMatchObject({ fiveHourPercent: 100, weeklyPercent: 61 });
  if (count !== 8 && !spent) expect(getCachedProviderAccountQuota("anthropic", ids[expectedSends - 1]!)).toMatchObject({ fiveHourPercent: 23, weeklyPercent: 47 });
});
