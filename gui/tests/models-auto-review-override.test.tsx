import { expect, test } from "bun:test";
import { modelsSettingsSummary } from "../src/pages/models-settings-summary";
import { routedModelOptions, type ModelRow } from "../src/pages/models-shared";
import type { TFn } from "../src/i18n/shared";

/**
 * The Models settings panel folds the global auto-review override. Two properties matter:
 * the dropdown offers routed rows (the selector must name a provider-namespaced catalog row),
 * and the summary surfaces the control only while it actually changes the reviewer.
 */
const t = ((key: string) => key) as unknown as TFn;

const base = {
  multiAgentMode: "v1" as const,
  shadowEnabled: true,
  shadowModel: "xai/grok-4.5",
  windowOn: false,
  windowValue: 350_000,
  pickerMode: "most-used",
  newModelsOff: false,
  aliasesOn: false,
};

function row(partial: Pick<ModelRow, "provider" | "id" | "namespaced"> & Partial<ModelRow>): ModelRow {
  return { disabled: false, ...partial };
}

test("summary names the auto-review override only while it is on", () => {
  expect(modelsSettingsSummary(t, base).some(item => item.id === "auto-review")).toBe(false);
  const on = modelsSettingsSummary(t, {
    ...base,
    autoReviewEnabled: true,
    autoReviewModel: "9router/ocg-muse-spark-1.3-contributor",
  });
  expect(on.find(item => item.id === "auto-review")).toEqual({
    id: "auto-review",
    label: "models.autoReviewOverride",
    value: "9router/ocg-muse-spark-1.3-contributor",
  });
});

test("the override dropdown offers routed rows and keeps a saved native value visible", () => {
  const models = [
    row({ provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", native: true }),
    row({ provider: "9router", id: "ocg-muse-spark-1.3-contributor", namespaced: "9router/ocg-muse-spark-1.3-contributor" }),
  ];
  const visible = [
    { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    { value: "9router/ocg-muse-spark-1.3-contributor", label: "muse-spark" },
  ];
  expect(routedModelOptions(visible, models).map(option => option.value))
    .toEqual(["9router/ocg-muse-spark-1.3-contributor"]);
  // A value saved by hand in config.json must stay selectable, or the row would read as empty.
  expect(routedModelOptions(visible, models, "gpt-5.6-sol").map(option => option.value).sort())
    .toEqual(["9router/ocg-muse-spark-1.3-contributor", "gpt-5.6-sol"]);
});
