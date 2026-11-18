import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import {
  initializeManagementAuthState, issueGuiSession, managementPrincipal,
  managementSessionIssuance, requireManagementAuth,
} from "../../src/server/management-auth";
import { loadConfig, saveConfig } from "../../src/config";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { parseExcludedProviders } from "../../src/server/management/combo-suggestion-routes";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import type { OcxConfig } from "../../src/types";

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-combo-suggestion-routes-"));
  process.env.OPENCODEX_HOME = home;
  saveConfig({
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["m"] } },
  } as OcxConfig);
});

afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function dispatch(config: OcxConfig, path: string, method: string, body?: unknown, adminOnly = false) {
  const url = new URL(path, "http://localhost:10100");
  const state = initializeManagementAuthState(config);
  const headers = new Headers({ Origin: url.origin, "content-type": "application/json" });
  if (adminOnly) {
    headers.set("X-OpenCodex-API-Key", state.token!);
  } else {
    const session = issueGuiSession(new ManagementRequest(url, { headers }), config, state)!;
    headers.set("X-OpenCodex-API-Key", session.token);
    headers.set("X-OpenCodex-GUI-Origin", session.browserOrigin);
    if (method !== "GET") headers.set("X-OpenCodex-CSRF-Token", session.csrfToken);
  }
  const req = new ManagementRequest(url, { method, headers, body: JSON.stringify(body) });
  expect(requireManagementAuth(req, state, config)).toBeNull();
  return (await handleManagementAPI(req, url, config, {}, managementPrincipal(req, state, config)!, undefined, {
    trustedLoopback: true,
    guiSessionIssuance: managementSessionIssuance(req, state),
  }))!;
}

async function call(config: OcxConfig, method: "GET" | "PUT", body?: unknown) {
  const response = await dispatch(config, "/api/combo-suggestions", method, body);
  return { status: response!.status, body: await response!.json() as Record<string, unknown> };
}

const onDisk = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;

test("excluded providers round-trip through config.json, and an empty list removes the key", async () => {
  const live = loadConfig();
  expect(await call(live, "GET")).toEqual({ status: 200, body: { excludedProviders: [] } });

  expect(await call(live, "PUT", { excludedProviders: [" cursor ", "cursor", "trae"] }))
    .toEqual({ status: 200, body: { excludedProviders: ["cursor", "trae"] } });
  expect(onDisk().comboSuggestionExcludedProviders).toEqual(["cursor", "trae"]);
  // The running server reads the in-memory config, so the write must land there too.
  expect(live.comboSuggestionExcludedProviders).toEqual(["cursor", "trae"]);
  expect(loadConfig().comboSuggestionExcludedProviders).toEqual(["cursor", "trae"]);
  expect(await call(loadConfig(), "GET")).toEqual({ status: 200, body: { excludedProviders: ["cursor", "trae"] } });

  expect(await call(live, "PUT", { excludedProviders: [] })).toEqual({ status: 200, body: { excludedProviders: [] } });
  expect("comboSuggestionExcludedProviders" in onDisk()).toBe(false);
  expect(live.comboSuggestionExcludedProviders).toBeUndefined();
});

test("a malformed write is refused and changes nothing", async () => {
  const live = loadConfig();
  for (const body of [{ excludedProviders: "cursor" }, { excludedProviders: [1] }, { excludedProviders: [""] }, { other: [] }]) {
    expect((await call(live, "PUT", body)).status).toBe(400);
  }
  expect("comboSuggestionExcludedProviders" in onDisk()).toBe(false);
});

test("parseExcludedProviders trims, dedupes and keeps order", () => {
  expect(parseExcludedProviders(["b", " a", "b "])).toEqual(["b", "a"]);
  expect(parseExcludedProviders(null)).toBeNull();
});

test("the config schema normalizes hand-edited exclusions and discards malformed lists", async () => {
  const { configSchema } = await import("../../src/config/schema/config-schema");
  const input = onDisk();
  const parse = (comboSuggestionExcludedProviders: unknown) =>
    configSchema.parse({ ...input, comboSuggestionExcludedProviders });
  expect(parse([" cursor ", "cursor"]).comboSuggestionExcludedProviders).toEqual(["cursor"]);
  for (const invalid of [[" "], ["a".repeat(257)], Array.from({ length: 257 }, () => "a")]) {
    const parsed = parse(invalid);
    expect(parsed.comboSuggestionExcludedProviders).toBeUndefined();
    expect(parsed.providers.mock).toBeDefined();
  }
});

const paidTarget = { provider: "paid", model: "gemini" };

async function saveSuggestion(live: OcxConfig, body: unknown) {
  return dispatch(live, "/api/combo-suggestions/save", "POST", body);
}

