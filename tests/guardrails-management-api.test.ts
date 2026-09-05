import { expect, setDefaultTimeout, test } from "bun:test";
import { handleManagementAPI, type ManagementApiDeps } from "../src/server/management-api";
import {
  clearGuardrailsTelemetryForTests,
  recordGuardrailsEvent,
} from "../src/guardrails/telemetry";
import { GuardrailsConfigRevisionConflictError } from "../src/guardrails/config-coordinator";
import { guardrailsPolicyRevision } from "../src/guardrails/runtime";
import type { OcxConfig } from "../src/types";
import { GUARDRAILS_CONFIRMED_MISS_ANALOGS } from "./helpers/guardrails-confirmed-miss-analogs";

setDefaultTimeout(15_000);

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
      },
    },
  };
}

function request(path: string, method = "GET", body?: unknown): Request {
  const headers = new Headers({ Host: "127.0.0.1:10100" });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://127.0.0.1:10100${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function mutationRequest(
  config: OcxConfig,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Request {
  const req = request(path, method, body);
  req.headers.set("if-match", `"${guardrailsPolicyRevision(config.guardrails ?? {})}"`);
  return req;
}

function persistenceSeam(): ManagementApiDeps {
  return {
    mutateAndAdoptGuardrailsConfig: (config, patch, expectedRevision) => {
      const currentRevision = guardrailsPolicyRevision(config.guardrails ?? {});
      if (currentRevision !== expectedRevision) {
        throw new GuardrailsConfigRevisionConflictError(currentRevision);
      }
      config.guardrails = { ...config.guardrails, ...patch };
      return { status: "committed", value: config.guardrails };
    },
    mutateAndAdoptGuardrailsCustomRule: (config, mutation, expectedRevision) => {
      const currentRevision = guardrailsPolicyRevision(config.guardrails ?? {});
      if (currentRevision !== expectedRevision) {
        throw new GuardrailsConfigRevisionConflictError(currentRevision);
      }
      const current = config.guardrails?.customRules ?? [];
      let customRules = current;
      if (mutation.kind === "create") customRules = [...current, mutation.rule];
      if (mutation.kind === "replace") {
        customRules = current.map(rule => rule.ruleId === mutation.ruleId ? mutation.rule : rule);
      }
      if (mutation.kind === "delete") customRules = current.filter(rule => rule.ruleId !== mutation.ruleId);
      config.guardrails = { ...config.guardrails, customRules };
      return { status: "committed", value: config.guardrails };
    },
  };
}

test("GET /api/guardrails is disabled by default and never exposes runtime mappings", async () => {
  const req = request("/api/guardrails");
  const response = await handleManagementAPI(req, new URL(req.url), baseConfig());
  expect(response?.status).toBe(200);
  const body = await response!.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    enabled: false,
    configuredEnabled: false,
    activation: { status: "disabled" },
    providerScope: { mode: "all" },
    providerOptions: expect.arrayContaining([
      expect.objectContaining({ id: "openai", kind: "configured" }),
      expect.objectContaining({ id: "anthropic-native", kind: "native" }),
    ]),
  });
  expect(body).not.toHaveProperty("replacements");
  expect(body).not.toHaveProperty("original");
});

test("every Guardrails Management API response is non-cacheable", async () => {
  const config = baseConfig();
  for (const path of [
    "/api/guardrails",
    "/api/guardrails/settings",
    "/api/guardrails/rules",
    "/api/guardrails/catalog",
    "/api/guardrails/activity",
    "/api/guardrails/export",
  ]) {
    const req = request(path);
    const response = await handleManagementAPI(req, new URL(req.url), config, persistenceSeam());
    expect(response?.headers.get("cache-control"), path).toBe("no-store");
  }
});

test("PUT /api/guardrails/settings persists valid settings and reports inactive configuration", async () => {
  const config = baseConfig();
  const req = mutationRequest(config, "/api/guardrails/settings", "PUT", {
    enabledDataTypes: [1, 2],
    disabledBuiltinRuleIds: ["api_keys.stripe-key"],
    keywordPrefilterEnabled: true,
  });
  const response = await handleManagementAPI(req, new URL(req.url), config, persistenceSeam());
  expect(response?.status).toBe(200);
  expect(config.guardrails).toEqual({
    enabledDataTypes: [1, 2],
    disabledBuiltinRuleIds: ["api_keys.stripe-key"],
    keywordPrefilterEnabled: true,
  });
  expect(await response!.json()).toMatchObject({
    ok: true,
    enabled: false,
    enabledDataTypes: [1, 2],
    activation: { status: "disabled" },
  });
});

