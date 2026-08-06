import { expect, test } from "bun:test";
import { shadowCallModelOptions } from "../src/pages/dashboard-shared";

const models = [
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

test("shadow-call options do not append a fallback for an empty current value", () => {
  expect(shadowCallModelOptions(models, "")).toHaveLength(models.length + 1);
});

test("both shadow-call selects use the canonical option helper", async () => {
  const [overview, modelsPage] = await Promise.all([
    Bun.file(new URL("../src/pages/dashboard-overview-sections.tsx", import.meta.url)).text(),
    Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text(),
  ]);

  expect(overview).toContain("shadowCallModelOptions(models, shadowCall?.model)");
  expect(modelsPage).toContain("shadowCallModelOptions(models.filter(model => activeNamespaced.has(model.namespaced)), shadowCall?.model)");
});
