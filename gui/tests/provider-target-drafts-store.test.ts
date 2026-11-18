import { expect, test } from "bun:test";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import {
  createProviderDraftStore,
  draftRequestPacing,
  providerSettingsDraftFromItem,
  providerSettingsDirty,
  providerSettingsFieldsDirty,
  providerSettingsPacingDirty,
  mergeProviderPacing,
  providerDraftTargetLabel,
} from "../src/provider-workspace/target-drafts";
import { threeWayMergeJson } from "../src/provider-workspace/provider-draft-merge";

function provider(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    name: "shared-provider",
    adapter: "openai-chat",
    baseUrl: "https://a.example.test/v1",
    authMode: "key",
    note: "saved",
    hasApiKey: true,
    ...overrides,
  } as WorkspaceItem;
}

test("the draft store isolates a same-name provider on two targets", () => {
  const store = createProviderDraftStore();
  const draftA = providerSettingsDraftFromItem(provider());
  const draftB = { ...draftA, note: "B draft" };
  store.write("/a", "shared-provider", { draft: draftA, baseline: draftA });
  store.write("/b", "shared-provider", { draft: draftB, baseline: draftB });

  expect(store.read("/a", "shared-provider")?.draft.note).toBe("saved");
  expect(store.read("/b", "shared-provider")?.draft.note).toBe("B draft");
  store.clear("/a", "shared-provider");
  expect(store.read("/a", "shared-provider")).toBeUndefined();
  expect(store.read("/b", "shared-provider")?.draft.note).toBe("B draft");
});

test("only applicable fields make the Settings draft dirty", () => {
  const saved = provider();
  const draft = providerSettingsDraftFromItem(saved);
  expect(providerSettingsFieldsDirty(draft, saved)).toBe(false);

  expect(providerSettingsFieldsDirty({ ...draft, note: "edited" }, saved)).toBe(true);
  // Vertex project/location are not part of an openai-chat provider's saved shape.
  expect(providerSettingsFieldsDirty({ ...draft, project: "ignored", location: "ignored" }, saved)).toBe(false);
  // Anthropic-only key transport is likewise not applicable here.
  expect(providerSettingsFieldsDirty({ ...draft, apiKeyTransport: "bearer" }, saved)).toBe(false);
});

test("pacing is its own dirty axis and ignores model/key order", () => {
  const saved = provider({ requestPacing: {
    enabled: true,
    requestsPerMinute: 30,
    models: { beta: { minIntervalMs: 20 }, alpha: { maxConcurrentRequests: 2 } },
    keys: { requestsPerMinute: 10 },
  } });
  const draft = providerSettingsDraftFromItem(saved);
  draft.pacingModels = { alpha: { maxConcurrentRequests: 2 }, beta: { minIntervalMs: 20 } };
  expect(providerSettingsPacingDirty(draft, saved)).toBe(false);
  expect(providerSettingsFieldsDirty(draft, saved)).toBe(false);
  expect(providerSettingsDirty(draft, saved)).toBe(false);

  draft.pacingRpm = "31";
  expect(providerSettingsPacingDirty(draft, saved)).toBe(true);
  expect(providerSettingsFieldsDirty(draft, saved)).toBe(false);
  expect(providerSettingsDirty(draft, saved)).toBe(true);
  expect(draftRequestPacing(draft).requestsPerMinute).toBe(31);
});

test("an omitted liveModels value and an explicit true are the same saved state", () => {
  const omitted = provider();
  const draft = providerSettingsDraftFromItem(omitted);
  expect(draft.liveModels).toBe(true);
  expect(providerSettingsFieldsDirty(draft, provider({ liveModels: true }))).toBe(false);
  expect(providerSettingsFieldsDirty(draft, provider({ liveModels: false }))).toBe(true);
});

test("a newer mount owns the entry and a stale completion cannot write or clear it", () => {
  const store = createProviderDraftStore();
  const base = providerSettingsDraftFromItem(provider());
  const first = Symbol("first");
  const second = Symbol("second");
  store.claim("/a", "shared-provider", first, { draft: base, baseline: base });
  expect(store.writeOwned("/a", "shared-provider", first, { draft: { ...base, note: "first edit" }, baseline: base })).toBe(true);

  const claimed = store.claim("/a", "shared-provider", second, { draft: base, baseline: base });
  expect(claimed.draft.note).toBe("first edit");
  expect(store.writeOwned("/a", "shared-provider", first, { draft: base, baseline: base })).toBe(false);
  expect(store.clearOwned("/a", "shared-provider", first)).toBe(false);
  expect(store.read("/a", "shared-provider")?.draft.note).toBe("first edit");

  expect(store.writeOwned("/a", "shared-provider", second, { draft: { ...base, note: "second edit" }, baseline: base })).toBe(true);
  expect(store.clearOwned("/a", "shared-provider", second)).toBe(true);
  expect(store.read("/a", "shared-provider")).toBeUndefined();
  expect(store.writeOwned("/a", "shared-provider", second, { draft: base, baseline: base })).toBe(false);
});

test("pacing merges different models and subfields independently", () => {
  const baseline = provider({ requestPacing: {
    enabled: true,
    models: { alpha: { requestsPerMinute: 10 }, beta: { requestsPerMinute: 20 } },
  } });
  const baselineDraft = providerSettingsDraftFromItem(baseline);
  const draft = { ...baselineDraft, pacingModels: { alpha: { requestsPerMinute: 11 }, beta: { requestsPerMinute: 20 } } };
  const merged = mergeProviderPacing(baselineDraft, draft, {
    enabled: true,
    models: { alpha: { requestsPerMinute: 10 }, beta: { requestsPerMinute: 99 }, gamma: { requestsPerMinute: 30 } },
  });
  expect(merged.models).toEqual({
    alpha: { requestsPerMinute: 11 },
    beta: { requestsPerMinute: 99 },
    gamma: { requestsPerMinute: 30 },
  });
});

test("JSON merge keeps prototype-named keys as own data and labels drop composite identity", () => {
  const latest = JSON.parse('{"__proto__":{"polluted":true},"provider":{"note":"saved"}}');
  const draft = JSON.parse('{"provider":{"note":"user"}}');
  const merged = threeWayMergeJson({}, latest, draft);
  expect(Object.hasOwn(merged.value as object, "__proto__")).toBe(true);
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  expect(providerDraftTargetLabel("https://hub.example\u0000key-material")).toBe("https://hub.example");
});