test("Guardrails management rejects unsupported settings and activates a valid feature", async () => {
  const config = baseConfig();
  const unsupported = request("/api/guardrails/settings", "PUT", { unexpected: true });
  const unsupportedResponse = await handleManagementAPI(unsupported, new URL(unsupported.url), config, persistenceSeam());
  expect(unsupportedResponse?.status).toBe(400);

  const emptyTypes = request("/api/guardrails/settings", "PUT", { enabledDataTypes: [] });
  const emptyTypesResponse = await handleManagementAPI(
    emptyTypes,
    new URL(emptyTypes.url),
    config,
    persistenceSeam(),
  );
  expect(emptyTypesResponse?.status).toBe(400);

  const activation = mutationRequest(config, "/api/guardrails/settings", "PUT", { enabled: true });
  const activationResponse = await handleManagementAPI(activation, new URL(activation.url), config, persistenceSeam());
  expect(activationResponse?.status).toBe(200);
  expect(await activationResponse!.json()).toMatchObject({ enabled: true, activation: { status: "active" } });
  expect(config.guardrails).toEqual({ enabled: true });
});

test("Guardrails management validates and atomically persists provider scope", async () => {
  const config = baseConfig();
  const selected = mutationRequest(config, "/api/guardrails/settings", "PUT", {
    providerScope: { mode: "selected", providerIds: ["openai"] },
  });
  const selectedResponse = await handleManagementAPI(
    selected,
    new URL(selected.url),
    config,
    persistenceSeam(),
  );
  expect(selectedResponse?.status).toBe(200);
  expect(config.guardrails?.providerScope).toEqual({
    mode: "selected",
    providerIds: ["openai"],
  });

  for (const providerScope of [
    { mode: "selected", providerIds: [] },
    { mode: "selected", providerIds: ["openai", "openai"] },
    { mode: "selected", providerIds: ["policy"] },
    { mode: "all", providerIds: ["openai"] },
  ]) {
    const invalid = mutationRequest(config, "/api/guardrails/settings", "PUT", {
      providerScope,
    });
    const response = await handleManagementAPI(
      invalid,
      new URL(invalid.url),
      config,
      persistenceSeam(),
    );
    expect(response?.status).toBe(400);
  }
});

test("Guardrails custom rule CRUD is scoped, validated, and does not need another server", async () => {
  const config = baseConfig();
  const rule = {
    ruleId: "custom.example-token",
    name: "Example token",
    dataType: 6,
    group: "CUSTOM",
    groupPriority: 1,
    displayName: "Example token",
    description: "Fixture-only local rule",
    regex: "token_[a-z0-9]{8}",
    keywords: ["token_"],
    banlist: [],
    validators: [],
    masking: { captureGroups: [], placeholderType: "CUSTOM_TOKEN" },
  };
  const create = mutationRequest(config, "/api/guardrails/rules", "POST", rule);
  expect((await handleManagementAPI(create, new URL(create.url), config, persistenceSeam()))?.status).toBe(200);

  const list = request("/api/guardrails/rules");
  expect(await (await handleManagementAPI(list, new URL(list.url), config, persistenceSeam()))?.json()).toMatchObject({
    customRuleCount: 1,
    customRules: [expect.objectContaining({ ruleId: rule.ruleId })],
  });

  const update = mutationRequest(
    config,
    `/api/guardrails/rules/${rule.ruleId}`,
    "PUT",
    { ...rule, description: "Updated fixture rule" },
  );
  expect((await handleManagementAPI(update, new URL(update.url), config, persistenceSeam()))?.status).toBe(200);
  const remove = mutationRequest(config, `/api/guardrails/rules/${rule.ruleId}`, "DELETE");
  expect((await handleManagementAPI(remove, new URL(remove.url), config, persistenceSeam()))?.status).toBe(200);
  expect(config.guardrails?.customRules).toEqual([]);
});

