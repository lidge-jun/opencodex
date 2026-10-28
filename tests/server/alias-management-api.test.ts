import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { refreshOwnedIntegration } from "../../src/integrations/owned-refresh";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration } from "../../src/integrations/writer";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function config(): OcxConfig {
  return { port: 10100, defaultProvider: "alpha", apiKeys: [{ id: "test", name: "test", key: "test-key", createdAt: new Date(0).toISOString() }], providers: {
    alpha: { adapter: "openai-chat", baseUrl: "https://alpha.test/v1", models: ["m1", "m2"] },
    beta: { adapter: "openai-chat", baseUrl: "https://beta.test/v1", models: ["b1"] },
  } };
}

async function request(c: OcxConfig, path: string, body?: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "PUT",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), host: "localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleManagementAPI(req, new URL(req.url), c, {
    saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory(),
  });
}

test("alias management routes persist partial updates and expose the effective view", async () => {
  const c = config();
  expect((await request(c, "/api/providers/alpha/alias", { alias: "a" }))?.status).toBe(200);
  expect((await request(c, "/api/providers/alpha/model-aliases", { set: { m1: "one" } }))?.status).toBe(200);
  expect((await request(c, "/api/default-aliases", { enabled: true, provider: "alpha" }))?.status).toBe(200);
  const response = await request(c, "/api/aliases");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ providers: { alpha: "a" }, models: { alpha: { m1: { alias: "one", source: "user" } } }, defaults: { providers: { alpha: true } } });
});

test("alias mutations converge owned client catalogs with the same refresh as visibility writes", async () => {
  const c = config();
  const refreshed: string[] = [];
  const convergeWith = async (path: string, body: unknown) => {
    const url = new URL(`http://localhost${path}`);
    return handleManagementAPI(new Request(url, {
      method: "PUT", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body),
    }), url, c, {
      saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory(),
      refreshOwnedCatalogIntegrations: async input => {
        const models = typeof input.models === "function" ? await input.models() : input.models;
        refreshed.push(`${path}:${models.map(model => model.namespaced).sort().join(",")}`);
        return [{ client: "hermes", ok: true, changed: true }];
      },
    });
  };
  for (const [path, body] of [
    ["/api/providers/alpha/alias", { alias: "gamma" }],
    ["/api/providers/alpha/model-aliases", { set: { m1: "one" } }],
    ["/api/default-aliases", { enabled: true, provider: "alpha" }],
  ] as const) {
    const response = await convergeWith(path, body);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, clientIntegrations: [{ client: "hermes", ok: true, changed: true }] });
  }
  expect(refreshed).toHaveLength(3);
});

test("a rename or removal of an alias migrates an alias-mode Hermes record and refuses a foreign edit", async () => {
  const base = mkdtempSync(join(tmpdir(), "ocx-alias-convergence-"));
  const home = join(base, "home");
  const env = { HOME: home, OPENCODEX_HOME: join(base, "opencodex"), CODEX_HOME: join(base, "codex") } as NodeJS.ProcessEnv;
  const store = createIntegrationStateStore(join(base, "store", "integrations"));
  mkdirSync(home, { recursive: true });
  const spec = INTEGRATION_CLIENTS.hermes;
  mkdirSync(spec.detectDir(env, home), { recursive: true });
  const configPath = spec.configPath(env, home);
  mkdirSync(dirname(configPath), { recursive: true });
  try {
    const aliased = (alias: string | undefined): OcxConfig => ({
      port: 10100,
      defaultProvider: "seek",
      providers: {
        seek: {
          adapter: "openai-chat", baseUrl: "https://seek.example/v1", ...(alias ? { alias } : {}),
          liveModels: false, models: ["glm-4.7-flash"], modelAliases: { "glm-4.7-flash": "fast" },
        },
      },
    } as unknown as OcxConfig);
    const roster: ExportModel[] = [{ namespaced: "seek/glm-4.7-flash", provider: "seek", id: "glm-4.7-flash", contextWindow: 100_000 }];

    const applied = applyIntegration({
      clientId: "hermes", models: roster, config: aliased("SEK"), port: 10100,
      env, home, store, modelIdMode: "alias",
    });
    expect(applied.ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain("SEK/fast");

    const refreshWith = (cfg: OcxConfig) => refreshOwnedIntegration(
      { clientId: "hermes", models: roster, config: cfg, port: 10100, env, home, store },
    );

    const renamed = aliased("SEKX");
    expect(await refreshWith(renamed)).toMatchObject({ client: "hermes", ok: true, changed: true });
    const afterRename = readFileSync(configPath, "utf8");
    expect(afterRename).toContain("SEKX/fast");
    expect(afterRename).not.toContain("SEK/fast");

    const removed = aliased(undefined);
    expect(await refreshWith(removed)).toMatchObject({ client: "hermes", ok: true });
    const afterRemoval = readFileSync(configPath, "utf8");
    expect(afterRemoval).toContain("seek/fast");
    expect(afterRemoval).not.toContain("SEKX/fast");

    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n# foreign edit\n`);
    const refused = await refreshWith(aliased("SEKZ"));
    expect(refused).toMatchObject({ client: "hermes", ok: false, refusalReason: "conflict", state: "conflict" });
    expect(readFileSync(configPath, "utf8")).toContain("# foreign edit");
    expect(readFileSync(configPath, "utf8")).not.toContain("SEKZ/fast");
  } finally {
    removeTreeWithRetry(base);
  }
});

test("alias write routes reject case-insensitive collisions", async () => {
  const c = config();
  expect((await request(c, "/api/providers/alpha/alias", { alias: "BETA" }))?.status).toBe(409);
  expect((await request(c, "/api/providers/alpha/model-aliases", { set: { m1: "m2" } }))?.status).toBe(409);
  expect((await request(c, "/api/providers/alpha/model-aliases", { set: { m1: "same", m2: "SAME" } }))?.status).toBe(409);
  expect((await request(c, "/api/providers/alpha/model-aliases", { set: { m1: "gpt-5.6-sol" } }))?.status).toBe(409);
});
