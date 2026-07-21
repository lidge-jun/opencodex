import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceComboAfterFailure,
  clearComboSelectionState,
  clearComboTargetCooldowns,
  comboAliasIssues,
  comboConfigError,
  comboConfigIssues,
  comboDefaultEffort,
  comboFailureDecision,
  comboIdFromRawBody,
  comboModelId,
  comboPublicModelId,
  concreteComboRequestBody,
  coolComboTarget,
  getCombo,
  isComboTargetInCooldown,
  isValidComboId,
  listComboIds,
  NoAvailableComboTargetsError,
  noteComboSuccess,
  noteComboFailure,
  normalizeComboConfig,
  parseComboModelId,
  parseRetryAfterMs,
  pickComboTarget,
  resolveComboId,
  targetKey,
  tryPickComboModel,
  UnknownComboError,
} from "../src/combos";
import { getConfigPath, readConfigDiagnostics, saveConfig } from "../src/config";
import { routeModel } from "../src/router";
import { handleManagementAPI } from "../src/server/management-api";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { syncCatalogModels } from "../src/codex/catalog";

const VALID_COMBO = { targets: [{ provider: "a", model: "m1" }] };

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
      c: { adapter: "openai-chat", baseUrl: "https://c.example/v1", apiKey: "kc", models: ["m3"] },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
    ...overrides,
  };
}

function rrConfig(stickyLimit: number, weights: number[]): OcxConfig {
  const providers = baseConfig().providers;
  const names = ["a", "b", "c"];
  return baseConfig({
    providers,
    combos: {
      free: {
        strategy: "round-robin",
        stickyLimit,
        targets: weights.map((weight, index) => ({
          provider: names[index]!,
          model: `m${index + 1}`,
          weight,
        })),
      },
    },
  });
}

function successfulPicks(config: OcxConfig, count: number): string[] {
  const combo = getCombo(config, "free")!;
  return Array.from({ length: count }, () => {
    const pick = pickComboTarget(config, "free")!;
    noteComboSuccess("free", combo, pick.target);
    return targetKey(pick.target);
  });
}

async function withTempHome<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
  const previousHome = process.env.OPENCODEX_HOME;
  const dir = mkdtempSync(join(tmpdir(), "ocx-combos-"));
  process.env.OPENCODEX_HOME = dir;
  try {
    return await run(dir);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRawConfig(config: unknown): void {
  writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
}

async function comboApi(
  config: OcxConfig,
  method: string,
  path: string,
  body?: unknown,
  refreshCodexCatalog: () => Promise<void> = async () => {},
): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    refreshCodexCatalog,
  });
}

async function comboApiRaw(config: OcxConfig, method: string, path: string, body: string): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body,
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    refreshCodexCatalog: async () => {},
  });
}

async function responseJson(response: Response | null): Promise<Record<string, unknown>> {
  expect(response).not.toBeNull();
  return response!.json() as Promise<Record<string, unknown>>;
}

afterEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
});

describe("combo namespace primitives", () => {
  test("parses and formats combo model ids", () => {
    expect(parseComboModelId("combo/free")).toBe("free");
    expect(parseComboModelId("combo/  free  ")).toBe("  free  ");
    expect(parseComboModelId("combo/")).toBeNull();
    expect(parseComboModelId("nvidia/free")).toBeNull();
    expect(comboModelId("free")).toBe("combo/free");
  });

  test("checks source combo ids and target keys", () => {
    expect(isValidComboId("free.v1_2-x")).toBe(true);
    expect(isValidComboId("-free")).toBe(false);
    expect(targetKey({ provider: "a", model: "m1" })).toBe("a/m1");
  });

  test("resolves canonical ids before exact aliases and ignores unknown bare ids", () => {
    const config = baseConfig({
      combos: {
        free: { ...VALID_COMBO, alias: "combo/other" },
        other: { targets: [{ provider: "b", model: "m2" }], alias: "vendor/flash" },
      },
    });
    expect(resolveComboId(config, "combo/other")).toBe("other");
    expect(resolveComboId(config, "vendor/flash")).toBe("other");
    expect(resolveComboId(config, "unknown-bare")).toBeNull();
    expect(tryPickComboModel(config, "vendor/flash")?.comboId).toBe("other");
    expect(tryPickComboModel(config, "unknown-bare")).toBeNull();
    expect(() => tryPickComboModel(config, "combo/missing")).toThrow(UnknownComboError);
  });
});

