import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import {
  loadExportModels,
  previewExportModels,
  resetExportSnapshotForTests,
} from "../../src/server/management/model-rows";
import { clearGatherRoutedModelsInflight, resetCatalogRuntimeStateForTests } from "../../src/codex/catalog";
import { clearModelCache, getStaleCached, setCached } from "../../src/codex/model-cache";
import type { ExportModel } from "../../src/clients/config-export";
import type { OcxConfig } from "../../src/types";

/**
 * Two publications can interleave inside one export load, and the roster it retains has to be
 * identified by the revision that stood when its rows were chosen rather than by whatever is
 * current when it finishes.
 *
 * The interleaving here is real, not simulated: the load runs a two-provider gather, alpha answers
 * immediately and beta is held open, so the load is still inside its own await after alpha has
 * chosen and published its rows. A competing publication lands in that window. Sampling the
 * revision at retention time would record alpha's rows under the competing publication's identity,
 * and every later check would then agree the preview was current.
 */
const ALPHA_HOST = "https://alpha.gather-race.test/v1";
const BETA_HOST = "https://beta.gather-race.test/v1";

const originalFetch = globalThis.fetch;
let configRoot = "";
let priorHome: string | undefined;

function raceConfig(): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "alpha",
    providers: {
      alpha: { adapter: "openai-chat", baseUrl: ALPHA_HOST, models: [] },
      beta: { adapter: "openai-chat", baseUrl: BETA_HOST, models: [] },
    },
  } as OcxConfig);
}

/** Alpha answers at once; beta stays open until the returned release is called. */
function holdBetaOpen(): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const alpha = String(input).includes("alpha.");
    if (!alpha) await gate;
    return new Response(JSON.stringify({ data: [{ id: alpha ? "alpha-chosen" : "beta-only" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return release;
}

/**
 * Resolves once alpha's rows are published, which is also once they are stamped: the provider
 * publishes and builds its result in one synchronous block, so a cache entry another task can see
 * is proof the revision that vouches for those rows has already been taken.
 */
async function afterAlphaChoseItsRows(): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (getStaleCached("alpha") !== null) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("alpha never published its rows");
}

const alphaRows = (models: readonly ExportModel[]): string[] =>
  models.filter(model => model.provider === "alpha").map(model => model.namespaced);

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "ocx-gather-race-"));
  priorHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = configRoot;
  resetExportSnapshotForTests();
  clearModelCache();
  clearGatherRoutedModelsInflight();
  resetCatalogRuntimeStateForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetExportSnapshotForTests();
  clearModelCache();
  clearGatherRoutedModelsInflight();
  resetCatalogRuntimeStateForTests();
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(configRoot);
});

describe("an export load retains the revision its rows were chosen under", () => {
  test("a load nothing competes with leaves a preview that serves exactly what it returned", async () => {
    const release = holdBetaOpen();
    const config = raceConfig();
    const load = loadExportModels(config);
    await afterAlphaChoseItsRows();
    release();
    const exported = await load;

    expect(alphaRows(exported)).toEqual(["alpha/alpha-chosen"]);
    // The control for the case below. Without it, a preview refused for some unrelated reason
    // would look like the race being closed.
    expect(previewExportModels(config)).toEqual(exported);
  });

  test("rows chosen before a competing publication are never served as current", async () => {
    const release = holdBetaOpen();
    const config = raceConfig();
    const load = loadExportModels(config);
    await afterAlphaChoseItsRows();
    // The competing flight publishes here: alpha has chosen and stamped its rows, and this load
    // has not reached its retention yet because beta is still open.
    expect(setCached("alpha", [{ id: "alpha-superseded", provider: "alpha" }])).toBe(true);
    release();
    const exported = await load;

    // The load still returns the rows it fetched. Those rows are not wrong; they are simply no
    // longer the current ones.
    expect(alphaRows(exported)).toEqual(["alpha/alpha-chosen"]);
    // What must not survive is the claim that they are current. Sampling the revision at
    // retention would have read the competing publication's, matched it on the way out, and
    // handed a preview these rows under an identity they never had.
    expect(previewExportModels(config)).toBeNull();
  });
});
