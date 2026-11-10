import { expect, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";

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

test("alias write routes reject case-insensitive collisions", async () => {
  const c = config();
  expect((await request(c, "/api/providers/alpha/alias", { alias: "BETA" }))?.status).toBe(409);
  expect((await request(c, "/api/providers/alpha/model-aliases", { set: { m1: "m2" } }))?.status).toBe(409);
  expect((await request(c, "/api/providers/alpha/model-aliases", { set: { m1: "same", m2: "SAME" } }))?.status).toBe(409);
  expect((await request(c, "/api/providers/alpha/model-aliases", { set: { m1: "gpt-5.6-sol" } }))?.status).toBe(409);
});

test("#7705: an alias template is set, previewed, listed with its source, and cleared", async () => {
  const c = config();
  c.providers.alpha!.alias = "AL";
  const set = await request(c, "/api/providers/alpha/alias-template", { template: "{providerAlias}-{modelBasename}" });
  expect(set?.status).toBe(200);
  expect(await set?.json()).toMatchObject({ ok: true, provider: "alpha", template: "{providerAlias}-{modelBasename}", preview: { generated: 2, skipped: [] } });
  expect(c.providers.alpha!.aliasTemplate).toBe("{providerAlias}-{modelBasename}");
  const list = await (await request(c, "/api/aliases"))!.json();
  expect(list).toMatchObject({ templates: { alpha: "{providerAlias}-{modelBasename}" }, models: { alpha: { m1: { alias: "AL-m1", source: "template" }, m2: { alias: "AL-m2", source: "template" } } } });
  expect((await request(c, "/api/providers/alpha/alias-template", { template: null }))?.status).toBe(200);
  expect(c.providers.alpha!.aliasTemplate).toBeUndefined();
  expect((await (await request(c, "/api/aliases"))!.json()).models.alpha).toBeUndefined();
});

test("#7705: an invalid template or unknown provider is refused without a write", async () => {
  const c = config();
  for (const template of ["{vendor}-{modelBasename}", "{providerAlias}", "", 7]) {
    expect((await request(c, "/api/providers/alpha/alias-template", { template }))?.status).toBe(400);
  }
  expect(c.providers.alpha!.aliasTemplate).toBeUndefined();
  expect((await request(c, "/api/providers/nobody/alias-template", { template: "{modelBasename}" }))?.status).toBe(404);
});
