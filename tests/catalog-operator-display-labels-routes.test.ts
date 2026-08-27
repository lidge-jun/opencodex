/**
 * #2201: operator display labels must reach every surface that lists routed models,
 * not just the on-disk catalog.
 *
 * `applyOperatorDisplayLabels` was originally called only from `prepareCatalog`, so
 * the live `GET /v1/models` route, `/api/models`, and client exports all kept
 * emitting the routed slug as the label while the on-disk catalog was correct. A
 * unit test that calls the helper by hand cannot see that gap — it proves the
 * helper works, not that anything uses it. So these drive the real routes.
 *
 * Each surface is exercised twice, with and without the operator map, and the two
 * results are compared field by field. That is what pins "display-only": rather
 * than listing the fields that must not move — slug, provider, native id,
 * ordering, spawn-candidate identity — the whole payload is required to be
 * identical once the label field is normalised away. A change that shifted
 * ordering, or renamed an id, would fail without anyone having predicted it.
 */

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

// startServer plus two discovery GETs exceeds the default 5s budget under full-suite
// Windows load, same flake class as claude-models-discovery.
setDefaultTimeout(30_000);

const LABEL = "Fast Draft";
const LABELLED = "test-model";
const PLAIN = "other-model";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-label-routes-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-label-routes-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

/** Static models, so the surfaces under test never depend on a live provider fetch. */
function config(modelDisplayNames?: Record<string, string>): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    openaiProviderTierVersion: 2,
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        liveModels: false,
        models: [PLAIN, LABELLED],
        ...(modelDisplayNames ? { modelDisplayNames } : {}),
      },
    },
  } as unknown as OcxConfig;
}

/** Run a surface against a config, from a clean load each time. */
async function withConfig<T>(
  modelDisplayNames: Record<string, string> | undefined,
  read: (config: OcxConfig) => Promise<T>,
): Promise<T> {
  saveConfig(config(modelDisplayNames));
  return read(loadConfig());
}

/**
 * Drop a field everywhere it appears, so everything *else* can be compared.
 *
 * Removed rather than blanked: on the management and export rows the label field
 * is optional and only present once a label resolves, so its *presence* is part
 * of what changes. Blanking left the labelled run with an extra key and the
 * comparison failed for the one reason it was meant to ignore.
 */
function withoutField(value: unknown, field: string): unknown {
  if (Array.isArray(value)) return value.map(entry => withoutField(entry, field));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === field) continue;
    out[key] = withoutField(inner, field);
  }
  return out;
}

// -- GET /v1/models, the live Codex catalog route --------------------------

async function codexCatalog(modelDisplayNames?: Record<string, string>) {
  saveConfig(config(modelDisplayNames));
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?client_version=0.50.0", server.url), {
      headers: { authorization: "Bearer placeholder" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { models: { slug: string; display_name?: string }[] };
    return body.models;
  } finally {
    await server.stop(true);
  }
}

test("GET /v1/models emits the operator label as display_name", async () => {
  const models = await codexCatalog({ [LABELLED]: LABEL });
  const labelled = models.find(m => m.slug === `mock/${LABELLED}`);
  const plain = models.find(m => m.slug === `mock/${PLAIN}`);

  expect(labelled?.display_name).toBe(LABEL);
  // The unmapped sibling keeps today's behaviour: the routed slug as its label.
  expect(plain?.display_name).toBe(`mock/${PLAIN}`);
  // The routing identity is untouched — the slug is what the client sends back.
  expect(labelled?.slug).toBe(`mock/${LABELLED}`);
});

test("GET /v1/models changes nothing but the label", async () => {
  const before = await codexCatalog();
  const after = await codexCatalog({ [LABELLED]: LABEL });

  expect(before.find(m => m.slug === `mock/${LABELLED}`)?.display_name).toBe(`mock/${LABELLED}`);
  expect(after.find(m => m.slug === `mock/${LABELLED}`)?.display_name).toBe(LABEL);
  // Ordering included: the arrays are compared in order, so a label that moved a
  // row would fail here even though no field changed.
  expect(withoutField(after, "display_name")).toEqual(withoutField(before, "display_name"));
});

test("removing the label restores the derived one on the live route", async () => {
  expect((await codexCatalog({ [LABELLED]: LABEL }))
    .find(m => m.slug === `mock/${LABELLED}`)?.display_name).toBe(LABEL);
  expect((await codexCatalog({}))
    .find(m => m.slug === `mock/${LABELLED}`)?.display_name).toBe(`mock/${LABELLED}`);
});

// -- management rows and client exports ------------------------------------

test("/api/models rows carry the operator label, and nothing else moves", async () => {
  const read = async (cfg: OcxConfig) => {
    const { listManagementModelRows } = await import("../src/server/management/model-rows");
    return listManagementModelRows(cfg);
  };
  const before = await withConfig(undefined, read);
  const after = await withConfig({ [LABELLED]: LABEL }, read);

  const row = (rows: Awaited<ReturnType<typeof read>>, id: string) =>
    rows.find(r => r.provider === "mock" && r.id === id) as Record<string, unknown> | undefined;

  expect(row(after, LABELLED)?.displayName).toBe(LABEL);
  expect(row(before, LABELLED)?.displayName).toBeUndefined();
  expect(row(after, PLAIN)?.displayName).toBeUndefined();
  // `namespaced` is the routing identity the GUI writes back into disabledModels.
  expect(row(after, LABELLED)?.namespaced).toBe(`mock/${LABELLED}`);
  expect(withoutField(after, "displayName")).toEqual(withoutField(before, "displayName"));
});

test("client exports carry the operator label, and nothing else moves", async () => {
  const read = async (cfg: OcxConfig) => {
    const { loadExportModels } = await import("../src/server/management/model-rows");
    return loadExportModels(cfg);
  };
  const before = await withConfig(undefined, read);
  const after = await withConfig({ [LABELLED]: LABEL }, read);

  const exported = (models: Awaited<ReturnType<typeof read>>, id: string) =>
    models.find(m => (m as Record<string, unknown>).namespaced === `mock/${id}`) as
      Record<string, unknown> | undefined;

  expect(exported(after, LABELLED)?.displayName).toBe(LABEL);
  expect(exported(before, LABELLED)?.displayName).toBeUndefined();
  expect(exported(after, LABELLED)?.id).toBe(LABELLED);
  expect(withoutField(after, "displayName")).toEqual(withoutField(before, "displayName"));
});

// -- the boundary itself ---------------------------------------------------

test("fetchAllModels is the labelling boundary every server surface shares", async () => {
  // The three surfaces above all reach live models through this one call. Pinning
  // it directly means a fourth consumer added later inherits the labels rather
  // than quietly becoming a fifth surface that shows routed slugs.
  const models = await withConfig({ [LABELLED]: LABEL }, async cfg => {
    const { fetchAllModels } = await import("../src/server/management/shared");
    return fetchAllModels(cfg);
  });

  expect(models.find(m => m.id === LABELLED)?.displayName).toBe(LABEL);
  expect(models.find(m => m.id === PLAIN)?.displayName).toBeUndefined();
  // Identity is untouched, which is what makes this safe to do for every caller.
  expect(models.map(m => `${m.provider}/${m.id}`).sort()).toEqual(
    [`mock/${PLAIN}`, `mock/${LABELLED}`].sort(),
  );
});