describe("combo request cloning", () => {
  const target = { provider: "a", model: "m1" };

  test("detects canonical and alias combo model ids in raw request records", () => {
    const config = baseConfig({ combos: { free: { ...VALID_COMBO, alias: "deepseek-v4-flash" } } });
    expect(comboIdFromRawBody({ model: "combo/free" }, config)).toBe("free");
    expect(comboIdFromRawBody({ model: "deepseek-v4-flash" }, config)).toBe("free");
    expect(comboIdFromRawBody({ model: "a/m1" }, config)).toBeNull();
    expect(comboIdFromRawBody({ model: 1 }, config)).toBeNull();
    expect(comboIdFromRawBody(null, config)).toBeNull();
  });

  test("clones the untouched body and injects an omitted combo default", () => {
    const raw = { model: "combo/free", input: [{ role: "user", content: "hi" }] };
    const concrete = concreteComboRequestBody(raw, target, "high");
    expect(concrete).toEqual({
      model: "a/m1",
      input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    });
    expect(raw).toEqual({ model: "combo/free", input: [{ role: "user", content: "hi" }] });
    expect(concrete.input).not.toBe(raw.input);
  });

  test("combo default respects client-owned ignored reasoning values", () => {
    expect(concreteComboRequestBody({ model: "combo/x", reasoning: null }, target, "high").reasoning).toBeNull();
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { effort: "" } }, target, "high",
    ).reasoning).toEqual({ effort: "" });
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { effort: "banana" } }, target, "high",
    ).reasoning).toEqual({ effort: "banana" });
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { effort: null } }, target, "high",
    ).reasoning).toEqual({ effort: null });
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { summary: "concise" } }, target, "high",
    ).reasoning).toEqual({ summary: "concise", effort: "high" });
  });
});

