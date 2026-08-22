import { expect, test } from "bun:test";
import { buildProviderModelGroups } from "../src/models-groups";
import { CAP_OPTIONS, CAP_OPTION_SET, fmtK, NATIVE_CAP_OPTIONS, NATIVE_CAP_OPTION_SET } from "../src/pages/models-shared";

const nativeRow = (id: string) => ({ provider: "openai", id, native: true });
const customRow = (id: string) => ({ provider: "openai", id, native: false });

test("a custom row does not strip the openai card of its native identity", () => {
  // `native` (every row is native) flips as soon as a custom model is added. Card identity —
  // badge, hint, sort order — has to key off nativeProviderGroup so adding one custom model
  // through the newly exposed "+" button cannot turn the passthrough card into a plain one.
  const before = buildProviderModelGroups([nativeRow("gpt-5.6-sol")], []);
  expect(before[0]!.native).toBe(true);
  expect(before[0]!.nativeProviderGroup).toBe(true);

  const after = buildProviderModelGroups([nativeRow("gpt-5.6-sol"), customRow("gpt-5.4")], []);
  expect(after[0]!.native).toBe(false);
  expect(after[0]!.nativeProviderGroup).toBe(true);
});

test("a provider with no native rows is not a native group", () => {
  const groups = buildProviderModelGroups([{ provider: "kimi", id: "k2", native: false }], []);
  expect(groups[0]!.nativeProviderGroup).toBe(false);
});

test("the native card keeps sorting first once a custom row joins it", () => {
  const groups = buildProviderModelGroups(
    [{ provider: "anthropic", id: "opus", native: false }, nativeRow("gpt-5.6-sol"), customRow("gpt-5.4")],
    [],
  );
  expect(groups[0]!.provider).toBe("openai");
});

test("the native cap ladder offers exactly the three contracted windows", () => {
  expect(NATIVE_CAP_OPTIONS).toEqual([272_000, 372_000, 922_000]);
  // A cap only lowers a window, so no option may sit above the advertised native window.
  for (const value of NATIVE_CAP_OPTIONS) expect(value).toBeLessThanOrEqual(922_000);
  // The set must follow the list: the select inserts a saved value only when its own
  // option set is missing it, so a mismatched set would drop the selected option.
  for (const value of NATIVE_CAP_OPTIONS) expect(NATIVE_CAP_OPTION_SET.has(value)).toBe(true);
  // Routed providers keep the generic ladder untouched.
  expect(CAP_OPTIONS).toContain(350_000);
  expect(CAP_OPTION_SET.has(350_000)).toBe(true);
  expect(NATIVE_CAP_OPTION_SET.has(350_000)).toBe(false);
});

test("fmtK renders past a million as M, not as four-digit k", () => {
  expect(fmtK(1_000_000)).toBe("1M");
  expect(fmtK(1_050_000)).toBe("1.05M");
  expect(fmtK(922_000)).toBe("922k");
  expect(fmtK(372_000)).toBe("372k");
  expect(fmtK(272_000)).toBe("272k");
  expect(fmtK(350_000)).toBe("350k");
});

test("the native group keeps its window readable with the cap switched off", async () => {
  const src = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  // Routed providers hide the value when the cap is off (off = "no opinion"), but a native
  // row always advertises some window, so the number stays on screen for that group.
  expect(src).toContain("{(capOn || nativeProviderGroup) && (");
  // With the cap off the stored value is only what a future toggle would apply — the 350k
  // default — so the display falls back to the widest window the rows actually advertise.
  // Matched as separate fragments because the expression is wrapped across lines now, and
  // it grew a native branch: with the cap off the native group shows its default window
  // rather than the widest advertised row. A single-line literal pinned the formatting
  // instead of the behaviour and broke on the reflow that introduced that branch.
  expect(src).toContain("const capDisplayValue = capOn");
  expect(src).toContain("nativeProviderGroup ? NATIVE_GPT56_DEFAULT_WINDOW : (widestRowWindow ?? providerCap)");
  // The select is inert until the cap is actually on: showing a number is not the same as
  // offering to change one.
  expect(src).toContain("disabled={busy || !capOn}");
});

test("the native group exposes the context modal alongside the custom-model and cap controls", async () => {
  const src = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  // The context button is no longer gated: the canonical openai seed check admits
  // contextWindow/modelContextWindows as user-owned overlays, and the native accessors only
  // ever narrow the measured window with them.
  expect(src).not.toContain("{!nativeProviderGroup && (");
  expect(src).toContain('onClick={() => openContextSettings(group)}');
  // Badge and hint follow provider identity, not row composition.
  expect(src).toContain("{nativeProviderGroup && <span");
  expect(src).toContain("{nativeProviderGroup && <p");
  // The custom-add and cap controls no longer sit behind an isNative guard.
  expect(src).not.toMatch(/\{!isNative && </);
});
