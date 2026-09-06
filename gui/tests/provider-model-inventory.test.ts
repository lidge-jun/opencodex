import { expect, test } from "bun:test";
import {
  parseModelInventory,
  countModelInventory,
  parseModelSelection,
  parseCustomModelInventory,
  parseCustomModelCreated,
  catalogRefreshPending,
} from "../src/provider-workspace/model-inventory";
import type { ModelRow } from "../src/pages/models-shared";

const row = (overrides: Partial<ModelRow> = {}): ModelRow => ({
  provider: "vendor", id: "model", namespaced: "vendor/model", disabled: false, ...overrides,
});

test("empty is authoritative; malformed envelopes cannot masquerade as an empty inventory", () => {
  expect(parseModelInventory([])).toEqual([]);
  for (const value of [null, undefined, {}, { models: [] }, "[]", false]) {
    expect(() => parseModelInventory(value)).toThrow();
  }
});

for (const field of ["provider", "id", "namespaced"] as const) {
  for (const value of [undefined, null, "", "  ", 1, [], {}]) {
    test(`inventory rejects invalid ${field}: ${JSON.stringify(value)}`, () => {
      expect(() => parseModelInventory([row(), { ...row(), [field]: value }])).toThrow();
    });
  }
}

for (const field of ["disabled", "native", "custom", "initialSelectionPending"] as const) {
  for (const value of [null, "false", 0, [], {}]) {
    test(`inventory rejects invalid action flag ${field}: ${JSON.stringify(value)}`, () => {
      expect(() => parseModelInventory([{ ...row(), [field]: value }])).toThrow();
    });
  }
}

test("disabled is required; optional action flags may be absent", () => {
  const { disabled: _disabled, ...missing } = row();
  expect(() => parseModelInventory([missing])).toThrow();
  expect(parseModelInventory([row()])).toEqual([row()]);
});

for (const customId of [undefined, null, "", " ", 3]) {
  test(`custom rows require a stable id: ${JSON.stringify(customId)}`, () => {
    expect(() => parseModelInventory([{ ...row(), custom: true, customId }])).toThrow();
  });
}

test("raw identities and native flags are preserved, never inferred from provider or spelling", () => {
  const inputs = [
    row({ provider: "openai", id: "gpt-5.5", namespaced: "gpt-5.5", native: true }),
    row({ provider: "openai", id: "gpt-5.5", namespaced: "openai/gpt-5.5", native: false, custom: true, customId: "c1" }),
    row({ provider: "openai", id: "account-work/gpt-5.5", namespaced: "account-work/gpt-5.5", native: true }),
    row({ id: "vendor/model", namespaced: "vendor/vendor-model" }),
    row({ id: " spaced-id ", namespaced: "vendor/ spaced-id " }),
  ];
  expect(parseModelInventory(inputs)).toEqual(inputs);
});

test("identical identity duplicates collapse without merging separate namespaced rows", () => {
  const native = row({ provider: "openai", namespaced: "model", native: true });
  const routed = row({ provider: "openai", namespaced: "openai/model", custom: true, customId: "c1" });
  expect(parseModelInventory([native, { ...native }, routed])).toEqual([native, routed]);
  expect(countModelInventory(parseModelInventory([native, { ...native }, routed]))).toEqual({ openai: 2 });
});

for (const conflict of [
  { id: "other" }, { disabled: true }, { native: true }, { initialSelectionPending: true },
  { custom: true, customId: "c1" },
]) {
  test(`same provider/selector with conflicting action identity fails closed: ${JSON.stringify(conflict)}`, () => {
    expect(() => parseModelInventory([row(), row(conflict)])).toThrow();
  });
}

test("stable custom ids cannot silently change between otherwise duplicate DTOs", () => {
  expect(() => parseModelInventory([
    row({ custom: true, customId: "old" }), row({ custom: true, customId: "replacement" }),
  ])).toThrow();
});

test("the same namespaced key in distinct provider groups remains distinct", () => {
  const rows = [row(), row({ provider: "another" })];
  expect(parseModelInventory(rows)).toEqual(rows);
  expect(countModelInventory(rows)).toEqual({ vendor: 1, another: 1 });
});

test("counts use unique non-disabled inventory before selection, query or the 300-chip cap", () => {
  const rows = Array.from({ length: 305 }, (_, index) => row({ id: `model-${index}`, namespaced: `vendor/model-${index}` }));
  rows.push({ ...rows[0]! }, row({ id: "hidden", namespaced: "vendor/hidden", disabled: true }),
    row({ provider: "hidden-only", disabled: true }), row({ provider: "other", initialSelectionPending: true, disabled: true }));
  expect(countModelInventory(rows)).toEqual({ vendor: 305, "hidden-only": 0, other: 0 });
  expect(countModelInventory([])).toEqual({});
});