describe("combo target cooldowns", () => {
  const target = { provider: "a", model: "m1" };

  test("parses numeric and date Retry-After values with exact bounds", () => {
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    expect(parseRetryAfterMs("0.001", now)).toBe(1);
    expect(parseRetryAfterMs("120", now)).toBe(120_000);
    expect(parseRetryAfterMs("999999", now)).toBe(600_000);
    expect(parseRetryAfterMs(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(parseRetryAfterMs(new Date(now + 900_000).toUTCString(), now)).toBe(600_000);
  });

  test("rejects missing malformed zero and expired Retry-After values", () => {
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
    expect(parseRetryAfterMs("", now)).toBeUndefined();
    expect(parseRetryAfterMs("0", now)).toBeUndefined();
    expect(parseRetryAfterMs("not-a-date", now)).toBeUndefined();
    expect(parseRetryAfterMs(new Date(now - 1_000).toUTCString(), now)).toBeUndefined();
  });

  test("expires cooldowns and clears only the requested combo", () => {
    coolComboTarget("free", target, { now: 1_000, cooldownMs: 100 });
    coolComboTarget("other", target, { now: 1_000, cooldownMs: 100 });
    expect(isComboTargetInCooldown("free", target, 1_099)).toBe(true);
    expect(isComboTargetInCooldown("free", target, 1_100)).toBe(false);
    expect(isComboTargetInCooldown("other", target, 1_050)).toBe(true);
    clearComboTargetCooldowns("other");
    expect(isComboTargetInCooldown("other", target, 1_050)).toBe(false);
  });
});

describe("combo failure policy and advancement", () => {
  test("hops only retryable provider-local failures", () => {
    for (const status of [401, 403, 404, 408, 429, 500, 503]) {
      expect(comboFailureDecision(status, "provider failure")).toBe("hop");
    }
    expect(comboFailureDecision(400, "context_length_exceeded")).toBe("stop");
    expect(comboFailureDecision(403, '{"code":"origin_rejected"}')).toBe("stop");
    expect(comboFailureDecision(413, "request too large")).toBe("stop");
    expect(comboFailureDecision(409, "conflict")).toBe("stop");
    expect(comboFailureDecision(499, "client cancelled")).toBe("stop");
    expect(comboFailureDecision(422, "invalid_api_key")).toBe("hop");
  });

  test("failure clears the active sticky target without adding a success", () => {
    const config = rrConfig(2, [1, 1]);
    const combo = getCombo(config, "free")!;
    const first = pickComboTarget(config, "free")!;
    noteComboSuccess("free", combo, first.target);
    noteComboFailure("free", first.target);
    expect(pickComboTarget(config, "free")?.target.provider).toBe("b");
  });

  test("advancement preserves attempted order and attempts each target once", () => {
    const config = baseConfig({
      combos: {
        free: {
          targets: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
            { provider: "c", model: "m3" },
          ],
        },
      },
    });
    const first = pickComboTarget(config, "free")!;
    const second = advanceComboAfterFailure(config, first, { now: 1_000 })!;
    const third = advanceComboAfterFailure(config, second, { now: 1_000 })!;
    const exhausted = advanceComboAfterFailure(config, third, { now: 1_000 });
    expect(first.attempted).toEqual(["a/m1"]);
    expect(second.attempted).toEqual(["a/m1", "b/m2"]);
    expect(third.attempted).toEqual(["a/m1", "b/m2", "c/m3"]);
    expect(exhausted).toBeNull();
  });
});

describe("deterministic combo selection", () => {
  test("equal-weight RR rotates exactly", () => {
    const config = rrConfig(1, [1, 1, 1]);
    expect(successfulPicks(config, 6)).toEqual([
      "a/m1", "b/m2", "c/m3", "a/m1", "b/m2", "c/m3",
    ]);
  });

  test("smooth weights and sticky successes have a deterministic sequence", () => {
    const config = rrConfig(2, [2, 1]);
    expect(successfulPicks(config, 12)).toEqual([
      "a/m1", "a/m1", "b/m2", "b/m2", "a/m1", "a/m1",
      "a/m1", "a/m1", "b/m2", "b/m2", "a/m1", "a/m1",
    ]);
  });

  test("repeated picks and production routing remain pinned without success", () => {
    const config = rrConfig(1, [1, 1]);
    expect(pickComboTarget(config, "free")?.target.provider).toBe("a");
    expect(pickComboTarget(config, "free")?.target.provider).toBe("a");
    expect(routeModel(config, "combo/free").providerName).toBe("a");
    expect(routeModel(config, "combo/free").providerName).toBe("a");
  });

  test("eligibility, exclusions, and state reset are deterministic", () => {
    const config = rrConfig(1, [1, 1]);
    expect(pickComboTarget(config, "free", { exclude: ["a/m1"] })?.target.provider).toBe("b");
    clearComboSelectionState("free");
    expect(pickComboTarget(config, "free", { eligible: target => target.provider !== "a" })?.target.provider).toBe("b");
    clearComboSelectionState("free");
    expect(pickComboTarget(config, "free")?.target.provider).toBe("a");
  });

  test("disabled members are skipped and an all-disabled combo fails closed", () => {
    const config = baseConfig();
    config.providers.a!.disabled = true;
    expect(pickComboTarget(config, "free")?.target.provider).toBe("b");
    config.providers.b!.disabled = true;
    expect(() => tryPickComboModel(config, "combo/free")).toThrow(NoAvailableComboTargetsError);
    expect(() => routeModel(config, "combo/free")).toThrow(NoAvailableComboTargetsError);
  });

  test("missing members are skipped after unsupported in-memory corruption", () => {
    const config = baseConfig();
    delete config.providers.a;
    expect(pickComboTarget(config, "free")?.target.provider).toBe("b");
  });
});

describe("combo validation and normalization", () => {
  test("validates alias shape, namespace, native families, and uniqueness", () => {
    const combos = {
      free: { ...VALID_COMBO, alias: "deepseek-v4-flash" },
      routed: { ...VALID_COMBO, alias: "vendor/fast" },
    };
    expect(comboAliasIssues("new", "plain-model", combos)).toEqual([]);
    expect(comboAliasIssues("new", "vendor/model", combos)).toEqual([]);
    expect(comboAliasIssues("new", "combo/model", combos)[0]?.message).toContain("reserved");
    expect(comboAliasIssues("new", "gpt-5", combos)[0]?.message).toContain("OpenAI native family");
    expect(comboAliasIssues("new", "deepseek-v4-flash", combos)[0]?.message).toContain("already used");
    expect(comboAliasIssues("renamed", "deepseek-v4-flash", combos, {
      excludeComboId: "free",
    })).toEqual([]);
  });

  test("reports every validation row with a stable path and message", () => {
    const providers = baseConfig().providers;
    const cases: Array<{
      id?: string;
      raw: unknown;
      providers?: OcxConfig["providers"];
      options?: { requireEnabledTarget?: boolean };
      path: Array<string | number>;
      message: string;
    }> = [
      { id: "-bad", raw: VALID_COMBO, path: [], message: "combo id" },
      { raw: VALID_COMBO, providers: { combo: providers.a! }, path: [], message: 'reserved "combo/" namespace' },
      { id: "a", raw: VALID_COMBO, path: [], message: 'combo id "a" collides' },
      { raw: null, path: [], message: "combo must be an object" },
      { raw: { ...VALID_COMBO, strategy: "random" }, path: ["strategy"], message: "failover" },
      { raw: { ...VALID_COMBO, stickyLimit: 1.5 }, path: ["stickyLimit"], message: "integer from 1 to 100" },
      { raw: { ...VALID_COMBO, defaultEffort: "turbo" }, path: ["defaultEffort"], message: "low, medium, high" },
      { raw: { targets: [] }, path: ["targets"], message: "non-empty array" },
      { raw: { targets: [null] }, path: ["targets", 0], message: "must be an object" },
      { raw: { targets: [{ provider: " ", model: "m1" }] }, path: ["targets", 0, "provider"], message: "is required" },
      { raw: { targets: [{ provider: "missing", model: "m1" }] }, path: ["targets", 0, "provider"], message: "not configured" },
      { raw: { targets: [{ provider: "a", model: " " }] }, path: ["targets", 0, "model"], message: "is required" },
      {
        raw: VALID_COMBO,
        providers: { a: { ...providers.a!, disabled: true } },
        options: { requireEnabledTarget: true },
        path: ["targets"],
        message: "at least one enabled provider",
      },
      { raw: { targets: [{ provider: "a", model: "m1", weight: 1.5 }] }, path: ["targets", 0, "weight"], message: "integer from 1 to 10000" },
      {
        raw: { targets: [{ provider: " a ", model: " m1 " }, { provider: "a", model: "m1" }] },
        path: ["targets", 1],
        message: 'duplicate combo target "a/m1"',
      },
    ];

    for (const row of cases) {
      const issue = comboConfigIssues(
        row.id ?? "free",
        row.raw,
        row.providers ?? providers,
        row.options,
      ).find(candidate => candidate.path.join(".") === row.path.join("."));
      expect(issue?.path).toEqual(row.path);
      expect(issue?.message).toContain(row.message);
    }
  });

  test("rejects every non-integer or out-of-range numeric edge without healing", () => {
    const providers = baseConfig().providers;
    for (const stickyLimit of [0, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(comboConfigIssues("free", { ...VALID_COMBO, stickyLimit }, providers)[0]).toMatchObject({
        path: ["stickyLimit"],
      });
    }
    for (const weight of [0, 1.5, 10_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(comboConfigIssues("free", {
        targets: [{ provider: "a", model: "m1", weight }],
      }, providers)[0]).toMatchObject({ path: ["targets", 0, "weight"] });
    }
  });

  test("normalizes valid values and returns defensive default efforts", () => {
    expect(normalizeComboConfig({
      defaultEffort: "high",
      targets: [{ provider: " a ", model: " m1 ", weight: 2 }],
    })).toEqual({
      strategy: "failover",
      stickyLimit: 1,
      defaultEffort: "high",
      alias: null,
      targets: [{ provider: "a", model: "m1", weight: 2 }],
    });
    const aliased = baseConfig({
      combos: { free: { ...VALID_COMBO, alias: "  deepseek-v4-flash  " } },
    });
    expect(getCombo(aliased, "free")?.alias).toBe("deepseek-v4-flash");
    expect(comboPublicModelId("free", getCombo(aliased, "free")!)).toBe("deepseek-v4-flash");
    expect(comboDefaultEffort(baseConfig(), "free")).toBe("medium");
    expect(comboDefaultEffort(baseConfig({
      combos: { free: { defaultEffort: "xhigh", targets: [{ provider: "a", model: "m1" }] } },
    }), "free")).toBe("xhigh");
    const corrupt = baseConfig() as OcxConfig & { combos: Record<string, { defaultEffort: string; targets: [] }> };
    corrupt.combos.free!.defaultEffort = "turbo";
    expect(comboDefaultEffort(corrupt, "free")).toBeNull();
  });

  test("inherited combo names are unknown across getters, effort, and routing", () => {
    const config = baseConfig();
    for (const id of ["constructor", "toString"]) {
      expect(getCombo(config, id)).toBeUndefined();
      expect(comboDefaultEffort(config, id)).toBeNull();
      expect(() => tryPickComboModel(config, `combo/${id}`)).toThrow(UnknownComboError);
    }
    expect(() => tryPickComboModel(config, "combo/ free ")).toThrow(UnknownComboError);
  });

  test("preserves a physical provider named combo while no combos are configured", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "combo",
      providers: {
        combo: { adapter: "openai-chat", baseUrl: "https://combo.example/v1" },
      },
    };
    expect(routeModel(config, "combo/model")).toMatchObject({
      providerName: "combo",
      modelId: "model",
    });
    expect(comboConfigError("free", VALID_COMBO, config.providers)).toContain("reserved");
  });
});

describe("persisted combo config parity", () => {
  test("reports malformed maps and exact domain messages for policy-independent rows", async () => {
    await withTempHome(() => {
      const providers = baseConfig().providers;
      const root = { port: 10100, defaultProvider: "a", providers };
      writeRawConfig({ ...root, combos: [] });
      expect(readConfigDiagnostics()).toMatchObject({
        source: "fallback",
        error: expect.stringContaining("combos must be an object"),
      });

      const rows: Array<{ id: string; combo: unknown; providers?: OcxConfig["providers"] }> = [
        { id: "free", combo: { ...VALID_COMBO, strategy: "random" } },
        { id: "free", combo: { ...VALID_COMBO, stickyLimit: 0 } },
        { id: "free", combo: { ...VALID_COMBO, defaultEffort: "turbo" } },
        { id: "free", combo: { targets: [] } },
        { id: "free", combo: { targets: [{ provider: "missing", model: "m1" }] } },
        { id: "free", combo: { targets: [{ provider: "a", model: " " }] } },
        { id: "free", combo: { targets: [{ provider: "a", model: "m1", weight: 1.5 }] } },
        { id: "free", combo: { targets: [{ provider: " a ", model: " m1 " }, { provider: "a", model: "m1" }] } },
        { id: "free", combo: VALID_COMBO, providers: { combo: providers.a! } },
        { id: "a", combo: VALID_COMBO },
      ];
      for (const row of rows) {
        const rowProviders = row.providers ?? providers;
        const expected = comboConfigError(row.id, row.combo, rowProviders)!;
        writeRawConfig({
          port: 10100,
          defaultProvider: Object.keys(rowProviders)[0],
          providers: rowProviders,
          combos: { [row.id]: row.combo },
        });
        const diagnostics = readConfigDiagnostics();
        expect(diagnostics.source).toBe("fallback");
        expect(diagnostics.error).toContain(expected);
      }
    });
  });

  test("rejects duplicate aliases across persisted combos at load time", async () => {
    await withTempHome(() => {
      const providers = baseConfig().providers;
      writeRawConfig({
        port: 10100,
        defaultProvider: "a",
        providers,
        combos: {
          free: { ...VALID_COMBO, alias: "deepseek-v4-flash" },
          spare: { ...VALID_COMBO, alias: "deepseek-v4-flash" },
        },
      });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("already used by combo");
    });
  });

  test("loads one-disabled and all-disabled combos without mutating normalized values", async () => {
    await withTempHome(() => {
      const config = baseConfig({
        providers: {
          ...baseConfig().providers,
          a: { ...baseConfig().providers.a!, disabled: true },
        },
        combos: {
          free: {
            strategy: "round-robin",
            stickyLimit: 3,
            defaultEffort: "high",
            targets: [{ provider: "a", model: "m1", weight: 2 }, { provider: "b", model: "m2" }],
          },
        },
      });
      writeRawConfig(config);
      expect(readConfigDiagnostics()).toMatchObject({
        source: "file",
        error: null,
        config: { combos: config.combos },
      });

      config.providers.b!.disabled = true;
      writeRawConfig(config);
      const allDisabled = readConfigDiagnostics();
      expect(allDisabled.source).toBe("file");
      expect(allDisabled.error).toBeNull();
      expect(allDisabled.config.combos).toEqual(config.combos);
      expect(comboConfigError("free", config.combos!.free, config.providers, {
        requireEnabledTarget: true,
      })).toContain("at least one enabled");
    });
  });
});

describe("combo management API", () => {
  test("PUT and DELETE clear only the mutated combo cooldowns", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        combos: {
          free: VALID_COMBO,
          other: { targets: [{ provider: "b", model: "m2" }] },
        },
      });
      saveConfig(config);
      const freeTarget = { provider: "a", model: "m1" };
      const otherTarget = { provider: "b", model: "m2" };

      coolComboTarget("free", freeTarget, { cooldownMs: 60_000 });
      coolComboTarget("other", otherTarget, { cooldownMs: 60_000 });
      expect(isComboTargetInCooldown("free", freeTarget)).toBe(true);
      expect((await comboApi(config, "PUT", "/api/combos", {
        id: "free",
        combo: VALID_COMBO,
      }))?.status).toBe(200);
      expect(isComboTargetInCooldown("free", freeTarget)).toBe(false);
      expect(isComboTargetInCooldown("other", otherTarget)).toBe(true);

      coolComboTarget("free", freeTarget, { cooldownMs: 60_000 });
      expect((await comboApi(config, "DELETE", "/api/combos?id=free"))?.status).toBe(200);
      expect(isComboTargetInCooldown("free", freeTarget)).toBe(false);
      expect(isComboTargetInCooldown("other", otherTarget)).toBe(true);
    });
  });

  test("GET is sorted and PUT upserts normalized whole values", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const created = await comboApi(config, "PUT", "/api/combos", {
        id: "zeta",
        combo: { targets: [{ provider: " a ", model: " m1 " }] },
      });
      expect(created?.status).toBe(200);
      expect(await responseJson(created)).toMatchObject({
        success: true,
        id: "zeta",
        model: "combo/zeta",
        combo: { strategy: "failover", stickyLimit: 1, defaultEffort: "medium" },
      });
      const updated = await comboApi(config, "PUT", "/api/combos", {
        id: "zeta",
        combo: { strategy: "round-robin", stickyLimit: 2, defaultEffort: "high", targets: [{ provider: "b", model: "m2", weight: 3 }] },
      });
      expect((await responseJson(updated)).combo).toMatchObject({ strategy: "round-robin", stickyLimit: 2, defaultEffort: "high" });
      await comboApi(config, "PUT", "/api/combos", {
        id: "alpha",
        combo: { targets: [{ provider: "a", model: "m1" }] },
      });
      const listed = await responseJson(await comboApi(config, "GET", "/api/combos"));
      expect((listed.combos as Array<{ id: string }>).map(row => row.id)).toEqual(["alpha", "zeta"]);
      expect(listComboIds(config)).toEqual(["alpha", "zeta"]);
    });
  });

  test("PUT stores aliases and GET exposes the public model", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "flash",
        combo: { ...VALID_COMBO, alias: "  deepseek-v4-flash  " },
      });
      expect(response?.status).toBe(200);
      expect(await responseJson(response)).toMatchObject({
        id: "flash",
        model: "deepseek-v4-flash",
        combo: { alias: "deepseek-v4-flash" },
      });
      expect(config.combos?.flash?.alias).toBe("deepseek-v4-flash");
      const listed = await responseJson(await comboApi(config, "GET", "/api/combos"));
      expect(listed.combos).toEqual([expect.objectContaining({
        id: "flash",
        model: "deepseek-v4-flash",
        alias: "deepseek-v4-flash",
      })]);
    });
  });

  test("PUT rejects invalid and duplicate aliases without memory or disk mutation", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        combos: { free: { ...VALID_COMBO, alias: "deepseek-v4-flash" } },
      });
      saveConfig(config);
      for (const alias of ["combo/shadow", "gpt-5", "deepseek-v4-flash"]) {
        const beforeMemory = structuredClone(config);
        const beforeDisk = readFileSync(getConfigPath(), "utf8");
        const response = await comboApi(config, "PUT", "/api/combos", {
          id: "other",
          combo: { ...VALID_COMBO, alias },
        });
        expect(response?.status).toBe(400);
        expect(config).toEqual(beforeMemory);
        expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
      }
    });
  });

  test("PUT renames atomically, migrates public references, and clears both ids", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        disabledModels: ["before", "combo/old", "middle", "old-public", "after"],
        subagentModels: ["combo/old", "another", "old-public"],
        combos: {
          old: {
            strategy: "round-robin",
            stickyLimit: 2,
            alias: "old-public",
            targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
          },
        },
      });
      saveConfig(config);
      const oldCombo = getCombo(config, "old")!;
      const oldPick = pickComboTarget(config, "old")!;
      noteComboSuccess("old", oldCombo, oldPick.target);
      config.combos!.new = {
        strategy: "round-robin",
        stickyLimit: 2,
        targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      };
      const staleNewCombo = getCombo(config, "new")!;
      const staleNewPick = pickComboTarget(config, "new")!;
      noteComboSuccess("new", staleNewCombo, staleNewPick.target);
      delete config.combos!.new;
      coolComboTarget("old", { provider: "a", model: "m1" }, { cooldownMs: 60_000 });
      coolComboTarget("new", { provider: "b", model: "m2" }, { cooldownMs: 60_000 });

      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "new",
        renameFrom: "old",
        combo: {
          strategy: "round-robin",
          stickyLimit: 2,
          alias: "new-public",
          targets: [{ provider: "b", model: "m2" }, { provider: "a", model: "m1" }],
        },
      });
      expect(response?.status).toBe(200);
      expect(await responseJson(response)).toMatchObject({ id: "new", model: "new-public" });
      expect(config.combos?.old).toBeUndefined();
      expect(config.combos?.new?.alias).toBe("new-public");
      expect(config.disabledModels).toEqual(["before", "new-public", "middle", "after"]);
      expect(config.subagentModels).toEqual(["new-public", "another"]);
      expect(isComboTargetInCooldown("old", { provider: "a", model: "m1" })).toBe(false);
      expect(isComboTargetInCooldown("new", { provider: "b", model: "m2" })).toBe(false);
      expect(pickComboTarget(config, "new")?.target.provider).toBe("b");
      config.combos!.old = config.combos!.new!;
      expect(pickComboTarget(config, "old")?.target.provider).toBe("b");
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(persisted.combos?.old).toBeUndefined();
      expect(persisted.combos?.new?.alias).toBe("new-public");
      expect(persisted.disabledModels).toEqual(["before", "new-public", "middle", "after"]);
      expect(persisted.subagentModels).toEqual(["new-public", "another"]);
    });
  });

  test("PUT rename rejects missing sources and existing destinations without mutation", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        combos: {
          free: VALID_COMBO,
          other: { targets: [{ provider: "b", model: "m2" }] },
        },
      });
      saveConfig(config);
      for (const request of [
        { id: "new", renameFrom: "missing", combo: VALID_COMBO },
        { id: "other", renameFrom: "free", combo: VALID_COMBO },
      ]) {
        const beforeMemory = structuredClone(config);
        const beforeDisk = readFileSync(getConfigPath(), "utf8");
        const response = await comboApi(config, "PUT", "/api/combos", request);
        expect(response?.status).toBe(400);
        expect(config).toEqual(beforeMemory);
        expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
      }
    });
  });

  test("PUT alias changes migrate public references without renaming", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        disabledModels: ["combo/free"],
        subagentModels: ["combo/free"],
      });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "free",
        combo: { ...VALID_COMBO, alias: "free-public" },
      });
      expect(response?.status).toBe(200);
      expect(config.disabledModels).toEqual(["free-public"]);
      expect(config.subagentModels).toEqual(["free-public"]);
    });
  });

  test("PUT clearing an alias deduplicates migrated references in stable order", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        disabledModels: ["before", "old-public", "combo/free", "after", "old-public"],
        subagentModels: ["old-public", "another", "combo/free"],
        combos: { free: { ...VALID_COMBO, alias: "old-public" } },
      });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "free",
        combo: VALID_COMBO,
      });
      expect(response?.status).toBe(200);
      expect(config.disabledModels).toEqual(["before", "combo/free", "after"]);
      expect(config.subagentModels).toEqual(["combo/free", "another"]);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(persisted.disabledModels).toEqual(["before", "combo/free", "after"]);
      expect(persisted.subagentModels).toEqual(["combo/free", "another"]);
    });
  });

  test("PUT rejects malformed JSON, non-record roots, and non-string ids without mutation", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const before = readFileSync(getConfigPath(), "utf8");
      const malformed = await comboApiRaw(config, "PUT", "/api/combos", "{");
      expect(malformed?.status).toBe(400);
      expect(await responseJson(malformed)).toMatchObject({ error: "invalid JSON body" });
      for (const root of [null, [], "text", 3, true]) {
        const response = await comboApi(config, "PUT", "/api/combos", root);
        expect(response?.status).toBe(400);
        expect(await responseJson(response)).toMatchObject({ error: "request body must be an object" });
      }
      for (const id of [{}, [], 3]) {
        const response = await comboApi(config, "PUT", "/api/combos", { id, combo: VALID_COMBO });
        expect(response?.status).toBe(400);
        expect(await responseJson(response)).toMatchObject({ error: "id is required and must be a string" });
      }
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(config.combos).toEqual(baseConfig().combos);
    });
  });

  test("POST and PATCH cannot create or update combos", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const before = readFileSync(getConfigPath(), "utf8");
      for (const method of ["POST", "PATCH"]) {
        expect(await comboApi(config, method, "/api/combos", { id: "new", combo: VALID_COMBO })).toBeNull();
      }
      expect(config.combos).toEqual(baseConfig().combos);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    });
  });

  test("invalid PUT and all-disabled PUT leave config and disk unchanged", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        providers: {
          ...baseConfig().providers,
          a: { ...baseConfig().providers.a!, disabled: true },
        },
      });
      saveConfig(config);
      for (const combo of [
        { targets: [{ provider: "missing", model: "m" }] },
        { targets: [{ provider: "a", model: "m1" }] },
      ]) {
        const before = readFileSync(getConfigPath(), "utf8");
        const response = await comboApi(config, "PUT", "/api/combos", { id: "denied", combo });
        expect(response?.status).toBe(400);
        expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
        expect(config.combos?.denied).toBeUndefined();
      }
      const mixed = await comboApi(config, "PUT", "/api/combos", {
        id: "mixed",
        combo: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
      });
      expect(mixed?.status).toBe(200);
    });
  });

  test("DELETE is own-property safe and removes the final combo map", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      for (const id of ["missing", "constructor", "toString"]) {
        const response = await comboApi(config, "DELETE", `/api/combos?id=${id}`);
        expect(response?.status).toBe(404);
      }
      const deleted = await comboApi(config, "DELETE", "/api/combos?id=free");
      expect(deleted?.status).toBe(200);
      expect(config.combos).toBeUndefined();
      expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).combos).toBeUndefined();
    });
  });

  test("DELETE refresh immediately retires the final managed combo catalog row", async () => {
    await withTempHome(async dir => {
      const previousCodexHome = process.env.CODEX_HOME;
      const codexHome = join(dir, "codex-home");
      mkdirSync(codexHome, { recursive: true });
      process.env.CODEX_HOME = codexHome;
      const catalogPath = join(codexHome, "opencodex-catalog.json");
      writeFileSync(catalogPath, JSON.stringify({
        models: [{
          slug: "combo/free",
          display_name: "combo/free",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "low" }],
          input_modalities: ["text"],
          context_window: 128_000,
        }],
      }));
      try {
        const config = baseConfig({
          providers: {
            a: {
              adapter: "openai-chat",
              baseUrl: "https://a.example/v1",
              apiKey: "ka",
              liveModels: false,
              models: ["m1"],
              modelContextWindows: { m1: 128_000 },
            },
          },
          combos: { free: VALID_COMBO },
        });
        saveConfig(config);
        const deleted = await comboApi(
          config,
          "DELETE",
          "/api/combos?id=free",
          undefined,
          async () => { await syncCatalogModels(config); },
        );
        expect(deleted?.status).toBe(200);
        const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
          models: Array<{ slug?: string }>;
        };
        expect(catalog.models.some(model => model.slug === "combo/free")).toBe(false);
      } finally {
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
      }
    });
  });

  test("provider deletion is guarded by sorted combo dependencies until cleanup", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        defaultProvider: "c",
        combos: {
          zeta: { targets: [{ provider: "a", model: "m1" }] },
          alpha: { targets: [{ provider: "a", model: "m1" }] },
        },
      });
      saveConfig(config);
      const before = readFileSync(getConfigPath(), "utf8");
      const blocked = await comboApi(config, "DELETE", "/api/providers?name=a");
      expect(blocked?.status).toBe(409);
      expect(await responseJson(blocked)).toMatchObject({ combos: ["alpha", "zeta"] });
      expect(config.providers.a).toBeDefined();
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);

      await comboApi(config, "DELETE", "/api/combos?id=alpha");
      await comboApi(config, "DELETE", "/api/combos?id=zeta");
      const deleted = await comboApi(config, "DELETE", "/api/providers?name=a");
      expect(deleted?.status).toBe(200);
      expect(config.providers.a).toBeUndefined();
    });
  });
});