test("Guardrails catalog exposes safe built-in metadata without compiled matchers", async () => {
  const req = request("/api/guardrails/catalog");
  const response = await handleManagementAPI(req, new URL(req.url), baseConfig());
  expect(response?.status).toBe(200);
  const body = await response!.json() as { builtinRules: Array<Record<string, unknown>> };
  expect(body.builtinRules).toContainEqual(expect.objectContaining({ ruleId: "api_keys.stripe-key" }));
  expect(body.builtinRules).toContainEqual(expect.objectContaining({
    ruleId: "opencodex.api-keys.assignment",
    source: "opencodex",
  }));
  expect(body.builtinRules[0]).not.toHaveProperty("regex");
  expect(body.builtinRules[0]).not.toHaveProperty("matcher");
});

test("Guardrails catalog and built-in toggle return the same typed asset failure", async () => {
  const config = baseConfig();
  const deps: ManagementApiDeps = {
    ...persistenceSeam(),
    guardrailsBuiltinRuleCatalog: () => {
      throw new Error("synthetic bundled asset failure");
    },
  };
  const catalog = request("/api/guardrails/catalog");
  const catalogResponse = await handleManagementAPI(catalog, new URL(catalog.url), config, deps);
  const toggle = mutationRequest(
    config,
    "/api/guardrails/rules/api_keys.stripe-key/enabled",
    "PUT",
    { enabled: false },
  );
  const toggleResponse = await handleManagementAPI(toggle, new URL(toggle.url), config, deps);

  for (const response of [catalogResponse, toggleResponse]) {
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({ code: "guardrails_assets_invalid" });
  }
  expect(config.guardrails).toBeUndefined();
});

test("Guardrails rules endpoint toggles a built-in rule and enforces revisions", async () => {
  const config = baseConfig();
  const list = request("/api/guardrails/rules");
  const listed = await handleManagementAPI(list, new URL(list.url), config, persistenceSeam());
  const revision = listed!.headers.get("etag");
  const body = await listed!.json() as { rules: Array<{ ruleId: string; enabled: boolean }> };
  expect(body.rules.find(rule => rule.ruleId === "api_keys.stripe-key")?.enabled).toBe(true);

  const toggle = request("/api/guardrails/rules/api_keys.stripe-key/enabled", "PUT", { enabled: false });
  toggle.headers.set("if-match", revision!);
  expect((await handleManagementAPI(toggle, new URL(toggle.url), config, persistenceSeam()))?.status).toBe(200);
  expect(config.guardrails?.disabledBuiltinRuleIds).toContain("api_keys.stripe-key");

  const stale = request("/api/guardrails/settings", "PUT", { mode: "detect" });
  stale.headers.set("if-match", revision!);
  const staleResponse = await handleManagementAPI(stale, new URL(stale.url), config, persistenceSeam());
  expect(staleResponse?.status).toBe(412);
  expect(await staleResponse!.json()).toMatchObject({ code: "guardrails_revision_conflict" });
});

test("Guardrails mutations require If-Match while persistence conflicts remain 409", async () => {
  const config = baseConfig();
  const missing = request("/api/guardrails/settings", "PUT", { mode: "detect" });
  const missingResponse = await handleManagementAPI(missing, new URL(missing.url), config, persistenceSeam());
  expect(missingResponse?.status).toBe(428);
  expect(await missingResponse!.json()).toMatchObject({ code: "guardrails_revision_required" });

  const weak = request("/api/guardrails/settings", "PUT", { mode: "detect" });
  weak.headers.set("if-match", `W/"${guardrailsPolicyRevision(config.guardrails ?? {})}"`);
  const weakResponse = await handleManagementAPI(weak, new URL(weak.url), config, persistenceSeam());
  expect(weakResponse?.status).toBe(400);
  expect(await weakResponse!.json()).toMatchObject({ code: "guardrails_revision_invalid" });

  const unavailable = mutationRequest(config, "/api/guardrails/settings", "PUT", { mode: "detect" });
  const unavailableResponse = await handleManagementAPI(
    unavailable,
    new URL(unavailable.url),
    config,
    {
      mutateAndAdoptGuardrailsConfig: () => ({ status: "unavailable", reason: "conflict" }),
    },
  );
  expect(unavailableResponse?.status).toBe(409);
  expect(await unavailableResponse!.json()).toMatchObject({ code: "config_conflict" });
});

