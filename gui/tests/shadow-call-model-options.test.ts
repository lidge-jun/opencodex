import { expect, test } from "bun:test";
import { shadowCallModelOptions } from "../src/pages/dashboard-shared";

const models = [
  { provider: "openai", id: "gpt-5.6-luna", namespaced: "gpt-5.6-luna" },
  { provider: "xai", id: "gpt-5.6-luna", namespaced: "xai/gpt-5.6-luna" },
  { provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol" },
  { provider: "subapi", id: "gpt-5.6-sol", namespaced: "subapi/gpt-5.6-sol" },
  { provider: "encoded/provider", id: "model/with/slash", namespaced: "encoded%2Fprovider/model%2Fwith%2Fslash" },
];

test("shadow-call options preserve canonical native and routed namespaced ids", () => {
  const options = shadowCallModelOptions(models, undefined);

  expect(options).toContainEqual({ value: "gpt-5.6-sol", label: "gpt-5.6-sol" });
  expect(options).toContainEqual({ value: "subapi/gpt-5.6-sol", label: "subapi/gpt-5.6-sol" });
  expect(options).toContainEqual({ value: "encoded%2Fprovider/model%2Fwith%2Fslash", label: "encoded%2Fprovider/model%2Fwith%2Fslash" });
  expect(options.map(option => option.value)).not.toContain("encoded/provider/model/with/slash");
});

test("shadow-call options retain an unmatched legacy current value", () => {
  expect(shadowCallModelOptions(models, "legacy/bare-id").at(-1)).toEqual({
    value: "legacy/bare-id",
    label: "legacy/bare-id",
  });
});

test("shadow-call options exclude only source targets on the intersecting provider", () => {
  const options = shadowCallModelOptions(models, "openai/gpt-5.6-luna", ["gpt-5.6-luna"]);

  expect(options.map(option => option.value)).not.toContain("gpt-5.6-luna");
  expect(options.map(option => option.value)).not.toContain("openai/gpt-5.6-luna");
  expect(options).toContainEqual({ value: "xai/gpt-5.6-luna", label: "xai/gpt-5.6-luna" });
});

test("shadow-call options exclude a custom-provider self-target", () => {
  const options = shadowCallModelOptions([
    { provider: "xai", id: "custom-helper", namespaced: "xai/custom-helper" },
    { provider: "xai", id: "grok-4.5", namespaced: "xai/grok-4.5" },
  ], undefined, ["custom-helper"]);

  expect(options.map(option => option.value)).not.toContain("xai/custom-helper");
  expect(options).toContainEqual({ value: "xai/grok-4.5", label: "xai/grok-4.5" });
});

test("shadow-call options do not grandfather a stale self-target", () => {
  const withoutNativeSource = models.filter(model => model.namespaced !== "gpt-5.6-luna");
  const options = shadowCallModelOptions(withoutNativeSource, "openai/gpt-5.6-luna", ["gpt-5.6-luna"]);

  expect(options.map(option => option.value)).not.toContain("openai/gpt-5.6-luna");
});

test("shadow-call options do not append a fallback for an empty current value", () => {
  expect(shadowCallModelOptions(models, "")).toHaveLength(models.length);
});

test("both shadow-call selects use the canonical option helper", async () => {
  const [overview, modelsPage] = await Promise.all([
    Bun.file(new URL("../src/pages/dashboard-overview-sections.tsx", import.meta.url)).text(),
    Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text(),
  ]);

  expect(overview).toContain("shadowCallModelOptions(models, shadowCall?.model, shadowCall?.sourceModels)");
  expect(modelsPage).toMatch(/shadowCallModelOptions\(\s*models\.filter\(model => activeNamespaced\.has\(model\.namespaced\)\),\s*shadowCall\?\.model,\s*shadowCall\?\.sourceModels,/);
});
