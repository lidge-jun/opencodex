import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { parseFastRowId, fastRowBases } from "../../src/server/fast-row";
import { knownEffortRowIds } from "../../src/server/effort-row";
import { collectDefaultModelExposure } from "../../src/cli/doctor";
import { configSchema } from "../../src/config/schema/config-schema";
import { routeModel } from "../../src/router";
import { gatherRoutedModels } from "../../src/codex/catalog/provider-fetch";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";

/**
 * `preferModelAliasIds` changes the `/v1/models` row `id` from `provider/nativeId` to the
 * effective model alias when one exists.  This lets every downstream harness (Codex CLI,
 * Command Code, Claude Code, Hermes) discover operator-chosen short names directly from the
 * API, eliminating per-harness synchronization scripts.
 *
 * Each case starts a real server with `startServer(0)`, hits `GET /v1/models`, and inspects
 * the JSON output — the same integration style used by Cursor local-models and Grok discovery.
 */
setDefaultTimeout(SERVER_BUDGET_MS);

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function aliasConfig(prefer: boolean): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "seek",
    ...(prefer ? { preferModelAliasIds: true } : {}),
    providers: {
      seek: {
        adapter: "openai-chat",
        baseUrl: "https://seek.example/v1",
        alias: "SEK",
        liveModels: false,
        models: ["glm-4.7-flash"],
        modelAliases: {
          "glm-4.7-flash": "SEK-glm-4.7-flash",
        },
      },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-prefer-alias-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  // Startup leaves config-dir ACL hardening in flight on Windows; settle it before removal.
  if (testHome) await removeTreeAfterBackgroundWork(testHome);
  testHome = "";
});

describe("preferModelAliasIds on /v1/models", () => {
  test("default (off): row id is provider/nativeId, no native_id field", async () => {
    saveConfig(aliasConfig(false));
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string; alias_of?: string; native_id?: string }[] };
      const seekRow = body.data.find(m => m.id.includes("glm") || m.id.includes("SEK"));
      expect(seekRow).toBeDefined();
      // Without the flag, id is the traditional provider/nativeId form
      expect(seekRow!.id).toContain("/");
      // native_id is only added when alias is promoted
      expect(seekRow!.native_id).toBeUndefined();
      // alias_of is present because we have modelAliases
      expect(seekRow!.alias_of).toBeDefined();
    } finally {
      await server.stop(true);
    }
  });

  test("on: row id becomes the effective alias, native_id preserves original", async () => {
    saveConfig(aliasConfig(true));
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string; alias_of?: string; native_id?: string }[] };
      const seekRow = body.data.find(m => m.id === "SEK-glm-4.7-flash");
      expect(seekRow).toBeDefined();
      // alias is now the id
      expect(seekRow!.id).toBe("SEK-glm-4.7-flash");
      // native_id preserves the old form
      expect(seekRow!.native_id).toBeDefined();
      expect(seekRow!.native_id).toContain("glm-4.7-flash");
      expect(seekRow!.native_id).toContain("/");
      // alias_of still present for backward compatibility
      expect(seekRow!.alias_of).toBeDefined();
    } finally {
      await server.stop(true);
    }
  });

  test("on: models without modelAliases keep their provider/nativeId as id", async () => {
    const config = aliasConfig(true);
    // Add a second provider without modelAliases
    config.providers.plain = {
      adapter: "openai-chat",
      baseUrl: "https://plain.example/v1",
      liveModels: false,
      models: ["test-model"],
    };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string; alias_of?: string; native_id?: string }[] };
      const plainRow = body.data.find(m => m.id.includes("test-model"));
      expect(plainRow).toBeDefined();
      // No alias → id stays as provider/nativeId
      expect(plainRow!.id).toBe("plain/test-model");
      // No native_id added when no alias swap happened
      expect(plainRow!.native_id).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});


test("shared aliases remain qualified, unique and routable", async () => {
  const config = aliasConfig(true);
  config.providers.other = { ...config.providers.seek!, alias: "OTH" };
  saveConfig(config);
  const server = startServer(0);
  try {
    const body = await (await fetch(new URL("/v1/models", server.url))).json() as { data: { id: string }[] };
    const ids = body.data.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("SEK-glm-4.7-flash");
    expect(ids).toContain("seek/glm-4.7-flash");
    expect(ids).toContain("other/glm-4.7-flash");
    for (const id of ids) expect(() => routeModel(config, id)).not.toThrow();
  } finally { await server.stop(true); }
});

test("a shadowed alias never advertises a different provider's route", async () => {
  const config = aliasConfig(true);
  config.providers.seek!.modelAliases = { "glm-4.7-flash": "plain-native" };
  config.providers.plain = { adapter: "openai-chat", baseUrl: "https://plain.example/v1", liveModels: false, models: ["plain-native"] };
  saveConfig(config);
  const server = startServer(0);
  try {
    const body = await (await fetch(new URL("/v1/models", server.url))).json() as { data: { id: string; owned_by: string }[] };
    const row = body.data.find(row => row.owned_by === "seek")!;
    expect(routeModel(config, row.id)).toMatchObject({ providerName: "seek", modelId: "glm-4.7-flash" });
  } finally { await server.stop(true); }
});