test("Guardrails tester returns only a masked preview and never persists tester text", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const config = baseConfig();
  const testRequest = request("/api/guardrails/test", "POST", { text: `token ${secret}` });
  const response = await handleManagementAPI(testRequest, new URL(testRequest.url), config, persistenceSeam());
  expect(response?.status).toBe(200);
  const body = await response!.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    simulation: true,
    trafficProtection: "disabled",
  });
  expect(body.maskedPreview).toBe("token <STRIPE_ACCESS_TOKEN_1>");
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(config.guardrails).toBeUndefined();

  const analogText = GUARDRAILS_CONFIRMED_MISS_ANALOGS.map(analog => analog.input).join("\n");
  const analogRequest = request("/api/guardrails/test", "POST", { text: analogText });
  const analogResponse = await handleManagementAPI(
    analogRequest,
    new URL(analogRequest.url),
    config,
    persistenceSeam(),
  );
  expect(analogResponse?.status).toBe(200);
  const analogBody = await analogResponse!.json() as {
    findings: Array<{ placeholderType: string; ruleId: string }>;
    maskedPreview: string;
  };
  expect(analogBody.findings).toHaveLength(23);
  for (const analog of GUARDRAILS_CONFIRMED_MISS_ANALOGS) {
    expect(analogBody.maskedPreview).not.toContain(analog.value);
  }
  expect(config.guardrails).toBeUndefined();

  config.guardrails = { enabled: true, mode: "detect" };
  const detectRequest = request("/api/guardrails/test", "POST", { text: "synthetic sample" });
  const detectResponse = await handleManagementAPI(
    detectRequest,
    new URL(detectRequest.url),
    config,
    persistenceSeam(),
  );
  expect(await detectResponse!.json()).toMatchObject({
    simulation: true,
    trafficProtection: "detect",
  });

  config.guardrails = {
    enabled: true,
    mode: "enforce",
    keywordPrefilterEnabled: true,
  };
  const prefilteredRequest = request("/api/guardrails/test", "POST", { text: "synthetic sample" });
  const prefilteredResponse = await handleManagementAPI(
    prefilteredRequest,
    new URL(prefilteredRequest.url),
    config,
    persistenceSeam(),
  );
  expect(await prefilteredResponse!.json()).toMatchObject({
    simulation: true,
    trafficProtection: "enforce",
  });

  config.guardrails = {
    enabled: true,
    mode: "enforce",
    providerScope: { mode: "selected", providerIds: ["removed-provider"] },
  };
  const uncoveredRequest = request("/api/guardrails/test", "POST", { text: "synthetic sample" });
  const uncoveredResponse = await handleManagementAPI(
    uncoveredRequest,
    new URL(uncoveredRequest.url),
    config,
    persistenceSeam(),
  );
  expect(await uncoveredResponse!.json()).toMatchObject({
    simulation: true,
    trafficProtection: "no-provider-coverage",
  });

  const tooLarge = request("/api/guardrails/test", "POST", { text: "x".repeat(128 * 1024 + 1) });
  expect((await handleManagementAPI(tooLarge, new URL(tooLarge.url), config, persistenceSeam()))?.status).toBe(413);

  const tooManyFindings = request("/api/guardrails/test", "POST", {
    text: "x".repeat(4_097),
    settings: { enabledDataTypes: [6] },
    draftRule: {
      ruleId: "custom.capacity",
      name: "Capacity",
      dataType: 6,
      group: "CUSTOM",
      groupPriority: 1,
      displayName: "Capacity",
      description: "Capacity fixture",
      regex: "x",
      keywords: [],
      banlist: [],
      validators: [],
      masking: { captureGroups: [], placeholderType: "CAPACITY" },
    },
  });
  const capacityResponse = await handleManagementAPI(
    tooManyFindings,
    new URL(tooManyFindings.url),
    config,
    persistenceSeam(),
  );
  expect(capacityResponse?.status).toBe(413);
  expect(await capacityResponse!.json()).toMatchObject({
    code: "guardrails_capacity_exceeded",
  });

  const rule = {
    name: "Tester limit",
    dataType: 6 as const,
    group: "CUSTOM",
    groupPriority: 1,
    displayName: "Tester limit",
    description: "Capacity fixture",
    regex: "token_[a-z0-9]{8}",
    keywords: [],
    banlist: [],
    validators: [],
    masking: { captureGroups: [], placeholderType: "TESTER_LIMIT" },
  };
  config.guardrails = {
    customRules: Array.from({ length: 100 }, (_, index) => ({
      ...rule,
      ruleId: `custom.tester-${index}`,
      masking: { ...rule.masking, placeholderType: `TESTER_LIMIT_${index}` },
    })),
  };
  const tooManyRules = request("/api/guardrails/test", "POST", {
    text: "token_abcdefgh",
    draftRule: {
      ...rule,
      ruleId: "custom.tester-overflow",
      masking: { ...rule.masking, placeholderType: "TESTER_LIMIT_OVERFLOW" },
    },
  });
  const tooManyRulesResponse = await handleManagementAPI(
    tooManyRules,
    new URL(tooManyRules.url),
    config,
    persistenceSeam(),
  );
  expect(tooManyRulesResponse?.status).toBe(400);
  expect(JSON.stringify(await tooManyRulesResponse!.json())).toContain("customRules");
  expect(config.guardrails.customRules).toHaveLength(100);
});

