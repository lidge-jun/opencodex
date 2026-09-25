import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeActiveOAuthAccessToken,
  OAUTH_PROVIDERS,
} from "../../src/oauth";
import {
  gatherRoutedModels,
  gatherRoutedModelsForCatalogGather,
  fetchProviderModels,
  type CatalogGatherProviderAuthOutcome,
  type CatalogGatherProviderModelOutcome,
} from "../../src/codex/catalog/provider-fetch";
import { parseCatalogBuffer, setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { encodeMessage, encodeString } from "../../src/adapters/devin/cloud-direct/wire";
import { clearModelCache } from "../../src/codex/model-cache";
import { getAuthRefreshIntentPath, saveCredential } from "../../src/oauth/store";
import { knownModelIdsForProvider } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

interface FileSnapshot {
  readonly bytes: Buffer;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
}

const originalHome = process.env.HOME;
const originalOpencodexHome = process.env.OPENCODEX_HOME;
const originalCodexHome = process.env.CODEX_HOME;
const originalKimiRefresh = OAUTH_PROVIDERS.kimi!.refresh;

let root: string;
let opencodexHome: string;

function authStoreBytes(expires: number): Buffer {
  return Buffer.from(JSON.stringify({
    kimi: {
      activeAccountId: "active",
      accounts: [{
        id: "active",
        credential: {
          access: "fixture-a",
          refresh: "fixture-r",
          expires,
        },
      }],
    },
  }) + "\n");
}

function devinAuthStoreBytes(apiBaseUrl: string): Buffer {
  return Buffer.from(JSON.stringify({
    devin: {
      activeAccountId: "active",
      accounts: [{
        id: "active",
        credential: {
          access: "fixture-devin-key",
          refresh: "fixture-devin-key",
          expires: Number.MAX_SAFE_INTEGER,
          apiBaseUrl,
        },
      }],
    },
  }) + "\n");
}

function snapshotFile(path: string): FileSnapshot {
  const stat = statSync(path, { bigint: true });
  return {
    bytes: readFileSync(path),
    inode: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
  };
}

function expectFileUnchanged(path: string, before: FileSnapshot): void {
  const after = snapshotFile(path);
  expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
  expect({ inode: after.inode, mode: after.mode, mtimeNs: after.mtimeNs }).toEqual({
    inode: before.inode,
    mode: before.mode,
    mtimeNs: before.mtimeNs,
  });
}

function liveKimiProvider(onFetch: () => void): OcxProviderConfig {
  return {
    ...structuredClone(OAUTH_PROVIDERS.kimi!.providerConfig),
    liveModels: true,
    models: ["k3"],
    fetch: async () => {
      onFetch();
      return new Response(JSON.stringify({ data: [{ id: "k3" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

async function runCatalogGather(
  authStoreBuffer: Uint8Array | null,
  onFetch: () => void,
): Promise<{
  rows: Awaited<ReturnType<typeof gatherRoutedModelsForCatalogGather>>;
  outcomes: CatalogGatherProviderAuthOutcome[];
  modelOutcomes: CatalogGatherProviderModelOutcome[];
}> {
  const config: OcxConfig = { providers: { kimi: liveKimiProvider(onFetch) } };
  const outcomes: CatalogGatherProviderAuthOutcome[] = [];
  const modelOutcomes: CatalogGatherProviderModelOutcome[] = [];
  const rows = await gatherRoutedModelsForCatalogGather(
    config,
    { authStoreBuffer },
    { providerAuthOutcomes: outcomes, providerModelOutcomes: modelOutcomes },
  );
  return { rows, outcomes, modelOutcomes };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-catalog-auth-observe-"));
  opencodexHome = join(root, "opencodex");
  mkdirSync(opencodexHome, { recursive: true, mode: 0o700 });
  process.env.HOME = join(root, "home");
  process.env.OPENCODEX_HOME = opencodexHome;
  process.env.CODEX_HOME = join(root, "codex");
  clearModelCache();
});

afterEach(() => {
  OAUTH_PROVIDERS.kimi!.refresh = originalKimiRefresh;
  clearModelCache();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpencodexHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  removeTreeWithRetry(root);
});

describe("catalog gather OAuth observation", () => {
  test("refreshing Copilot gather binds the new bearer to the refreshed origin", async () => {
    await saveCredential("github-copilot", {
      access: "fixture-old-token", refresh: "fixture-refresh", expires: Date.now() - 1,
      apiBaseUrl: "https://api.githubcopilot.com",
    });
    const originalRefresh = OAUTH_PROVIDERS["github-copilot"]!.refresh;
    let refreshCalls = 0;
    OAUTH_PROVIDERS["github-copilot"]!.refresh = async () => {
      refreshCalls += 1;
      return {
        access: "fixture-new-token", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
        apiBaseUrl: "https://api.business.githubcopilot.com",
      };
    };
    const calls: { url: string; authorization: string | null }[] = [];
    try {
      const rows = await gatherRoutedModels({ providers: {
        "github-copilot": {
          ...structuredClone(OAUTH_PROVIDERS["github-copilot"]!.providerConfig),
          fetch: async (input, init) => {
            calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
            return Response.json({ data: [{ id: "fixture-model" }] });
          },
        },
      } });

      expect(refreshCalls).toBe(1);
      expect(calls).toEqual([{ url: "https://api.business.githubcopilot.com/models", authorization: "Bearer fixture-new-token" }]);
      expect(rows.map(row => row.id)).toContain("fixture-model");
    } finally {
      OAUTH_PROVIDERS["github-copilot"]!.refresh = originalRefresh;
    }
  });

  test("expired active token stays typed and gather does not refresh or touch the auth store", async () => {
    const now = Date.now();
    const authPath = join(opencodexHome, "auth.json");
    writeFileSync(authPath, authStoreBytes(now - 1), { mode: 0o600 });
    chmodSync(authPath, 0o644);

    // A pre-existing intent marker proves observe-only gather neither removes nor rewrites it.
    const intentPath = getAuthRefreshIntentPath("kimi", "active");
    writeFileSync(intentPath, "{\"version\":1,\"sentinel\":true}\n", { mode: 0o600 });

    const authBefore = snapshotFile(authPath);
    const intentBefore = snapshotFile(intentPath);
    const listingBefore = readdirSync(opencodexHome).sort();
    const observedBuffer = readFileSync(authPath);
    let refreshCalls = 0;
    let outboundCalls = 0;
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      refreshCalls += 1;
      return { access: "replacement-a", refresh: "replacement-r", expires: now + 3_600_000 };
    };

    expect(observeActiveOAuthAccessToken("kimi", observedBuffer, now).kind).toBe("expired");
    const { rows, outcomes, modelOutcomes } = await runCatalogGather(
      observedBuffer,
      () => { outboundCalls += 1; },
    );

    expect(rows.map(row => row.id)).toEqual(["k3"]);
    expect(refreshCalls).toBe(0);
    expect(outboundCalls).toBe(0);
    expect(outcomes).toEqual([{ provider: "kimi", state: "expired" }]);
    expect(modelOutcomes).toEqual([{ provider: "kimi", state: "degraded" }]);
    expectFileUnchanged(authPath, authBefore);
    expectFileUnchanged(intentPath, intentBefore);
    expect(readdirSync(opencodexHome).sort()).toEqual(listingBefore);
    expect(readdirSync(opencodexHome).some(name => name.startsWith("auth.json.invalid-"))).toBe(false);
    expect(existsSync(`${authPath}.pre-multiauth`)).toBe(false);
  });

  test("unparseable auth-store bytes are typed malformed and never backed up or rewritten", async () => {
    const authPath = join(opencodexHome, "auth.json");
    writeFileSync(authPath, "{unparseable\n", { mode: 0o644 });
    const before = snapshotFile(authPath);
    const listingBefore = readdirSync(opencodexHome).sort();
    const observedBuffer = readFileSync(authPath);
    let refreshCalls = 0;
    let outboundCalls = 0;
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      refreshCalls += 1;
      return { access: "replacement-a", refresh: "replacement-r", expires: Date.now() + 3_600_000 };
    };

    expect(observeActiveOAuthAccessToken("kimi", observedBuffer).kind).toBe("malformed");
    const { rows, outcomes, modelOutcomes } = await runCatalogGather(
      observedBuffer,
      () => { outboundCalls += 1; },
    );

    expect(rows.map(row => row.id)).toEqual(["k3"]);
    expect(outcomes).toEqual([{ provider: "kimi", state: "malformed" }]);
    expect(modelOutcomes).toEqual([{ provider: "kimi", state: "degraded" }]);
    expect(refreshCalls).toBe(0);
    expect(outboundCalls).toBe(0);
    expectFileUnchanged(authPath, before);
    expect(readdirSync(opencodexHome).sort()).toEqual(listingBefore);
    expect(readdirSync(opencodexHome).some(name => name.startsWith("auth.json.invalid-"))).toBe(false);
    expect(existsSync(`${authPath}.pre-multiauth`)).toBe(false);
  });

  test("available observed token permits live discovery without entering refresh", async () => {
    const now = Date.now();
    const authPath = join(opencodexHome, "auth.json");
    writeFileSync(authPath, authStoreBytes(now + 3_600_000), { mode: 0o644 });
    const before = snapshotFile(authPath);
    const listingBefore = readdirSync(opencodexHome).sort();
    const observedBuffer = readFileSync(authPath);
    let refreshCalls = 0;
    let outboundCalls = 0;
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      refreshCalls += 1;
      return { access: "replacement-a", refresh: "replacement-r", expires: now + 3_600_000 };
    };

    expect(observeActiveOAuthAccessToken("kimi", observedBuffer, now).kind).toBe("available");
    const { rows, outcomes, modelOutcomes } = await runCatalogGather(
      observedBuffer,
      () => { outboundCalls += 1; },
    );

    expect(rows.map(row => row.id)).toEqual(["k3"]);
    expect(outcomes).toEqual([{ provider: "kimi", state: "available" }]);
    expect(modelOutcomes).toEqual([{ provider: "kimi", state: "authoritative" }]);
    expect(refreshCalls).toBe(0);
    expect(outboundCalls).toBe(1);
    expectFileUnchanged(authPath, before);
    expect(readdirSync(opencodexHome).sort()).toEqual(listingBefore);
  });

  test("Devin discovery keeps the durable key bound to its observed tenant host", async () => {
    const tenantBaseUrl = "https://eu.windsurf.com/_route/api_server";
    const observedBuffer = devinAuthStoreBytes(tenantBaseUrl);
    const observation = observeActiveOAuthAccessToken("devin", observedBuffer);
    expect(observation.kind).toBe("available");
    if (observation.kind !== "available") throw new Error("expected available Devin credential");
    expect(observation.snapshot.apiBaseUrl).toBe(tenantBaseUrl);

    writeFileSync(join(opencodexHome, "auth.json"), observedBuffer, { mode: 0o600 });
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response("upstream unavailable", { status: 503 });
    }) as typeof fetch;
    try {
      const provider = structuredClone(OAUTH_PROVIDERS["devin"]!.providerConfig);
      await gatherRoutedModelsForCatalogGather(
        { providers: { devin: provider } },
        { authStoreBuffer: observedBuffer },
      );
      clearModelCache();
      await gatherRoutedModels({ providers: { devin: provider } });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Both observe-only catalog materialization and ordinary refreshing discovery
    // must retain the account's destination alongside its token.
    expect(urls.length).toBe(2);
    expect(urls.every(url => url.startsWith(`${tenantBaseUrl}/`))).toBe(true);
    expect(urls.every(url => !url.startsWith("https://server.codeium.com/"))).toBe(true);
  });

  test("Devin observation rejects a Copilot-only destination while Copilot keeps its own host", () => {
    const copilotHost = "https://region.githubcopilot.com";
    const devin = observeActiveOAuthAccessToken("devin", devinAuthStoreBytes(copilotHost));
    expect(devin.kind).toBe("available");
    if (devin.kind !== "available") throw new Error("expected available Devin credential");
    expect(devin.snapshot.apiBaseUrl).toBeUndefined();

    const tenantUrl = "https://eu.windsurf.com/_route/api_server";
    const validDevin = observeActiveOAuthAccessToken("devin", devinAuthStoreBytes(tenantUrl));
    expect(validDevin.kind).toBe("available");
    if (validDevin.kind !== "available") throw new Error("expected available Devin credential");
    expect(validDevin.snapshot.apiBaseUrl).toBe(tenantUrl);

    const copilotStore = Buffer.from(JSON.stringify({
      "github-copilot": {
        activeAccountId: "active",
        accounts: [{ id: "active", credential: {
          access: "fixture-copilot-key", refresh: "fixture-copilot-key",
          expires: Number.MAX_SAFE_INTEGER, apiBaseUrl: copilotHost,
        } }],
      },
    }));
    const copilot = observeActiveOAuthAccessToken("github-copilot", copilotStore);
    expect(copilot.kind).toBe("available");
    if (copilot.kind !== "available") throw new Error("expected available Copilot credential");
    expect(copilot.snapshot.apiBaseUrl).toBe(copilotHost);
  });

  test("Devin invalid stored tenant uses the same fixed route for discovery and decoding", async () => {
    const provider = { adapter: "devin", baseUrl: "https://windsurf.com",
      authMode: "oauth", liveModels: true, models: [] } as OcxProviderConfig;
    const destination = "https://server.codeium.com";
    const authPath = join(opencodexHome, "auth.json");
    writeFileSync(authPath, devinAuthStoreBytes("https://invalid.example"), { mode: 0o600 });
    setCachedCatalogForTests(parseCatalogBuffer(
      encodeMessage(1, Buffer.concat([encodeString(1, "fixed-route-only-model"), encodeString(22, "fixed-route-only-model")])),
      "fixture-devin-key", destination,
    ));
    try {
      expect((await fetchProviderModels("devin", provider, 60_000)).map(row => row.id)).toContain("fixed-route-only-model");
      expect(knownModelIdsForProvider("devin", provider)).toContain("fixed-route-only-model");
    } finally {
      setCachedCatalogForTests(null);
    }
  });

  test("Devin catalog and routing cache follow the full tenant path with one token", async () => {
    const tenantA = "https://eu.windsurf.com/_route/api_server/tenant_a";
    const tenantB = "https://eu.windsurf.com/_route/api_server/tenant_b";
    const provider = { adapter: "devin", baseUrl: "https://server.codeium.com",
      authMode: "oauth", liveModels: true, models: [] } as OcxProviderConfig;
    const authPath = join(opencodexHome, "auth.json");
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (() => { networkCalls++; throw new Error("unexpected Devin catalog request"); }) as typeof fetch;
    try {
      const roster = (id: string, destination: string) => {
        setCachedCatalogForTests(parseCatalogBuffer(
          encodeMessage(1, Buffer.concat([encodeString(1, id), encodeString(22, id)])),
          "fixture-devin-key", destination,
        ));
        writeFileSync(authPath, devinAuthStoreBytes(destination), { mode: 0o600 });
      };
      roster("tenant-a-only-model", tenantA);
      expect((await fetchProviderModels("devin", provider, 60_000)).map(row => row.id))
        .toContain("tenant-a-only-model");
      expect(knownModelIdsForProvider("devin", provider)).toContain("tenant-a-only-model");

      roster("tenant-b-only-model", tenantB);
      expect(knownModelIdsForProvider("devin", provider)).not.toContain("tenant-a-only-model");
      const tenantBModels = (await fetchProviderModels("devin", provider, 60_000)).map(row => row.id);
      expect(tenantBModels).toContain("tenant-b-only-model");
      expect(tenantBModels).not.toContain("tenant-a-only-model");
      expect(knownModelIdsForProvider("devin", provider)).toContain("tenant-b-only-model");
      expect(knownModelIdsForProvider("devin", provider)).not.toContain("tenant-a-only-model");

      // A failure at B may serve B's stale roster, but its cooldown cannot
      // suppress a subsequent discovery for A under the same token.
      setCachedCatalogForTests(null);
      expect((await fetchProviderModels("devin", provider, 0)).map(row => row.id))
        .toContain("tenant-b-only-model");
      expect(networkCalls).toBeGreaterThan(0);
      const callsAfterFailure = networkCalls;
      roster("tenant-a-only-model", tenantA);
      expect((await fetchProviderModels("devin", provider, 60_000)).map(row => row.id))
        .toContain("tenant-a-only-model");
      expect(networkCalls).toBe(callsAfterFailure);
    } finally {
      setCachedCatalogForTests(null);
      globalThis.fetch = originalFetch;
    }
  });
});
