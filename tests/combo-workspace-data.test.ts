import { describe, expect, test } from "bun:test";
import {
  type ComboItem,
  COMBO_EFFORTS,
  buildComboAttention,
  comboPublicModelId,
  draftEquals,
  emptyDraft,
  filterCombos,
  groupCombos,
  intersectComboEfforts,
  isValidComboId,
  parseComboList,
  toPutBody,
  updateComboAliasDraft,
  validateComboDraft,
} from "../gui/src/combo-workspace-data";
import { comboImagesSupported } from "../gui/src/combo-capabilities";

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
    nativeAlias: false,
    displayName: null,
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
        nativeAlias: false,
        displayName: null,
        strategy: "failover",
        stickyLimit: 1,
        defaultEffort: null,
        imageInput: "auto",
        targets: [{ provider: "a", model: "m1", weight: 1, clientKey: expect.stringMatching(/^ct-\d+$/) }],
      },
      {
        id: "weighted",
        model: "combo/weighted",
        alias: null,
        nativeAlias: false,
        displayName: null,
        strategy: "round-robin",
        stickyLimit: 4,
        defaultEffort: "high",
        imageInput: "auto",
        targets: [
          { provider: "a", model: "m1", weight: 3, clientKey: expect.stringMatching(/^ct-\d+$/) },
          { provider: "b", model: "m2", weight: 1, clientKey: expect.stringMatching(/^ct-\d+$/) },
        ],
      },
    ]);
    // UI-only keys must be unique across the parsed list.
    const keys = items.flatMap((item) => item.targets.map((t) => t.clientKey));
    expect(new Set(keys).size).toBe(keys.length);
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

  test("intersectComboEfforts keeps only common advertised efforts (#488)", () => {
    const map = new Map<string, readonly string[] | undefined>([
      ["a/m1", ["low", "medium", "high", "ultra"]],
      ["b/m2", ["medium", "high", "xhigh"]],
    ]);
    expect(intersectComboEfforts(
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      map,
    )).toEqual(["medium", "high"]);
  });

  test("intersectComboEfforts treats unknown members as picker wildcards", () => {
    const map = new Map<string, readonly string[] | undefined>([
      ["a/m1", ["low", "medium"]],
    ]);
    expect(intersectComboEfforts(
      [{ provider: "a", model: "m1" }, { provider: "b", model: "unknown" }],
      map,
    )).toEqual(["low", "medium"]);
    expect(intersectComboEfforts(
      [{ provider: "b", model: "unknown" }],
      map,
    )).toEqual(COMBO_EFFORTS);
  });

  test("intersectComboEfforts keeps an advertised empty ladder restrictive", () => {
    const map = new Map<string, readonly string[] | undefined>([
      ["a/m1", ["low", "medium"]],
      ["b/no-reasoning", []],
    ]);
    expect(intersectComboEfforts(
      [{ provider: "a", model: "m1" }, { provider: "b", model: "no-reasoning" }],
      map,
    )).toEqual([]);
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

  test("attention flags combos missing from the live catalog (#484)", () => {
    const attention = buildComboAttention(
      [
        combo({ id: "ok" }),
        combo({ id: "missing", model: "combo/missing" }),
        combo({ id: "empty", model: "combo/empty", targets: [] }),
      ],
      { cataloguedComboIds: new Set(["ok"]) },
    );
    expect(attention).toEqual([
      { id: "missing", model: "combo/missing", reason: "catalog-omitted" },
      { id: "empty", model: "combo/empty", reason: "empty-targets" },
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
    expect(validate(combo({
      alias: "gpt-5.6-sol",
      nativeAlias: true,
      displayName: "Nova1 - Sol",
    }))).toBeNull();
    expect(validate(combo({
      alias: "ordinary-alias",
      nativeAlias: true,
      displayName: "Nova1 - Sol",
    }))).toBe("unsupportedNativeAlias");
    expect(validate(combo({
      alias: "gpt-unknown",
      nativeAlias: true,
      displayName: "Nova1 - Unknown",
    }))).toBe("unsupportedNativeAlias");
    expect(validate(combo({
      alias: "gpt-5.6-sol",
      nativeAlias: true,
      displayName: null,
    }))).toBe("missingNativeAliasDisplayName");
    expect(validate(combo({
      alias: "gpt-5.6-sol",
      nativeAlias: true,
      displayName: `Nova1${String.fromCharCode(10)}Sol`,
    }))).toBe("invalidDisplayName");
    // Slashed ids in the same families are fine — only BARE names collide with natives.
    expect(validate(combo({ alias: "openai/gpt-5" }))).toBeNull();
    expect(validate(combo({ alias: "taken" }), { existingAliases: ["taken"] })).toBe("duplicateAlias");
    expect(validate(combo({ alias: "taken" }), { existingAliases: ["other"] })).toBeNull();
  });

  test("alias edits can convert a hidden native alias back to an ordinary combo", () => {
    const native = combo({
      alias: "gpt-5.6-sol",
      nativeAlias: true,
      displayName: "Nova1 - Sol",
    });

    const ordinary = updateComboAliasDraft(native, "fast-chat");
    expect(ordinary).toMatchObject({
      alias: "fast-chat",
      model: "fast-chat",
      nativeAlias: false,
      displayName: null,
    });
    expect(validate(ordinary)).toBeNull();
    expect(toPutBody(ordinary).combo).not.toHaveProperty("nativeAlias");
    expect(toPutBody(ordinary).combo).not.toHaveProperty("displayName");

    expect(updateComboAliasDraft(native, "")).toMatchObject({
      alias: null,
      model: "combo/free",
      nativeAlias: false,
      displayName: null,
    });
    expect(updateComboAliasDraft(native, "gpt-5.6-terra")).toMatchObject({
      nativeAlias: true,
      displayName: "Nova1 - Sol",
    });
  });

  test("create drafts support bare, custom-prefixed, and default public names", () => {
    expect(comboPublicModelId("aka", "aka")).toBe("aka");
    expect(comboPublicModelId("aka", "vendor/aka")).toBe("vendor/aka");
    expect(comboPublicModelId("aka", null)).toBe("combo/aka");

    const bare = combo({ id: "aka", model: "aka", alias: "aka" });
    expect(validate(bare, { isCreate: true })).toBeNull();
    expect(toPutBody(bare).combo.alias).toBe("aka");

    const defaultName = combo({ id: "aka", model: "combo/aka", alias: null });
    expect(validate(defaultName, { isCreate: true })).toBeNull();
    expect("alias" in toPutBody(defaultName).combo).toBe(false);
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
    // clientKey is UI-only — never serialize it upstream even when present on the draft.
    const withClientKeys = toPutBody(combo({
      targets: [
        { provider: "a", model: "m1", clientKey: "ct-ui-1" },
        { provider: "b", model: "m2", clientKey: "ct-ui-2" },
      ],
    }));
    expect(withClientKeys.combo.targets.every((t) => !("clientKey" in t))).toBe(true);
  });

  test("preserves an unset effort through parse, draft, and PUT", () => {
    expect(parseComboList({ combos: [{ id: "free", targets: [] }] })[0]?.defaultEffort).toBeNull();
    expect(emptyDraft().defaultEffort).toBeNull();
    const draft = combo({ defaultEffort: null });
    expect(toPutBody(draft).combo.defaultEffort).toBeNull();
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

  test("parse and PUT preserve advanced native-alias fields", () => {
    const parsed = parseComboList({
      combos: [{
        id: "nova-sol",
        model: "gpt-5.6-sol",
        alias: "gpt-5.6-sol",
        nativeAlias: true,
        displayName: "Nova1 - Sol",
        targets: [{ provider: "a", model: "m1" }],
      }],
    })[0]!;

    expect(parsed).toMatchObject({
      nativeAlias: true,
      displayName: "Nova1 - Sol",
    });
    expect(toPutBody(parsed).combo).toMatchObject({
      alias: "gpt-5.6-sol",
      nativeAlias: true,
      displayName: "Nova1 - Sol",
    });
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


describe("comboImagesSupported", () => {
  test("returns false with no targets or incomplete targets", () => {
    expect(comboImagesSupported([], [])).toBe(false);
    expect(comboImagesSupported([{ provider: "", model: "" }], [])).toBe(false);
    expect(comboImagesSupported(
      [{ provider: "a", model: "vision" }, { provider: "", model: "" }],
      [{ provider: "a", id: "vision", inputModalities: ["text", "image"] }],
    )).toBe(false);
  });

  test("returns true only when every complete target advertises image", () => {
    const models = [
      { provider: "a", id: "m1", inputModalities: ["text", "image"] },
      { provider: "b", id: "m2", inputModalities: ["text", "image"] },
    ];
    expect(comboImagesSupported(
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      models,
    )).toBe(true);
  });

  test("returns false when any target is missing from the catalog or lacks image", () => {
    const models = [
      { provider: "a", id: "m1", inputModalities: ["text", "image"] },
      { provider: "b", id: "m2", inputModalities: ["text"] },
    ];
    expect(comboImagesSupported(
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      models,
    )).toBe(false);
    expect(comboImagesSupported(
      [{ provider: "a", model: "m1" }, { provider: "b", model: "ghost" }],
      models,
    )).toBe(false);
  });
});

describe("combo imageInput draft persistence", () => {
  test("parseComboList preserves explicit disabled", () => {
    const items = parseComboList({
      combos: [{
        id: "limited",
        strategy: "failover",
        imageInput: "disabled",
        targets: [{ provider: "a", model: "m1" }],
      }],
    });
    expect(items[0]?.imageInput).toBe("disabled");
  });

  test("draftEquals distinguishes disabled from auto", () => {
    const base = emptyDraft("x");
    const disabled = { ...base, imageInput: "disabled" as const };
    expect(draftEquals(base, { ...base, imageInput: "auto" })).toBe(true);
    expect(draftEquals(base, disabled)).toBe(false);
  });

  test("toPutBody emits imageInput only when disabled", () => {
    const auto = emptyDraft("x");
    auto.targets = [{ provider: "a", model: "m1" }];
    expect(toPutBody(auto).combo).not.toHaveProperty("imageInput");
    const disabled = { ...auto, imageInput: "disabled" as const };
    expect(toPutBody(disabled).combo.imageInput).toBe("disabled");
  });
});
