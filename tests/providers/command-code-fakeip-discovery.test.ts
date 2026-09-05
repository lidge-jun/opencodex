import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression: canonical Command Code OAuth discovery must survive Clash /
// Surge / Mihomo fake-IP DNS (198.18.0.0/15) WITHOUT proxy env.
//
// Production shape: the daemon runs under launchd/systemd WITHOUT
// HTTP(S)_PROXY in its environment (system/VPN proxying happens at the IP
// layer via TUN), while local DNS answers every hostname with a fake IP. The
// old outbound path armed the `allowBenchmarkAddresses` exception ONLY when a
// proxy env was configured, so the canonical
// `GET https://api.commandcode.ai/provider/v1/models` was rejected with
// `ProviderOutboundPolicyError: ... benchmark address ...`, the catalog marked
// `{ status: "failed", reason: "blocked" }`, and the dashboard showed "Model
// discovery was blocked by destination policy" with 0/0 visible models.
//
// The fix adds a narrow TUN transparency exception: the REGISTRY's own fixed
// discovery URL (proven by `isRegistryModelDiscoveryUrl` against the final
// request URL — not the provider name) may pin-connect through the
// intercepting TUN when EVERY DNS answer is benchmark space. Literal
// 198.18.x.x URLs, loopback/RFC1918/link-local/metadata answers, mixed
// answers, query/fragment smuggling, renamed rows, and non-canonical URLs all
// stay rejected.
//
// DNS is mocked at the node:dns/promises seam so the test is deterministic and
// independent of the machine's resolver. Bun isolates modules per test file,
// so this mock cannot leak into other suites.
const lookupMock = mock(async (_hostname: string, _opts: unknown): Promise<{ address: string; family: number }[]> => []);
mock.module("node:dns/promises", () => ({ lookup: lookupMock }));

const { buildModelsRequest } = await import("../../src/oauth");
const { providerOutboundGet, ProviderOutboundPolicyError } = await import("../../src/lib/provider-outbound");
const { isRegistryModelDiscoveryUrl } = await import("../../src/providers/model-discovery");
const { PROXY_ENV_KEYS } = await import("../../src/lib/proxy-env");
const { gatherRoutedModels, clearGatherRoutedModelsInflight } = await import("../../src/codex/catalog/provider-fetch");
const { clearModelCache, clearProviderDiscoveryStatus, getProviderDiscoveryStatus } = await import("../../src/codex/model-cache");
const { withStubbedProviderFetch } = await import("../helpers/catalog-provider-fetch");
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const FIXTURE = readFileSync(join(import.meta.dir, "../fixtures/commandcode-models.json"), "utf8");

const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function clearProxyEnv(): void {
  for (const key of proxyKeys) delete process.env[key];
}

function canonicalOAuthRow(): OcxProviderConfig {
  return {
    adapter: "command-code",
    baseUrl: "https://api.commandcode.ai",
    authMode: "oauth",
    liveModels: true,
    defaultModel: "deepseek/deepseek-v4-flash",
  };
}

function canonicalConfig(): OcxConfig {
  return {
    providers: {
      "command-code": {
        ...canonicalOAuthRow(),
        apiKey: "simulated-oauth-bearer",
      },
    },
  } as unknown as OcxConfig;
}