test("Guardrails export/import supports dry-run and one atomic apply", async () => {
  const source = baseConfig();
  source.guardrails = {
    enabled: true,
    mode: "enforce",
    disabledBuiltinRuleIds: ["api_keys.stripe-key"],
    customRules: [{
      ruleId: "custom.import-token",
      name: "Import token",
      dataType: 6,
      group: "CUSTOM",
      groupPriority: 1,
      displayName: "Import token",
      description: "Import fixture",
      regex: "import_[a-z0-9]{8}",
      keywords: ["import_"],
      banlist: [],
      validators: [],
      masking: { captureGroups: [], placeholderType: "IMPORT_TOKEN" },
    }],
  };
  const exportRequest = request("/api/guardrails/export");
  const exported = await handleManagementAPI(exportRequest, new URL(exportRequest.url), source, persistenceSeam());
  expect(exported?.headers.get("content-disposition")).toContain("opencodex-guardrails.json");
  const bundle = await exported!.json();
  expect(bundle.settings.providerScope).toEqual({ mode: "all" });

  const incompleteBundle = structuredClone(bundle) as {
    settings: Record<string, unknown>;
  };
  delete incompleteBundle.settings.mode;
  const incomplete = request("/api/guardrails/import", "POST", {
    mode: "replace",
    dryRun: true,
    bundle: incompleteBundle,
  });
  expect((await handleManagementAPI(
    incomplete,
    new URL(incomplete.url),
    baseConfig(),
    persistenceSeam(),
  ))?.status).toBe(400);

  const target = baseConfig();
  const dryRun = mutationRequest(
    target,
    "/api/guardrails/import",
    "POST",
    { mode: "replace", dryRun: true, bundle },
  );
  const dryRunResponse = await handleManagementAPI(
    dryRun,
    new URL(dryRun.url),
    target,
    persistenceSeam(),
  );
  expect(dryRunResponse?.headers.get("etag")).toBe(`"${guardrailsPolicyRevision(target.guardrails ?? {})}"`);
  expect(await dryRunResponse?.json()).toMatchObject({
    ok: true,
    dryRun: true,
    createCount: 1,
  });
  expect(target.guardrails).toBeUndefined();

  const staleDryRun = request(
    "/api/guardrails/import",
    "POST",
    { mode: "replace", dryRun: true, bundle },
  );
  staleDryRun.headers.set("if-match", '"stale-revision"');
  const staleDryRunResponse = await handleManagementAPI(
    staleDryRun,
    new URL(staleDryRun.url),
    target,
    persistenceSeam(),
  );
  expect(staleDryRunResponse?.status).toBe(412);
  expect(await staleDryRunResponse?.json()).toMatchObject({
    code: "guardrails_revision_conflict",
    revision: guardrailsPolicyRevision(target.guardrails ?? {}),
  });

  const conflictTarget = baseConfig();
  conflictTarget.guardrails = {
    enabled: false,
    customRules: [{
      ...source.guardrails!.customRules![0]!,
      regex: "DIFFERENT_[A-Z]+",
    }],
  };
  const conflictDryRun = mutationRequest(
    conflictTarget,
    "/api/guardrails/import",
    "POST",
    { mode: "merge", dryRun: true, bundle },
  );
  const conflictResponse = await handleManagementAPI(
    conflictDryRun,
    new URL(conflictDryRun.url),
    conflictTarget,
    persistenceSeam(),
  );
  expect(conflictResponse?.status).toBe(200);
  expect(await conflictResponse!.json()).toMatchObject({
    ok: false,
    dryRun: true,
    createCount: 0,
    unchangedCount: 0,
    conflicts: ["custom.import-token"],
  });
  expect(conflictTarget.guardrails.customRules?.[0]?.regex).toBe("DIFFERENT_[A-Z]+");

  const mergeTarget = baseConfig();
  mergeTarget.guardrails = {
    enabled: false,
    mode: "detect",
    failurePolicy: "passthrough",
    enabledDataTypes: [2, 6],
    disabledBuiltinRuleIds: ["credentials.url_with_creds"],
    keywordPrefilterEnabled: false,
  };
  const merge = mutationRequest(
    mergeTarget,
    "/api/guardrails/import",
    "POST",
    { mode: "merge", dryRun: false, bundle },
  );
  expect((await handleManagementAPI(
    merge,
    new URL(merge.url),
    mergeTarget,
    persistenceSeam(),
  ))?.status).toBe(200);
  expect(mergeTarget.guardrails).toMatchObject({
    enabled: false,
    mode: "detect",
    failurePolicy: "passthrough",
    enabledDataTypes: [2, 6],
    disabledBuiltinRuleIds: ["credentials.url_with_creds"],
    keywordPrefilterEnabled: false,
  });
  expect(mergeTarget.guardrails.customRules?.[0]?.ruleId).toBe("custom.import-token");

  const apply = mutationRequest(
    target,
    "/api/guardrails/import",
    "POST",
    { mode: "replace", dryRun: false, bundle },
  );
  expect((await handleManagementAPI(apply, new URL(apply.url), target, persistenceSeam()))?.status).toBe(200);
  expect(target.guardrails?.customRules?.[0]?.ruleId).toBe("custom.import-token");
  expect(target.guardrails?.disabledBuiltinRuleIds).toEqual(["api_keys.stripe-key"]);
});

