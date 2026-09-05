/**
 * The web-search sidecar is a rotation site of its own, and it reaches Anthropic through the
 * shared 429 hook rather than the main response loop. A pool that is switched off must still
 * recover there: `anthropicAccountPool.enabled: false` declines PROACTIVE routing, not the
 * reactive retry that runs only after upstream has already refused the request.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../../src/adapters/base";
import { clearAnthropicAccountPoolState } from "../../../src/oauth/anthropic-routing";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";
let handleResponses: typeof import("../../../src/server/responses")["handleResponses"];
let observedKeys: string[] = [];
let sidecarMode = false;

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
  const actualResolver = await import("../../../src/server/adapter-resolve");
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
      on429?: (retryAfter: string | null) => Promise<ProviderAdapter | null>;
    }) => {
      const first = await args.adapter.buildRequest(args.parsed);
      observedKeys.push(new Headers(first.headers).get("authorization") ?? "");
      const rotated = await args.on429?.("30");
      if (!rotated) throw new Error("Anthropic sidecar did not rotate after 429");
      const second = await rotated.buildRequest(args.parsed);
      observedKeys.push(new Headers(second.headers).get("authorization") ?? "");
      return new Response("sidecar-ok", { status: 200 });
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
});

afterEach(() => {
  clearAnthropicAccountPoolState();
  clearGenericFailoverHealth();
  removeTreeWithRetry(testHome);
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  mock.restore();
});

test("Anthropic web-search sidecar rotates on 429 when proactive pooling is disabled", async () => {
  sidecarMode = true;
  for (let index = 0; index < 2; index += 1) {
    await saveCredential("anthropic", {
      access: `anthropic-access-${index}`,
      refresh: `anthropic-refresh-${index}`,
      expires: Date.now() + 3_600_000,
      accountId: `anthropic-account-${index}`,
    } as never, { addAccount: true });
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
      },
    },
  } as unknown as OcxConfig;

  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/model",
      input: "search",
      stream: true,
      tools: [{ type: "web_search" }],
    }),
  }), config, { model: "", provider: "" });

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("sidecar-ok");
  expect(observedKeys).toEqual([
    "Bearer anthropic-access-0",
    "Bearer anthropic-access-1",
  ]);
});