afterEach(() => {
  for (const key of proxyKeys) {
    const previous = originalProxyEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  globalThis.fetch = originalFetch;
  lookupMock.mockReset();
  clearModelCache("command-code");
  clearProviderDiscoveryStatus("command-code");
  clearModelCache("nebius");
  clearProviderDiscoveryStatus("nebius");
  clearGatherRoutedModelsInflight();
});

describe("command-code OAuth discovery under Clash/Mihomo fake-IP DNS", () => {
  test("canonical request targets the registry discovery URL with the account bearer", () => {
    const request = buildModelsRequest(canonicalOAuthRow(), "account-bearer", "command-code");
    expect(request.url).toBe("https://api.commandcode.ai/provider/v1/models");
    expect(request.headers.Authorization).toBe("Bearer account-bearer");
    expect(isRegistryModelDiscoveryUrl("command-code", request.url)).toBe(true);
  });

  test("canonical URL pin-connects through the TUN without proxy env", async () => {
    clearProxyEnv();
    lookupMock.mockResolvedValue([{ address: "198.18.0.29", family: 4 }]);
    const request = buildModelsRequest(canonicalOAuthRow(), "account-bearer", "command-code");

    const response = await providerOutboundGet(
      "command-code",
      canonicalOAuthRow(),
      request.url,
      { headers: request.headers },
      {
        isCanonicalUrl: isRegistryModelDiscoveryUrl,
        pinnedGet: (async (_url, pinned, _signal, requestOptions) => {
          expect(pinned.address).toBe("198.18.0.29");
          expect(new Headers(requestOptions?.headers).get("authorization")).toBe("Bearer account-bearer");
          return new Response(FIXTURE, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as never,
      },
    );

    expect(response.status).toBe(200);
  });

  test("full catalog gather discovers the live OAuth catalog without proxy env", async () => {
    clearProxyEnv();
    // Production resolves the OAuth bearer through the OBSERVED auth-store path
    // (filesystem evidence -> observedModelsAuthResolver), never the provider
    // row. Mirror that here: write a command-code account into an isolated
    // OPENCODEX_HOME auth store and gather through the observed entry point.
    // The stubbed executor asserts the materialized bearer without exposing it.
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { gatherRoutedModelsForCatalogGather } = await import("../../src/codex/catalog/provider-fetch");
    const root = mkdtempSync(join(tmpdir(), "ocx-cc-fakeip-"));
    const home = join(root, "opencodex");
    mkdirSync(home, { recursive: true });
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    const now = Date.now();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        "command-code": {
          activeAccountId: "account-1",
          accounts: [{
            id: "account-1",
            credential: { access: "observed-oauth-bearer", refresh: "r", expires: now + 3_600_000 },
          }],
        },
      }) + "\n",
    );
    const observedBuffer = new Uint8Array(
      await Bun.file(join(home, "auth.json")).arrayBuffer(),
    );
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://api.commandcode.ai/provider/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer observed-oauth-bearer");
      expect(init?.redirect).toBe("manual");
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const config: OcxConfig = {
        providers: {
          "command-code": {
            adapter: "command-code",
            baseUrl: "https://api.commandcode.ai",
            authMode: "oauth",
            liveModels: true,
            defaultModel: "deepseek/deepseek-v4-flash",
          },
        },
      };
      const models = await gatherRoutedModelsForCatalogGather(
        withStubbedProviderFetch(config),
        { authStoreBuffer: observedBuffer },
      );
      const ours = models.filter(model => model.provider === "command-code");

      expect(ours.length).toBeGreaterThan(1);
      expect(ours.map(model => model.id)).toContain("deepseek/deepseek-v4-flash");
      expect(getProviderDiscoveryStatus("command-code")).toEqual({ status: "ok" });
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      const { removeTreeWithRetry } = await import("../helpers/remove-tree");
      removeTreeWithRetry(root);
    }
  });

  test("literal 198.18.x.x discovery URLs stay rejected", async () => {
    clearProxyEnv();
    await expect(providerOutboundGet(
      "command-code",
      canonicalOAuthRow(),
      "https://198.18.0.29/provider/v1/models",
      {},
      { isCanonicalUrl: isRegistryModelDiscoveryUrl },
    )).rejects.toBeInstanceOf(ProviderOutboundPolicyError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test("loopback / RFC1918 / metadata / link-local companions stay rejected", async () => {
    clearProxyEnv();
    for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.50", "169.254.169.254", "169.254.10.20"]) {
      lookupMock.mockResolvedValueOnce([
        { address: "198.18.0.29", family: 4 },
        { address, family: 4 },
      ]);
      await expect(providerOutboundGet(
        "command-code",
        canonicalOAuthRow(),
        "https://api.commandcode.ai/provider/v1/models",
        {},
        { isCanonicalUrl: isRegistryModelDiscoveryUrl },
      )).rejects.toThrow(ProviderOutboundPolicyError);
    }
  });

  test("query/fragment smuggling on the canonical origin+path stays rejected", async () => {
    clearProxyEnv();
    for (const url of [
      "https://api.commandcode.ai/provider/v1/models?token=secret",
      "https://api.commandcode.ai/provider/v1/models#fragment",
    ]) {
      expect(isRegistryModelDiscoveryUrl("command-code", url)).toBe(false);
      lookupMock.mockResolvedValueOnce([{ address: "198.18.0.29", family: 4 }]);
      await expect(providerOutboundGet(
        "command-code",
        canonicalOAuthRow(),
        url,
        {},
        { isCanonicalUrl: isRegistryModelDiscoveryUrl },
      )).rejects.toThrow(ProviderOutboundPolicyError);
    }
  });

  // CodeRabbit round 1 on PR #3489: the proof blanket-rejected every query, so a
  // registry-owned fixed query (Nebius `path: "models"` + `query: { verbose:
  // "true" }`) could never receive the TUN exception even though the normal
  // discovery resolver appends that exact query to the final request URL.
  // Registry-owned fixed queries are canonical ONLY on exact match; anything
  // missing, changed, added, or fragmented stays rejected.
  test("registry-owned fixed queries match exactly (real Nebius entry)", async () => {
    clearProxyEnv();
    const canonical = "https://api.tokenfactory.nebius.com/v1/models?verbose=true";
    expect(isRegistryModelDiscoveryUrl("nebius", canonical)).toBe(true);
    // The production request builder must emit exactly the proven URL.
    const request = buildModelsRequest(
      { adapter: "openai-chat", baseUrl: "https://api.tokenfactory.nebius.com/v1", authMode: "key" },
      "nebius-key",
      "nebius",
    );
    expect(request.url).toBe(canonical);

    // Canonical query pin-connects through the TUN without proxy env.
    lookupMock.mockResolvedValueOnce([{ address: "198.18.0.29", family: 4 }]);
    const accepted = await providerOutboundGet(
      "nebius",
      { baseUrl: "https://api.tokenfactory.nebius.com/v1" },
      canonical,
      { headers: request.headers },
      {
        isCanonicalUrl: isRegistryModelDiscoveryUrl,
        pinnedGet: (async (_url, pinned, _signal, requestOptions) => {
          expect(pinned.address).toBe("198.18.0.29");
          expect(new Headers(requestOptions?.headers).get("authorization")).toBe("Bearer nebius-key");
          return new Response(JSON.stringify({ data: [{ id: "moonshotai/Kimi-K3" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as never,
      },
    );
    expect(accepted.status).toBe(200);

    // Missing, changed, additional, and fragmented queries stay rejected.
    for (const url of [
      "https://api.tokenfactory.nebius.com/v1/models",
      "https://api.tokenfactory.nebius.com/v1/models?verbose=false",
      "https://api.tokenfactory.nebius.com/v1/models?verbose=true&x=1",
      "https://api.tokenfactory.nebius.com/v1/models?verbose=true#fragment",
    ]) {
      expect(isRegistryModelDiscoveryUrl("nebius", url)).toBe(false);
      lookupMock.mockResolvedValueOnce([{ address: "198.18.0.29", family: 4 }]);
      await expect(providerOutboundGet(
        "nebius",
        { baseUrl: "https://api.tokenfactory.nebius.com/v1" },
        url,
        {},
        { isCanonicalUrl: isRegistryModelDiscoveryUrl },
      )).rejects.toThrow(ProviderOutboundPolicyError);
    }
  });

  test("absolute url specs with a fixed registry query require the exact query", async () => {
    const { withRegistryDiscovery } = await import("../helpers/provider-registry-discovery");
    await withRegistryDiscovery("together", {
      url: "https://api.together.xyz/v1/catalog",
      query: { capability: "chat" },
    }, async () => {
      const canonical = "https://api.together.xyz/v1/catalog?capability=chat";
      expect(isRegistryModelDiscoveryUrl("together", canonical)).toBe(true);
      expect(isRegistryModelDiscoveryUrl("together", "https://api.together.xyz/v1/catalog")).toBe(false);
      expect(isRegistryModelDiscoveryUrl("together", "https://api.together.xyz/v1/catalog?capability=embed")).toBe(false);
      expect(isRegistryModelDiscoveryUrl("together", "https://api.together.xyz/v1/catalog?capability=chat&x=1")).toBe(false);
    });
  });

  test("renamed rows fetching an attacker URL gain nothing", async () => {
    clearProxyEnv();
    expect(isRegistryModelDiscoveryUrl("renamed-row", "https://api.commandcode.ai/provider/v1/models")).toBe(false);
    expect(isRegistryModelDiscoveryUrl("command-code", "https://evil.example/provider/v1/models")).toBe(false);
    lookupMock.mockResolvedValueOnce([{ address: "198.18.0.29", family: 4 }]);
    await expect(providerOutboundGet(
      "renamed-row",
      { adapter: "openai-chat", baseUrl: "https://evil.example/v1" },
      "https://evil.example/v1/models",
      {},
      { isCanonicalUrl: isRegistryModelDiscoveryUrl },
    )).rejects.toThrow(ProviderOutboundPolicyError);
  });

  test("NO_PROXY-matched canonical hosts keep the rejection (direct route)", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.NO_PROXY = "api.commandcode.ai";
    process.env.no_proxy = "api.commandcode.ai";
    lookupMock.mockResolvedValueOnce([{ address: "198.18.0.29", family: 4 }]);
    await expect(providerOutboundGet(
      "command-code",
      canonicalOAuthRow(),
      "https://api.commandcode.ai/provider/v1/models",
      {},
      { isCanonicalUrl: isRegistryModelDiscoveryUrl },
    )).rejects.toThrow(ProviderOutboundPolicyError);
  });

  test("explicit-zero mapped benchmark answers stay covered, hostile tails stay rejected", async () => {
    clearProxyEnv();
    lookupMock.mockResolvedValueOnce([{ address: "::ffff:0:c612:1b", family: 6 }]);
    const accepted = await providerOutboundGet(
      "command-code",
      canonicalOAuthRow(),
      "https://api.commandcode.ai/provider/v1/models",
      {},
      {
        isCanonicalUrl: isRegistryModelDiscoveryUrl,
        pinnedGet: (async () => new Response(FIXTURE, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as never,
      },
    );
    expect(accepted.status).toBe(200);

    lookupMock.mockResolvedValueOnce([{ address: "::ffff:0:5db8:d822", family: 6 }]);
    await expect(providerOutboundGet(
      "command-code",
      canonicalOAuthRow(),
      "https://api.commandcode.ai/provider/v1/models",
      {},
      { isCanonicalUrl: isRegistryModelDiscoveryUrl },
    )).rejects.toThrow(ProviderOutboundPolicyError);
  });

  test("without the canonical-URL proof the fake-IP answer still blocks (fail-closed seam)", async () => {
    clearProxyEnv();
    lookupMock.mockResolvedValueOnce([{ address: "198.18.0.29", family: 4 }]);
    const request = buildModelsRequest(canonicalOAuthRow(), "account-bearer", "command-code");
    await expect(providerOutboundGet(
      "command-code",
      canonicalOAuthRow(),
      request.url,
      { headers: request.headers },
    )).rejects.toThrow(/benchmark address \(198\.18\.0\.29\)/);
  });
});
