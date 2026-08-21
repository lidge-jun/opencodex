import { expect, test } from "bun:test";
import {
  sidecarBackendForModel,
  webSearchModelOptionsForPicker,
  webSearchSidecarSelectionForModel,
  visionModelOptions,
  visionSidecarBackendForModel,
  type ModelInfo,
  type VisionModelOption,
} from "../src/pages/dashboard-shared";

const models: ModelInfo[] = [
  { id: "gpt-5.6-luna", provider: "openai", namespaced: "gpt-5.6-luna" },
  { id: "o3-mini", provider: "openai", namespaced: "o3-mini" },
  { id: "claude-haiku-4-5", provider: "anthropic", namespaced: "anthropic/claude-haiku-4-5" },
  { id: "grok-4.5", provider: "xai", namespaced: "xai/grok-4.5" },
];

const serverOptions: VisionModelOption[] = [
  { value: "gpt-5.6-luna", label: "gpt-5.6-luna", backend: "openai", baseline: true },
  { value: "claude-haiku-4-5", label: "claude-haiku-4-5", backend: "anthropic", baseline: true },
];

test("the server list wins over the legacy provider-name list", () => {
  const options = visionModelOptions(serverOptions, models, "gpt-5.6-luna");
  expect(options.map(option => option.value)).toEqual(["gpt-5.6-luna", "claude-haiku-4-5"]);
  // o3-mini is an openai row, so the legacy list would have offered it.
  expect(options.some(option => option.value === "o3-mini")).toBe(false);
});

test("an absent server list falls back instead of emptying the picker", () => {
  // A server that predates this field must not leave the user with no options at
  // all; the legacy openai+anthropic list is the documented degrade path.
  const options = visionModelOptions(undefined, models, undefined);
  expect(options.map(option => option.value)).toEqual(["gpt-5.6-luna", "o3-mini", "claude-haiku-4-5"]);
});

test("an empty server list is authoritative and does not resurrect text-only rows", () => {
  // A current server that computed no eligible describer is not a legacy server. Falling
  // back here would re-offer o3-mini, the exact row the filter exists to remove.
  const options = visionModelOptions([], models, undefined);
  expect(options).toEqual([]);
});

test("the configured model stays selectable, exactly once", () => {
  // Grandfathering a model the server no longer lists keeps the picker honest
  // about what is actually configured.
  const unlisted = visionModelOptions(serverOptions, models, "custom-vision");
  expect(unlisted[0]?.value).toBe("custom-vision");
  expect(unlisted.filter(option => option.value === "custom-vision")).toHaveLength(1);

  const alreadyListed = visionModelOptions(serverOptions, models, "claude-haiku-4-5");
  expect(alreadyListed.filter(option => option.value === "claude-haiku-4-5")).toHaveLength(1);
  expect(alreadyListed.map(option => option.value)).toEqual(["gpt-5.6-luna", "claude-haiku-4-5"]);
});

test("the returned array is fresh, so unshift cannot mutate shared state", () => {
  const first = visionModelOptions(serverOptions, models, "custom-vision");
  const second = visionModelOptions(serverOptions, models, "another-custom");
  expect(first.some(option => option.value === "another-custom")).toBe(false);
  expect(second.some(option => option.value === "custom-vision")).toBe(false);
  expect(serverOptions).toHaveLength(2);
});

test("a server-supplied vision backend wins when the catalog cannot identify its provider", () => {
  const model = "claude-haiku-4-5";
  const options = visionModelOptions([
    // A configured Anthropic adapter need not be named "anthropic", and this
    // model can be absent from the independently refreshed /api/models catalog.
    { value: model, label: model, backend: "anthropic" },
  ], [], undefined);

  // This documents the old save-path result: catalog inference alone defaults
  // to OpenAI when there is no matching model row.
  expect(sidecarBackendForModel([], model)).toBe("openai");
  expect(visionSidecarBackendForModel([], options, model)).toBe("anthropic");
});

test("an older server with no option list cannot rewrite the persisted anthropic backend", () => {
  const model = "claude-grandfathered";
  // The compatibility path: a server that predates visionModels sends nothing, and the
  // configured model is absent from the catalog. Without the persisted backend travelling
  // with the grandfathered entry, the next save would silently downgrade it to openai.
  const options = visionModelOptions(undefined, [], model, "anthropic");

  expect(options[0]).toMatchObject({ value: model, backend: "anthropic" });
  expect(visionSidecarBackendForModel([], options, model)).toBe("anthropic");
  expect(sidecarBackendForModel([], model)).toBe("openai");
});

test("an authoritative empty list still keeps the configured model and its backend", () => {
  const model = "claude-grandfathered";
  const options = visionModelOptions([], [], model, "anthropic");

  // Nothing is eligible, but the user's own configured model stays visible and keeps the
  // backend it was saved with, so opening the picker cannot silently rewrite it.
  expect(options.map(option => option.value)).toEqual([model]);
  expect(visionSidecarBackendForModel([], options, model)).toBe("anthropic");
});

test("a server web-search auth-slot option keeps its backend without a catalog row", () => {
  const model = "claude-haiku-4-5";
  const options = webSearchModelOptionsForPicker([
    { value: model, label: model, backend: "anthropic", model, authSlot: true },
  ], [], undefined);

  expect(webSearchSidecarSelectionForModel([], options, model)).toEqual({
    backend: "anthropic",
    model,
  });
});