test("Guardrails Replace dry-run reports a privacy-safe security diff", async () => {
  const target = baseConfig();
  target.guardrails = {
    enabled: true,
    mode: "enforce",
    failurePolicy: "block",
    enabledDataTypes: [1, 2, 3, 4, 5, 6],
    disabledBuiltinRuleIds: [],
    keywordPrefilterEnabled: false,
    customRules: [{
      ruleId: "custom.removed-by-replace",
      name: "Removed by replace",
      dataType: 6,
      group: "CUSTOM",
      groupPriority: 1,
      displayName: "Removed by replace",
      description: "Security diff fixture",
      regex: "fixture_[a-z0-9]{8}",
      keywords: ["fixture_"],
      banlist: [],
      validators: [],
      masking: { captureGroups: [], placeholderType: "FIXTURE" },
    }],
  };
  const bundle = {
    version: 1,
    settings: {
      configuredEnabled: false,
      mode: "detect",
      failurePolicy: "passthrough",
      providerScope: { mode: "selected", providerIds: ["openai"] },
      enabledDataTypes: [1, 2],
      disabledBuiltinRuleIds: ["api_keys.stripe-key"],
      customRuleCount: 0,
      keywordPrefilterEnabled: true,
    },
    customRules: [],
  };
  const dryRun = mutationRequest(
    target,
    "/api/guardrails/import",
    "POST",
    { mode: "replace", dryRun: true, bundle },
  );
  const response = await handleManagementAPI(
    dryRun,
    new URL(dryRun.url),
    target,
    persistenceSeam(),
  );
  expect(response?.status).toBe(200);
  const body = await response!.json();
  expect(body).toMatchObject({
    ok: true,
    dryRun: true,
    securityDiff: {
      weakensProtection: true,
      enabled: {
        before: true,
        after: false,
        changed: true,
        weakening: true,
      },
      mode: {
        before: "enforce",
        after: "detect",
        changed: true,
        weakening: true,
      },
      failurePolicy: {
        before: "block",
        after: "passthrough",
        changed: true,
        weakening: true,
      },
      providerScope: {
        before: { mode: "all" },
        after: { mode: "selected", providerIds: ["openai"] },
        addedProviderIds: ["openai"],
        removedProviderIds: [],
        changed: true,
        weakening: true,
      },
      enabledDataTypes: {
        before: [1, 2, 3, 4, 5, 6],
        after: [1, 2],
        added: [],
        removed: [3, 4, 5, 6],
        changed: true,
        weakening: true,
      },
      disabledBuiltinRules: {
        beforeCount: 0,
        afterCount: 1,
        newlyDisabledCount: 1,
        reenabledCount: 0,
        changed: true,
        weakening: true,
      },
      customRules: {
        beforeCount: 1,
        afterCount: 0,
        addedCount: 0,
        removedCount: 1,
        changedDefinitionCount: 0,
        changedRuleIds: [],
        removedRuleIds: ["custom.removed-by-replace"],
        changed: true,
        weakening: true,
      },
      keywordPrefilterEnabled: {
        before: false,
        after: true,
        changed: true,
        weakening: false,
      },
    },
  });
  expect(target.guardrails).toEqual({
    enabled: true,
    mode: "enforce",
    failurePolicy: "block",
    enabledDataTypes: [1, 2, 3, 4, 5, 6],
    disabledBuiltinRuleIds: [],
    keywordPrefilterEnabled: false,
    customRules: [{
      ruleId: "custom.removed-by-replace",
      name: "Removed by replace",
      dataType: 6,
      group: "CUSTOM",
      groupPriority: 1,
      displayName: "Removed by replace",
      description: "Security diff fixture",
      regex: "fixture_[a-z0-9]{8}",
      keywords: ["fixture_"],
      banlist: [],
      validators: [],
      masking: { captureGroups: [], placeholderType: "FIXTURE" },
    }],
  });
  expect(JSON.stringify(body)).not.toContain("api.example.test");
});

