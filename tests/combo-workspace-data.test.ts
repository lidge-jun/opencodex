import { describe, expect, test } from "bun:test";
import {
  type ComboItem,
  buildComboAttention,
  draftEquals,
  filterCombos,
  groupCombos,
  isValidComboId,
  parseComboList,
  toPutBody,
  validateComboDraft,
} from "../gui/src/combo-workspace-data";

const configuredProviders = {
  a: {},
  b: {},
  chatgpt: {},
  openai: {},
  disabled: { disabled: true },
} as const;

function combo(overrides: Partial<ComboItem> = {}): ComboItem {
  return {
    id: "free",
    model: "combo/free",
    alias: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: "medium",
    targets: [
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
    ],
    ...overrides,
  };
}

function validate(
  item: ComboItem,
  options: {
    existingIds?: readonly string[];
    existingAliases?: readonly string[];
    isCreate?: boolean;
    providers?: Readonly<Record<string, { disabled?: boolean }>>;
  } = {},
) {
  return validateComboDraft(item, {
    existingIds: options.existingIds ?? [],
    existingAliases: options.existingAliases ?? [],
    isCreate: options.isCreate ?? false,
    providers: options.providers ?? configuredProviders,
  });
}

describe("combo-workspace-data", () => {
  test("parseComboList accepts normalized GET rows and skips malformed entries", () => {
    const items = parseComboList({
      combos: [
        {
          id: " weighted ",
          model: " combo/weighted ",
          strategy: "round-robin",
          stickyLimit: 4,
          defaultEffort: "high",
          targets: [
            { provider: " a ", model: " m1 ", weight: 3 },
            { provider: "b", model: "m2", weight: 1 },
            { provider: "", model: "bad" },
          ],
        },
        {
          id: "fallback",
          strategy: "failover",
          targets: [{ provider: "a", model: "m1", weight: 1 }],
        },
        { id: "", targets: [] },
        null,
      ],
    });

    expect(items).toEqual([
      {
        id: "fallback",
        model: "combo/fallback",
        alias: null,
        strategy: "failover",
        stickyLimit: 1,
        defaultEffort: "medium",
        targets: [{ provider: "a", model: "m1", weight: 1 }],
      },
      {
        id: "weighted",
        model: "combo/weighted",
        alias: null,
        strategy: "round-robin",
        stickyLimit: 4,
        defaultEffort: "high",
        targets: [
          { provider: "a", model: "m1", weight: 3 },
          { provider: "b", model: "m2", weight: 1 },
        ],
      },
    ]);
    expect(parseComboList([])).toEqual([]);
    expect(parseComboList({ combos: "invalid" })).toEqual([]);
  });

  test("parseComboList normalizes aliases and derives the public model name", () => {
    const items = parseComboList({
      combos: [
        {
          id: "masked",
          alias: " deepseek-v4-flash ",
          targets: [{ provider: "a", model: "m1" }],
        },
        {
          id: "plain",
          alias: "   ",
          targets: [{ provider: "a", model: "m1" }],
        },
        {
          id: "serverwins",
          model: "server/public-name",
          alias: "ignored-by-model",
          targets: [{ provider: "a", model: "m1" }],
        },
      ],
    });

    expect(items.map((item) => [item.id, item.model, item.alias])).toEqual([
      ["masked", "deepseek-v4-flash", "deepseek-v4-flash"],
      ["plain", "combo/plain", null],
      ["serverwins", "server/public-name", "ignored-by-model"],
    ]);
  });

  test("group and filter cover id, wire model, provider, and target model", () => {
    const items = [
      combo(),
      combo({
        id: "balanced",
        model: "combo/balanced",
        strategy: "round-robin",
        targets: [{ provider: "openai", model: "gpt-balanced", weight: 2 }],
      }),
    ];
    const grouped = groupCombos(items);

    expect(grouped.failover.map((item) => item.id)).toEqual(["free"]);
    expect(grouped.roundRobin.map((item) => item.id)).toEqual(["balanced"]);
    expect(filterCombos(items, "balanced").map((item) => item.id)).toEqual(["balanced"]);
    expect(filterCombos(items, "combo/free").map((item) => item.id)).toEqual(["free"]);
    expect(filterCombos(items, "openai").map((item) => item.id)).toEqual(["balanced"]);
    expect(filterCombos(items, "gpt-balanced").map((item) => item.id)).toEqual(["balanced"]);
  });

  test("attention flags zero-target and one-target defensive rows", () => {
    const attention = buildComboAttention([
      combo({ id: "empty", model: "combo/empty", targets: [] }),
      combo({ id: "thin", model: "combo/thin", targets: [{ provider: "a", model: "m1" }] }),
      combo(),
    ]);

    expect(attention).toEqual([
      { id: "empty", model: "combo/empty", reason: "empty-targets" },
      { id: "thin", model: "combo/thin", reason: "few-targets" },
    ]);
  });

  test("validates combo id boundaries and duplicate ids on create and rename", () => {
    expect(isValidComboId("a")).toBe(true);
    expect(isValidComboId(`a${"x".repeat(63)}`)).toBe(true);
    expect(isValidComboId(`a${"x".repeat(64)}`)).toBe(false);
    expect(isValidComboId("a.b_c-1")).toBe(true);
    expect(isValidComboId("-bad")).toBe(false);

    expect(validate(combo({ id: "" }))).toBe("missingId");
    expect(validate(combo({ id: "-bad" }))).toBe("invalidId");
    expect(validate(combo(), { existingIds: ["free"], isCreate: true })).toBe("duplicateId");
    // Edit callers pass OTHER combos' ids: keeping the current id passes, renaming
    // into an occupied id fails.
    expect(validate(combo(), { existingIds: ["other"], isCreate: false })).toBeNull();
    expect(validate(combo({ id: "other" }), { existingIds: ["other"], isCreate: false })).toBe("duplicateId");
  });

  test("validates public alias shape, namespace, family, and uniqueness", () => {
    expect(validate(combo({ alias: "deepseek-v4-flash" }))).toBeNull();
    expect(validate(combo({ alias: "vendor/deepseek-v4-flash" }))).toBeNull();
    expect(validate(combo({ alias: "  " }))).toBeNull();
    expect(validate(combo({ alias: "bad alias" }))).toBe("invalidAlias");
    expect(validate(combo({ alias: "a/b/c" }))).toBe("invalidAlias");
    expect(validate(combo({ alias: "-leading-hyphen" }))).toBe("invalidAlias");
    expect(validate(combo({ alias: "combo/other" }))).toBe("aliasReservedNamespace");
    expect(validate(combo({ alias: "combo" }))).toBe("aliasReservedNamespace");
    expect(validate(combo({ alias: "gpt-5" }))).toBe("aliasNativeFamily");
    expect(validate(combo({ alias: "codex-latest" }))).toBe("aliasNativeFamily");
    // Slashed ids in the same families are fine — only BARE names collide with natives.
    expect(validate(combo({ alias: "openai/gpt-5" }))).toBeNull();
    expect(validate(combo({ alias: "taken" }), { existingAliases: ["taken"] })).toBe("duplicateAlias");
    expect(validate(combo({ alias: "taken" }), { existingAliases: ["other"] })).toBeNull();
  });

  test("toPutBody emits the exact plain-object PUT contract", () => {
    const roundRobin = combo({
      id: " weighted ",
      strategy: "round-robin",
      stickyLimit: 7,
      defaultEffort: "high",
      targets: [
        { provider: " a ", model: " m1 ", weight: 3 },
        { provider: "b", model: "m2" },
      ],
    });
    const rrBody = toPutBody(roundRobin);

    expect(Object.getPrototypeOf(rrBody)).toBe(Object.prototype);
    expect(rrBody).toEqual({
      id: "weighted",
      combo: {
        targets: [
          { provider: "a", model: "m1", weight: 3 },
          { provider: "b", model: "m2", weight: 1 },
        ],
        strategy: "round-robin",
        defaultEffort: "high",
        stickyLimit: 7,
      },
    });

    const failoverBody = toPutBody(combo({
      stickyLimit: 99,
      targets: [{ provider: "a", model: "m1", weight: 8 }],
    }));
    expect(failoverBody).toEqual({
      id: "free",
      combo: {
        targets: [{ provider: "a", model: "m1" }],
        strategy: "failover",
        defaultEffort: "medium",
      },
    });
    expect("stickyLimit" in failoverBody.combo).toBe(false);
    expect("weight" in failoverBody.combo.targets[0]!).toBe(false);
  });

  test("toPutBody carries alias and renameFrom only when set", () => {
    const aliased = toPutBody(combo({ alias: " deepseek-v4-flash " }));
    expect(aliased).toEqual({
      id: "free",
      combo: {
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
        strategy: "failover",
        defaultEffort: "medium",
        alias: "deepseek-v4-flash",
      },
    });
    expect("renameFrom" in aliased).toBe(false);

    const renamed = toPutBody(combo({ id: "new-name" }), { renameFrom: "free" });
    expect(renamed.id).toBe("new-name");
    expect(renamed.renameFrom).toBe("free");
    expect("alias" in renamed.combo).toBe(false);
  });

  test("rejects duplicate targets", () => {
    expect(validate(combo({
      targets: [
        { provider: "a", model: "same" },
        { provider: "a", model: "same" },
      ],
    }))).toBe("duplicateTarget");
  });

  test("rejects fractional, zero, and over-max sticky limits and weights", () => {
    for (const stickyLimit of [1.5, 0, 101]) {
      expect(validate(combo({ strategy: "round-robin", stickyLimit }))).toBe("invalidStickyLimit");
    }
    for (const weight of [1.5, 0, 10001]) {
      expect(validate(combo({
        strategy: "round-robin",
        targets: [{ provider: "a", model: "m1", weight }],
      }))).toBe("invalidWeight");
    }
  });

  test("rejects unknown providers and namespace collisions", () => {
    expect(validate(combo({
      targets: [{ provider: "missing", model: "m1" }],
    }))).toBe("unknownProvider");
    expect(validate(combo({ id: "a" }))).toBe("providerCollision");
    expect(validate(combo(), {
      providers: { ...configuredProviders, combo: {} },
    })).toBe("reservedNamespace");
  });

  test("allows mixed enabled and disabled members but rejects all-disabled drafts", () => {
    expect(validate(combo({
      targets: [
        { provider: "disabled", model: "m1" },
        { provider: "a", model: "m2" },
      ],
    }))).toBeNull();
    expect(validate(combo({
      targets: [{ provider: "disabled", model: "m1" }],
    }))).toBe("noEnabledTarget");
  });

  test("preserves an existing legacy chatgpt member through validation and PUT", () => {
    const existing = combo({
      targets: [{ provider: "chatgpt", model: "gpt-5.5" }],
    });

    expect(validate(existing, {
      providers: {
        openai: {},
        chatgpt: {},
      },
    })).toBeNull();
    expect(toPutBody(existing).combo.targets).toEqual([
      { provider: "chatgpt", model: "gpt-5.5" },
    ]);
  });

  test("draftEquals includes strategy, sticky limit, effort, order, and weight", () => {
    const baseline = combo({
      strategy: "round-robin",
      stickyLimit: 2,
      defaultEffort: "high",
      targets: [
        { provider: "a", model: "m1", weight: 2 },
        { provider: "b", model: "m2", weight: 1 },
      ],
    });

    expect(draftEquals(baseline, { ...baseline })).toBe(true);
    expect(draftEquals(baseline, { ...baseline, strategy: "failover" })).toBe(false);
    expect(draftEquals(baseline, { ...baseline, stickyLimit: 3 })).toBe(false);
    expect(draftEquals(baseline, { ...baseline, defaultEffort: "low" })).toBe(false);
    expect(draftEquals(baseline, { ...baseline, targets: [...baseline.targets].reverse() })).toBe(false);
    expect(draftEquals(baseline, {
      ...baseline,
      targets: [{ ...baseline.targets[0]!, weight: 4 }, baseline.targets[1]!],
    })).toBe(false);
  });

  test("draftEquals tracks id and alias edits for rename and public-name flows", () => {
    const baseline = combo();

    expect(draftEquals(baseline, { ...baseline })).toBe(true);
    expect(draftEquals(baseline, { ...baseline, id: "renamed" })).toBe(false);
    expect(draftEquals(baseline, { ...baseline, alias: "deepseek-v4-flash" })).toBe(false);
    expect(draftEquals(
      { ...baseline, alias: "deepseek-v4-flash" },
      { ...baseline, alias: null },
    )).toBe(false);
  });
});
