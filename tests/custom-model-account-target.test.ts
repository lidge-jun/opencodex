import { beforeEach, describe, expect, test } from "bun:test";

import { getDefaultConfig, validateConfigCandidate } from "../src/config";
import {
  customModelCodexAccountIdForRoute,
  customModelCodexAccountTargetAssignmentError,
  customModelCodexAccountTargetError,
  filterModelsByCustomRouteAvailability,
  normalizeCustomModelCodexAccountTarget,
  providerSupportsCustomModelCodexAccountTarget,
} from "../src/codex/custom-model-account-target";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import { listCodexAccountTargetOptions } from "../src/codex/auth-api";
import { filterCatalogVisibleModels } from "../src/codex/catalog/provider-fetch";
import type { CatalogModel } from "../src/codex/catalog";
import { handleAgentSettingsRoutes } from "../src/server/management/agent-settings-routes";
import { handleModelRoutes } from "../src/server/management/model-routes";
import { isApiAuthRequired } from "../src/server/auth-cors";
import {
  listManagementModelRows,
  loadExportModels,
  managementModelRowIsExportable,
  toExportModel,
} from "../src/server/management/model-rows";
import { visionCandidateRows } from "../src/server/management/vision-sidecar-options";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxCustomModel } from "../src/types";

const canonicalOpenAi = {
  adapter: "openai-responses" as const,
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward" as const,
};

