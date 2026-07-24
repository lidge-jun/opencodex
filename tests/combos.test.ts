import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  resetComboEffortWarningStateForTests,
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
import { injectClaudeAgentDefs } from "../src/claude/agents-inject";

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
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "ocx-combos-"));
  process.env.OPENCODEX_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  try {
    return await run(dir);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
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

  afterEach(() => resetComboEffortWarningStateForTests());

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
    const concrete = concreteComboRequestBody(raw, target, "high", ["low", "high"]);
    expect(concrete).toEqual({
      model: "a/m1",
      input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    });
    expect(raw).toEqual({ model: "combo/free", input: [{ role: "user", content: "hi" }] });
    expect(concrete.input).not.toBe(raw.input);
  });

  test("combo default respects client-owned ignored reasoning values", () => {
    expect(concreteComboRequestBody({ model: "combo/x", reasoning: null }, target, "high", []).reasoning).toBeNull();
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { effort: "" } }, target, "high", [],
    ).reasoning).toEqual({ effort: "" });
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { effort: "banana" } }, target, "high", [],
    ).reasoning).toEqual({ effort: "banana" });
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { effort: null } }, target, "high", [],
    ).reasoning).toEqual({ effort: null });
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { summary: "concise" } }, target, "high", ["high"],
    ).reasoning).toEqual({ summary: "concise", effort: "high" });
  });

  test("omits combo defaults for unset, unsupported, and unknown target capabilities", () => {
    expect(concreteComboRequestBody({ model: "combo/x" }, target, null, ["high"]).reasoning).toBeUndefined();
    expect(concreteComboRequestBody({ model: "combo/x" }, target, "high", []).reasoning).toBeUndefined();
    expect(concreteComboRequestBody({ model: "combo/x" }, target, "high", undefined).reasoning).toBeUndefined();
    expect(concreteComboRequestBody({ model: "combo/x" }, target, "high", ["low", "medium"]).reasoning).toBeUndefined();
  });

  test("debug-warns once per unsupported combo default", () => {
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    concreteComboRequestBody({ model: "combo/x" }, target, "high", []);
    concreteComboRequestBody({ model: "combo/x" }, target, "high", []);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[1]).toEqual({
      provider: "a",
      model: "m1",
      requestedEffort: "high",
      capability: "unsupported",
    });
    debug.mockRestore();
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

  test("advancement preserves an explicit payload-eligibility filter", () => {
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
    const next = advanceComboAfterFailure(config, first, {
      now: 1_000,
      eligible: target => target.provider === "c",
    });
    expect(next?.target.provider).toBe("c");
    expect(next?.attempted).toEqual(["a/m1", "c/m3"]);
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

  test("routes a concrete combo target without re-entering its shadowing alias", () => {
    const config = baseConfig({
      combos: {
        free: {
          alias: "a/m1",
          targets: [{ provider: "a", model: "m1" }],
        },
      },
    });

    expect(routeModel(config, "a/m1")).toMatchObject({
      providerName: "a",
      modelId: "m1",
      combo: { comboId: "free", target: { provider: "a", model: "m1" } },
    });
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
    expect(normalizeComboConfig({ targets: [{ provider: "a", model: "m1" }] }).defaultEffort).toBeNull();
    expect(comboDefaultEffort(baseConfig(), "free")).toBeNull();
    const aliased = baseConfig({
      combos: { free: { ...VALID_COMBO, alias: "  deepseek-v4-flash  " } },
    });
    expect(getCombo(aliased, "free")?.alias).toBe("deepseek-v4-flash");
    expect(comboPublicModelId("free", getCombo(aliased, "free")!)).toBe("deepseek-v4-flash");
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
