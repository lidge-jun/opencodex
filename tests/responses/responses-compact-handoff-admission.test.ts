import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearUpstreamHostHealth } from "../../src/codex/upstream-host-health";
import { handleResponsesCompact } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { configureSharedSpendLedger, sharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * The compact handoff map is process-global while its lane key arrives in a
 * caller-controlled header. These tests pin the admission-principal namespacing
 * that keeps one authenticated client from claiming another client's remembered
 * fallback route by re-sending the same lane header.
 */
describe("compact handoff route admission namespacing", () => {
  function poolConfig(): OcxConfig {
    return {
      defaultProvider: "openai",
      activeCodexAccountId: "pool-a",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      codexAccounts: [{
        id: "pool-a",
        email: "pool@example.test",
        isMain: false,
        chatgptAccountId: "pool_acc",
      }],
    } as OcxConfig;
  }

  async function withPoolEnv<T>(run: (config: OcxConfig) => Promise<T>): Promise<T> {
    const testDir = mkdtempSync(join(tmpdir(), "ocx-compact-handoff-admission-"));
    const previousOpencodexHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = testDir;
    process.env.CODEX_HOME = testDir;
    clearCodexUpstreamHealth();
    clearUpstreamHostHealth();
    clearAccountQuota();
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-a-access-token",
      refreshToken: "pool-a-refresh-token",
      expiresAt: Date.now() + 300_000,
      chatgptAccountId: "pool_acc",
    });
    updateAccountQuota("pool-a", 10);
    // Taken after this helper installs its home so direct compact dispatch owns that journal.
    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      return await run(poolConfig());
    } finally {
      // Released before this helper restores and removes its home so no live database is unlinked.
      releaseSpendHome();
      globalThis.fetch = originalFetch;
      clearCodexUpstreamHealth();
      clearUpstreamHostHealth();
      clearAccountQuota();
      removeTreeWithRetry(testDir);
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  }

  function compactionRequest(
    body: Record<string, unknown>,
    extraHeaders: Record<string, string>,
  ): Request {
    return new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });
  }

  function compactionBody(model: string): Record<string, unknown> {
    return {
      model,
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
        { type: "compaction_trigger" },
      ],
      tools: [{ type: "function", name: "shell" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };
  }

  for (const historicalPool of ["retired-display-label", "openai"]) test(`native compact explains spend refusal with history from ${historicalPool}`, async () => {
    await withPoolEnv(async config => {
      configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: 100 } }, undefined, ["openai"]));
      const ledger = sharedSpendLedger();
      expect(ledger.reserve({ sendId: "historical", scopes: { poolId: historicalPool },
        inputTokens: 90, outputCeilingTokens: 0 }).reserved).toBe(true);
      ledger.markDispatched("historical");
      ledger.settle("historical", { inputTokens: 90, outputTokens: 0 });
      let calls = 0;
      globalThis.fetch = (async () => { calls++; throw new Error("compact must refuse before wire"); }) as typeof fetch;
      const response = await handleResponsesCompact(compactionRequest(compactionBody("gpt-5.6-sol"), {}),
        config, { model: "", provider: "", spendInputEstimateTokens: 20 });
      expect(response.status).toBe(429);
      const body = await response.text();
      if (historicalPool === "retired-display-label") {
        expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
        expect(body).toContain("unassigned historical provider-pool balances");
      } else {
        expect(response.headers.get("x-opencodex-local-refusal")).toBeNull();
        expect(body).toContain("request_send_budget_exhausted");
        expect(body).not.toContain("unassigned historical provider-pool balances");
      }
      expect(body).not.toContain("retired-display-label");
      expect(calls).toBe(0);
      expect(ledger.snapshot("pool", "openai")?.settled).toBe(90);
    });
  });

  test.each(["routed", "native", "combo"] as const)("remembered cross-provider compact inherits the original two-send ceiling (%s)", async mode => {
    await withPoolEnv(async config => {
      config.providers["openai-apikey"] = {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "openai-test-key",
        models: ["gpt-5.6-sol"],
        transientRetryOn5xx: { attempts: 2 },
      };
      config.providers.backup = {
        adapter: "openai-responses",
        baseUrl: "https://backup.example/v1",
        authMode: "key",
        apiKey: "backup-test-key",
        models: ["summary"],
        transientRetryOn5xx: { attempts: 3 },
      };
      if (mode === "combo") {
        config.providers.spare = { ...config.providers.backup, baseUrl: "https://spare.example/v1" };
        config.combos = { "summarizer": {
          strategy: "failover",
          targets: [{ provider: "backup", model: "summary" }, { provider: "spare", model: "summary" }],
        } };
      }
      const calls: Array<{ host: string; path: string }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push({ host: url.hostname, path: url.pathname });
        if (url.hostname === "api.openai.com") {
          return Response.json({ error: { message: "The usage limit has been reached" } }, { status: 429 });
        }
        if (calls.length === 1) {
          const response = {
            id: "resp_seed", object: "response", status: "completed", model: "summary",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] }],
          };
          return mode === "combo"
            ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
            : Response.json(response);
        }
        return Response.json({ error: { message: "Backup is overloaded" } }, { status: 503 });
      }) as typeof fetch;
      const headers = { "x-codex-parent-thread-id": `compact-handoff-two-sends-${mode}` };
      const admission = {
        kind: "configured", keyId: "compact-client", source: "dedicated",
        contextPrincipalId: "principal-handoff-cap",
      } as const;
      const compact = (model: string) => handleResponsesCompact(
        compactionRequest(compactionBody(model), headers), config, { model: "", provider: "" }, undefined, admission,
      );
      const seed = await compact(mode === "combo" ? "combo/summarizer" : "backup/summary");
      expect(seed.status).toBe(200);
      await seed.body?.cancel();
      expect(calls).toEqual([{ host: "backup.example", path: "/v1/responses" }]);
      config.providers.backup.supportsNativeCompactEndpoint = mode === "native";
      calls.length = 0;

      const response = await compact("openai-apikey/gpt-5.6-sol");
      expect(response.status).toBe(429);
      expect(await response.text()).toContain("The usage limit has been reached");
      expect(calls).toEqual([
        { host: "api.openai.com", path: "/v1/responses/compact" },
        { host: "backup.example", path: mode === "native" ? "/v1/responses/compact" : "/v1/responses" },
      ]);
    });
  });

  test("a remembered native compact on the same provider cannot reuse the first send's spend seed", async () => {
    await withPoolEnv(async config => {
      const provider = config.providers.summarizer = {
        adapter: "openai-responses", baseUrl: "https://summary.example/v1", authMode: "key",
        apiKey: "summary-test-key", models: ["primary", "backup"], transientRetryOn5xx: { attempts: 4 },
      };
      const sends: string[] = [];
      const quota = { error: { message: "The usage limit has been reached" } };
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        sends.push(`${url.pathname}:${model}`);
        if (model === "primary") return Response.json(quota, { status: 429 });
        return Response.json({ id: "resp_seed", object: "response", status: "completed", model,
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] }] });
      }) as typeof fetch;
      const headers = { "x-codex-parent-thread-id": "compact-same-provider-spend" };
      const admission = { kind: "configured", keyId: "compact-client", source: "dedicated",
        contextPrincipalId: "principal-handoff-spend" } as const;
      const compact = (model: string, logCtx: RequestLogContext) => handleResponsesCompact(
        compactionRequest(compactionBody(`summarizer/${model}`), headers), config, logCtx, undefined, admission,
      );
      const initialLog: RequestLogContext = { model: "", provider: "", spendInputEstimateTokens: 0 };
      const seed = await compact("backup", initialLog);
      expect(seed.status).toBe(200);
      await seed.body?.cancel();
      initialLog.spendTracker?.settle(undefined);
      provider.supportsNativeCompactEndpoint = true;
      sends.length = 0;
      configureSharedSpendLedger(spendPolicyFromConfig({ root: { maxTokens: 150 } }));

      const logCtx: RequestLogContext = { model: "", provider: "", spendInputEstimateTokens: 100 };
      const response = await compact("primary", logCtx);
      expect(sends).toEqual(["/v1/responses/compact:primary"]);
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual(quota);
      logCtx.spendTracker!.settle(undefined);
      expect(sharedSpendLedger().snapshot("root", headers["x-codex-parent-thread-id"])).toMatchObject({ reserved: 0, unresolved: 100 });
    });
  });

  test.each([250, 300])("configured native-to-routed compact admits paced same-key 429 retries under %i tokens", async maxTokens => {
    await withPoolEnv(async config => {
      config.providers.summarizer = {
        adapter: "openai-responses", baseUrl: "https://summary.example/v1", authMode: "key",
        apiKey: "summary-test-key", models: ["summary"], supportsNativeCompactEndpoint: true,
        transientRetryOn5xx: { attempts: 4 }, retryOn429: { attempts: 2, intervalMs: 1 },
        requestPacing: { enabled: true, maxConcurrentRequests: 1 },
      };
      configureSharedSpendLedger(spendPolicyFromConfig({ root: { maxTokens } }));
      const sends: string[] = [];
      const quota = { error: { message: "The provider is rate limiting this turn" } };
      const logCtx: RequestLogContext = { model: "", provider: "", spendInputEstimateTokens: 100 };
      const root = "compact-routed-key-retry";
      const ledger = sharedSpendLedger();
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const { pathname } = new URL(input instanceof Request ? input.url : String(input));
        sends.push(pathname);
        expect(ledger.snapshot("root", root)?.reserved).toBe(sends.length * 100);
        return pathname.endsWith("/compact") ? Response.json({ error: { message: "No native endpoint" } }, { status: 404 })
          : Response.json(quota, { status: 429 });
      }) as typeof fetch;
      const response = await handleResponsesCompact(compactionRequest(compactionBody("summarizer/summary"),
        { "x-codex-parent-thread-id": root }), config, logCtx);
      expect(sends).toEqual(["/v1/responses/compact", ...Array(Math.floor(maxTokens / 100) - 1).fill("/v1/responses")]);
      expect(response.status).toBe(429);
      const result = await response.json();
      if (maxTokens === 250) expect(result).toEqual(quota);
      else {
        expect(result).toMatchObject({ error: { code: "rate_limit_exceeded" } });
        expect(result.error.message).toContain(quota.error.message);
      }
      logCtx.spendTracker!.settle(undefined);
      expect(ledger.snapshot("root", root)).toMatchObject({ reserved: 0, unresolved: Math.floor(maxTokens / 100) * 100 });
    });
  });

  test("a remembered route is claimed only by the principal that stored it", async () => {
    await withPoolEnv(async config => {
      config.providers.deepseek = {
        adapter: "openai-chat",
        baseUrl: "https://api.deepseek.com",
        authMode: "key",
        apiKey: "deepseek-test-key",
        models: ["deepseek-v4-flash"],
      };
      config.providers["openai-apikey"] = {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "openai-test-key",
        models: ["gpt-5.6-sol"],
      };
      const headers = { "x-codex-parent-thread-id": "compact-handoff-admission-thread" };
      const owner = {
        kind: "configured",
        keyId: "compact-client",
        source: "dedicated",
        contextPrincipalId: "principal-owner",
      } as const;
      const calls: Array<{ model: string; nativeCompact: boolean }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        const nativeCompact = url.endsWith("/responses/compact");
        calls.push({ model: body.model ?? "", nativeCompact });
        if (nativeCompact) {
          return Response.json({ error: { message: "The usage limit has been reached" } }, {
            status: 502,
          });
        }
        return new Response(JSON.stringify({
          id: "resp_1",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "DeepSeek handoff summary" }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;

      const compact = (model: string, admission: Parameters<typeof handleResponsesCompact>[4]) =>
        handleResponsesCompact(
          compactionRequest(compactionBody(model), headers),
          config,
          { model: "", provider: "" },
          undefined,
          admission,
        );

      // The owner stores the deepseek route under (its principal, this lane).
      const stored = await compact("deepseek/deepseek-v4-flash", owner);
      try {
        expect(stored.status).toBe(200);
        expect(calls).toEqual([{ model: "deepseek-v4-flash", nativeCompact: false }]);
      } finally {
        await stored.body?.cancel();
      }

      // A different admitted principal re-sending the same lane header must not
      // claim it: every attempt stays on the requested model's native compact.
      for (const intruder of [
        // Same key id, rotated secret. Admission mints a new principal, and this
        // is precisely the pair a keyId-derived key would have collapsed.
        { kind: "configured", keyId: "compact-client", source: "dedicated", contextPrincipalId: "principal-rotated" },
        // Authenticated but carrying no minted principal: ineligible, not pooled.
        { kind: "environment", source: "bearer" },
        { kind: "loopback", source: "loopback" },
        undefined,
      ] as const) {
        calls.length = 0;
        const res = await compact("openai-apikey/gpt-5.6-sol", intruder);
        try {
          expect(res.status).toBe(502);
          expect(calls.length).toBeGreaterThan(0);
          expect(calls.every(call => call.model === "gpt-5.6-sol" && call.nativeCompact)).toBe(true);
        } finally {
          await res.body?.cancel();
        }
      }

      // The owner's own quota-blocked retry still finds the route and hands off.
      calls.length = 0;
      const handoff = await compact("openai-apikey/gpt-5.6-sol", owner);
      try {
        expect(handoff.status).toBe(200);
        expect(calls.at(-1)).toEqual({ model: "deepseek-v4-flash", nativeCompact: false });
      } finally {
        await handoff.body?.cancel();
      }
    });
    // Five request sequences ride the transient-502 retry ladder; the default
    // 5s budget is not enough on a contended host.
  }, 20000);
});
