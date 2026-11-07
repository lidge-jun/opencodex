import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { loadExportModels, resetExportSnapshotForTests } from "../../src/server/management/model-rows";
import { setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { hermesProfileStore } from "../../src/integrations/hermes-profiles";
import { defaultIntegrationIO, parseConfig } from "../../src/integrations/config-io";
import { clearModelCache } from "../../src/codex/model-cache";
import { previewRouteModel } from "../../src/router";
import { RUNTIME_PROVIDER_FETCH, runtimeProviderFetch, type RuntimeProviderFetch } from "../../src/lib/provider-runtime-fetch";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let config: OcxConfig;
let network: ReturnType<typeof spyOn>;
let store: ReturnType<typeof createIntegrationStateStore>;
const env = {} as NodeJS.ProcessEnv;
beforeEach(() => {
  home = createTempHome("ocx-api-model-names-");
  config = { port: 10100, hostname: "127.0.0.1", defaultProvider: "acme", nativeFastMode: false,
    providers: { acme: { adapter: "openai-chat", baseUrl: "https://acme.example/v1", apiKey: "fixture", alias: "AC", liveModels: false, models: ["vendor/model-x"], modelAliases: { "vendor/model-x": "AC-model-x" } } },
  } as unknown as OcxConfig;
  store = createIntegrationStateStore(home.path("store"));
  setIntegrationMutationFlightTestHooks({ store });
  setIntegrationPathTestHooks({ env, home: home.root });
  resetExportSnapshotForTests();
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("live network denied"); });
});
afterEach(() => {
  network.mockRestore(); resetExportSnapshotForTests();
  setIntegrationMutationFlightTestHooks(null); setIntegrationPathTestHooks(null); home.remove();
});
async function api(path: string, body?: unknown, method = "POST") {
  const url = new URL(path, "http://127.0.0.1:10100");
  const response = await handleManagementAPI(new Request(url, {
    method: body === undefined ? "GET" : method,
    headers: { Host: url.host, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), url, config, { saveConfigPreservingClaudeCode: () => { throw new Error("unexpected config write"); }, createManagementConvergeCodex: catalogConvergenceFactory() });
  expect(response).not.toBeNull(); return response!;
}
async function warm() { await loadExportModels(config, [{ provider: "acme", id: "vendor/model-x" }]); }
function witness() {
  return readdirSync(home.root, { recursive: true }).map(String).sort().map(path => {
    const full = join(home.root, path);
    return statSync(full).isDirectory() ? [path] : [path, readFileSync(full, "utf8"), statSync(full).mtimeMs];
  });
}
function install(client: "hermes" | "commandcode") {
  mkdirSync(INTEGRATION_CLIENTS[client].detectDir(env, home.root), { recursive: true });
  return INTEGRATION_CLIENTS[client].configPath(env, home.root);
}
function keys(client: string, document: unknown) {
  const value = document as { providers: { opencodex: { models: object } }; provider: { opencodex: { models: object } } };
  return Object.keys(client === "hermes" ? value.providers.opencodex.models : value.provider.opencodex.models);
}

test.each(["hermes", "commandcode"])("cold %s export refuses passively before discovery", async client => {
  const before = witness();
  const response = await api(`/api/client-config?client=${client}&preview=1&modelNames=alias`);
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("integration_preview_unavailable");
  expect(witness()).toEqual(before); expect(network).not.toHaveBeenCalled();
});
test.each(["hermes", "commandcode"])("warm %s export uses alias keys without touching home/config", async client => {
  await warm(); const before = witness(); const configBefore = JSON.stringify(config);
  const response = await api(`/api/client-config?client=${client}&preview=1&modelNames=alias`);
  expect(response.status).toBe(200);
  expect(keys(client, (await response.json()).config)).toContain("AC/AC-model-x");
  const routed = await api(`/api/client-config?client=${client}&preview=1`);
  expect(keys(client, (await routed.json()).config)).toContain("acme/vendor-model-x");
  expect(witness()).toEqual(before); expect(JSON.stringify(config)).toBe(configBefore);
  expect(network).not.toHaveBeenCalled();
});
test("stale passive export cannot refresh the snapshot", async () => {
  await warm(); config.providers.acme!.modelAliases = { "vendor/model-x": "renamed" };
  const before = witness();
  expect((await api("/api/client-config?client=hermes&preview=1&modelNames=alias")).status).toBe(409);
  expect(witness()).toEqual(before); expect(network).not.toHaveBeenCalled();
});
test.each(["modelNames=raw", "modelNames=", "modelNames=alias&modelNames=routed"])("export validates %s before catalog", async query => {
  const before = witness();
  const response = await api(`/api/client-config?client=hermes&preview=1&${query}`);
  expect(response.status).toBe(400); expect((await response.json()).code).toBe("invalid_model_names");
  expect(witness()).toEqual(before); expect(network).not.toHaveBeenCalled();
});
test.each(["alias", "routed"])("unsupported client export rejects %s before catalog", async mode => {
  const before = witness();
  const response = await api(`/api/client-config?client=pi&modelNames=${mode}`);
  expect(response.status).toBe(400); expect((await response.json()).code).toBe("invalid_model_names");
  expect(witness()).toEqual(before); expect(network).not.toHaveBeenCalled();
});
for (const modelNames of ["raw", null, 42, {}, "alias", "routed"]) {
  test(`invalid or unsupported request ${JSON.stringify(modelNames)} rejected before reads`, async () => {
    const before = witness();
    const clientId = modelNames === "alias" || modelNames === "routed" ? "pi" : "hermes";
    for (const preview of [true, false]) {
      const response = preview ? await api("/api/client-integrations/preview", { clientId, operation: "apply", modelNames })
        : await api(`/api/client-integrations/${clientId}`, { enabled: true, modelNames }, "PUT");
      expect(response.status).toBe(400); expect((await response.json()).code).toBe("invalid_model_names");
    }
    expect(witness()).toEqual(before); expect(network).not.toHaveBeenCalled();
  });
}
test.each([
  ["/api/client-integrations/hermes", { enabled: false, modelNames: "alias" }, "PUT"],
  ["/api/client-integrations/preview", { clientId: "hermes", operation: "disable", modelNames: "routed" }, "POST"],
  ["/api/client-integrations/restore", { opId: "missing", modelNames: "alias" }, "POST"],
  ["/api/client-integrations/restore/preview", { opId: "missing", modelNames: "routed" }, "POST"],
  ["/api/client-integrations/commandcode/restore", { opId: "missing", modelNames: "alias" }, "POST"],
  ["/api/client-integrations/commandcode/restore/preview", { opId: "missing", modelNames: "alias" }, "POST"],
  ["/api/client-integrations/aside/profiles", { enabled: true, modelNames: "alias" }, "PUT"],
  ["/api/client-integrations/aside/profiles/1/preview", { operation: "apply", modelNames: "routed" }, "POST"],
  ["/api/client-integrations/aside/profiles/1/restore", { opId: "missing", modelNames: "alias" }, "POST"],
])("reject mode on disabled/restore action %s", async (path, body, method) => {
  expect((await api(path as string, body, method as string)).status).toBe(400);
});

test("mode-only plans differ even when no model has an alias", async () => {
  install("hermes"); delete config.providers.acme!.modelAliases; await warm();
  const alias = await (await api("/api/client-integrations/preview", { clientId: "hermes", operation: "apply", modelNames: "alias" })).json();
  const routed = await (await api("/api/client-integrations/preview", { clientId: "hermes", operation: "apply", modelNames: "routed" })).json();
  expect(alias.canApply).toBe(true); expect(routed.canApply).toBe(true);
  expect(alias.changes).toEqual(routed.changes);
  expect(alias.fingerprint).not.toBe(routed.fingerprint);
});

test("named Hermes preview and commit reuse the naming handler and profile store", async () => {
  const defaultPath = install("hermes");
  const profileHome = join(dirname(defaultPath), "profiles", "work");
  mkdirSync(profileHome, { recursive: true });
  writeFileSync(join(profileHome, "config.yaml"), "providers:\n  fixture:\n    api: http://fixture.invalid\n", "utf8");
  await warm();
  const preview = await api("/api/client-integrations/preview?client=hermes&profile=work", { clientId: "hermes", operation: "apply", modelNames: "alias" });
  expect(preview.status).toBe(200);
  const plan = await preview.json(); expect(plan.canApply).toBe(true);
  const commit = await api("/api/client-integrations/hermes?profile=work", { enabled: true, modelNames: "alias", operation: "apply", planFingerprint: plan.fingerprint }, "PUT");
  expect({ status: commit.status, receipt: await commit.json() }).toMatchObject({ status: 200 });
  expect(hermesProfileStore(store, "work").readRecords().hermes?.modelNames).toBe("alias");
  expect(store.readRecords().hermes).toBeUndefined();
  expect(keys("hermes", parseConfig(readFileSync(join(profileHome, "config.yaml"), "utf8"), "yaml"))).toContain("AC/AC-model-x");
});

test("stale snapshot rebuilding retains explicit naming intent", async () => {
  install("hermes"); await warm();
  const original = await (await api("/api/client-integrations/preview", { clientId: "hermes", operation: "apply", modelNames: "alias" })).json();
  setIntegrationMutationFlightTestHooks({ store, run: async operation => {
    await loadExportModels(config, [{ provider: "acme", id: "vendor/model-x", contextWindow: 123456 }]);
    return operation();
  } });
  const refused = await api("/api/client-integrations/hermes", { enabled: true, operation: "apply", planFingerprint: original.fingerprint, modelNames: "alias" }, "PUT");
  expect(refused.status).toBe(409);
  const stale = await refused.json(); expect(stale.code).toBe("integration_preview_stale");
  const freshAlias = await (await api("/api/client-integrations/preview", { clientId: "hermes", operation: "apply", modelNames: "alias" })).json();
  const freshRouted = await (await api("/api/client-integrations/preview", { clientId: "hermes", operation: "apply", modelNames: "routed" })).json();
  expect(stale.plan.fingerprint).toBe(freshAlias.fingerprint);
  expect(stale.plan.fingerprint).not.toBe(freshRouted.fingerprint);
});
test.each(["hermes", "commandcode"] as const)("%s plan binds mode, commits it, omission preserves it", async client => {
  const path = install(client); await warm(); const before = witness();
  const aliasPlan = await (await api("/api/client-integrations/preview", { clientId: client, operation: "apply", modelNames: "alias" })).json();
  const routedPlan = await (await api("/api/client-integrations/preview", { clientId: client, operation: "apply", modelNames: "routed" })).json();
  expect(aliasPlan.canApply).toBe(true); expect(routedPlan.canApply).toBe(true);
  expect(aliasPlan.fingerprint).not.toBe(routedPlan.fingerprint);
  expect(witness()).toEqual(before); expect(existsSync(path)).toBe(false);
  const stale = await api(`/api/client-integrations/${client}`, { enabled: true, modelNames: "routed", operation: "apply", planFingerprint: aliasPlan.fingerprint }, "PUT");
  expect(stale.status).toBe(409); expect((await stale.json()).code).toBe("integration_preview_stale");
  expect(existsSync(path)).toBe(false);
  const commit = await api(`/api/client-integrations/${client}`, { enabled: true, modelNames: "alias", operation: "apply", planFingerprint: aliasPlan.fingerprint }, "PUT");
  expect(commit.status).toBe(200);
  expect((store.readRecords()[client] as { modelNames?: string })?.modelNames).toBe("alias");
  expect(keys(client, parseConfig(readFileSync(path, "utf8"), client === "hermes" ? "yaml" : "json"))).toContain("AC/AC-model-x");
  const omitted = await (await api("/api/client-integrations/preview", { clientId: client, operation: "apply" })).json();
  expect((await api(`/api/client-integrations/${client}`, { enabled: true, operation: "apply", planFingerprint: omitted.fingerprint }, "PUT")).status).toBe(200);
  expect((store.readRecords()[client] as { modelNames?: string })?.modelNames).toBe("alias");
});

test("different explicit modes never join the same mutation flight", async () => {
  install("hermes"); await warm();
  const plan = await (await api("/api/client-integrations/preview", { clientId: "hermes", operation: "apply", modelNames: "alias" })).json();
  const entered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  setIntegrationMutationFlightTestHooks({ store,
    io: { ...defaultIntegrationIO(store), now: () => { if (++reads === 2) secondEntered.resolve(); return Date.now(); } },
    run: async operation => { entered.resolve(); await release.promise; return operation(); },
  });
  const body = { enabled: true, operation: "apply", planFingerprint: plan.fingerprint };
  const first = api("/api/client-integrations/hermes", { ...body, modelNames: "alias" }, "PUT");
  let second: Promise<Response> | undefined;
  try {
    await entered.promise;
    second = api("/api/client-integrations/hermes", { ...body, modelNames: "routed" }, "PUT");
    await secondEntered.promise;
  } finally { release.resolve(); }
  expect((await first).status).toBe(200);
  const response = await second!;
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("integration_mutation_busy");
});

test.each(["hermes", "commandcode"] as const)("%s unbound apply revalidates an alias reassigned during discovery", async client => {
  const path = install(client);
  const provider = config.providers.acme!;
  provider.liveModels = true;
  provider.models = ["vendor/model-x", "model-b"];
  provider.modelAliases = { "vendor/model-x": "pick" };
  config.fastRows = false;
  clearModelCache("acme");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let discoveries = 0;
  const discoveryFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "acme.example" || url.pathname !== "/v1/models") throw new Error("unexpected fixture request");
    discoveries++;
    entered.resolve();
    await release.promise;
    return Response.json({ data: [{ id: "vendor/model-x" }, { id: "model-b" }] });
  }) as typeof fetch;
  const runtimeProvider = provider as typeof provider & { [RUNTIME_PROVIDER_FETCH]?: RuntimeProviderFetch; fetch?: typeof fetch };
  runtimeProvider[RUNTIME_PROVIDER_FETCH] = {
    providerName: "acme", origins: [new URL(provider.baseUrl).origin], fetch: discoveryFetch,
  };
  // Admission preserves the existing outbound executor slot but drops symbol bookkeeping.
  runtimeProvider.fetch = runtimeProviderFetch(runtimeProvider, "acme");
  const mutation = api(`/api/client-integrations/${client}`, { enabled: true, modelNames: "alias" }, "PUT");
  try {
    await entered.promise;
    // The admitted roster began with pick -> A. The live config now routes pick -> B.
    provider.modelAliases = { "model-b": "pick" };
  } finally { release.resolve(); }
  try {
    const response = await mutation;
    expect(response.status).toBe(200);
    expect(discoveries).toBe(1);
    expect(network).not.toHaveBeenCalled();
    const document = parseConfig(readFileSync(path, "utf8"), client === "hermes" ? "yaml" : "json");
    const concrete = keys(client, document).filter(key => key.startsWith("acme/") || key.startsWith("AC/"));
    expect(concrete.sort()).toEqual(["AC/pick", "acme/vendor-model-x"].sort());
    const canonicalA = previewRouteModel(config, "acme/vendor-model-x");
    const currentPick = previewRouteModel(config, "AC/pick");
    expect([canonicalA.providerName, canonicalA.modelId]).toEqual(["acme", "vendor/model-x"]);
    expect([currentPick.providerName, currentPick.modelId]).toEqual(["acme", "model-b"]);
    expect(store.readRecords()[client]?.modelNames).toBe("alias");
  } finally { clearModelCache("acme"); }
});

