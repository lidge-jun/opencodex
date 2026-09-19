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
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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