test("prototype-like provider names are own data keys rather than inherited counters", () => {
  const rows = ["__proto__", "constructor", "toString"].map(provider => row({ provider }));
  const counts = countModelInventory(rows);
  for (const provider of ["__proto__", "constructor", "toString"]) {
    expect(Object.hasOwn(counts, provider)).toBe(true); expect(counts[provider]).toBe(1);
  }
});

test("selection retains full available and live provenance independently", () => {
  const value = { selected: { vendor: ["chosen"] }, available: { vendor: ["chosen", "hidden", "not-chosen"] }, liveModelCounts: { vendor: 2 } };
  expect(parseModelSelection(value)).toEqual(value);
  expect(parseModelSelection({ selected: {}, available: {}, liveModelCounts: {} })).toEqual({ selected: {}, available: {}, liveModelCounts: {} });
});

for (const value of [
  null, {}, { selected: [], available: {}, liveModelCounts: {} },
  { selected: {}, available: { vendor: "model" }, liveModelCounts: {} },
  { selected: { vendor: [null] }, available: {}, liveModelCounts: {} },
  { selected: {}, available: {}, liveModelCounts: { vendor: -1 } },
  { selected: {}, available: {}, liveModelCounts: { vendor: "2" } },
]) {
  test(`malformed paired selection fails the observation: ${JSON.stringify(value)}`, () => {
    expect(() => parseModelSelection(value)).toThrow();
  });
}

test("custom ownership validates the full list, including foreign provider rows", () => {
  const record = { id: "stable", provider: "vendor", modelId: "model" };
  expect(parseCustomModelInventory([record])).toEqual([record]);
  for (const value of [null, {}, [{ provider: "vendor", modelId: "model" }], [record, { id: "foreign", provider: "other", modelId: 3 }]]) {
    expect(() => parseCustomModelInventory(value)).toThrow();
  }
  expect(() => parseCustomModelInventory([record, { ...record, provider: "other" }])).toThrow();
  expect(() => parseCustomModelInventory([record, { ...record, modelId: "replacement" }])).toThrow();
});

test("POST adoption requires exact provider, raw model and nonblank stable id", () => {
  const record = { id: "new-id", provider: "vendor", modelId: "vendor/model" };
  expect(parseCustomModelCreated(record, "vendor", "vendor/model")).toEqual(record);
  for (const value of [null, {}, { ...record, id: " " }, { ...record, provider: "other" }, { ...record, modelId: "vendor-model" }]) {
    expect(() => parseCustomModelCreated(value, "vendor", "vendor/model")).toThrow();
  }
});

test("refresh outcome cannot imply success from an absent or malformed disposition", () => {
  expect(catalogRefreshPending({ catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] } })).toBe(false);
  for (const value of [{}, { catalogRefresh: null }, { catalogRefresh: { status: "failed" } }, { catalogRefresh: { status: "unknown" } }]) {
    expect(catalogRefreshPending(value)).toBe(true);
  }
});

test("custom/native flags and used metadata cannot authorize a malformed DTO", () => {
  for (const extra of [
    { custom: true, customId: "c1", native: true }, { customId: "orphan-id" },
    { inputModalities: "text" }, { reasoningEfforts: [null] }, { displayName: [] },
    { contextWindow: "128000" }, { contextCap: Infinity }, { contextCapped: "false" },
  ]) expect(() => parseModelInventory([{ ...row(), ...extra }])).toThrow();
});

test("absent liveModelCounts preserves unknown provenance without losing full selection or inventory", () => {
  const parsed = parseModelSelection({ selected: { vendor: ["chosen"] }, available: { vendor: ["chosen", "other"] } });
  expect(parsed).toEqual({ selected: { vendor: ["chosen"] }, available: { vendor: ["chosen", "other"] }, liveModelCounts: {} });
  expect(Object.hasOwn(parsed.liveModelCounts, "vendor")).toBe(false);
  expect(parseModelSelection({ selected: {}, available: {}, liveModelCounts: { vendor: 0 } }).liveModelCounts)
    .toEqual({ vendor: 0 });
});

for (const liveModelCounts of [null, [], "", 0, false, { vendor: 1.5 }, { vendor: NaN }, { vendor: Infinity }]) {
  test(`present malformed liveModelCounts must not become unknown (${JSON.stringify(liveModelCounts)})`, () => {
    expect(() => parseModelSelection({ selected: {}, available: {}, liveModelCounts })).toThrow();
  });
}
