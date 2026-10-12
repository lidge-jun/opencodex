/**
 * Devin model resolution over the catalog's family metadata
 * (ClientModelConfig #23 ModelInfo, #30 ModelFamilyMetadata, #31 default flag).
 *
 * Row shapes mirror a live GetCascadeModelConfigs response captured 2026-09-27:
 * bare `swe-1-7` is the Max row while `swe-1-7-medium` is the family default,
 * SWE-2 has no bare row, GLM-5.2's bare row is its default, Fast Mode is a
 * `-fast` suffix on Claude and `-priority` on GPT, and three families share a
 * string prefix with a different family.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveWireModelUidForTests } from "../../src/adapters/devin";
import { fetchDevinUsableModels, selectDevinFamilyMember } from "../../src/adapters/devin/live-models";
import { parseCatalogBuffer, setCachedCatalogForTests, type CacheEntry } from "../../src/adapters/devin/cloud-direct/catalog";
import { encodeMessage, encodeString, encodeVarintField } from "../../src/adapters/devin/cloud-direct/wire";

const HOST = "https://server.codeium.com";
const KEY = "devin-family-resolution-test-key";

interface Row {
  uid: string;
  family?: string;
  axes?: Array<[key: string, order: number, name?: string]>;
  isDefault?: boolean;
  maxOut?: number;
  images?: boolean;
  disabled?: boolean;
  thinking?: boolean;
}

function row(r: Row): Buffer {
  const info = Buffer.concat([
    ...(r.thinking !== undefined ? [encodeMessage(6, encodeVarintField(15, r.thinking ? 1 : 0))] : []),
    ...(r.maxOut !== undefined ? [encodeVarintField(13, r.maxOut)] : []),
    ...(r.family ? [encodeString(23, r.family)] : []),
  ]);
  const meta = r.axes ? Buffer.concat([
    encodeString(1, r.family ?? ""),
    ...r.axes.map(([key, order, name]) => encodeMessage(2, Buffer.concat([
      encodeString(1, key),
      encodeMessage(2, Buffer.concat([
        ...(order ? [encodeVarintField(1, order)] : []),
        ...(name ? [encodeString(2, name)] : []),
      ])),
    ]))),
    ...(r.isDefault ? [encodeVarintField(3, 1)] : []),
  ]) : undefined;
  return encodeMessage(1, Buffer.concat([
    encodeString(1, r.uid),
    ...(r.disabled ? [encodeVarintField(4, 1)] : []),
    ...(r.images !== undefined ? [encodeVarintField(5, r.images ? 1 : 0)] : []),
    encodeString(22, r.uid),
    ...(info.length > 0 ? [encodeMessage(23, info)] : []),
    ...(meta ? [encodeMessage(30, meta)] : []),
    ...(r.isDefault ? [encodeVarintField(31, 1)] : []),
  ]));
}

const EFFORT5 = ["Low", "Medium", "High", "XHigh", "Max"] as const;

function claudeFamily(family: string, prefix: string): Row[] {
  const rows: Row[] = [];
  for (const fast of [0, 1]) {
    EFFORT5.forEach((name, order) => rows.push({
      uid: `${prefix}-${name.toLowerCase()}${fast ? "-fast" : ""}`,
      family,
      axes: [["Effort", order, name], ["Thinking", 1], ["Fast Mode", fast], ["1M Context", 0]],
      isDefault: !fast && name === "Medium",
      maxOut: 128_000,
      images: true,
      thinking: true,
    }));
  }
  return rows;
}

function gptFamily(family: string, prefix: string, withDefault = true): Row[] {
  const rows: Row[] = [];
  const names = ["None", "Low", "Medium", "High", "XHigh", "Max"];
  for (const fast of [0, 1]) {
    names.forEach((name, order) => rows.push({
      uid: `${prefix}-${name.toLowerCase()}${fast ? "-priority" : ""}`,
      family,
      axes: [["Reasoning Effort", order, name], ["Fast Mode", fast], ["Prompt Cache Retention", 1, "24h"]],
      isDefault: withDefault && !fast && name === "Medium",
      maxOut: 128_000,
    }));
  }
  return rows;
}

const LIVE_ROWS: Row[] = [
  { uid: "swe-1-7", family: "swe-1.7", axes: [["Reasoning Effort", 5, "Max"]], maxOut: 128_000, images: true },
  { uid: "swe-1-7-medium", family: "swe-1.7", axes: [["Reasoning Effort", 2, "Medium"]], isDefault: true, maxOut: 128_000, images: true },
  { uid: "swe-2-medium", family: "swe-2", axes: [["Reasoning Effort", 0, "Medium"]], maxOut: 128_000, images: true },
  { uid: "swe-2-high", family: "swe-2", axes: [["Reasoning Effort", 1, "High"]], isDefault: true, maxOut: 128_000, images: true },
  { uid: "swe-2-max", family: "swe-2", axes: [["Reasoning Effort", 2, "Max"]], maxOut: 128_000, images: true },
  ...claudeFamily("claude-opus-5", "claude-opus-5"),
  ...claudeFamily("claude-opus-5-5", "claude-opus-5-5"),
  ...gptFamily("gpt-6-sol", "gpt-6-sol"),
  // gpt-5.4 marks no default member; gpt-5.4-mini shares its string prefix.
  ...gptFamily("gpt-5.4", "gpt-5-4", false),
  { uid: "gpt-5-4-mini-low", family: "gpt-5.4-mini", axes: [["Reasoning Effort", 0, "Low"]] },
  { uid: "glm-5-2", family: "glm-5.2", axes: [["Effort", 1, "High"], ["1M Context", 0]], isDefault: true },
  { uid: "glm-5-2-max", family: "glm-5.2", axes: [["Effort", 2, "Max"], ["1M Context", 0]] },
  { uid: "glm-5-2-none", family: "glm-5.2", axes: [["Effort", 0, "No Thinking"], ["1M Context", 0]] },
  { uid: "glm-5-2-1m", family: "glm-5.2", axes: [["Effort", 1, "High"], ["1M Context", 1]] },
  { uid: "glm-5-2-max-1m", family: "glm-5.2", axes: [["Effort", 2, "Max"], ["1M Context", 1]] },
  { uid: "glm-5-2-none-1m", family: "glm-5.2", axes: [["Effort", 0, "No Thinking"], ["1M Context", 1]] },
  { uid: "glm-5-3-high", family: "glm-5-3", axes: [["Effort", 1, "High"]], isDefault: true },
  { uid: "glm-5-3-flash-low", family: "glm-5-3-flash", axes: [["Effort", 0, "Low"]], isDefault: true },
  { uid: "kimi-k3-low", family: "kimi-k3", axes: [["Reasoning Effort", 0, "Low"]], maxOut: 131_072, images: true },
  { uid: "kimi-k3-high", family: "kimi-k3", axes: [["Reasoning Effort", 1, "High"]], isDefault: true, maxOut: 131_072, images: true },
  { uid: "kimi-k3-max", family: "kimi-k3", axes: [["Reasoning Effort", 2, "Max"]], maxOut: 131_072, images: true },
  { uid: "claude-sonnet-4-6", family: "claude-sonnet-4.6", axes: [["Effort", 2, "High"], ["Thinking", 0], ["Fast Mode", 0], ["1M Context", 0]] },
  { uid: "claude-sonnet-4-6-thinking", family: "claude-sonnet-4.6", axes: [["Effort", 2, "High"], ["Thinking", 1], ["Fast Mode", 0], ["1M Context", 0]], isDefault: true },
  { uid: "claude-sonnet-4-6-1m", family: "claude-sonnet-4.6", axes: [["Effort", 2, "High"], ["Thinking", 0], ["Fast Mode", 0], ["1M Context", 1]] },
  { uid: "gemini-3-5-flash-minimal", family: "gemini-3.5-flash", axes: [["Reasoning Effort", 0, "Minimal"]] },
  { uid: "gemini-3-5-flash-medium", family: "gemini-3.5-flash", axes: [["Reasoning Effort", 2, "Medium"]], isDefault: true },
  // Both assert #5 true; only swe-1-6 is measured image-blind.
  { uid: "swe-1-6", family: "swe-1.6", axes: [["Speed", 0]], images: true, maxOut: 128_000 },
  { uid: "swe-1-6-fast", family: "swe-1.6-fast", axes: [["Speed", 1]], images: true, maxOut: 128_000 },
  // Legacy rows carry no family metadata.
  { uid: "MODEL_PRIVATE_11", maxOut: 64_000 },
];

function catalogOf(rows: Row[]): CacheEntry {
  return parseCatalogBuffer(Buffer.concat(rows.map(row)), KEY, HOST);
}

const resolve = (catalog: CacheEntry, model: string, effort?: string) =>
  resolveWireModelUidForTests(model, KEY, HOST, effort, catalog);

describe("catalog family metadata parsing", () => {
  const catalog = catalogOf(LIVE_ROWS);

  test("reads ModelInfo, family axes and the default flag", () => {
    expect(catalog.byUid.get("swe-1-7-medium")).toMatchObject({
      familyUid: "swe-1.7",
      familyLabel: "swe-1.7",
      familyAxes: { "Reasoning Effort": { order: 2, name: "Medium" } },
      isFamilyDefault: true,
      maxOutputTokens: 128_000,
    });
    expect(catalog.byUid.get("swe-1-7")?.isFamilyDefault).toBeUndefined();
    expect(catalog.byUid.get("claude-opus-5-low-fast")).toMatchObject({
      supportsThinking: true,
      familyAxes: { "Fast Mode": { order: 1 }, Thinking: { order: 1 }, Effort: { order: 0, name: "Low" } },
    });
    expect(catalog.byUid.get("MODEL_PRIVATE_11")).toMatchObject({ maxOutputTokens: 64_000 });
    expect(catalog.byUid.get("MODEL_PRIVATE_11")?.familyAxes).toBeUndefined();
  });

  test("swe-1-6 is text-only even though its row asserts images; swe-1-6-fast is not", () => {
    expect(catalog.byUid.get("swe-1-6")?.supportsImages).toBe(false);
    expect(catalog.byUid.get("swe-1-6-fast")?.supportsImages).toBe(true);
  });
});

describe("family-based wire model resolution", () => {
  const catalog = catalogOf(LIVE_ROWS);

  test.each([
    // An effort moves only the effort axis; bare swe-1-7 is Max, not the default.
    ["swe-1-7", "medium", "swe-1-7-medium"],
    ["swe-1-7", undefined, "swe-1-7-medium"],
    ["swe-1.7", undefined, "swe-1-7-medium"],
    ["swe-1-7", "max", "swe-1-7"],
    // A missing rung rounds up, never down: SWE-1.7 has only Medium and Max.
    ["swe-1-7", "high", "swe-1-7"],
    ["swe-1-7", "low", "swe-1-7-medium"],
    ["swe-1-7-high", undefined, "swe-1-7"],
    ["swe-2", undefined, "swe-2-high"],
    ["swe-2", "max", "swe-2-max"],
    ["swe-2", "low", "swe-2-medium"],
    ["swe-2", "xhigh", "swe-2-max"],
    ["swe-2-high", "medium", "swe-2-medium"],
    ["glm-5-2", undefined, "glm-5-2"],
    ["glm-5.2", undefined, "glm-5-2"],
    ["glm-5-2", "none", "glm-5-2-none"],
    ["glm-5-2", "max-1m", "glm-5-2-max-1m"],
    ["glm-5-2", "1m", "glm-5-2-1m"],
    // Fast Mode and 1M Context stay at the default member's values unless asked.
    ["claude-opus-5", undefined, "claude-opus-5-medium"],
    ["claude-opus-5", "fast", "claude-opus-5-medium-fast"],
    ["claude-opus-5", "HIGH", "claude-opus-5-high"],
    ["claude-opus-5-high-fast", "low", "claude-opus-5-low-fast"],
    ["claude-opus-5-high-fast", undefined, "claude-opus-5-high-fast"],
    ["gpt-6-sol", "fast", "gpt-6-sol-medium-priority"],
    ["gpt-6-sol", "none", "gpt-6-sol-none"],
    ["gpt-6-sol", "priority", "gpt-6-sol-medium"],
    ["gpt-6-sol-medium-priority", undefined, "gpt-6-sol-medium-priority"],
    // Nearest rung, ties to the higher one; never another family.
    ["kimi-k3", "medium", "kimi-k3-high"],
    ["kimi-k3", "xhigh", "kimi-k3-max"],
    ["claude-opus-5", "none", "claude-opus-5-low"],
    // `none` switches Thinking off where that is how the family spells it.
    ["claude-sonnet-4-6", undefined, "claude-sonnet-4-6-thinking"],
    ["claude-sonnet-4-6", "none", "claude-sonnet-4-6"],
    ["gemini-3-5-flash", "minimal", "gemini-3-5-flash-minimal"],
    // No default member: every toggle at its lowest order, effort nearest Medium.
    ["gpt-5-4", undefined, "gpt-5-4-medium"],
    ["glm-5-3", "medium", "glm-5-3-high"],
    ["swe-1-6", undefined, "swe-1-6"],
    ["swe-1-6-fast", undefined, "swe-1-6-fast"],
    ["MODEL_PRIVATE_11", undefined, "MODEL_PRIVATE_11"],
  ] as Array<[string, string | undefined, string]>)("%s @ %s -> %s", async (model, effort, expected) => {
    expect(await resolve(catalog, model, effort)).toBe(expected);
  });

  test("a disabled member is passed over while the family has an enabled one", async () => {
    const rows = LIVE_ROWS.map((r) => (r.uid === "swe-2-high" ? { ...r, disabled: true } : r));
    // High (the default) is disabled: the next enabled rung up wins.
    expect(await resolve(catalogOf(rows), "swe-2")).toBe("swe-2-max");
    // Nothing enabled at or above High: the highest enabled rung below it.
    const capped = rows.map((r) => (r.uid === "swe-2-max" ? { ...r, disabled: true } : r));
    expect(await resolve(catalogOf(capped), "swe-2")).toBe("swe-2-medium");
  });

  test("an unknown caller effort keeps a named row", async () => {
    expect(await resolve(catalog, "swe-2-max", "future-effort")).toBe("swe-2-max");
  });

  test("a disabled named row keeps its uid when the request lands on it", async () => {
    const rows = LIVE_ROWS.map((r) => (r.uid === "swe-2-max" ? { ...r, disabled: true } : r));
    // The preflight then names the refused row instead of serving High.
    expect(await resolve(catalogOf(rows), "swe-2-max", "max")).toBe("swe-2-max");
    // A different variant still passes over the disabled row.
    expect(await resolve(catalogOf(rows), "swe-2-max", "high")).toBe("swe-2-high");
    // Naming the family is not naming the row: selection skips it.
    expect(await resolve(catalogOf(rows), "swe-2", "max")).toBe("swe-2-high");
  });

  test("a requested effort is not lowered to keep a toggle", async () => {
    const family = "devin-test-mix";
    const rows: Row[] = [
      { uid: "mix-medium", family, axes: [["Reasoning Effort", 0, "Medium"], ["Fast Mode", 0]], isDefault: true },
      { uid: "mix-high", family, axes: [["Reasoning Effort", 1, "High"], ["Fast Mode", 0]] },
      { uid: "mix-medium-fast", family, axes: [["Reasoning Effort", 0, "Medium"], ["Fast Mode", 1]] },
    ];
    // Named Fast row, asked for at High: no High Fast row exists, so Fast yields.
    expect(await resolve(catalogOf(rows), "mix-medium-fast", "high")).toBe("mix-high");
    // A Fast row at or above the request still wins over dropping Fast.
    const withMaxFast = [...rows, { uid: "mix-max-fast", family, axes: [["Reasoning Effort", 2, "Max"], ["Fast Mode", 1]] } as Row];
    expect(await resolve(catalogOf(withMaxFast), "mix-medium-fast", "high")).toBe("mix-max-fast");
    // An unranked Fast row cannot prove it is not lower than High.
    const unranked: Row[] = [rows[0]!, rows[1]!, { uid: "mix-fast", family, axes: [["Fast Mode", 1]] }];
    expect(await resolve(catalogOf(unranked), "mix-fast", "high")).toBe("mix-high");
    // Without a requested effort, Fast still decides.
    expect(await resolve(catalogOf(rows), "devin-test-mix", "fast")).toBe("mix-medium-fast");
  });

  test("none keeps Thinking off when the Thinking-off row has no rung", async () => {
    const family = "devin-test-think";
    const rows: Row[] = [
      { uid: "think-off", family, axes: [["Thinking", 0]] },
      { uid: "think-high", family, axes: [["Effort", 2, "High"], ["Thinking", 1]], isDefault: true },
    ];
    expect(await resolve(catalogOf(rows), "devin-test-think", "none")).toBe("think-off");
    expect(await resolve(catalogOf(rows), "devin-test-think", "high")).toBe("think-high");
  });

  test("scores distinct family axes without a members-by-axes cross-product", () => {
    // The anchor row carries the wide axis set: the mismatch baseline scans `targets`,
    // which the anchor fills. With per-member baseline recomputation this case is
    // members x axes (~144M iterations); hoisted, it is anchor axes + member axes.
    const wideAxes = Object.fromEntries(
      Array.from({ length: 12_000 }, (_, index) => [`Anchor ${index}`, { order: 1 }]),
    );
    const members = [
      {
        modelUid: "wide-anchor",
        displayName: "wide-anchor",
        familyUid: "wide",
        familyAxes: wideAxes,
        isFamilyDefault: true,
      },
      ...Array.from({ length: 12_000 }, (_, index) => ({
        modelUid: `wide-${index}`,
        displayName: `wide-${index}`,
        familyUid: "wide",
        familyAxes: { [`Axis ${index}`]: { order: 1 } },
      })),
    ];
    const started = performance.now();
    expect(selectDevinFamilyMember(members, {})?.modelUid).toBe("wide-anchor");
    // Wall-clock bound, generous on purpose: the hoist makes this ~36k axis touches
    // (ms even on a contended runner), while the per-member rescan needs ~144M — the
    // bound only has to distinguish those two orders, not measure fast hardware.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test.each(["toString", "constructor", "__proto__"])("counts an extra own %s axis instead of inheriting a target", axis => {
    const member = (modelUid: string, familyAxes: Record<string, { order: number }>) => ({
      modelUid, displayName: modelUid, familyUid: "own-axes", familyAxes,
    });
    const anchor = member("anchor", { A: { order: 1 } });
    const exact = member("exact", { A: { order: 1 } });
    const extra = member("extra", Object.fromEntries([["A", { order: 1 }], [axis, { order: 1 }]]));
    expect(selectDevinFamilyMember([extra, exact], {}, anchor)?.modelUid).toBe("exact");
    const namedAnchor = member("named-anchor", Object.fromEntries([[axis, { order: 2 }]]));
    const namedExact = member("named-exact", Object.fromEntries([[axis, { order: 2 }]]));
    expect(selectDevinFamilyMember([member("missing", {}), namedExact], {}, namedAnchor)?.modelUid).toBe("named-exact");
  });

  test("ranks an exact axis match ahead of missing and extra axes", () => {
    const anchor = {
      modelUid: "axis-anchor",
      displayName: "axis-anchor",
      familyUid: "wide",
      familyAxes: { A: { order: 1 }, B: { order: 2 } },
      isFamilyDefault: true,
    };
    const exact = {
      modelUid: "axis-exact",
      displayName: "axis-exact",
      familyUid: "wide",
      familyAxes: { A: { order: 1 }, B: { order: 2 } },
    };
    const missing = {
      modelUid: "axis-missing",
      displayName: "axis-missing",
      familyUid: "wide",
      familyAxes: { A: { order: 1 } },
    };
    const extra = {
      modelUid: "axis-extra",
      displayName: "axis-extra",
      familyUid: "wide",
      familyAxes: { A: { order: 1 }, B: { order: 2 }, C: { order: 1 }, D: { order: 3 } },
    };
    // The anchor itself always wins while listed: the ranking claim is about the
    // members it cannot see, so exclude it and pass it explicitly.
    const members = [missing, extra, exact];
    expect(selectDevinFamilyMember(members, {}, anchor)?.modelUid).toBe("axis-exact");
    // Without the exact row, a member missing one target axis scores baseline - 1,
    // while a member matching every target but exposing two extra axes scores
    // 0 + 2 — unequal mismatch counts, so the ordering is proven rather than a tie.
    expect(selectDevinFamilyMember([missing, extra], {}, anchor)?.modelUid).toBe("axis-missing");
  });
});

describe("suffix fallback without family metadata never crosses families", () => {
  // Same uids, no #23/#30/#31: the path an older catalog takes.
  const bare = (uids: string[]) => catalogOf(uids.map((uid) => ({ uid })));

  test.each([
    ["claude-opus-5", ["claude-opus-5-5-low", "claude-opus-5-5-medium-fast"], "claude-opus-5-medium"],
    ["gpt-5-4", ["gpt-5-4-mini-low"], "gpt-5-4-medium"],
    ["glm-5-3", ["glm-5-3-flash-low"], "glm-5-3-medium"],
  ] as Array<[string, string[], string]>)("%s ignores %j", async (model, uids, expected) => {
    expect(await resolve(bare(uids), model)).toBe(expected);
  });

  test("a variant of the same base is still found", async () => {
    expect(await resolve(bare(["claude-opus-5-5-low", "claude-opus-5-high"]), "claude-opus-5")).toBe("claude-opus-5-high");
  });
});

describe("family-aware picker", () => {
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("devin-family-resolution.test.ts reached the network");
    }) as typeof globalThis.fetch;
    setCachedCatalogForTests(catalogOf(LIVE_ROWS));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    setCachedCatalogForTests(null);
  });

  test("collapses rows to families with their real ladders and default effort", async () => {
    const result = await fetchDevinUsableModels({ apiKey: KEY, baseUrl: HOST });
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.models).toContain("swe-1-7");
    expect(result.models).toContain("claude-sonnet-4-6");
    expect(result.models).not.toContain("claude-sonnet-4-6-thinking");
    expect(result.models).not.toContain("MODEL_PRIVATE_11");
    // swe-1-6-fast is its own family, not a variant folded into swe-1-6.
    expect(result.models).toContain("swe-1-6");
    expect(result.models).toContain("swe-1-6-fast");
    expect(result.efforts["swe-1-7"]).toEqual(["medium", "max"]);
    expect(result.defaultEfforts["swe-1-7"]).toBe("medium");
    expect(result.efforts["swe-2"]).toEqual(["medium", "high", "max"]);
    expect(result.defaultEfforts["swe-2"]).toBe("high");
    expect(result.efforts["kimi-k3"]).toEqual(["low", "high", "max"]);
    expect(result.defaultEfforts["kimi-k3"]).toBe("high");
    expect(result.efforts["glm-5-2"]).toEqual(["none", "high", "max"]);
    expect(result.defaultEfforts["glm-5-2"]).toBe("high");
    expect(result.efforts["gpt-6-sol"]).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(result.defaultEfforts["gpt-6-sol"]).toBe("medium");
    expect(result.efforts["gemini-3-5-flash"]).toEqual(["minimal", "medium"]);
    expect(result.defaultEfforts["gemini-3-5-flash"]).toBe("medium");
    // A family without a default member advertises no default effort.
    expect(result.defaultEfforts["gpt-5-4"]).toBeUndefined();
    expect(result.inputModalities["swe-1-6"]).toEqual(["text"]);
    expect(result.inputModalities["swe-1-6-fast"]).toEqual(["text", "image"]);
  });

  test("publishes the enabled default when the marked default is disabled", async () => {
    const family = "devin-test-default";
    const catalog = catalogOf([
      { uid: "default-low", family, axes: [["Reasoning Effort", 0, "Low"]] },
      { uid: "default-high", family, axes: [["Reasoning Effort", 1, "High"]], isDefault: true, disabled: true },
      { uid: "default-max", family, axes: [["Reasoning Effort", 2, "Max"]] },
    ]);
    setCachedCatalogForTests(catalog);
    const result = await fetchDevinUsableModels({ apiKey: KEY, baseUrl: HOST });
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.efforts[family]).toEqual(["low", "max"]);
    expect(result.defaultEfforts[family]).toBe("max");
    expect(await resolve(catalog, family)).toBe("default-max");
  });
});
