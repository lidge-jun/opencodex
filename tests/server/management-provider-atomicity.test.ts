import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armClaudeCodeBaseline, loadConfig, saveConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import * as atomicWrite from "../../src/config/atomic-write";
import * as derivedRegistries from "../../src/config/derived-registries";
import * as mutationLock from "../../src/config/mutation-lock";
import * as catalogMigration from "../../src/codex/custom-model-catalog-migration";
import {
  configRebaseDeletionKeys, deleteConfigObjectChildKey, deleteConfigTopLevelKey,
  prepareConfigObjectChildDeletionRebase,
} from "../../src/config/rebase-provenance";
import { prepareConfigMutationDatabasePathForWrite } from "../../src/config/mutation-lock";
import * as destinationPolicy from "../../src/lib/destination-policy";
import * as stateStores from "../../src/lib/state-store-registrations";
import { clearModelCache, getStaleCached, setCached } from "../../src/codex/model-cache";
import { routeModel } from "../../src/router";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousHome: string | undefined;
const failure = new Error("injected persistence failure");

function fixture(): OcxConfig {
  return {
    port: 10100, defaultProvider: "fallback", openaiProviderTierVersion: 2,
    providers: {
      fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", models: ["fallback-model"] },
      relay: {
        adapter: "openai-chat", baseUrl: "https://relay.example/v1", models: ["relay-model"],
        defaultModel: "relay-model", headers: { "X-Keep": "original" },
      },
      openai: {
        adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward", codexAccountMode: "direct",
      },
    },
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-provider-atomicity-"));
  process.env.OPENCODEX_HOME = home;
  spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
});