describe("custom-model exact Codex account targets", () => {
  let config: OcxConfig;
  let persistCalls: number;
  let convergeCalls: number;
  let configSeenAtConverge: OcxConfig | undefined;
  let routedModels: CatalogModel[];
  let mutateConfig: NonNullable<Parameters<typeof handleModelRoutes>[0]["deps"]["mutatePersistedConfig"]>;

  beforeEach(() => {
    persistCalls = 0;
    convergeCalls = 0;
    configSeenAtConverge = undefined;
    routedModels = [];
    config = {
      ...getDefaultConfig(),
      providers: {
        openai: { ...canonicalOpenAi },
        proxy: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1" },
      },
      codexAccounts: [{ id: "pool-a", email: "a@example.test", isMain: false }],
      customModels: [],
    };
    mutateConfig = callback => {
      const authoritative = structuredClone(config);
      const mutation = callback(authoritative);
      if (mutation.changed) persistCalls += 1;
      return {
        status: mutation.changed ? "committed" : "unchanged",
        value: mutation.value,
        config: authoritative,
      };
    };
  });

  async function request(
    method: "GET" | "POST" | "PUT",
    pathname: string,
    body?: unknown,
    options: { omitAtomicMutationSeam?: boolean } = {},
  ) {
    const url = new URL(`http://127.0.0.1:10199${pathname}`);
    const req = new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    return handleModelRoutes({
      req,
      url,
      config,
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls += 1; },
        ...(options.omitAtomicMutationSeam ? {} : { mutatePersistedConfig: mutateConfig }),
        fetchAllModels: async () => routedModels,
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      convergeCodexCatalog: async () => {
        convergeCalls += 1;
        configSeenAtConverge = structuredClone(config);
        return {
          status: "committed",
          changed: false,
          degraded: false,
          notices: [],
        };
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    });
  }

  async function agentRequest(pathname: string) {
    const url = new URL(`http://127.0.0.1:10199${pathname}`);
    const req = new Request(url);
    return handleAgentSettingsRoutes({
      req,
      url,
      config,
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls += 1; },
        fetchAllModels: async () => routedModels,
      },
      convergeCodexCatalog: async () => ({
        status: "committed",
        changed: false,
        degraded: false,
        notices: [],
      }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
  }

  test("uses the selector target grammar but never accepts the internal main sentinel", () => {
    expect(normalizeCustomModelCodexAccountTarget("@main")).toBe(MAIN_CODEX_ACCOUNT_ID);
    expect(normalizeCustomModelCodexAccountTarget("pool-a")).toBe("pool-a");
    expect(normalizeCustomModelCodexAccountTarget("__main__")).toBeUndefined();
    expect(customModelCodexAccountTargetError("openai", canonicalOpenAi, "@main")).toBeUndefined();
    expect(providerSupportsCustomModelCodexAccountTarget("openai", canonicalOpenAi)).toBe(true);
    expect(providerSupportsCustomModelCodexAccountTarget("openai", {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex/",
    })).toBe(true);
    expect(providerSupportsCustomModelCodexAccountTarget("openai", {
      ...canonicalOpenAi,
      adapter: "openai-chat",
    })).toBe(false);
    expect(providerSupportsCustomModelCodexAccountTarget("openai", {
      ...canonicalOpenAi,
      baseUrl: "https://example.invalid/backend-api/codex",
    })).toBe(false);
    expect(providerSupportsCustomModelCodexAccountTarget("proxy", config.providers.proxy)).toBe(false);
    expect(customModelCodexAccountTargetError("proxy", config.providers.proxy, "pool-a"))
      .toContain("canonical openai Codex-forward provider");
    expect(customModelCodexAccountTargetAssignmentError(config, "openai", "missing"))
      .toContain("existing Codex pool-account id");
  });

  test("slash custom ids retain their exact account binding after routed-slug decoding", () => {
    config.customModels = [{
      id: "slash-target",
      provider: "openai",
      modelId: "vendor/model",
      codexAccountTarget: "@main",
    }];
    for (const selector of ["openai/vendor-model", "openai/vendor/model"]) {
      expect(routeModel(config, selector)).toMatchObject({
        providerName: "openai",
        modelId: "vendor/model",
        codexAccountId: MAIN_CODEX_ACCOUNT_ID,
        codexAccountBinding: "custom-model",
      });
    }
  });

  test("POST, GET, PUT, and null-clear round-trip the exact target", async () => {
    const posted = await request("POST", "/api/custom-models/account-target", {
      provider: "openai",
      modelId: "targeted-preview",
      codexAccountTarget: "@main",
      codexAccountTargetWriteNonce: "11111111-1111-4111-8111-111111111111",
    });
    expect(posted?.status).toBe(201);
    const created = await posted!.json() as OcxCustomModel & { codexAccountTargetWriteNonce?: string };
    expect(created.codexAccountTarget).toBe("@main");
    expect(created.codexAccountTargetWriteNonce).toBe("11111111-1111-4111-8111-111111111111");
    expect(config.customModels?.[0]).not.toHaveProperty("codexAccountTargetWriteNonce");
    expect(persistCalls).toBe(1);

    const listed = await request("GET", "/api/custom-models");
    expect(await listed!.json()).toEqual([expect.objectContaining({
      id: created.id,
      codexAccountTarget: "@main",
    })]);

    const changed = await request("PUT", `/api/custom-models/${created.id}/account-target`, {
      codexAccountTarget: "pool-a",
      codexAccountTargetWriteNonce: "22222222-2222-4222-8222-222222222222",
    });
    expect(changed?.status).toBe(200);
    expect(await changed!.json()).toMatchObject({
      codexAccountTarget: "pool-a",
      codexAccountTargetWriteNonce: "22222222-2222-4222-8222-222222222222",
    });

    const cleared = await request("PUT", `/api/custom-models/${created.id}/account-target`, {
      codexAccountTarget: null,
      codexAccountTargetWriteNonce: "33333333-3333-4333-8333-333333333333",
    });
    expect(cleared?.status).toBe(200);
    expect(await cleared!.json()).toMatchObject({
      codexAccountTargetWriteNonce: "33333333-3333-4333-8333-333333333333",
    });
    expect(config.customModels?.[0]?.codexAccountTarget).toBeUndefined();
  });

  test("an injected legacy saver still isolates target-aware route fixtures from the real config store", async () => {
    const response = await request("POST", "/api/custom-models/account-target", {
      provider: "openai",
      modelId: "fixture-only-preview",
      codexAccountTarget: "@main",
      codexAccountTargetWriteNonce: "12121212-1212-4212-8212-121212121212",
    }, { omitAtomicMutationSeam: true });

    expect(response?.status).toBe(201);
    expect(persistCalls).toBe(1);
    expect(config.customModels).toEqual([expect.objectContaining({
      modelId: "fixture-only-preview",
      codexAccountTarget: "@main",
    })]);
    expect(config.customModels?.[0]).not.toHaveProperty("codexAccountTargetWriteNonce");
  });

  test("catalog convergence sees the full authoritative config accepted by the atomic target write", async () => {
    config.hostname = "0.0.0.0";
    config.port = 10199;
    mutateConfig = callback => {
      const authoritative = structuredClone(config);
      // A cooperating writer can update the desired binding for the next start while this
      // process remains externally bound. The model write must not weaken the live auth gate.
      authoritative.hostname = "127.0.0.1";
      authoritative.port = 20200;
      authoritative.codexAccounts = [
        ...(authoritative.codexAccounts ?? []),
        { id: "pool-new", email: "new@example.test", isMain: false },
      ];
      authoritative.providers.openai!.selectedModels = ["converged-preview"];
      const mutation = callback(authoritative);
      if (mutation.changed) persistCalls += 1;
      authoritative.customModelCatalogMigration = {
        version: 1,
        legacyOwnedSlugs: ["openai/legacy-preview"],
      };
      return {
        status: mutation.changed ? "committed" : "unchanged",
        value: mutation.value,
        config: authoritative,
      };
    };

    const response = await request("POST", "/api/custom-models/account-target", {
      provider: "openai",
      modelId: "converged-preview",
      codexAccountTarget: "pool-new",
      codexAccountTargetWriteNonce: "13131313-1313-4313-8313-131313131313",
    });

    expect(response?.status).toBe(201);
    expect(config.codexAccounts?.some(account => account.id === "pool-new")).toBe(true);
    expect(config.providers.openai?.selectedModels).toEqual(["converged-preview"]);
    expect(config.customModelCatalogMigration).toEqual({
      version: 1,
      legacyOwnedSlugs: ["openai/legacy-preview"],
    });
    expect(config.hostname).toBe("0.0.0.0");
    expect(config.port).toBe(10199);
    expect(isApiAuthRequired(config)).toBe(true);
    expect(configSeenAtConverge?.codexAccounts?.some(account => account.id === "pool-new")).toBe(true);
    expect(configSeenAtConverge?.providers.openai?.selectedModels).toEqual(["converged-preview"]);
    expect(configSeenAtConverge?.customModelCatalogMigration).toEqual({
      version: 1,
      legacyOwnedSlugs: ["openai/legacy-preview"],
    });
    expect(configSeenAtConverge?.hostname).toBe("0.0.0.0");
    expect(configSeenAtConverge?.port).toBe(10199);
  });

  test("legacy unbound PUT ignores the nonce older CLIs sent on every edit", async () => {
    config.customModels = [{
      id: "legacy-unbound",
      provider: "openai",
      modelId: "legacy-unbound-preview",
    }];
    const response = await request("PUT", "/api/custom-models/legacy-unbound", {
      displayName: "Renamed by old CLI",
      codexAccountTargetWriteNonce: "14141414-1414-4414-8414-141414141414",
    });

    expect(response?.status).toBe(200);
    expect(config.customModels?.[0]?.displayName).toBe("Renamed by old CLI");
    expect(config.customModels?.[0]).not.toHaveProperty("codexAccountTargetWriteNonce");
    expect(await response!.json()).not.toHaveProperty("codexAccountTargetWriteNonce");
  });

  test("target-aware POST rejects a same-slug row that wins the persisted-config race", async () => {
    const concurrent: OcxCustomModel = {
      id: "concurrent-row",
      provider: "openai",
      modelId: "raced-preview",
      codexAccountTarget: "@main",
    };
    mutateConfig = callback => {
      const authoritative = structuredClone(config);
      authoritative.customModels = [concurrent];
      const mutation = callback(authoritative);
      expect(mutation.changed).toBe(false);
      return { status: "unchanged", value: mutation.value, config: authoritative };
    };

    const response = await request("POST", "/api/custom-models/account-target", {
      provider: "openai",
      modelId: "raced-preview",
      codexAccountTarget: "@main",
      codexAccountTargetWriteNonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(response?.status).toBe(409);
    expect((await response!.json() as { error: string }).error).toBe("duplicate model");
    expect(config.customModels).toEqual([concurrent]);
    expect(persistCalls).toBe(0);
    expect(convergeCalls).toBe(0);
  });

  test("target-aware PUT reports a concurrently deleted row without attesting or converging", async () => {
    config.customModels = [{
      id: "deleted-during-write",
      provider: "openai",
      modelId: "deleted-preview",
      codexAccountTarget: "@main",
    }];
    mutateConfig = callback => {
      const authoritative = structuredClone(config);
      delete authoritative.customModels;
      const mutation = callback(authoritative);
      expect(mutation.changed).toBe(false);
      return { status: "unchanged", value: mutation.value, config: authoritative };
    };

    const response = await request("PUT", "/api/custom-models/deleted-during-write/account-target", {
      displayName: "Must not be attested",
      codexAccountTargetWriteNonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    expect(response?.status).toBe(404);
    expect((await response!.json() as { error: string }).error).toBe("not found");
    expect(config.customModels).toBeUndefined();
    expect(persistCalls).toBe(0);
    expect(convergeCalls).toBe(0);
  });

  test("target-aware writes require their dedicated route and attest before persistence", async () => {
    const legacyPost = await request("POST", "/api/custom-models", {
      provider: "openai",
      modelId: "legacy-target",
      codexAccountTarget: "@main",
    });
    expect(legacyPost?.status).toBe(409);
    expect((await legacyPost!.json() as { error: string }).error).toContain("target-aware route required");

    config.customModels = [{
      id: "retained-target",
      provider: "openai",
      modelId: "retained-preview",
      codexAccountTarget: "@main",
    }];
    const legacyPut = await request("PUT", "/api/custom-models/retained-target", {
      displayName: "Must not mutate",
    });
    expect(legacyPut?.status).toBe(409);
    expect(config.customModels[0]?.displayName).toBeUndefined();

    const missingPostNonce = await request("POST", "/api/custom-models/account-target", {
      provider: "openai",
      modelId: "missing-post-nonce",
      codexAccountTarget: "@main",
    });
    expect(missingPostNonce?.status).toBe(400);

    config.customModels = [{
      id: "unbound",
      provider: "openai",
      modelId: "unbound-preview",
    }];
    const emptyTargetAwarePut = await request("PUT", "/api/custom-models/unbound/account-target", {
      displayName: "Must not mutate",
      codexAccountTargetWriteNonce: "44444444-4444-4444-8444-444444444444",
    });
    expect(emptyTargetAwarePut?.status).toBe(400);
    expect(config.customModels[0]?.displayName).toBeUndefined();
    expect(persistCalls).toBe(0);
  });

  test("management writes reject malformed and noncanonical bindings before persistence", async () => {
    const badNonce = await request("POST", "/api/custom-models/account-target", {
      provider: "openai",
      modelId: "bad-nonce",
      codexAccountTarget: "@main",
      codexAccountTargetWriteNonce: "not-a-uuid",
    });
    expect(badNonce?.status).toBe(400);
    expect((await badNonce!.json() as { error: string }).error).toContain("UUID");

    const internal = await request("POST", "/api/custom-models/account-target", {
      provider: "openai",
      modelId: "bad-main",
      codexAccountTarget: "__main__",
      codexAccountTargetWriteNonce: "55555555-5555-4555-8555-555555555555",
    });
    expect(internal?.status).toBe(400);
    expect((await internal!.json() as { error: string }).error).toContain("@main");

    const wrongProvider = await request("POST", "/api/custom-models/account-target", {
      provider: "proxy",
      modelId: "bad-provider",
      codexAccountTarget: "pool-a",
      codexAccountTargetWriteNonce: "66666666-6666-4666-8666-666666666666",
    });
    expect(wrongProvider?.status).toBe(400);
    const missingAccount = await request("POST", "/api/custom-models/account-target", {
      provider: "openai",
      modelId: "missing-account",
      codexAccountTarget: "not-added",
      codexAccountTargetWriteNonce: "77777777-7777-4777-8777-777777777777",
    });
    expect(missingAccount?.status).toBe(400);
    expect(persistCalls).toBe(0);
  });

  test("an orphaned stored target can be preserved but not replaced by another unknown id", async () => {
    config.customModels = [{
      id: "orphaned",
      provider: "openai",
      modelId: "orphaned-preview",
      codexAccountTarget: "deleted-account",
    }];

    const preserved = await request("PUT", "/api/custom-models/orphaned/account-target", {
      displayName: "Still repairable",
      codexAccountTargetWriteNonce: "88888888-8888-4888-8888-888888888888",
    });
    expect(preserved?.status).toBe(200);
    expect(await preserved!.json()).toMatchObject({
      codexAccountTarget: "deleted-account",
      codexAccountTargetWriteNonce: "88888888-8888-4888-8888-888888888888",
    });

    const typo = await request("PUT", "/api/custom-models/orphaned/account-target", {
      codexAccountTarget: "another-missing-account",
      codexAccountTargetWriteNonce: "99999999-9999-4999-8999-999999999999",
    });
    expect(typo?.status).toBe(400);
    expect(config.customModels[0]?.codexAccountTarget).toBe("deleted-account");
  });

  test("config writes validate the field while load-compatible rows stay additive", () => {
    const valid = {
      ...config,
      customModels: [{
        id: "valid",
        provider: "openai",
        modelId: "targeted",
        codexAccountTarget: "@main",
      }],
    };
    expect(validateConfigCandidate(valid).ok).toBe(true);
    expect(validateConfigCandidate({
      ...valid,
      customModels: [{ ...valid.customModels[0], codexAccountTarget: "__main__" }],
    })).toMatchObject({ ok: false, error: expect.stringContaining("codexAccountTarget") });
    expect(validateConfigCandidate({
      ...valid,
      customModels: [{ ...valid.customModels[0], provider: "proxy", codexAccountTarget: "pool-a" }],
    })).toMatchObject({ ok: false, error: expect.stringContaining("canonical openai") });
  });

  test("duplicate custom rows cannot hide or disagree with an exact account binding", () => {
    const unbound: OcxCustomModel = {
      id: "duplicate-unbound",
      provider: "openai",
      modelId: "duplicate-preview",
    };
    const bound: OcxCustomModel = {
      id: "duplicate-bound",
      provider: "openai",
      modelId: "duplicate-preview",
      codexAccountTarget: "@main",
    };
    const catalogModel = {
      id: "duplicate-preview",
      provider: "openai",
      catalogKind: "custom-model-v1" as const,
    };

    for (const rows of [[unbound, bound], [bound, unbound]]) {
      const validation = validateConfigCandidate({ ...config, customModels: rows });
      expect(validation.ok).toBe(false);
      if (!validation.ok) expect(validation.error).toContain("duplicate routed model");

      config.customModels = rows;
      expect(() => customModelCodexAccountIdForRoute(config, "openai", "duplicate-preview"))
        .toThrow("Ambiguous custom model account binding");
      expect(filterCatalogVisibleModels([catalogModel], config)).toEqual([]);
    }

    config.customModels = [
      { ...bound, id: "same-target-a" },
      { ...bound, id: "same-target-b" },
    ];
    expect(customModelCodexAccountIdForRoute(config, "openai", "duplicate-preview"))
      .toBe(MAIN_CODEX_ACCOUNT_ID);
    expect(filterCatalogVisibleModels([catalogModel], config)).toEqual([catalogModel]);

    const aliasBound: OcxCustomModel = {
      id: "alias-bound",
      provider: "openai",
      modelId: "vendor/model",
      codexAccountTarget: "@main",
    };
    const aliasUnbound: OcxCustomModel = {
      id: "alias-unbound",
      provider: "openai",
      modelId: "vendor-model",
    };
    const aliasCatalogModel = {
      id: "vendor-model",
      provider: "openai",
      catalogKind: "custom-model-v1" as const,
    };
    for (const rows of [[aliasBound, aliasUnbound], [aliasUnbound, aliasBound]]) {
      const validation = validateConfigCandidate({ ...config, customModels: rows });
      expect(validation.ok).toBe(false);
      if (!validation.ok) expect(validation.error).toContain("duplicate routed model");

      config.customModels = rows;
      expect(() => customModelCodexAccountIdForRoute(config, "openai", "vendor-model"))
        .toThrow("Ambiguous custom model account binding");
      expect(() => routeModel(config, "openai/vendor-model"))
        .toThrow("ambiguous model id");
      expect(filterCatalogVisibleModels([aliasCatalogModel], config)).toEqual([]);
    }

    config.customModels = [
      { ...unbound, id: "unbound-a" },
      { ...unbound, id: "unbound-b" },
    ];
    expect(validateConfigCandidate(config).ok).toBe(true);
    expect(customModelCodexAccountIdForRoute(config, "openai", "duplicate-preview"))
      .toBeUndefined();
  });

  test("management-only target metadata never enters client export rows", () => {
    const exported = toExportModel({
      provider: "openai",
      id: "targeted",
      namespaced: "openai/targeted",
      disabled: false,
      custom: true,
      customId: "custom-id",
      codexAccountTarget: "pool-private-id",
    });
    expect(Object.hasOwn(exported, "codexAccountTarget")).toBe(false);
    expect(managementModelRowIsExportable({
      provider: "openai",
      id: "targeted",
      namespaced: "openai/targeted",
      disabled: false,
      codexAccountTargetAvailable: false,
    })).toBe(false);
  });

  test("a malformed loaded target stays repair-visible but is hidden from every data-plane export", async () => {
    config.providers = { openai: { ...canonicalOpenAi, disabled: true } };
    config.customModels = [{
      id: "malformed-row",
      provider: "openai",
      modelId: "malformed-target",
      codexAccountTarget: null as unknown as string,
      inputModalities: ["text", "image"],
    }];

    const rows = await listManagementModelRows(config);
    const repairRow = rows.find(row => row.customId === "malformed-row");
    expect(repairRow).toMatchObject({
      namespaced: "openai/malformed-target",
      codexAccountTargetAvailable: false,
    });
    expect(Object.hasOwn(repairRow ?? {}, "codexAccountTarget")).toBe(false);
    expect(await loadExportModels(config)).not.toContainEqual(
      expect.objectContaining({ namespaced: "openai/malformed-target" }),
    );
    expect(await visionCandidateRows(config)).not.toContainEqual(
      expect.objectContaining({ id: "malformed-target" }),
    );

    config.providers.openai = { ...canonicalOpenAi };
    expect(() => routeModel(config, "openai/malformed-target"))
      .toThrow("Invalid custom model account binding");
  });

  test("catalog visibility hides an orphaned target but keeps the management binding", () => {
    const model = {
      id: "targeted",
      provider: "openai",
      catalogKind: "custom-model-v1" as const,
    };
    config.customModels = [{
      id: "targeted-row",
      provider: "openai",
      modelId: "targeted",
      codexAccountTarget: "pool-a",
    }];
    config.codexAccounts = [];
    expect(filterCatalogVisibleModels([model], config)).toEqual([]);
    expect(config.customModels[0]?.codexAccountTarget).toBe("pool-a");

    config.codexAccounts = [{ id: "pool-a", email: "a@example.com", isMain: false }];
    expect(filterCatalogVisibleModels([model], config)).toEqual([model]);

    config.customModels[0]!.codexAccountTarget = "@main";
    config.codexAccounts = [];
    expect(filterCatalogVisibleModels([model], config)).toEqual([model]);
  });

  test("active-picker filtering removes unavailable custom routes without applying model visibility", async () => {
    const targeted = {
      id: "targeted",
      provider: "openai",
      catalogKind: "custom-model-v1" as const,
    };
    const ordinary = {
      id: "ordinary",
      provider: "openai",
      catalogKind: "custom-model-v1" as const,
    };
    config.customModels = [{
      id: "targeted-row",
      provider: "openai",
      modelId: "targeted",
      codexAccountTarget: "pool-a",
    }];
    config.codexAccounts = [];
    expect(filterModelsByCustomRouteAvailability([targeted, ordinary], config))
      .toEqual([ordinary]);

    config.codexAccounts = [{ id: "pool-a", email: "a@example.com", isMain: false }];
    expect(filterModelsByCustomRouteAvailability([targeted, ordinary], config))
      .toEqual([targeted, ordinary]);

    config.customModels = [
      { id: "bound", provider: "openai", modelId: "targeted", codexAccountTarget: "@main" },
      { id: "unbound", provider: "openai", modelId: "targeted" },
    ];
    expect(filterModelsByCustomRouteAvailability([targeted, ordinary], config))
      .toEqual([ordinary]);

    config.customModels = [
      { id: "same-a", provider: "openai", modelId: "targeted", codexAccountTarget: "@main" },
      { id: "same-b", provider: "openai", modelId: "targeted", codexAccountTarget: "@main" },
    ];
    expect(filterModelsByCustomRouteAvailability([targeted, ordinary], config))
      .toEqual([targeted, ordinary]);

    config.customModels = [
      { id: "plain-a", provider: "openai", modelId: "targeted" },
      { id: "plain-b", provider: "openai", modelId: "targeted" },
    ];
    expect(filterModelsByCustomRouteAvailability([targeted, ordinary], config))
      .toEqual([targeted, ordinary]);

    config.customModels = [
      { id: "plain", provider: "openai", modelId: "ordinary" },
    ];
    config.providers.openai = { ...canonicalOpenAi, disabled: true };
    expect(filterModelsByCustomRouteAvailability([targeted, ordinary], config))
      .toEqual([]);
    expect((await listManagementModelRows(config)).find(row => row.customId === "plain"))
      .toMatchObject({ disabled: true });
    config.providers.openai = { ...canonicalOpenAi };
    expect(filterModelsByCustomRouteAvailability([targeted, ordinary], config))
      .toEqual([targeted, ordinary]);
  });

  test("active management pickers do not re-advertise a repair-only exact target", async () => {
    config.customModels = [{
      id: "targeted-row",
      provider: "openai",
      modelId: "targeted",
      codexAccountTarget: "deleted-account",
    }];
    config.codexAccounts = [];
    config.disabledModels = ["openai/ordinary"];
    config.providers.openai.selectedModels = ["selected-elsewhere"];
    routedModels = [
      { id: "targeted", provider: "openai", catalogKind: "custom-model-v1" },
      { id: "ordinary", provider: "openai", catalogKind: "custom-model-v1" },
    ];

    const selectedResponse = await request("GET", "/api/selected-models");
    expect(selectedResponse?.status).toBe(200);
    const selectedBody = await selectedResponse!.json() as { available: Record<string, string[]> };
    // This picker intentionally retains disabled and currently-unselected rows for editing.
    expect(selectedBody.available.openai).toEqual(["ordinary"]);

    config.disabledModels = [];
    config.providers.openai.selectedModels = ["ordinary"];
    const injection = await (await agentRequest("/api/injection-model"))!.json() as {
      available: Array<{ namespaced: string }>;
    };
    expect(injection.available.map(model => model.namespaced)).toContain("openai/ordinary");
    expect(injection.available.map(model => model.namespaced)).not.toContain("openai/targeted");

    const subagents = await (await agentRequest("/api/subagent-models"))!.json() as { available: string[] };
    expect(subagents.available).toContain("openai/ordinary");
    expect(subagents.available).not.toContain("openai/targeted");

    const fallback = await (await agentRequest("/api/subagent-model-fallback"))!.json() as { available: string[] };
    expect(fallback.available).toContain("openai/ordinary");
    expect(fallback.available).not.toContain("openai/targeted");

    const claude = await (await agentRequest("/api/claude-code"))!.json() as {
      available: string[];
      aliases: Array<{ display_name: string }>;
    };
    expect(claude.available).toContain("openai/ordinary");
    expect(claude.available).not.toContain("openai/targeted");
    expect(claude.aliases.map(alias => alias.display_name)).toContain("ordinary (openai)");
    expect(claude.aliases.map(alias => alias.display_name)).not.toContain("targeted (openai)");

    config.providers.openai.selectedModels = ["selected-elsewhere"];
    const allowlistedSubagents = await (await agentRequest("/api/subagent-models"))!.json() as {
      available: string[];
    };
    expect(allowlistedSubagents.available).not.toContain("openai/ordinary");
  });

  test("the lightweight options projection exposes only safe labels and public targets", () => {
    config.codexAccounts = [
      { id: "pool-a", email: "worker@example.com", alias: "Work", isMain: false, logLabel: "p123abc" },
      { id: "bad id!", email: "bad@example.com", isMain: false },
    ];
    const targets = listCodexAccountTargetOptions(config);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ target: "@main", isMain: true, logLabel: "main" });
    expect(targets[1]).toMatchObject({
      target: "pool-a",
      isMain: false,
      label: "Work",
      email: "w***r@example.com",
      logLabel: "p123abc",
    });
    expect(JSON.stringify(targets)).not.toContain("bad@example.com");
    expect(JSON.stringify(targets)).not.toContain("__main__");
    expect(JSON.stringify(targets)).not.toContain("credential");
    expect(JSON.stringify(targets)).not.toContain("quota");
  });
});
