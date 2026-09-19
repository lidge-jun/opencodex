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
 * Things can change inside one export load, and what it retains has to be identified by the state
 * its rows were chosen under rather than by whatever is current when it finishes.
 *
 * The interleaving here is real. The load runs a two-provider gather, alpha answers immediately and
 * beta is held open, so the load is still inside its own await after alpha has chosen, published
 * and stamped its rows. Whatever the case does in that window lands where it matters.
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

/**
 * Runs the supplied step in the window where alpha has chosen and beta has not answered, then lets
 * the load finish.
 *
 * Beta is released in a finally and the load is awaited there too, because a failure inside the
 * window would otherwise leave a gather in flight while teardown clears the caches it is about to
 * publish into, and the next case would inherit it.
 */
async function loadWhileBetaIsHeld(
  during: (config: OcxConfig) => void | Promise<void>,
): Promise<{ config: OcxConfig; exported: readonly ExportModel[] }> {
  const release = holdBetaOpen();
  const config = raceConfig();
  const load = loadExportModels(config);
  const settled = load.catch(() => undefined);
  try {
    await afterAlphaChoseItsRows();
    await during(config);
  } finally {
    release();
    await settled;
  }
  return { config, exported: await load };
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

describe("an export load retains what its rows were chosen under", () => {
  test("a load nothing competes with leaves a preview that serves exactly what it returned", async () => {
    const { config, exported } = await loadWhileBetaIsHeld(() => {});

    expect(alphaRows(exported)).toEqual(["alpha/alpha-chosen"]);
    // The control for the two cases below. Without it, a preview refused for some unrelated reason
    // would look like a race being closed.
    expect(previewExportModels(config)).toEqual(exported);
  });

  test("rows chosen before a competing publication are never served as current", async () => {
    const { config, exported } = await loadWhileBetaIsHeld(() => {
      // The competing flight publishes here: alpha has chosen and stamped its rows, and this load
      // has not reached its retention yet because beta is still open.
      expect(setCached("alpha", [{ id: "alpha-superseded", provider: "alpha" }])).toBe(true);
    });

    // The load still returns the rows it fetched. Those rows are not wrong; they are simply no
    // longer the current ones.
    expect(alphaRows(exported)).toEqual(["alpha/alpha-chosen"]);
    // What must not survive is the claim that they are current. Sampling the revision at retention
    // would have read the competing publication's, matched it on the way out, and handed a preview
    // these rows under an identity they never had.
    expect(previewExportModels(config)).toBeNull();
  });

  test("a configuration edited during the load changes neither the rows nor what is retained", async () => {
    const { config, exported } = await loadWhileBetaIsHeld(edited => {
      // Management routes edit the live configuration in place. This edit would remove the row
      // below from the projection, which is what makes it visible: the load gathered under the
      // configuration it admitted and has to project under that same one.
      edited.disabledModels = ["alpha/alpha-chosen"];
    });

    // Gathered under the admitted configuration and projected under it too. Reading the live
    // object for the projection would have produced rows belonging to neither configuration.
    expect(alphaRows(exported)).toEqual(["alpha/alpha-chosen"]);
    // Retaining would record this roster under a configuration that does not produce it. Refusing
    // costs one ordinary load and is the only honest answer.
    expect(previewExportModels(config)).toBeNull();
  });

  test("replacing a provider's transport executor retires the roster it gathered", async () => {
    const { config, exported } = await loadWhileBetaIsHeld(() => {});
    expect(previewExportModels(config)).toEqual(exported);

    // The executor is the one part of a provider that is not data, so it is held by reference
    // rather than compared as content. A different executor can answer differently, so a roster
    // gathered through the previous one is no longer a roster for this configuration.
    // The executor is not part of the configuration's declared shape; the transport reads it off
    // the provider at call time, which is exactly why it is held by reference here.
    (config.providers.alpha as { fetch?: typeof fetch }).fetch = (async () => new Response("{}")) as typeof fetch;
    expect(previewExportModels(config)).toBeNull();
  });

  test("a configuration carrying an accessor is refused without the accessor being read", async () => {
    let reads = 0;
    const { config, exported } = await loadWhileBetaIsHeld(edited => {
      Object.defineProperty(edited, "disabledModels", {
        configurable: true,
        enumerable: true,
        get: () => { reads += 1; return []; },
      });
    });

    // The rows are still the ordinary answer; only the preview authority is withheld.
    expect(alphaRows(exported)).toEqual(["alpha/alpha-chosen"]);
    expect(previewExportModels(config)).toBeNull();
    // A copier that serialized the configuration would have called this and then compared whatever
    // it chose to return. Refusing without invoking it is the difference between reading a
    // configuration and asking it what it would like to be.
    expect(reads).toBe(0);
  });
});