for (const client of ["hermes", "commandcode"] as const) {
  for (const inherited of [false, true]) {
    for (const overwrite of [false, true]) {
      test(`${client} post-freeze alias reassignment refuses ${overwrite ? "overwrite" : "apply"} with ${inherited ? "inherited" : "explicit"} mode`, async () => {
        const path = install(client);
        const provider = config.providers.acme!;
        provider.modelAliases = { "vendor/model-x": "pick" };
        config.fastRows = false;
        if (inherited) {
          const setup = await api(`/api/client-integrations/${client}`, { enabled: true, modelNames: "alias" }, "PUT");
          expect(setup.status).toBe(200);
          expect(store.readRecords()[client]?.modelNames).toBe("alias");
        }
        provider.models = ["vendor/model-x", "model-b"];
        const before = witness();
        setIntegrationMutationFlightTestHooks({ store, run: operation => {
          // The coordinator captures config synchronously before its first await.
          const pending = operation();
          provider.modelAliases = { "model-b": "pick" };
          return pending;
        } });
        const response = await api(`/api/client-integrations/${client}`, {
          enabled: true, ...(inherited ? {} : { modelNames: "alias" }),
          ...(overwrite ? { overwriteConflict: true } : {}),
        }, "PUT");
        expect(response.status).toBe(409);
        expect((await response.json()).reason).toBe("conflict");
        expect(witness()).toEqual(before);
        expect(existsSync(path)).toBe(inherited);
      });
    }
  }
  test(`${client} post-freeze alias changes keep default routed apply unchanged`, async () => {
    const path = install(client);
    config.providers.acme!.models = ["vendor/model-x", "model-b"];
    config.providers.acme!.modelAliases = { "vendor/model-x": "pick" };
    config.fastRows = false;
    setIntegrationMutationFlightTestHooks({ store, run: operation => {
      const pending = operation();
      config.providers.acme!.modelAliases = { "model-b": "pick" };
      return pending;
    } });
    expect((await api(`/api/client-integrations/${client}`, { enabled: true }, "PUT")).status).toBe(200);
    expect(store.readRecords()[client]?.modelNames).toBe("routed");
    const document = parseConfig(readFileSync(path, "utf8"), client === "hermes" ? "yaml" : "json");
    const concrete = keys(client, document).filter(key => key.startsWith("acme/") || key.startsWith("AC/"));
    expect(concrete.sort()).toEqual(["acme/model-b", "acme/vendor-model-x"].sort());
  });
}
