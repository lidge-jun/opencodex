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
} from "../src/oauth";
import {
  gatherRoutedModelsForCatalogGather,
  type CatalogGatherProviderAuthOutcome,
  type CatalogGatherProviderModelOutcome,
} from "../src/codex/catalog/provider-fetch";
import { clearModelCache } from "../src/codex/model-cache";
import { getAuthRefreshIntentPath } from "../src/oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
});
