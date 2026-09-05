import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceComboAfterFailure,
  clearComboSelectionState,
  clearComboTargetCooldowns,
  earliestComboCooldownExpiry,
  pickComboTargetWithWait,
  comboAliasIssues,
  comboConfigError,
  comboConfigIssues,
  comboDefaultEffort,
  comboDisabledModelId,
  comboDisabledModelSelectors,
  comboIdFromRawBody,
  comboModelId,
  comboPublicModelId,
  comboRequestHasImageInput,
  concreteComboRequestBody,
  comboCooldownRetryAfterSeconds,
  COMBO_REQUEST_RATE_COOLDOWN_MS,
  coolComboTarget,
  earliestQuotaResetAt,
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
  remainingComboCooldownMs,
  pickComboTarget,
  preservesPhysicalComboProvider,
  resetComboEffortWarningStateForTests,
  resolveComboId,
  targetKey,
  tryPickComboModel,
  UnknownComboError,
} from "../../src/combos";
import {
  comboFailureCooldownScope,
  comboFailureDecision,
  isTransientRequestRateLimit,
} from "../../src/combos/failover";
import { comboUnavailableResponse } from "../../src/server/responses/core";
import { getConfigPath, readConfigDiagnostics, saveConfig } from "../../src/config";
import { routeModel } from "../../src/router";
import { handleManagementAPI } from "../../src/server/management-api";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { syncCatalogModels } from "../../src/codex/catalog";
import { injectClaudeAgentDefs } from "../../src/claude/agents-inject";
import { reconcileComboRotationState } from "../../src/combos/resolve";
import {
  clearCachedProviderQuotas,
  getCachedProviderQuota,
  replaceCachedProviderQuotas,
  setCachedProviderQuotaForTests,
} from "../../src/providers/quota-routing-cache";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as publicCombos from "../../src/combos";
import * as comboIdentifiers from "../../src/combos/identifiers";
import { repoPath } from "../helpers/repo-root";

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
    removeTreeWithRetry(dir);
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
    createManagementConvergeCodex: catalogConvergenceFactory(refreshCodexCatalog),
  });
}

async function comboApiRaw(config: OcxConfig, method: string, path: string, body: string): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body,
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
}

async function responseJson(response: Response | null): Promise<Record<string, unknown>> {
  expect(response).not.toBeNull();
  return response!.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearCachedProviderQuotas();
});

afterEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearCachedProviderQuotas();
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

  test("keeps native-alias discovery disables separate from the bare native key", () => {
    const nativeAlias = {
      alias: "gpt-5.6-sol",
      nativeAlias: true,
      displayName: "Nova1 - Sol",
    };
    expect(comboDisabledModelId("nova-sol", nativeAlias)).toBe("combo/nova-sol");
    expect(comboDisabledModelSelectors("nova-sol", nativeAlias)).toEqual(["combo/nova-sol"]);
    expect(comboDisabledModelSelectors("regular", { alias: "daily-fast" }))
      .toEqual(["combo/regular", "daily-fast"]);
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

  test("comboRequestHasImageInput scans Responses input only, not tools or metadata", () => {
    expect(comboRequestHasImageInput({
      model: "combo/free",
      input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }],
    })).toBe(true);
    expect(comboRequestHasImageInput({
      model: "combo/free",
      input: [{ type: "input_image", image_url: "https://example.test/i.png" }],
    })).toBe(true);
    expect(comboRequestHasImageInput({
      model: "combo/free",
      input: [{
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_image", image_url: "https://example.test/tool.png" }],
      }],
    })).toBe(true);
    // Tool schemas / metadata may legally mention the same type string without
    // carrying image content for the model.
    expect(comboRequestHasImageInput({
      model: "combo/free",
      input: [{ role: "user", content: "text only" }],
      tools: [{
        type: "function",
        name: "describe",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["input_image", "input_text"] },
            example: { type: "input_image" },
          },
        },
      }],
      metadata: { note: { type: "input_image" } },
    })).toBe(false);
    expect(comboRequestHasImageInput({
      model: "combo/free",
      input: "plain text",
      tools: [{ type: "function", function: { name: "x", parameters: { type: "input_image" } } }],
    })).toBe(false);
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

  test("omits combo defaults for unset, no-reasoning, and unknown target capabilities", () => {
    expect(concreteComboRequestBody({ model: "combo/x" }, target, null, ["high"]).reasoning).toBeUndefined();
    // An explicitly empty ladder is how a no-reasoning model is expressed.
    expect(concreteComboRequestBody({ model: "combo/x" }, target, "high", []).reasoning).toBeUndefined();
    // An unknown ladder stays fail-closed: the picker treats it as a wildcard, runtime injection does not.
    expect(concreteComboRequestBody({ model: "combo/x" }, target, "high", undefined).reasoning).toBeUndefined();
  });

  /**
   * #3108: a combo configured for `max` routed to a target whose ladder tops out lower
   * sent NO effort at all, so the provider default applied and the turn ran at `none` —
   * while the catalog advertised `max` for that same combo, because
   * effectiveComboDefault downgrades to the nearest supported rung instead of dropping.
   * The request path now resolves the same way the catalog did.
   */
  test("a combo default above the target ladder is downgraded, not dropped (#3108)", () => {
    expect(concreteComboRequestBody({ model: "combo/x" }, target, "max", ["low", "medium", "high"]).reasoning)
      .toEqual({ effort: "high" });
    expect(concreteComboRequestBody({ model: "combo/x" }, target, "high", ["low", "medium"]).reasoning)
      .toEqual({ effort: "medium" });
    // Exact support is still passed through untouched.
    expect(concreteComboRequestBody({ model: "combo/x" }, target, "max", ["high", "max"]).reasoning)
      .toEqual({ effort: "max" });
    // Never raises: a request below everything supported takes the lowest rung, not a higher one.
    expect(concreteComboRequestBody({ model: "combo/x" }, target, "low", ["high", "max"]).reasoning)
      .toEqual({ effort: "high" });
    // A caller-supplied effort still wins over the combo default.
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { effort: "low" } }, target, "max", ["low", "medium", "high"],
    ).reasoning).toEqual({ effort: "low" });
    // The resolved rung merges into a partial reasoning object rather than replacing it.
    expect(concreteComboRequestBody(
      { model: "combo/x", reasoning: { summary: "concise" } }, target, "max", ["low", "high"],
    ).reasoning).toEqual({ summary: "concise", effort: "high" });
  });

  test("debug-warns once per unsupported or unknown combo default", () => {
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
    concreteComboRequestBody({ model: "combo/x" }, target, "medium", undefined);
    concreteComboRequestBody({ model: "combo/x" }, target, "medium", undefined);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug.mock.calls[1]?.[1]).toMatchObject({
      requestedEffort: "medium",
      capability: "unknown",
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
    expect(parseRetryAfterMs(new Date(now + 90_000).toUTCString().toLowerCase(), now)).toBe(90_000);
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

  test("can preserve valid immediate Retry-After directives", () => {
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    const options = { preserveImmediate: true };
    expect(parseRetryAfterMs("0", now, options)).toBe(1);
    expect(parseRetryAfterMs(new Date(now - 1_000).toUTCString(), now, options)).toBe(1);
    expect(parseRetryAfterMs("Sunday, 06-Nov-94 08:49:37 GMT", now, options)).toBe(1);
    expect(parseRetryAfterMs("Sunday, 06-Nov-50 08:49:37 GMT", now, options)).toBe(600_000);
    expect(parseRetryAfterMs("Sun Nov  6 08:49:37 1994", now, options)).toBe(1);
    expect(parseRetryAfterMs("not-a-date", now, options)).toBeUndefined();
    expect(parseRetryAfterMs("-1", now, options)).toBeUndefined();
    expect(parseRetryAfterMs("March 1, 2020", now, options)).toBeUndefined();
    expect(parseRetryAfterMs("Sun Sep 99 99:99:99 2026", now, options)).toBeUndefined();
    const centuryBoundary = Date.parse("2099-12-31T23:59:00.000Z");
    expect(parseRetryAfterMs("Friday, 01-Jan-00 00:01:00 GMT", centuryBoundary, options)).toBe(120_000);
    const fullTimestampBoundary = Date.parse("2026-01-01T00:00:00.000Z");
    expect(parseRetryAfterMs("Wednesday, 01-Jan-76 00:00:00 GMT", fullTimestampBoundary, options)).toBe(600_000);
    expect(parseRetryAfterMs("Friday, 31-Dec-76 00:00:00 GMT", fullTimestampBoundary, options)).toBe(1);
  });

  test("parses asctime Retry-After values as UTC outside the UTC process timezone", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const now = Date.parse("2026-09-06T00:59:00.000Z");
      expect(parseRetryAfterMs("Sun Sep  6 01:00:00 2026", now)).toBe(60_000);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
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

  test("gives immediate Retry-After directives precedence over configured cooldowns", () => {
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    const pastDate = new Date(now - 1_000).toUTCString();
    coolComboTarget("retry-zero", target, { now, retryAfter: "0", cooldownMs: 5_000 });
    coolComboTarget("retry-past-date", target, { now, retryAfter: pastDate, cooldownMs: 5_000 });
    expect(isComboTargetInCooldown("retry-zero", target, now)).toBe(true);
    expect(isComboTargetInCooldown("retry-zero", target, now + 1)).toBe(false);
    expect(isComboTargetInCooldown("retry-past-date", target, now)).toBe(true);
    expect(isComboTargetInCooldown("retry-past-date", target, now + 1)).toBe(false);
  });

  test("uses reset-derived cooldown before combo cooldownMs and default cooldown", () => {
    const now = 1_000_000;
    const resetAt = Math.floor((now + 20_000) / 1_000);
    coolComboTarget("reset-wins", target, { now, resetAt, cooldownMs: 5_000 });
    coolComboTarget("configured-wins", target, { now, cooldownMs: 5_000 });
    coolComboTarget("default-wins", target, { now });
    expect(isComboTargetInCooldown("reset-wins", target, now + 5_000)).toBe(true);
    expect(isComboTargetInCooldown("reset-wins", target, now + 20_000)).toBe(false);
    expect(isComboTargetInCooldown("configured-wins", target, now + 5_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("configured-wins", target, now + 5_000)).toBe(false);
    expect(isComboTargetInCooldown("default-wins", target, now + 60_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("default-wins", target, now + 60_000)).toBe(false);
  });

  test("uses a short cooldown for request-rate 1302 without Retry-After", () => {
    coolComboTarget("free", target, {
      now: 1_000,
      code: "1302",
      message: "Rate limit reached for requests",
    });
    expect(isComboTargetInCooldown("free", target, 1_000 + COMBO_REQUEST_RATE_COOLDOWN_MS - 1)).toBe(true);
    expect(isComboTargetInCooldown("free", target, 1_000 + COMBO_REQUEST_RATE_COOLDOWN_MS)).toBe(false);

    const config = baseConfig({ combos: { free: VALID_COMBO } });
    const pick = pickComboTarget(config, "free", { now: 1_000 })!;
    advanceComboAfterFailure(config, pick, {
      now: 1_000,
      status: 429,
      code: "1302",
      message: "Rate limit reached for requests",
    });
    expect(isComboTargetInCooldown("free", pick.target, 1_000 + COMBO_REQUEST_RATE_COOLDOWN_MS - 1)).toBe(true);
    expect(isComboTargetInCooldown("free", pick.target, 1_000 + COMBO_REQUEST_RATE_COOLDOWN_MS)).toBe(false);

    const configured = baseConfig({
      combos: { free: { ...VALID_COMBO, cooldownMs: 7_000 } },
    });
    const configuredPick = pickComboTarget(configured, "free", { now: 1_000 })!;
    advanceComboAfterFailure(configured, configuredPick, {
      now: 1_000,
      status: 429,
      code: "1302",
      message: "Rate limit reached for requests",
    });
    expect(isComboTargetInCooldown("free", configuredPick.target, 1_000 + 7_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("free", configuredPick.target, 1_000 + 7_000)).toBe(false);
  });

  test("keeps the default cooldown for usage-window 1308", () => {
    coolComboTarget("free", target, {
      now: 1_000,
      code: "1308",
      message: "Usage limit reached for 5 hour",
    });
    expect(isComboTargetInCooldown("free", target, 1_000 + 59_999)).toBe(true);
    expect(isComboTargetInCooldown("free", target, 1_000 + 60_000)).toBe(false);
  });

  test("honors explicit Retry-After over the request-rate default", () => {
    coolComboTarget("free", target, {
      now: 1_000,
      retryAfter: "30",
      code: "1302",
    });
    expect(isComboTargetInCooldown("free", target, 1_000 + 29_999)).toBe(true);
    expect(isComboTargetInCooldown("free", target, 1_000 + 30_000)).toBe(false);
  });

  test("reports the soonest remaining cooldown as Retry-After seconds", () => {
    const later = { provider: "b", model: "m2" };
    coolComboTarget("free", target, { now: 1_000, cooldownMs: 5_000 });
    coolComboTarget("free", later, { now: 1_000, cooldownMs: 20_000 });
    expect(remainingComboCooldownMs("free", 1_000)).toBe(5_000);
    expect(comboCooldownRetryAfterSeconds("free", 1_000)).toBe("5");
    expect(comboCooldownRetryAfterSeconds("free", 3_500)).toBe("3");
    expect(comboCooldownRetryAfterSeconds("missing", 1_000)).toBeUndefined();
  });

  test("combo unavailable responses advertise remaining cooldown as Retry-After", () => {
    coolComboTarget("free", target, { now: 1_000, cooldownMs: 5_000 });
    const response = comboUnavailableResponse("No available targets for combo: free", {
      retryAfter: comboCooldownRetryAfterSeconds("free", 1_000),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  test("applies Retry-After before reset-derived and combo cooldown values", () => {
    const now = 1_000_000;
    coolComboTarget("retry", target, {
      now,
      retryAfter: "10",
      cooldownMs: 5_000,
    });
    expect(isComboTargetInCooldown("retry", target, now + 10_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("retry", target, now + 10_000)).toBe(false);

    const resetAt = Math.floor((now + 20_000) / 1_000);
    coolComboTarget("reset", target, {
      now,
      resetAt,
      cooldownMs: 5_000,
    });
    expect(isComboTargetInCooldown("reset", target, now + 20_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("reset", target, now + 20_000)).toBe(false);

    const config = baseConfig({
      combos: { free: { ...VALID_COMBO, cooldownMs: 5_000 } },
    });
    const pick = pickComboTarget(config, "free", { now })!;
    advanceComboAfterFailure(config, pick, {
      now,
      retryAfter: "10",
      resetAt,
    });
    expect(isComboTargetInCooldown("free", pick.target, now + 10_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("free", pick.target, now + 10_000)).toBe(false);
  });

  test("uses combo cooldownMs instead of the 60-second default", () => {
    // The production path passes this normalized combo value to coolComboTarget after a failure.
    const config = baseConfig({ combos: { free: { ...VALID_COMBO, cooldownMs: 5_000 } } });
    expect(normalizeComboConfig(config.combos!.free!).cooldownMs).toBe(5_000);
    expect(normalizeComboConfig(config.combos!.free!).waitForCooldownMs).toBe(0);

    const now = 1_000_000;
    coolComboTarget("short", target, { now, cooldownMs: 5_000 });
    coolComboTarget("default", target, { now });
    expect(isComboTargetInCooldown("short", target, now + 5_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("short", target, now + 5_000)).toBe(false);
    expect(isComboTargetInCooldown("default", target, now + 5_000)).toBe(true);
    expect(isComboTargetInCooldown("default", target, now + 60_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("default", target, now + 60_000)).toBe(false);
  });

  test("finds the earliest cooldown expiry and waits within the budget", async () => {
    const config = baseConfig({
      combos: {
        free: {
          targets: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
          waitForCooldownMs: 10_000,
        },
      },
    });
    const now = 1_000_000;
    coolComboTarget("free", config.combos!.free!.targets[0]!, { now, cooldownMs: 3_000 });
    coolComboTarget("free", config.combos!.free!.targets[1]!, { now, cooldownMs: 8_000 });
    expect(earliestComboCooldownExpiry("free", config.combos!.free!.targets, now)).toBe(now + 3_000);

    const sleeps: number[] = [];
    const pick = await pickComboTargetWithWait(config, "free", {
      now,
      waitForCooldownMs: 10_000,
      sleep: async ms => { sleeps.push(ms); },
    });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeCloseTo(3_000, -2);
    expect(pick?.target.provider).toBe("a");
    expect(earliestComboCooldownExpiry("free", config.combos!.free!.targets, now + 3_000)).toBe(now + 8_000);
    expect(earliestComboCooldownExpiry("free", [{ provider: "c", model: "m3" }], now)).toBeUndefined();
  });

  test("logs and waits for the target with the earliest cooldown expiry", async () => {
    const config = baseConfig({
      combos: {
        free: {
          targets: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
          waitForCooldownMs: 10_000,
        },
      },
    });
    const now = 1_000_000;
    coolComboTarget("free", config.combos!.free!.targets[0]!, { now, cooldownMs: 8_000 });
    coolComboTarget("free", config.combos!.free!.targets[1]!, { now, cooldownMs: 3_000 });
    const sleeps: number[] = [];
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pick = await pickComboTargetWithWait(config, "free", {
        now,
        waitForCooldownMs: 10_000,
        sleep: async ms => { sleeps.push(ms); },
      });
      expect(sleeps).toEqual([3_000]);
      expect(pick?.target).toMatchObject({ provider: "b", model: "m2" });
      expect(warning).toHaveBeenCalledWith(
        "[combo] free: all targets cooling, waiting 3000ms for b/m2",
      );
    } finally {
      warning.mockRestore();
    }
  });

  test.each(["deleted", "renamed"] as const)("returns null when the combo is %s during cooldown wait", async change => {
    const config = baseConfig({ combos: { free: VALID_COMBO } });
    const now = 1_000_000;
    coolComboTarget("free", target, { now, cooldownMs: 3_000 });
    const sleeps: number[] = [];
    const pick = await pickComboTargetWithWait(config, "free", {
      now,
      waitForCooldownMs: 5_000,
      sleep: async ms => {
        sleeps.push(ms);
        config.combos = change === "renamed" ? { renamed: config.combos!.free! } : {};
      },
    });
    expect(sleeps).toEqual([3_000]);
    expect(pick).toBeNull();
    if (change === "renamed") expect(getCombo(config, "renamed")).toBeDefined();
  });

  test("still rejects a combo that is missing before cooldown selection", async () => {
    await expect(pickComboTargetWithWait(baseConfig(), "missing", {
      waitForCooldownMs: 5_000,
    })).rejects.toBeInstanceOf(UnknownComboError);
  });

  test("returns null when real sleepWithAbort rejects after an abort", async () => {
    const config = baseConfig({
      combos: {
        free: {
          targets: [{ provider: "a", model: "m1" }],
          waitForCooldownMs: 100,
        },
      },
    });
    const now = Date.now();
    coolComboTarget("free", target, { now, cooldownMs: 25 });
    const abort = new AbortController();
    const pending = pickComboTargetWithWait(config, "free", {
      now,
      waitForCooldownMs: 100,
      abortSignal: abort.signal,
    });
    setTimeout(() => abort.abort(new Error("test abort")), 5);
    expect(await pending).toBeNull();
  });

  test("fails closed without waiting and honors abort during injected sleep", async () => {
    const config = baseConfig({
      combos: {
        free: {
          targets: [{ provider: "a", model: "m1" }],
          waitForCooldownMs: 10_000,
        },
      },
    });
    const now = 1_000_000;
    coolComboTarget("free", target, { now, cooldownMs: 3_000 });
    const noWait: number[] = [];
    expect(await pickComboTargetWithWait(config, "free", {
      now,
      waitForCooldownMs: 0,
      sleep: async ms => { noWait.push(ms); },
    })).toBeNull();
    expect(noWait).toEqual([]);

    const abort = new AbortController();
    let slept = false;
    const pending = pickComboTargetWithWait(config, "free", {
      now,
      waitForCooldownMs: 10_000,
      abortSignal: abort.signal,
      sleep: async () => {
        slept = true;
        abort.abort();
      },
    });
    expect(await pending).toBeNull();
    expect(slept).toBe(true);
  });

  test("does not wait for cooling targets with exhausted provider quota", async () => {
    const now = 50_000;
    const config = baseConfig({
      combos: {
        free: {
          targets: [{ provider: "a", model: "m1" }],
          waitForCooldownMs: 5_000,
        },
      },
    });
    setCachedProviderQuotaForTests("a", {
      monthlyPercent: 100,
      monthlyResetAt: now + 14 * 24 * 60 * 60_000,
      updatedAt: now,
    });
    coolComboTarget("free", target, { now, cooldownMs: 1_000 });
    const sleeps: number[] = [];
    expect(await pickComboTargetWithWait(config, "free", {
      now,
      waitForCooldownMs: 5_000,
      sleep: async ms => { sleeps.push(ms); },
    })).toBeNull();
    expect(sleeps).toEqual([]);
  });

  test("fails closed without sleeping when cooldown expiry exceeds the wait budget", async () => {
    const config = baseConfig({
      combos: {
        free: {
          targets: [{ provider: "a", model: "m1" }],
          waitForCooldownMs: 10_000,
        },
      },
    });
    const now = 1_000_000;
    coolComboTarget("free", target, { now, cooldownMs: 10_000 });
    const sleeps: number[] = [];
    expect(await pickComboTargetWithWait(config, "free", {
      now,
      waitForCooldownMs: 1_000,
      sleep: async ms => { sleeps.push(ms); },
    })).toBeNull();
    expect(sleeps).toEqual([]);
  });

  test("applies combo cooldownMs to a failure-derived cooldown", () => {
    const config = baseConfig({
      combos: { free: { ...VALID_COMBO, cooldownMs: 5_000 } },
    });
    const combo = getCombo(config, "free")!;
    const pick = pickComboTarget(config, "free")!;
    advanceComboAfterFailure(config, pick, { now: 1_000_000 });
    expect(isComboTargetInCooldown("free", combo.targets[0]!, 1_000_000 + 5_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown("free", combo.targets[0]!, 1_000_000 + 5_000)).toBe(false);
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
    expect(comboFailureDecision(410, "resource is gone")).toBe("stop");
    expect(comboFailureDecision(410, "The model has reached its end of life and is no longer available.")).toBe("hop");
    expect(comboFailureDecision(410, "The model is scheduled for retirement.")).toBe("hop");
    expect(comboFailureDecision(410, "gone", { code: "model_retired" })).toBe("hop");
    expect(comboFailureDecision(499, "client cancelled")).toBe("stop");
    expect(comboFailureDecision(422, "invalid_api_key")).toBe("hop");
    // #1524: a LOCAL input-admission refusal means "this candidate cannot fit the request",
    // not "the request is impossible". The next candidate may have a larger context window,
    // so the chain must continue instead of ending at the first incompatible target.
    //
    // The decision keys on the STRUCTURED code, which the proxy now preserves through
    // classifyError. Matching raw text instead would let any upstream override a terminal
    // verdict by echoing the token, so that shape must NOT hop.
    expect(comboFailureDecision(413, 'refused', { code: 'input_admission_refused' })).toBe('hop');
    expect(comboFailureDecision(400, 'upstream mentions input_admission_refused in prose')).toBe('stop');
    // An UPSTREAM context verdict still stops: retrying that elsewhere is guesswork, and a
    // generic 413 with no structured code keeps its existing conservative handling.
    expect(comboFailureDecision(400, "context_length_exceeded")).toBe("stop");
    const providerHardCap = JSON.stringify({ error: {
      message: "Prompt 346030 > 262144 maximum context length",
      type: "invalid_request_prompt_too_long",
      code: "5059",
      raw_status_code: 400,
    }});
    expect(comboFailureDecision(400, providerHardCap, { code: "5059" })).toBe("hop");
    expect(comboFailureDecision(400, "ordinary invalid request", { code: "5059" })).toBe("stop");
    expect(comboFailureDecision(413, "request too large")).toBe("stop");
  });

  test("free-tier and monthly quota failures hop with the right scope, without weakening generic 400 handling", () => {
    const orca = JSON.stringify({ error: {
      type: "invalid_request_error",
      code: "free_rate_limited",
      message: "This prompt is longer than the free tier allows for a single request.",
    }});
    expect(comboFailureDecision(400, orca, { code: "free_rate_limited" })).toBe("hop");
    // `free_rate_limited` is a PER-REQUEST cap ("longer than the free tier allows for a single
    // request"), so it must not cool the provider for every other combo: a shorter prompt would
    // still have been served. It keeps its hop verdict but records no cooldown evidence.
    expect(comboFailureCooldownScope(400, orca, { code: "free_rate_limited" })).toBe("none");
    expect(comboFailureDecision(400, "ordinary invalid request", { code: "invalid_request_error" })).toBe("stop");
    // The account-window quota cap is genuine provider-wide evidence and keeps its scope.
    expect(comboFailureCooldownScope(429, "Monthly usage limit reached. Resets in 14 days.", {
      code: "GoUsageLimitError",
    })).toBe("provider");
    expect(isTransientRequestRateLimit({
      status: 429,
      code: "GoUsageLimitError",
      message: "Monthly usage limit reached. Resets in 14 days.",
    })).toBe(false);
    expect(comboFailureCooldownScope(429, "Rate limit reached for requests", { code: "1302" })).toBe("target");
    expect(isTransientRequestRateLimit({
      status: 429,
      code: "1302",
      message: "Rate limit reached for requests",
    })).toBe(true);
  });

  test("failover skips providers with fresh exhausted quota evidence before dispatch", () => {
    const now = 50_000;
    const config = baseConfig();
    setCachedProviderQuotaForTests("a", {
      monthlyPercent: 100,
      monthlyResetAt: now + 14 * 24 * 60 * 60_000,
      updatedAt: now,
    });
    const pick = pickComboTarget(config, "free", { now });
    expect(pick?.target.provider).toBe("b");
  });

  test.each(["pool", "direct"] as const)("defers native %s quota decisions to account and model scoped authentication", mode => {
    const now = 50_000;
    const config = baseConfig({
      providers: {
        a: {
          adapter: "openai-responses",
          authMode: "forward",
          codexAccountMode: mode,
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb" },
      },
    });
    setCachedProviderQuotaForTests("a", { weeklyPercent: 100, updatedAt: now });

    const pick = pickComboTarget(config, "free", { now });

    expect(pick?.target.provider).toBe("a");
  });

  test("native provider summary quota does not suppress a bounded cooldown wait", async () => {
    const now = 50_000;
    const config = baseConfig({
      providers: {
        a: {
          adapter: "openai-responses",
          authMode: "forward",
          codexAccountMode: "pool",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      },
      combos: {
        free: {
          targets: [{ provider: "a", model: "m1" }],
          waitForCooldownMs: 2_000,
        },
      },
    });
    setCachedProviderQuotaForTests("a", { weeklyPercent: 100, updatedAt: now });
    coolComboTarget("free", { provider: "a", model: "m1" }, { now, cooldownMs: 1_000 });
    const sleeps: number[] = [];

    const pick = await pickComboTargetWithWait(config, "free", {
      now,
      waitForCooldownMs: 2_000,
      sleep: async ms => { sleeps.push(ms); },
    });

    expect(pick?.target.provider).toBe("a");
    expect(sleeps).toEqual([1_000]);
  });

  test("still filters exhausted quota on a noncanonical forward destination", () => {
    const now = 50_000;
    const config = baseConfig({
      providers: {
        a: {
          adapter: "openai-responses",
          authMode: "forward",
          codexAccountMode: "pool",
          baseUrl: "https://chatgpt.com.example/backend-api/codex",
        },
        b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb" },
      },
    });
    setCachedProviderQuotaForTests("a", { weeklyPercent: 100, updatedAt: now });

    const pick = pickComboTarget(config, "free", { now });

    expect(pick?.target.provider).toBe("b");
  });

  test("retains caller eligibility restrictions for native targets", () => {
    const now = 50_000;
    const config = baseConfig({
      providers: {
        a: {
          adapter: "openai-responses",
          authMode: "forward",
          codexAccountMode: "pool",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb" },
      },
    });
    setCachedProviderQuotaForTests("a", { weeklyPercent: 100, updatedAt: now });

    const pick = pickComboTarget(config, "free", {
      now,
      eligible: target => target.provider !== "a",
    });

    expect(pick?.target.provider).toBe("b");
  });

  test("elapsed quota reset does not permanently blacklist a provider", () => {
    const now = 50_000;
    const config = baseConfig();
    setCachedProviderQuotaForTests("a", {
      monthlyPercent: 100,
      monthlyResetAt: now - 1,
      updatedAt: now,
    });
    const pick = pickComboTarget(config, "free", { now });
    expect(pick?.target.provider).toBe("a");
  });

  test("exhausted credits without an unlimited flag skip the provider", () => {
    const now = 50_000;
    const config = baseConfig();
    setCachedProviderQuotaForTests("a", {
      creditsUsd: { used: 10, limit: 10, remaining: 0, percent: 100 },
      updatedAt: now,
    });
    expect(pickComboTarget(config, "free", { now })?.target.provider).toBe("b");
  });

  test("provider-scoped cooldown skips sibling models but leaves other providers eligible", () => {
    const config = baseConfig({
      combos: {
        free: {
          targets: [
            { provider: "a", model: "m1" },
            { provider: "a", model: "m1b" },
            { provider: "b", model: "m2" },
          ],
        },
      },
    });
    config.providers.a!.models = ["m1", "m1b"];
    const first = pickComboTarget(config, "free", { now: 1_000 })!;
    const next = advanceComboAfterFailure(config, first, { now: 1_000, cooldownScope: "provider" })!;
    expect(next.target.provider).toBe("b");
    expect(isComboTargetInCooldown("free", { provider: "a", model: "m1b" }, 1_001)).toBe(true);
    expect(isComboTargetInCooldown("free", { provider: "b", model: "m2" }, 1_001)).toBe(false);
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
  test("replacing quota snapshots removes providers omitted from the refresh", () => {
    const now = Date.now();
    replaceCachedProviderQuotas([
      { provider: "a", label: "a", source: "test", quota: { updatedAt: now } },
      { provider: "b", label: "b", source: "test", quota: { updatedAt: now } },
    ]);
    replaceCachedProviderQuotas([
      { provider: "a", label: "a", source: "test", quota: { updatedAt: now } },
    ]);
    expect(getCachedProviderQuota("a", now)).not.toBeNull();
    expect(getCachedProviderQuota("b", now)).toBeNull();
  });

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

  test("random selection is weighted per request and does not inherit round-robin stickiness", () => {
    const roundRobin = rrConfig(2, [1, 1]);
    expect(pickComboTarget(roundRobin, "free")?.target.provider).toBe("a");

    const random = baseConfig({
      combos: {
        free: {
          strategy: "random",
          targets: [
            { provider: "a", model: "m1", weight: 1 },
            { provider: "b", model: "m2", weight: 3 },
          ],
        },
      },
    });
    const entropy = spyOn(Math, "random");
    try {
      entropy.mockReturnValueOnce(0).mockReturnValueOnce(0.5);
      expect(pickComboTarget(random, "free")?.target.provider).toBe("a");
      expect(pickComboTarget(random, "free")?.target.provider).toBe("b");
    } finally {
      entropy.mockRestore();
    }
  });

  test("least-used selection counts successful requests and preserves configured ties", () => {
    const config = baseConfig({
      combos: {
        free: {
          strategy: "least-used",
          targets: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
        },
      },
    });

    expect(successfulPicks(config, 4)).toEqual(["a/m1", "b/m2", "a/m1", "b/m2"]);
  });

  test("reset-window selects the eligible target whose cached quota resets soonest", () => {
    const now = Date.now();
    const config = baseConfig({
      combos: {
        free: {
          strategy: "reset-window",
          targets: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
            { provider: "c", model: "m3" },
          ],
        },
      },
    });
    setCachedProviderQuotaForTests("a", { updatedAt: now, fiveHourResetAt: now + 24 * 60 * 60_000 });
    setCachedProviderQuotaForTests("b", { updatedAt: now, weeklyResetAt: now + 60 * 60_000 });
    setCachedProviderQuotaForTests("c", { updatedAt: now });

    expect(pickComboTarget(config, "free")?.target.provider).toBe("b");
    expect(routeModel(config, "combo/free").routeDecision?.selected).toMatchObject({
      tieBreak: "reset-window",
    });
  });

  test("reset-window treats elapsed resets as unknown and falls back to configured order", () => {
    const now = Date.now();
    const config = baseConfig({
      combos: {
        free: {
          strategy: "reset-window",
          targets: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
            { provider: "c", model: "m3" },
          ],
        },
      },
    });
    setCachedProviderQuotaForTests("a", { updatedAt: now, fiveHourResetAt: now - 1 });
    setCachedProviderQuotaForTests("b", { updatedAt: now, weeklyResetAt: now + 60 * 60_000 });
    setCachedProviderQuotaForTests("c", { updatedAt: now, monthlyResetAt: now + 60 * 60_000 });
    expect(pickComboTarget(config, "free")?.target.provider).toBe("b");

    config.providers.a!.disabled = true;
    expect(pickComboTarget(config, "free")?.target.provider).toBe("b");

    clearCachedProviderQuotas();
    setCachedProviderQuotaForTests("b", {
      updatedAt: now - 30 * 60_000 - 1,
      weeklyResetAt: now + 1,
    });
    expect(pickComboTarget(config, "free")?.target.provider).toBe("b");

    config.providers.a!.disabled = false;
    expect(pickComboTarget(config, "free")?.target.provider).toBe("a");
  });

  test("reset-window treats non-finite reset timestamps as unknown", () => {
    const now = Date.now();
    expect(earliestQuotaResetAt({ updatedAt: now, fiveHourResetAt: Number.POSITIVE_INFINITY }, now)).toBeNull();
    expect(earliestQuotaResetAt({ updatedAt: now, weeklyResetAt: Number.NaN }, now)).toBeNull();
    expect(earliestQuotaResetAt({
      updatedAt: now,
      customWindows: [{ label: "burst", percent: 100, resetAt: Number.POSITIVE_INFINITY }],
    }, now)).toBeNull();
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

  test("an explicitly configured native alias resolves before canonical OpenAI routing", () => {
    const config = baseConfig({
      codexAccountNamespaces: { main: "@main" },
      combos: {
        nova: {
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Nova1 - Sol",
          targets: [{ provider: "a", model: "m1" }],
        },
      },
    });
    config.providers.openai = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      codexAccountMode: "direct",
    };

    expect(routeModel(config, "gpt-5.6-sol")).toMatchObject({
      providerName: "a",
      modelId: "m1",
      combo: { comboId: "nova", target: { provider: "a", model: "m1" } },
    });
    expect(routeModel(config, "combo/nova")).toMatchObject({
      providerName: "a",
      modelId: "m1",
    });
    const accountQualified = routeModel(config, "main/gpt-5.6-sol");
    expect(accountQualified).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.6-sol",
    });
    expect(accountQualified.combo).toBeUndefined();
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
    expect(comboAliasIssues("new", "gpt-5.6-sol", combos, { allowNativeAlias: true })).toEqual([]);
    expect(comboAliasIssues("new", "deepseek-v4-flash", combos)[0]?.message).toContain("already used");
    expect(comboAliasIssues("renamed", "deepseek-v4-flash", combos, {
      excludeComboId: "free",
    })).toEqual([]);
  });

  test("requires an explicit labeled opt-in before a combo can own a native alias", () => {
    const providers = baseConfig().providers;
    expect(comboConfigError("nova", {
      ...VALID_COMBO,
      alias: "gpt-5.6-sol",
    }, providers)).toContain("nativeAlias=true");
    expect(comboConfigError("nova", {
      ...VALID_COMBO,
      alias: "gpt-5.6-sol",
      nativeAlias: true,
    }, providers)).toContain("displayName is required");
    expect(comboConfigError("nova", {
      ...VALID_COMBO,
      alias: "deepseek-v4-flash",
      nativeAlias: true,
      displayName: "Not native",
    }, providers)).toContain("requires a currently supported bare OpenAI-native");
    expect(comboConfigError("nova", {
      ...VALID_COMBO,
      alias: "gpt-future-preview",
      nativeAlias: true,
      displayName: "Future model",
    }, providers)).toContain("requires a currently supported bare OpenAI-native");
    expect(comboConfigError("nova", {
      ...VALID_COMBO,
      alias: "gpt-5.6-sol",
      nativeAlias: true,
      displayName: "Nova1 - Sol",
    }, providers)).toBeNull();
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
      { raw: { ...VALID_COMBO, strategy: "unexpected" }, path: ["strategy"], message: "failover" },
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

  test("validates cooldown knobs and supplies sparse-safe defaults", () => {
    const providers = baseConfig().providers;
    const cooldownValues: unknown[] = [0, 1.5, 600_001, -1, "5000"];
    for (const value of cooldownValues) {
      expect(comboConfigIssues("free", { ...VALID_COMBO, cooldownMs: value }, providers)).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["cooldownMs"] })]),
      );
    }
    const waitValues: unknown[] = [1.5, 600_001, -1, "5000"];
    for (const value of waitValues) {
      expect(comboConfigIssues("free", { ...VALID_COMBO, waitForCooldownMs: value }, providers)).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["waitForCooldownMs"] })]),
      );
    }
    expect(comboConfigIssues("free", { ...VALID_COMBO, waitForCooldownMs: 0 }, providers))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ path: ["waitForCooldownMs"] })]));
    const normalized = normalizeComboConfig(VALID_COMBO);
    expect(normalized.cooldownMs).toBeUndefined();
    expect(normalized.waitForCooldownMs).toBe(0);
  });

  test("normalizes valid values and returns defensive default efforts", () => {
    expect(normalizeComboConfig({
      defaultEffort: "high",
      targets: [{ provider: " a ", model: " m1 ", weight: 2 }],
    })).toEqual({
      strategy: "failover",
      stickyLimit: 1,
      waitForCooldownMs: 0,
      defaultEffort: "high",
      reasoningEffortMode: "strict",
      imageInput: "auto",
      alias: null,
      nativeAlias: false,
      displayName: null,
      targets: [{ provider: "a", model: "m1", weight: 2 }],
    });
    expect(normalizeComboConfig({ targets: [{ provider: "a", model: "m1" }] }).defaultEffort).toBeNull();
    // Anything that is not the literal "adaptive" normalizes to today's behavior, so a
    // malformed or absent value can never silently opt a user in.
    expect(normalizeComboConfig({ targets: [{ provider: "a", model: "m1" }] }).reasoningEffortMode).toBe("strict");
    expect(normalizeComboConfig({
      reasoningEffortMode: "adaptive",
      targets: [{ provider: "a", model: "m1" }],
    }).reasoningEffortMode).toBe("adaptive");
    expect(comboConfigIssues("free", {
      reasoningEffortMode: "aggressive",
      targets: [{ provider: "a", model: "m1" }],
    }, baseConfig().providers).some(issue => issue.path[0] === "reasoningEffortMode")).toBe(true);
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
    expect(preservesPhysicalComboProvider(config)).toBeTrue();
    expect(preservesPhysicalComboProvider({ ...config, combos: {} })).toBeTrue();
    expect(preservesPhysicalComboProvider({ providers: {}, combos: {} })).toBeFalse();
    expect(preservesPhysicalComboProvider({ ...config, combos: { free: VALID_COMBO } })).toBeFalse();
    const inheritedProviders = Object.create({ combo: config.providers.combo }) as OcxConfig["providers"];
    expect(preservesPhysicalComboProvider({ providers: inheritedProviders, combos: {} })).toBeFalse();
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
        { id: "free", combo: { ...VALID_COMBO, strategy: "unexpected" } },
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

describe("combo generation reconciliation", () => {
  test("a surviving target accepts a late completion after a sibling topology change", () => {
    clearComboSelectionState();
    const original = rrConfig(2, [1, 1]);
    const oldPick = pickComboTarget(original, "free")!;
    expect(oldPick.target.provider).toBe("a");

    const removed = reconcileComboRotationState({
      generation: 10_000,
      providerNames: new Set(["a", "c"]),
      comboIds: new Set(["free"]),
      comboTargets: new Set(["free::a/m1", "free::c/m3"]),
      codexAccountIds: new Set(),
      oauthAccountKeys: new Set(),
      configRoots: new Set(),
    });
    expect(removed).toBeGreaterThan(0);

    const current = baseConfig({
      combos: {
        free: {
          strategy: "round-robin",
          stickyLimit: 2,
          targets: [
            { provider: "a", model: "m1", weight: 1 },
            { provider: "c", model: "m3", weight: 1 },
          ],
        },
      },
    });
    noteComboFailure("free", oldPick.target, oldPick.writerGeneration);
    expect(pickComboTarget(current, "free")?.target.provider).toBe("c");
  });

  test("a removed target rejects a late completion", () => {
    clearComboSelectionState();
    const original = rrConfig(1, [1, 1]);
    const originalCombo = getCombo(original, "free")!;

    reconcileComboRotationState({
      generation: 10_000,
      providerNames: new Set(["a", "c"]),
      comboIds: new Set(["free"]),
      comboTargets: new Set(["free::a/m1", "free::c/m3"]),
      codexAccountIds: new Set(),
      oauthAccountKeys: new Set(),
      configRoots: new Set(),
    });

    const removedPick = pickComboTarget(original, "free", { exclude: ["a/m1"] })!;
    expect(removedPick.target.provider).toBe("b");
    noteComboSuccess("free", originalCombo, removedPick.target, 0);
    expect(pickComboTarget(original, "free")?.target.provider).toBe("b");
  });
});

test("combo identifiers leaf preserves public export identity without facade imports", () => {
  const names = [
    "COMBO_NAMESPACE",
    "preservesPhysicalComboProvider",
    "isNativeAliasCombo",
    "targetKey",
    "parseComboModelId",
    "comboModelId",
    "comboPublicModelId",
    "comboDisabledModelId",
    "comboDisabledModelSelectors",
    "resolveComboId",
    "isValidComboId",
  ] as const;
  for (const name of names) {
    expect(publicCombos[name]).toBe(comboIdentifiers[name]);
  }
  const source = readFileSync(repoPath("src", "combos", "identifiers.ts"), "utf8");
  expect(source.split(/\r?\n/).some(line => /from\s+["']\.\/(types|index)["']/.test(line)))
    .toBe(false);
});