test("Guardrails Replace security diff ignores cosmetic custom-rule edits", async () => {
  const rule = {
    ruleId: "custom.cosmetic",
    name: "Cosmetic",
    dataType: 6 as const,
    group: "CUSTOM",
    groupPriority: 1,
    displayName: "Before",
    description: "Before description",
    regex: "cosmetic_[a-z0-9]{8}",
    keywords: ["cosmetic_"],
    banlist: [],
    validators: [],
    masking: { captureGroups: [], placeholderType: "COSMETIC" },
  };
  const target = baseConfig();
  target.guardrails = { enabled: true, customRules: [rule] };
  const settings = {
    configuredEnabled: true,
    mode: "enforce",
    failurePolicy: "block",
    enabledDataTypes: [1, 2, 3, 4, 5, 6],
    disabledBuiltinRuleIds: [],
    customRuleCount: 1,
    keywordPrefilterEnabled: false,
  };
  const bundle = {
    version: 1,
    settings,
    customRules: [{ ...rule, displayName: "After", description: "After description" }],
  };
  const dryRun = mutationRequest(
    target,
    "/api/guardrails/import",
    "POST",
    { mode: "replace", dryRun: true, bundle },
  );
  const body = await (await handleManagementAPI(
    dryRun,
    new URL(dryRun.url),
    target,
    persistenceSeam(),
  ))!.json();

  expect(body.securityDiff.customRules).toMatchObject({
    changedDefinitionCount: 0,
    changedRuleIds: [],
    removedRuleIds: [],
    weakening: false,
    requiresReview: false,
  });
  expect(body.securityDiff.weakensProtection).toBe(false);
  expect(body.securityDiff.requiresReview).toBe(false);
  expect(body.securityDiff.providerScope).toMatchObject({
    before: { mode: "all" },
    after: { mode: "all" },
    changed: false,
    weakening: false,
  });

  const securityRelevantBundle = {
    ...bundle,
    customRules: [{ ...rule, regex: "cosmetic_[A-Z0-9]{8}" }],
  };
  const reviewDryRun = mutationRequest(
    target,
    "/api/guardrails/import",
    "POST",
    { mode: "replace", dryRun: true, bundle: securityRelevantBundle },
  );
  const reviewBody = await (await handleManagementAPI(
    reviewDryRun,
    new URL(reviewDryRun.url),
    target,
    persistenceSeam(),
  ))!.json();
  expect(reviewBody.securityDiff.customRules).toMatchObject({
    changedDefinitionCount: 1,
    changedRuleIds: ["custom.cosmetic"],
    removedRuleIds: [],
    weakening: false,
    requiresReview: true,
  });
  expect(reviewBody.securityDiff.weakensProtection).toBe(false);
  expect(reviewBody.securityDiff.requiresReview).toBe(true);
});