function setCanonicalForward(config: OcxConfig) {
  Object.assign(config.providers.mock!, {
    adapter: "openai-responses",
    authMode: "forward",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  });
}

function seedPaidSuggestion() {
  const live = loadConfig();
  live.providers.paid = { ...live.providers.mock!, authMode: "api-key", baseUrl: "https://aiplatform.googleapis.com/v1", models: ["gemini"] };
  live.combos = { mix: { strategy: "failover", allowMeteredTargets: true, targets: [{ provider: "mock", model: "m" }] } };
  saveConfig(live);
  return live;
}

test("config DTO computes forward eligibility before redacting provider URLs", async () => {
  const { safeConfigDTO } = await import("../../src/server/auth-cors");
  const live = loadConfig();
  setCanonicalForward(live);
  live.providers.gateway = { ...live.providers.mock!, baseUrl: "https://chatgpt.com/backend-api/codex?route=custom" };
  live.providers.kimi = { adapter: "openai-chat", authMode: "oauth", baseUrl: "https://api.kimi.com/coding/v1?route=custom", models: ["kimi-for-coding"] };
  expect(safeConfigDTO(live)).toMatchObject({ providers: {
    mock: { canonicalOpenAiForward: true },
    gateway: { baseUrl: live.providers.mock!.baseUrl, canonicalOpenAiForward: false },
    kimi: { baseUrl: "https://api.kimi.com/coding/v1", knownSubscriptionOAuth: false },
  } });
});

test.each([
  ["GET", "/api/combo-suggestions", undefined],
  ["PUT", "/api/combo-suggestions", { excludedProviders: ["other"] }],
  ["POST", "/api/combo-suggestions/save", { id: "mix", mode: "append", targets: [paidTarget] }],
  ["POST", "/api/combo-suggestions/save", { id: "draft", mode: "create", targets: [paidTarget], allowMeteredTargets: true }],
] as const)("%s %s requires a dashboard session", async (method, path, body) => {
  const live = seedPaidSuggestion();
  const before = onDisk();
  const denied = await dispatch(live, path, method, body, true);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "dashboard session required" });
  expect(onDisk()).toEqual(before);
  expect((await dispatch(live, path, method, body)).status).toBe(200);
});

for (const code of ["suggestion_consent_required", "suggestion_provider_excluded"]) {
  test(`append refuses ${code} when policy changes before commit`, async () => {
    const live = seedPaidSuggestion();
    const changePolicy = () => {
      const current = onDisk() as unknown as OcxConfig;
      if (code === "suggestion_consent_required") delete current.combos!.mix!.allowMeteredTargets;
      else current.comboSuggestionExcludedProviders = ["paid"];
      writeFileSync(join(home, "config.json"), JSON.stringify(current));
    };
    setPersistedConfigMutationBeforeCommitForTests(changePolicy);
    const response = await saveSuggestion(live, { id: "mix", mode: "append", targets: [paidTarget] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code,
      policy: {
        allowMeteredTargets: code !== "suggestion_consent_required",
        excludedProviders: code === "suggestion_provider_excluded" ? ["paid"] : [],
      },
    });
    expect(loadConfig().combos?.mix?.targets).toHaveLength(1);
  });
}

test("append uses the current combo and marks a consented Vertex target metered", async () => {
  const live = seedPaidSuggestion();
  const current = loadConfig();
  current.combos!.mix!.displayName = "Current display name";
  saveConfig(current);
  const response = await saveSuggestion(live, { id: "mix", mode: "append", targets: [paidTarget] });
  expect(response.status).toBe(200);
  expect(loadConfig().combos?.mix).toMatchObject({
    displayName: "Current display name", allowMeteredTargets: true,
    targets: [{ ...paidTarget, metered: true }, { provider: "mock", model: "m" }],
  });
  expect(live.combos?.mix?.targets).toHaveLength(2);
});

test("create requires explicit consent for every channel", async () => {
  const live = seedPaidSuggestion();
  const draft = { id: "draft", mode: "create", targets: [paidTarget] };
  const response = await saveSuggestion(live, draft);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "suggestion_consent_required" });
  expect(loadConfig().combos?.draft).toBeUndefined();

  const current = loadConfig();
  setCanonicalForward(live);
  setCanonicalForward(current);
  saveConfig(current);
  const targets = [{ provider: "mock", model: "m" }, paidTarget];
  expect((await saveSuggestion(live, { ...draft, targets })).status).toBe(409);
  expect((await saveSuggestion(live, { ...draft, targets, allowMeteredTargets: true })).status).toBe(200);
  for (const config of [live, loadConfig()]) {
    expect(config.combos?.draft).toMatchObject({
      allowMeteredTargets: true,
      targets: targets.map(target => ({ ...target, metered: true })),
    });
  }
});

