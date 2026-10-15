import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { OPAQUE_COMPACTION_NOTE } from "../../src/responses/compaction";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearUpstreamHostHealth } from "../../src/codex/upstream-host-health";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { baseCompactionBody, compactionRequest, completedPayload, drainCompactionResponseState, installCompactionRoutingAclFixture, jsonResponse, removeCompactionFixture, sseResponse, twoAccountPoolConfig } from "../helpers/compaction-routing-fixtures";

installCompactionRoutingAclFixture();

// These contracts exercise HTTP compact/replay, not transport selection. Bind the
// synthetic executor at the physical-send seam so inherited proxy settings cannot
// bypass global fetch mocks. Keep WebSocket out of these HTTP/SSE fixtures as well.
function installHttpMock(config: OcxConfig, mock: typeof fetch): void {
  globalThis.fetch = mock;
  for (const provider of Object.values(config.providers)) {
    Object.assign(provider, { fetch: mock, upstreamWebsocket: false });
  }
}

async function withPoolEnv<T>(name: string, run: (config: OcxConfig, signal: AbortSignal) => Promise<T>, deadlineMs = 10_000): Promise<T> {
  const testDir = mkdtempSync(join(tmpdir(), name));
  const previousOpencodexHome = process.env.OPENCODEX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const originalFetch = globalThis.fetch;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  let releaseSpendHome: (() => void) | undefined;
  const client = new AbortController();
  // Fail with a cancellation before Bun's outer timeout can advance to another
  // test while a request still owns this fixture's fetch, accounts or state.
  const deadline = setTimeout(() => client.abort(new Error("HTTP compaction fixture deadline exceeded")), deadlineMs);
  try {
    releaseSpendHome = acquireOwnedSpendHome();
    clearCodexUpstreamHealth();
    clearUpstreamHostHealth();
    clearAccountQuota();
    for (const id of ["pool-a", "pool-b"]) {
      saveCodexAccountCredential(id, {
        accessToken: `${id}-access-token`, refreshToken: `${id}-refresh-token`,
        expiresAt: Date.now() + 300_000,
        chatgptAccountId: id === "pool-a" ? "pool_acc_a" : "pool_acc_b",
      });
      updateAccountQuota(id, id === "pool-a" ? 10 : 20);
    }
    return await run(twoAccountPoolConfig(), client.signal);
  } finally {
    clearTimeout(deadline);
    client.abort();
    try {
      try { await drainCompactionResponseState(); } finally {
        releaseSpendHome?.();
        await removeCompactionFixture(testDir);
      }
    } finally {
      // Restoration must run even if acquiring/releasing the lease or draining
      // the fixture fails; no later case may inherit this executor or home.
      globalThis.fetch = originalFetch;
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      clearCodexUpstreamHealth();
      clearUpstreamHostHealth();
      clearAccountQuota();
    }
  }
}

