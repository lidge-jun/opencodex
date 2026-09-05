import { describe, expect, test } from "bun:test";
import { decideTier, tierValueAfterDecision } from "../../src/providers/fastwire";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { fastPolicyForModel } from "../../src/providers/service-tier";
import { parseFastOnlyRowId, parseSyntheticRowId } from "../../src/server/fast-row";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

/**
 * Ingress round-trip semantics for synthetic Fast selectors
 * (devlog 260904_external_fast_wire/030).
 *
 * A fast row sets `service_tier: "priority"` as a CALLER intent and lets the existing
 * decideTier rule on it. It never writes tierDecision and never bypasses the policy, so
 * everything that already governs Fast keeps governing it. These tests pin that contract at
 * the decision layer every one of the five ingresses feeds.
 */

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://fixture.example/v1",
    ...overrides,
  } as OcxProviderConfig;
}

function configWith(providers: Record<string, OcxProviderConfig>, extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: Object.keys(providers)[0] ?? "fixture",
    providers,
    fastRows: true,
    ...extra,
  } as OcxConfig;
}

const eligible = () => configWith({
  fixture: provider({ models: ["m"], supportsServiceTier: true }),
});

describe("a fast selector becomes a caller intent, not a decision", () => {
  test("it resolves to the base model on the shared parser every ingress uses", () => {
    const config = eligible();
    expect(parseSyntheticRowId("m--fast", config).fastRow).toEqual({ baseId: "m" });
    expect(parseSyntheticRowId("fixture/m--fast", config).fastRow).toEqual({ baseId: "fixture/m" });
  });

  test("an eligible route turns the intent into the canonical wire value", () => {
    const config = eligible();
    const policy = fastPolicyForModel(config.providers.fixture, "m", "fixture");
    const decision = decideTier(policy, config.fastMode, "priority");
    expect(decision.kind).toBe("set");
    expect(tierValueAfterDecision(decision, "priority")).toBe("priority");
  });

  test("fastMode:false suppresses the intent — the operator switch is not overridable by id", () => {
    const config = configWith({ fixture: provider({ models: ["m"], supportsServiceTier: true }) }, { fastMode: false });
    // The selector still resolves: the id is understood, and the POLICY declines it.
    expect(parseSyntheticRowId("m--fast", config).fastRow).toEqual({ baseId: "m" });
    const decision = decideTier(
      fastPolicyForModel(config.providers.fixture, "m", "fixture"),
      config.fastMode,
      "priority",
    );
    expect(decision).toEqual({ kind: "drop" });
    // The value a handler writes back: undefined means REMOVE the field, which is what the
    // compact path must do rather than leaving a caller's stale tier to ride along.
    expect(tierValueAfterDecision(decision, "priority")).toBeUndefined();
  });

  test("an ineligible route degrades to a normal request rather than erroring", () => {
    // A stale client holding a --fast id after the model lost eligibility still gets served.
    const config = configWith({ fixture: provider({ models: ["m"], supportsServiceTier: false }) });
    const decision = decideTier(
      fastPolicyForModel(config.providers.fixture, "m", "fixture"),
      config.fastMode,
      "priority",
    );
    expect(decision).toEqual({ kind: "drop" });
    expect(tierValueAfterDecision(decision, "priority")).toBeUndefined();
  });

  test("an unclassified route does not invent a tier", () => {
    // Capability undefined is absence of evidence, not evidence of support.
    const config = configWith({ fixture: provider({ models: ["m"] }) });
    const decision = decideTier(
      fastPolicyForModel(config.providers.fixture, "m", "fixture"),
      config.fastMode,
      "priority",
    );
    expect(decision.kind).not.toBe("set");
  });
});

describe("cursor expresses the same intent as a model variant", () => {
  test("the canonical intent reaches Cursor's own fast wire value", () => {
    // Cursor's FastWire maps priority -> the `fast` variant, which is the existence proof
    // this whole unit generalizes: one caller intent, per-provider wire.
    const cursor = providerConfigSeed(getProviderRegistryEntry("cursor")!);
    const decision = decideTier(fastPolicyForModel(cursor, "claude-opus-5", "cursor"), undefined, "priority");
    expect(decision).toEqual({ kind: "set", value: "fast" });
  });
});

describe("surfaces that never parsed an effort row", () => {
  test("count_tokens and compact resolve Fast only, and nothing when the flag is off", () => {
    const config = configWith({ fixture: provider({ models: ["m"] }) }, { cursorEffortRows: true });
    expect(parseFastOnlyRowId(config, () => "m--fast")).toEqual({ baseId: "m" });
    // An effort row is NOT acquired by these surfaces.
    expect(parseFastOnlyRowId(config, () => "m--high")).toBeNull();
    const off = configWith({ fixture: provider({ models: ["m"] }) }, { fastRows: false });
    expect(parseFastOnlyRowId(off, () => "m--fast")).toBeNull();
  });
});

describe("explicit opt-out at the request path", () => {
  test("a --fast selector is an ordinary unknown model when the flag is false", () => {
    const config = configWith({ fixture: provider({ models: ["m"], supportsServiceTier: true }) }, { fastRows: false });
    const rows = parseSyntheticRowId("m--fast", config);
    expect(rows.fastRow).toBeNull();
    // And no rewrite happens, so the id reaches routing verbatim and fails there honestly
    // rather than being silently reinterpreted.
    expect(rows.effortRow).toBeNull();
  });
});



test("omitted Fast flag resolves selectors on ordinary and Fast-only ingress", () => {
  const config = configWith({ fixture: provider({ models: ["m"], supportsServiceTier: true }) });
  delete config.fastRows;
  expect(parseSyntheticRowId("fixture/m--fast", config).fastRow).toEqual({ baseId: "fixture/m" });
  expect(parseFastOnlyRowId(config, () => "fixture/m--fast")).toEqual({ baseId: "fixture/m" });
});