afterEach(() => {
  mock.restore();
  clearModelCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function harness(config = fixture(), save: (config: OcxConfig) => void = () => {}) {
  const events: string[] = [];
  const reconcile = spyOn(stateStores, "reconcileLiveStateStores").mockImplementation(() => {
    events.push("reconcile");
    return { storesVisited: 0, rowsRemoved: 0 };
  });
  const deps: ManagementApiDeps = {
    saveConfigPreservingClaudeCode: saved => { events.push("save"); save(saved); },
    clearProviderQuotaCache: () => { events.push("quota"); },
    clearThreadAccountMap: () => { events.push("threads"); },
    primeCodexPoolQuotas: async () => { events.push("prime"); },
  };
  async function patch(body: unknown, name = "relay") {
    const url = new URL(`http://127.0.0.1/api/providers?name=${name}`);
    return handleProviderRoutes({
      req: new Request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      url, config, deps, version: "test", trustedLoopbackIngress: true, guiSessionIssuance: null,
      convergeCodexCatalog: async () => {
        events.push("catalog");
        return { status: "committed", changed: false, degraded: false, notices: [] };
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    });
  }
  return { config, patch, events, reconcile };
}

describe("provider PATCH durable atomicity", () => {
  test.each([
    { disabled: true },
    { baseUrl: "https://changed.example/v1" },
    { defaultModel: "other-model" },
    { headers: { "X-New": "new" } },
    { requestPacing: { enabled: true, requestsPerMinute: 30 } },
    { pinnedReasoningEffort: "high" },
    { baseUrl: "https://changed.example/v1", defaultModel: "other-model", headers: { "X-New": "new" } },
  ])("save failure restores the provider and routing for %j", async body => {
    const config = fixture();
    const provider = config.providers.relay;
    const descriptor = { value: provider, enumerable: true, configurable: true, writable: true };
    Object.defineProperty(config.providers, "relay", descriptor);
    const before = structuredClone(config);
    const { routeDecision: _beforeTrace, ...routeBefore } = routeModel(config, "relay/relay-model");
    setCached("relay", []);
    let fail = true;
    let persisted: OcxConfig | undefined;
    const h = harness(config, saved => {
      // Persistence still runs under the existing synchronous coordinator.
      expect(() => prepareConfigMutationDatabasePathForWrite()).toThrow("must not run inside");
      if (fail) throw failure;
      persisted = structuredClone(saved);
    });
    await expect(h.patch(body)).rejects.toBe(failure);
    expect(config).toEqual(before);
    expect(config.providers.relay).toBe(provider);
    expect(Object.getOwnPropertyDescriptor(config.providers, "relay")).toEqual(descriptor);
    const { routeDecision: _afterTrace, ...routeAfter } = routeModel(config, "relay/relay-model");
    expect(routeAfter).toEqual(routeBefore);
    expect(getStaleCached("relay")).toEqual([]);
    expect(h.events).toEqual(["save"]);
    fail = false;
    expect((await h.patch(body))?.status).toBe(200);
    expect(persisted?.providers.relay).toMatchObject(body);
    expect(h.events.slice(1, 3)).toEqual(["save", "reconcile"]);
    const pacingOnly = "requestPacing" in body;
    if (pacingOnly) {
      expect(h.events).not.toContain("catalog");
      expect(getStaleCached("relay")).toEqual([]);
    } else if (!("disabled" in body)) {
      expect(getStaleCached("relay")).toBeNull();
    }
  });

  test.each([
    { name: "relay", body: { setDefault: true } },
    { name: "openai", body: { codexAccountMode: "pool" } },
  ])("standalone PATCH %j rolls back before side effects and retries", async ({ name, body }) => {
    const config = fixture();
    const before = structuredClone(config);
    let fail = true;
    const h = harness(config, saved => {
      expect(() => prepareConfigMutationDatabasePathForWrite()).toThrow("must not run inside");
      if (fail) throw failure;
      writeFileSync(join(home, "saved.json"), JSON.stringify(saved));
    });
    await expect(h.patch(body, name)).rejects.toBe(failure);
    expect(config).toEqual(before);
    expect(routeModel(config, "unlisted-model").providerName).toBe("fallback");
    expect(h.events).toEqual(["save"]);
    expect((config.providers.openai).codexAccountMode).toBe("direct");
    fail = false;
    expect((await h.patch(body, name))?.status).toBe(200);
    const reload = JSON.parse(readFileSync(join(home, "saved.json"), "utf8")) as OcxConfig;
    if (name === "relay") {
      expect(routeModel(reload, "unlisted-model").providerName).toBe("relay");
      expect(h.events).toEqual(["save", "save", "reconcile"]);
    } else {
      expect(reload.providers.openai.codexAccountMode).toBe("pool");
      expect(h.events).toEqual(["save", "save", "reconcile", "quota", "threads", "prime"]);
    }
  });

  test("atomic file-write failure rolls back a real nested rebase, then retry reloads and routes", async () => {
    const config = fixture();
    config.disabledModels = ["old-disabled"];
    config.claudeCode = { enabled: false };
    saveConfig(config);
    armClaudeCodeBaseline(config);
    const providers = config.providers;
    const fallback = providers.fallback;
    const headers = providers.relay.headers;
    const disabledModels = config.disabledModels;
    const before = structuredClone(config);
    const disk = structuredClone(config);
    disk.providers.fallback.baseUrl = "https://disk-change.example/v1";
    disk.providers.fallback.models!.push("disk-model");
    disk.disabledModels = ["disk-disabled"];
    disk.claudeCode = { enabled: true };
    writeFileSync(join(home, "config.json"), JSON.stringify(disk));
    const bytes = readFileSync(join(home, "config.json"), "utf8");
    const h = harness(config, saveConfigPreservingClaudeCode);
    const write = spyOn(atomicWrite, "atomicWriteFile").mockImplementation(() => {
      expect(config.providers.fallback.baseUrl).toBe(disk.providers.fallback.baseUrl);
      expect(config.disabledModels).toEqual(disk.disabledModels);
      throw failure;
    });
    await expect(h.patch({ baseUrl: "https://committed.example/v1" })).rejects.toBe(failure);
    expect(config).toEqual(before);
    expect(config.providers).toBe(providers);
    expect(config.providers.fallback).toBe(fallback);
    expect(config.providers.relay.headers).toBe(headers);
    expect(config.disabledModels).toBe(disabledModels);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(bytes);
    expect(h.events).toEqual(["save"]);
    write.mockRestore();
    expect((await h.patch({ baseUrl: "https://committed.example/v1" }))?.status).toBe(200);
    const reload = loadConfig();
    expect(routeModel(reload, "relay/relay-model").provider.baseUrl).toBe("https://committed.example/v1");
    expect(reload.providers.fallback.baseUrl).toBe(disk.providers.fallback.baseUrl);
    expect(reload.disabledModels).toEqual(disk.disabledModels);
    expect(config.claudeCode).toEqual(disk.claudeCode);
    expect(h.events).toEqual(["save", "save", "reconcile", "catalog"]);
  });

  test("rollback restores descriptors, absent fields, nested aliases, and pending deletion intent", async () => {
    const config = fixture();
    deleteConfigTopLevelKey(config, "fastRows");
    config.providerContextCaps = { relay: 8192, fallback: 4096 };
    deleteConfigObjectChildKey(config, "providerContextCaps", "relay");
    Object.defineProperty(config, "note", { value: undefined, configurable: true, writable: true, enumerable: false });
    const marker = Symbol("retained-owner");
    const owner = { generation: 1 };
    Object.defineProperty(config, marker, { value: owner, configurable: true });
    Object.defineProperty(config.providers, "relay", { enumerable: false });
    const providerDescriptor = Object.getOwnPropertyDescriptor(config.providers, "relay");
    const getter = () => { throw new Error("snapshot must not invoke accessors"); };
    Object.defineProperty(config, "runtimeProbe", { get: getter, configurable: true });
    const beforeDescriptors = Object.getOwnPropertyDescriptors(config);
    const caps = config.providerContextCaps;
    const h = harness(config, saved => {
      saved.providers.fallback.models!.push("uncommitted");
      saved.providerContextCaps!.fallback = 123;
      deleteConfigTopLevelKey(saved, "modelDiscovery");
      deleteConfigObjectChildKey(saved, "providerContextCaps", "fallback");
      Object.defineProperty(saved, "note", { value: "uncommitted", enumerable: true });
      owner.generation = 2;
      saved.fastRows = false;
      throw failure;
    });
    await expect(h.patch({ disabled: true })).rejects.toBe(failure);
    expect(Object.getOwnPropertyDescriptors(config)).toEqual(beforeDescriptors);
    expect(Object.getOwnPropertyDescriptor(config.providers, "relay")).toEqual(providerDescriptor);
    expect(config.providers.fallback.models).toEqual(["fallback-model"]);
    expect(config.providerContextCaps).toBe(caps);
    expect(caps).toEqual({ fallback: 4096 });
    expect(owner.generation).toBe(1);
    expect(Object.hasOwn(config, "fastRows")).toBe(false);
    expect(configRebaseDeletionKeys(config)).toEqual(new Set(["fastRows"]));
    expect(prepareConfigObjectChildDeletionRebase(config)).toEqual(new Map([["providerContextCaps", new Set(["relay"])]]));
  });

  test.each(["registry", "generation", "adoption"] as const)("%s failure after publication keeps live and persisted provider aligned", async stage => {
    const config = fixture();
    saveConfig(config);
    armClaudeCodeBaseline(config);
    const h = harness(config, saveConfigPreservingClaudeCode);
    const failAfterWrite = () => { throw failure; };
    const postWrite = stage === "registry"
      ? spyOn(derivedRegistries, "refreshConfigDerivedRegistries").mockImplementation(failAfterWrite)
      : stage === "generation"
        ? spyOn(mutationLock, "bumpGenerationForCooperatingConfigWrite").mockImplementation(failAfterWrite)
        : spyOn(catalogMigration, "adoptCustomModelCatalogMigration").mockImplementation(failAfterWrite);
    const patch = { baseUrl: "https://published.example/v1" };

    await expect(h.patch(patch)).rejects.toMatchObject({ name: "ConfigWritePublishedError", cause: failure });

    const disk = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
    expect(config.providers.relay).toMatchObject(patch);
    expect(config.providers.relay).toEqual(disk.providers.relay);
    expect(routeModel(config, "relay/relay-model").provider.baseUrl).toBe(patch.baseUrl);
    expect(h.events).toEqual(["save"]);
    postWrite.mockRestore();
    expect((await h.patch(patch))?.status).toBe(200);
    expect(loadConfig().providers.relay).toMatchObject(patch);
  });

  test("an identical persisted body still forbids rollback after registry refresh fails", async () => {
    const config = fixture();
    config.providers.relay.disabled = true;
    saveConfig(config);
    const provider = config.providers.relay;
    const bytes = readFileSync(join(home, "config.json"), "utf8");
    const h = harness(config, saveConfigPreservingClaudeCode);
    const write = spyOn(atomicWrite, "atomicWriteFile");
    spyOn(derivedRegistries, "refreshConfigDerivedRegistries").mockImplementation(() => { throw failure; });

    await expect(h.patch({ disabled: true })).rejects.toMatchObject({ name: "ConfigWritePublishedError", cause: failure });

    expect(write).not.toHaveBeenCalled();
    expect(config.providers.relay).not.toBe(provider);
    expect(config.providers.relay.disabled).toBe(true);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(bytes);
  });

  test("post-rename failure carries publication through the atomic writer", async () => {
    const config = fixture();
    saveConfig(config);
    const h = harness(config, saveConfigPreservingClaudeCode);
    const write = atomicWrite.atomicWriteFile;
    spyOn(atomicWrite, "atomicWriteFile").mockImplementation((path, bytes, io, hooks) => {
      write(path, bytes, io, {
        ...hooks,
        afterRename: target => { hooks?.afterRename?.(target); throw failure; },
      });
    });

    await expect(h.patch({ disabled: true })).rejects.toMatchObject({ name: "ConfigWritePublishedError", cause: failure });

    const disk = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
    expect(config.providers.relay.disabled).toBe(true);
    expect(config.providers.relay).toEqual(disk.providers.relay);
    expect(h.events).toEqual(["save"]);
  });

  test("rollback restores provider insertion order after persistence deletes and re-adds a key", async () => {
    const config = fixture();
    const providers = config.providers;
    const keys = Object.keys(providers);
    const original = structuredClone(config);
    const h = harness(config, saved => {
      const fallback = saved.providers.fallback;
      delete saved.providers.fallback;
      saved.providers.fallback = fallback;
      expect(Object.keys(saved.providers)).not.toEqual(keys);
      throw failure;
    });

    await expect(h.patch({ disabled: true })).rejects.toBe(failure);

    expect(config.providers).toBe(providers);
    expect(Object.keys(config.providers)).toEqual(keys);
    expect(config).toEqual(original);
  });

  test.each([false, true])("concurrent field-mask replay preserves a committed sibling when failure is %s", async failDelayed => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    spyOn(destinationPolicy, "providerDestinationResolvedError").mockImplementation(async (_name, candidate) => {
      if (candidate.headers?.["X-Delayed"] === "later") { entered(); await gate; }
      return null;
    });
    const config = fixture();
    let fail = failDelayed;
    let persisted: OcxConfig | undefined;
    const h = harness(config, saved => {
      if (fail && saved.providers.relay.headers?.["X-Delayed"] === "later") throw failure;
      persisted = structuredClone(saved);
    });
    const delayed = h.patch({ headers: { "X-Delayed": "later" }, defaultModel: "delayed-model" });
    const outcome = delayed.then(value => ({ value }), error => ({ error }));
    await waiting;
    expect((await h.patch({ headers: { "X-Committed": "first" }, note: "retained" }))?.status).toBe(200);
    const committedProvider = config.providers.relay;
    release();
    const result = await outcome;
    if (failDelayed) {
      expect(result).toEqual({ error: failure });
      expect(config.providers.relay).toBe(committedProvider);
      expect(config.providers.relay).toEqual(persisted!.providers.relay);
      expect(config.providers.relay.defaultModel).toBe("relay-model");
      expect(h.events).toEqual(["save", "reconcile", "catalog", "save"]);
      fail = false;
      expect((await h.patch({ headers: { "X-Delayed": "later" }, defaultModel: "delayed-model" }))?.status).toBe(200);
    } else {
      expect("value" in result && result.value?.status).toBe(200);
    }
    expect(persisted!.providers.relay).toMatchObject({
      note: "retained", defaultModel: "delayed-model",
      headers: { "X-Keep": "original", "X-Committed": "first", "X-Delayed": "later" },
    });
    expect(config.providers.relay).toEqual(persisted!.providers.relay);
  });
});
