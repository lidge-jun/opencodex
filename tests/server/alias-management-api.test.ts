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

test("provider alias routes treat inherited object keys as unknown providers", async () => {
  const c = config();
  const routes: Array<[string, unknown]> = [
    ["alias-template", { template: "{modelBasename}-x" }],
    ["alias", { alias: "proto" }],
    ["model-aliases", { set: { m1: "proto-one" } }],
  ];
  try {
    for (const name of ["__proto__", "constructor", "toString"]) {
      for (const [route, body] of routes) {
        expect((await request(c, `/api/providers/${name}/${route}`, body))?.status).toBe(404);
      }
    }
    const probe = {} as Record<string, unknown>;
    expect(probe.aliasTemplate).toBeUndefined();
    expect(probe.alias).toBeUndefined();
    expect(probe.modelAliases).toBeUndefined();
  } finally {
    for (const key of ["aliasTemplate", "alias", "modelAliases"]) delete (Object.prototype as Record<string, unknown>)[key];
  }
});

test("#7705: provider-wide writes cannot store a template the alias-template route would refuse", async () => {
  const { validateConfigCandidate } = await import("../../src/config");
  const bad = config();
  bad.providers.alpha!.aliasTemplate = "{vendor}-{modelBasename}";
  const refused = validateConfigCandidate(bad);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toContain("aliasTemplate");
  const good = config();
  good.providers.alpha!.aliasTemplate = "{modelBasename}-x";
  expect(validateConfigCandidate(good).ok).toBe(true);

  const c = config();
  const post = (provider: Record<string, unknown>) => {
    const req = new Request("http://localhost/api/providers", { method: "POST",
      headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ name: "alpha", provider }) });
    return handleManagementAPI(req, new URL(req.url), c, { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() });
  };
  const created = await post({ ...c.providers.alpha, aliasTemplate: "{modelBasename}-x" });
  expect(created?.status).toBe(400);
  expect((await created!.json()).error).toContain("aliasTemplate is managed by the dedicated alias API");
  expect(c.providers.alpha!.aliasTemplate).toBeUndefined();
});

test("default-aliases treats inherited object keys as unknown providers", async () => {
  const c = config();
  try {
    expect((await request(c, "/api/default-aliases", { enabled: true, provider: "__proto__" }))?.status).toBe(404);
    expect(({} as Record<string, unknown>).defaultAliases).toBeUndefined();
  } finally {
    delete (Object.prototype as Record<string, unknown>).defaultAliases;
  }
});