test("preferred and native IDs share a route; Codex gather is unchanged", async () => {
  const config = aliasConfig(true);
  expect(routeModel(config, "SEK-glm-4.7-flash")).toMatchObject({ providerName: "seek", modelId: "glm-4.7-flash" });
  expect(routeModel(config, "seek/glm-4.7-flash")).toMatchObject({ providerName: "seek", modelId: "glm-4.7-flash" });
  const before = await gatherRoutedModels({ ...config, preferModelAliasIds: false });
  const after = await gatherRoutedModels(config);
  expect(after.map(m => [m.id, m.alias])).toEqual(before.map(m => [m.id, m.alias]));
  expect(after.filter(m => m.provider === "seek")).toHaveLength(1);
});


test("built-in aliases preserve routable Fast siblings", async () => {
  const config = aliasConfig(true);
  config.defaultModelAliases = true;
  config.providers.seek!.models = ["claude-haiku-4-5"];
  config.providers.seek!.modelAliases = {};
  config.providers.seek!.supportsServiceTier = true;
  saveConfig(config);
  const server = startServer(0);
  try {
    const body = await (await fetch(new URL("/v1/models", server.url))).json() as { data: { id: string }[] };
    const fast = body.data.filter(row => row.id.endsWith("--fast"));
    expect(fast).toHaveLength(1);
    for (const row of fast) {
      const parsed = parseFastRowId(row.id, config, knownEffortRowIds(config), fastRowBases(config));
      expect(parsed).not.toBeNull();
      expect(routeModel(config, parsed!.baseId)).toMatchObject({ providerName: "seek", modelId: "claude-haiku-4-5" });
    }
  } finally { await server.stop(true); }
});


test("Codex and Anthropic discovery retain one unchanged identity per model", async () => {
  const snapshots: string[][][] = [];
  for (const prefer of [false, true]) {
    saveConfig(aliasConfig(prefer));
    const server = startServer(0);
    try {
      const codex = await (await fetch(new URL("/v1/models?client_version=0.130.0", server.url))).json() as { models: { slug: string }[] };
      const anthropic = await (await fetch(new URL("/v1/models", server.url), { headers: { "anthropic-version": "2023-06-01", "user-agent": "claude-code/2.1.207" } })).json() as { data: { id: string }[] };
      const ids = [codex.models.map(row => row.slug), anthropic.data.map(row => row.id)];
      for (const list of ids) {
        expect(list.length).toBeGreaterThan(0);
        expect(new Set(list).size).toBe(list.length);
      }
      snapshots.push(ids.map(list => list.toSorted()));
    } finally { await server.stop(true); }
  }
  expect(snapshots[1]).toEqual(snapshots[0]);
});


test("Cursor Fast listing keeps the advertised Fast identity", async () => {
  const config = aliasConfig(true);
  config.fastMode = true;
  config.defaultProvider = "cursor";
  config.providers = { cursor: { adapter: "openai-chat", baseUrl: "https://cursor.example/v1", liveModels: false, models: ["claude-opus-5"], modelAliases: { "claude-opus-5": "opus-pick" } } };
  saveConfig(config);
  const server = startServer(0);
  try {
    const body = await (await fetch(new URL("/v1/models", server.url))).json() as { data: { id: string; native_id?: string }[] };
    expect(body.data.map(row => row.id)).toContain("cursor/claude-opus-5-thinking-fast");
    expect(body.data.map(row => row.id)).not.toContain("opus-pick");
  } finally { await server.stop(true); }
});

test("the config schema validates the alias-ID opt-in independently", () => {
  const config = { ...aliasConfig(true), port: 18276 };
  expect(configSchema.parse(config).preferModelAliasIds).toBe(true);
  expect(configSchema.parse({ ...config, preferModelAliasIds: false }).preferModelAliasIds).toBe(false);
  expect(configSchema.parse({ ...config, preferModelAliasIds: "true" }).preferModelAliasIds).toBe(false);
});

test("doctor recognizes the native ID retained on an alias row", async () => {
  const result = await collectDefaultModelExposure({
    readConfiguredModelFn: () => "seek/glm-4.7-flash",
    readCatalogModelsFn: () => null,
    live: { pid: 4321, port: 18277, source: "config" },
    fetchFn: async () => new Response(JSON.stringify({ data: [{ id: "SEK-glm-4.7-flash", native_id: "seek/glm-4.7-flash" }] })),
  });
  expect(result.status).toBe("exposed");
  expect(result.source).toBe("proxy");
});