for (const paidSide of ["live", "persisted", "both"] as const) {
  test(`suggestion requires consent and marks the target metered when ${paidSide} config is paid`, async () => {
    const live = seedPaidSuggestion();
    const persisted = loadConfig();
    const freeProvider = { ...live.providers.paid!, adapter: "openai-responses" as const, baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const };
    const paidProvider = { ...freeProvider, baseUrl: "https://gateway.example/v1" };
    live.providers.paid = paidSide !== "persisted" ? paidProvider : freeProvider;
    persisted.providers.paid = paidSide !== "live" ? paidProvider : freeProvider;
    const subscription = { provider: "mock", model: "m" };
    const explicitlyMetered = { provider: "paid", model: "previous", metered: true };
    setCanonicalForward(live);
    setCanonicalForward(persisted);
    live.combos!.mix!.targets = [subscription, explicitlyMetered];
    persisted.combos!.mix!.targets = [subscription, explicitlyMetered];
    delete live.combos!.mix!.allowMeteredTargets;
    delete persisted.combos!.mix!.allowMeteredTargets;
    saveConfig(persisted);

    const configPath = join(home, "config.json");
    const beforeDisk = readFileSync(configPath, "utf8");
    const beforeLive = structuredClone(live.combos);
    const targets = [paidTarget];
    for (const request of [{ id: "draft", mode: "create", targets }, { id: "mix", mode: "append", targets }]) {
      const response = await saveSuggestion(live, request);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "suggestion_consent_required" });
      expect(readFileSync(configPath, "utf8")).toBe(beforeDisk);
      expect(live.combos).toEqual(beforeLive);
    }

    persisted.combos!.mix!.allowMeteredTargets = true;
    saveConfig(persisted);
    const response = await saveSuggestion(live, { id: "mix", mode: "append", targets });
    expect(response.status).toBe(200);
    for (const config of [live, loadConfig()]) {
      expect(config.combos?.mix?.targets).toEqual([subscription, explicitlyMetered, { ...paidTarget, metered: true }]);
    }
  });
}

test("append inserts a subscription before explicitly metered targets without reordering them", async () => {
  const live = seedPaidSuggestion();
  setCanonicalForward(live);
  const existing = [
    { provider: "mock", model: "first", metered: true },
    { provider: "mock", model: "second", metered: true },
  ];
  live.combos!.mix!.targets = existing;
  saveConfig(live);
  const target = { provider: "mock", model: "m" };
  const response = await saveSuggestion(live, { id: "mix", mode: "append", targets: [target] });
  expect(response.status).toBe(200);
  for (const config of [live, loadConfig()]) {
    expect(config.combos?.mix?.targets).toEqual([{ ...target, metered: true }, ...existing]);
  }
});

test.each(["create", "append"] as const)("Devin %s requires stored spend consent", async (mode) => {
  const live = seedPaidSuggestion();
  live.providers.devin = { adapter: "devin", authMode: "oauth", baseUrl: "https://server.codeium.com", models: ["gemini"] };
  delete live.combos!.mix!.allowMeteredTargets;
  saveConfig(live);
  const target = { provider: "devin", model: "gemini" };
  const request = { id: mode === "create" ? "draft" : "mix", mode, targets: [target] };
  const before = onDisk();
  const denied = await saveSuggestion(live, request);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({ code: "suggestion_consent_required" });
  expect(onDisk()).toEqual(before);
  expect(live.combos?.draft).toBeUndefined();
  expect(live.combos?.mix?.targets).toHaveLength(1);

  if (mode === "append") {
    live.combos!.mix!.allowMeteredTargets = true;
    saveConfig(live);
    expect((await saveSuggestion(live, request)).status).toBe(200);
    for (const config of [live, loadConfig()]) {
      expect(config.combos?.mix?.targets).toContainEqual({ ...target, metered: true });
    }
  }
});

test("append requires stored consent even for a canonical subscription and rejects request consent", async () => {
  const live = seedPaidSuggestion();
  setCanonicalForward(live);
  delete live.combos!.mix!.allowMeteredTargets;
  saveConfig(live);
  const before = onDisk();
  const request = { id: "mix", mode: "append", targets: [{ provider: "mock", model: "other" }] };
  expect((await saveSuggestion(live, { ...request, allowMeteredTargets: true })).status).toBe(400);
  const denied = await saveSuggestion(live, request);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({ code: "suggestion_consent_required" });
  expect(onDisk()).toEqual(before);
});