describe("HTTP compaction replay isolation", () => {
  test("fixture abort settles mocked work before restoring homes and fetch", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousFetch = globalThis.fetch;
    let settledInFixture = false;
    await expect(withPoolEnv("ocx-compact-http-abort-", async (config, signal) => {
      const fixtureHome = process.env.OPENCODEX_HOME;
      const mock = (async (_input: unknown, init?: RequestInit) => {
        try {
          return await new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) reject(init.signal.reason);
            else init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          });
        } finally {
          settledInFixture = process.env.OPENCODEX_HOME === fixtureHome && globalThis.fetch === mock;
        }
      }) as typeof fetch;
      installHttpMock(config, mock);
      await mock("https://fixture.invalid/responses", { signal });
    }, 10)).rejects.toThrow("HTTP compaction fixture deadline exceeded");
    expect(settledInFixture).toBe(true);
    expect(process.env.OPENCODEX_HOME).toBe(previousHome);
    expect(process.env.CODEX_HOME).toBe(previousCodexHome);
    expect(globalThis.fetch).toBe(previousFetch);
  });

  test("404 fallback records the compaction serving account for subsequent opaque replay", async () => {
    await withPoolEnv("ocx-compact-404-replay-", async (config, signal) => {
      config.codexAccountNamespaces = { side: "pool-b", first: "pool-a" };
      const headers = { "thread-id": `compact-replay-${crypto.randomUUID()}` };
      const item = { type: "compaction", encrypted_content: "native-account-b-3769" };
      const calls: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
      let compacting = false;
      installHttpMock(config, (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/responses/compact")) return Response.json({ detail: "Not Found" }, { status: 404 });
        calls.push({ body: await request.json() as Record<string, unknown>, headers: request.headers });
        return sseResponse([{ type: "response.completed", response: compacting
          ? { id: "resp_identity_compact_3769", status: "completed", output: [item] }
          : completedPayload("ordinary turn") }]);
      }) as typeof fetch);
      const turn = async (model: string, input: unknown[]) => {
        const response = await handleResponses(compactionRequest({ model, input, stream: true, store: false }, signal, headers), config, { model: "", provider: "" }, { abortSignal: signal });
        expect(response.status).toBe(200);
        await response.text();
      };
      await turn("first/gpt-5.5", [{ role: "user", content: "seed account A" }]);
      compacting = true;
      const compact = await handleResponsesCompact(compactionRequest({ model: "side/gpt-5.5", input: [{ role: "user", content: "compact on B" }] }, signal, headers), config, { model: "", provider: "" });
      expect(compact.status).toBe(200);
      const output = (await compact.json() as { output: unknown[] }).output;
      expect(output).toEqual([item]);
      compacting = false;
      await turn("side/gpt-5.5", [...output, { role: "user", content: "continue on B" }]);
      expect(calls.at(-1)!.headers.get("authorization")).toBe("Bearer pool-b-access-token");
      expect(JSON.stringify(calls.at(-1)!.body.input)).toContain("native-account-b-3769");
      await turn("first/gpt-5.5", [...output, { role: "user", content: "switch back to A" }]);
      expect(calls.at(-1)!.headers.get("authorization")).toBe("Bearer pool-a-access-token");
      expect(JSON.stringify(calls.at(-1)!.body.input)).not.toContain("native-account-b-3769");
      expect(JSON.stringify(calls.at(-1)!.body.input)).toContain(OPAQUE_COMPACTION_NOTE);
      expect(calls).toHaveLength(4);
    });
  }, 20_000);

  test("a quota-blocked previous-model compact retries the same thread's successful routed handoff target (#2723)", async () => {
    await withPoolEnv("ocx-compact-routed-handoff-", async (config, signal) => {
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
      const headers = { "x-codex-parent-thread-id": "compact-routed-handoff-thread" };
      // The remembered route is keyed by the admitted principal, so every call in
      // this scenario authenticates as the same configured client.
      const admission = { kind: "configured", keyId: "compact-client", source: "dedicated", contextPrincipalId: "compact-client-principal" } as const;
      const calls: Array<{ model: string; nativeCompact: boolean }> = [];
      installHttpMock(config, (async (input: string | URL | Request, init?: RequestInit) => {
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
        return jsonResponse(completedPayload("DeepSeek handoff summary"));
      }) as typeof fetch);

      const manual = await handleResponsesCompact(
        compactionRequest(
          baseCompactionBody({ model: "deepseek/deepseek-v4-flash" }),
          signal,
          headers,
        ),
        config, { model: "", provider: "" }, undefined, admission,
      );
      expect(manual.status).toBe(200);
      expect(calls).toEqual([{ model: "deepseek-v4-flash", nativeCompact: false }]);
      calls.length = 0;

      const unrelated = await handleResponsesCompact(
        compactionRequest(
          baseCompactionBody({ model: "openai-apikey/gpt-5.6-sol" }),
          signal,
          { "x-codex-parent-thread-id": "different-compact-thread" },
        ),
        config, { model: "", provider: "" }, undefined, admission,
      );
      expect(unrelated.status).toBe(502);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(call => call.model === "gpt-5.6-sol" && call.nativeCompact)).toBe(true);
      calls.length = 0;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const automatic = await handleResponsesCompact(
        compactionRequest(
          baseCompactionBody({ model: "openai-apikey/gpt-5.6-sol" }),
          signal,
          headers,
        ),
        config, logCtx, undefined, admission,
      );

      expect(automatic.status).toBe(200);
      const output = await automatic.json() as { output?: unknown[] };
      expect(output.output?.length).toBeGreaterThan(0);
      expect(logCtx.provider).toBe("deepseek");
      expect(calls.at(-1)).toEqual({ model: "deepseek-v4-flash", nativeCompact: false });
      expect(calls.slice(0, -1).length).toBeGreaterThan(0);
      expect(calls.slice(0, -1).every(call => (
        call.model === "gpt-5.6-sol" && call.nativeCompact
      ))).toBe(true);
    });
  }, 20_000);
});