test("Guardrails Replace import reports identical custom rules as unchanged", async () => {
  const rule = {
    ruleId: "custom.identical",
    name: "Identical",
    dataType: 6 as const,
    group: "CUSTOM",
    groupPriority: 1,
    displayName: "Identical",
    description: "Unchanged definition",
    regex: "identical_[a-z0-9]{8}",
    keywords: ["identical_"],
    banlist: [],
    validators: [],
    masking: { captureGroups: [], placeholderType: "IDENTICAL" },
  };
  const target = baseConfig();
  target.guardrails = { enabled: true, customRules: [rule] };
  const bundle = {
    version: 1,
    settings: {
      configuredEnabled: true,
      mode: "enforce",
      failurePolicy: "block",
      enabledDataTypes: [1, 2, 3, 4, 5, 6],
      disabledBuiltinRuleIds: [],
      customRuleCount: 1,
      keywordPrefilterEnabled: false,
    },
    customRules: [rule],
  };
  const request = mutationRequest(
    target,
    "/api/guardrails/import",
    "POST",
    { mode: "replace", dryRun: true, bundle },
  );
  const response = await handleManagementAPI(
    request,
    new URL(request.url),
    target,
    persistenceSeam(),
  );
  const body = await response!.json();

  expect(body).toMatchObject({
    ok: true,
    createCount: 0,
    unchangedCount: 1,
    replaceCount: 0,
  });
});

test("Guardrails Activity exposes bounded metadata and validates filters", async () => {
  clearGuardrailsTelemetryForTests();
  recordGuardrailsEvent({
    surface: "chat",
    mode: "enforce",
    result: "masked",
    registryGeneration: 7,
    count: 2,
    categoryIds: [6],
    ruleIds: ["api_keys.stripe-key"],
    latencyMs: 1.25,
    severity: "info",
  });
  const config = baseConfig();
  const activity = request(
    "/api/guardrails/activity?surface=chat&mode=enforce&result=masked&category=6&limit=10",
  );
  const body = await (await handleManagementAPI(activity, new URL(activity.url), config, persistenceSeam()))!.json() as {
    events: Array<Record<string, unknown>>;
    filteredSummary: {
      eventCount: number;
      findingCount: number;
      averageLatencyMs: number;
      topRules: Array<{ id: string; count: number }>;
    };
    retention: { kind: string };
  };
  expect(body.events).toHaveLength(1);
  expect(body.events[0]).toMatchObject({ surface: "chat", count: 2, registryGeneration: 7 });
  expect(body.filteredSummary).toEqual(expect.objectContaining({
    eventCount: 1,
    findingCount: 2,
    averageLatencyMs: 1.25,
    topRules: [{ id: "api_keys.stripe-key", count: 1 }],
  }));
  expect(body.retention.kind).toBe("in-memory");
  expect(JSON.stringify(body)).not.toContain("text");

  const invalid = request("/api/guardrails/activity?surface=unknown");
  expect((await handleManagementAPI(invalid, new URL(invalid.url), config, persistenceSeam()))?.status).toBe(400);
  const invalidCategory = request("/api/guardrails/activity?category=7");
  expect((await handleManagementAPI(
    invalidCategory,
    new URL(invalidCategory.url),
    config,
    persistenceSeam(),
  ))?.status).toBe(400);
  const invalidMode = request("/api/guardrails/activity?mode=observe");
  expect((await handleManagementAPI(
    invalidMode,
    new URL(invalidMode.url),
    config,
    persistenceSeam(),
  ))?.status).toBe(400);
  const invalidResult = request("/api/guardrails/activity?result=restored");
  expect((await handleManagementAPI(
    invalidResult,
    new URL(invalidResult.url),
    config,
    persistenceSeam(),
  ))?.status).toBe(400);
  clearGuardrailsTelemetryForTests();
});