describe("supported disabled-provider activation", () => {
  test("PATCH skips one disabled member, persists all-disabled state, and responses fail with the typed 503 envelope", async () => {
    await withTempHome(async () => {
      let bHits = 0;
      let cHits = 0;
      const upstreamB = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          bHits += 1;
          return Response.json({
            id: "chatcmpl-combo",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "from b" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        },
      });
      const upstreamC = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          cHits += 1;
          return Response.json({ error: { message: "default provider must not be reached" } }, { status: 500 });
        },
      });
      try {
        const config = baseConfig({
          defaultProvider: "c",
          providers: {
            a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka" },
            b: {
              adapter: "openai-chat",
              baseUrl: `${upstreamB.url.toString().replace(/\/$/, "")}/v1`,
              allowPrivateNetwork: true,
              apiKey: "kb",
            },
            c: {
              adapter: "openai-chat",
              baseUrl: `${upstreamC.url.toString().replace(/\/$/, "")}/v1`,
              allowPrivateNetwork: true,
              apiKey: "kc",
            },
          },
          combos: undefined,
        });
        saveConfig(config);
        expect((await comboApi(config, "PUT", "/api/combos", {
          id: "free",
          combo: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
        }))?.status).toBe(200);
        expect((await comboApi(config, "PATCH", "/api/providers?name=a", { disabled: true }))?.status).toBe(200);
        expect(routeModel(config, "combo/free").providerName).toBe("b");

        const routed = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
        }), config, { model: "", provider: "" });
        expect(routed.status).toBe(200);
        expect(bHits).toBe(1);
        expect(cHits).toBe(0);

        expect((await comboApi(config, "PATCH", "/api/providers?name=b", { disabled: true }))?.status).toBe(200);
        const diagnostics = readConfigDiagnostics();
        expect(diagnostics.source).toBe("file");
        expect(diagnostics.error).toBeNull();
        expect(diagnostics.config.combos?.free).toBeDefined();

        const unavailable = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
        }), diagnostics.config, { model: "", provider: "" });
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toMatchObject({
          error: { code: "combo_unavailable", type: "server_error" },
        });
        expect(bHits).toBe(1);
        expect(cHits).toBe(0);
      } finally {
        await upstreamB.stop(true);
        await upstreamC.stop(true);
      }
    });
  }, 10_000);
});
