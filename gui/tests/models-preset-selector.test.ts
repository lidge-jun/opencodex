import { expect, test } from "bun:test";
import { en } from "../src/i18n/en";

/**
 * #2465: the provider header gains a Preset / All segmented control. Custom is a STATE that
 * activates on edit, not a destination the user picks, so it renders as a disabled segment —
 * the current mode must never be ambiguous.
 */
test("the preset selector reuses the existing segmented control, not a new visual language", async () => {
  const src = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  // Same classes the v1/default/v2 selector already uses, so the header keeps one control
  // vocabulary instead of gaining a second look.
  expect(src).toContain('aria-label={t("models.presetLabel")}');
  expect(src).toMatch(/className="segmented models-segmented" role="radiogroup" aria-label=\{t\("models\.presetLabel"\)\}/);
  // Radios, not buttons-that-look-like-radios: the mode is a single choice.
  expect(src).toContain('role="radio"');
});

test("only providers with a shipped preset get the control", async () => {
  const src = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  // A provider with nothing to curate would otherwise show a dead switch.
  expect(src).toContain("const preset = presets[provider];");
  expect(src).toContain("if (!preset) return null;");
});

test("switching away from a custom selection confirms first", async () => {
  const src = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  expect(src).toContain("models.presetConfirmReplace");
  expect(src).toMatch(/mode === "preset" && preset\.mode === "custom"/);
});

test("every string the selector renders exists in the catalog", () => {
  for (const key of [
    "models.presetLabel",
    "models.presetMode_preset",
    "models.presetMode_all",
    "models.presetMode_custom",
    "models.presetSummary",
    "models.presetUpdateAvailable",
    "models.presetAppliedToast",
    "models.presetClearedToast",
    "models.presetEmpty",
    "models.presetConfirmReplace",
  ]) {
    expect(en[key as keyof typeof en]).toBeTruthy();
  }
});

test("the summary names both the shown count and the total", () => {
  // "9 of 412" is the point: a bare "9 models" hides how much was curated away.
  const summary = en["models.presetSummary"];
  expect(summary).toContain("{count}");
  expect(summary).toContain("{total}");
  expect(summary).toContain("{version}");
});

test("the zero-match message says the selection was left alone", () => {
  // A preset that matched nothing must not read as a success that changed something.
  expect(en["models.presetEmpty"]).toContain("unchanged");
});

