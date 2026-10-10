import { expect, test } from "bun:test";
import { effectiveDeclaration, withoutComments } from "./helpers/css-declarations";

/**
 * WP1 (devlog/_fin/260830_models_provider_header/020_control_affordances.md):
 * three controls in the provider header were operable but carried no visible
 * meaning. `Switch` accepted a `label` and spent it entirely on `aria-label`, so
 * every switch in the app was, to a sighted user, an unlabeled knob.
 *
 * These are source-text assertions; happy-dom performs no layout. The rendered
 * behaviour — that the visible label actually toggles the switch — is proven in
 * gui/tests/switch-labeled-dom.test.tsx, and the geometry proof lives in the
 * unit's evidence directory.
 */

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();

test("Switch renders its label as visible text inside the control", async () => {
  const ui = await read("../src/ui.tsx");

  // The visible-label path exists...
  expect(ui).toContain("showLabel");
  expect(ui).toContain("switch-labeled-text");

  // ...and the visible words are the accessible name, not a decorative copy of it.
  // aria-hidden here would leave the button nameless; aria-label would override the
  // words and break Label-in-Name.
  expect(ui).not.toMatch(/switch-labeled-text[^>]*aria-hidden/);
  expect(ui).toContain("aria-label={labeled ? undefined :");

  // `title` is strictly opt-in: defaulting it to `label` gave every untouched
  // Switch in the app an accessible description that merely repeats its name.
  expect(ui).toContain("title={title}");
  expect(ui).not.toMatch(/title=\{title \?\? /);
});

test("a labeled switch stays one atomic flex item", async () => {
  const css = withoutComments(await read("../src/styles.css"));

  // Without this the knob and its text become two shrinkable items inside
  // .models-provider-actions and the text collapses to a min-content column —
  // the same class of defect 010 fixed for the toggle's children.
  expect(effectiveDeclaration(css, ".switch.switch-labeled", "flex")).toBe("0 0 auto");
  expect(effectiveDeclaration(css, ".switch-labeled-text", "white-space")).toBe("nowrap");

  // The label lives inside the button, so the pill geometry moves to ::before —
  // otherwise the text would sit on the coloured track.
  expect(effectiveDeclaration(css, ".switch.switch-labeled", "width")).toBe("auto");
  expect(effectiveDeclaration(css, ".switch.switch-labeled::before", "width")).toBe("34px");
});

test("the three opaque provider-header controls now carry visible meaning", async () => {
  const page = await read("../src/pages/Models.tsx");

  // 1. alias-defaults switch: label was already correct, it was merely discarded.
  const aliasSwitch = page.slice(
    page.indexOf('label={t("models.useDefaultAliases")}') - 300,
    page.indexOf('label={t("models.useDefaultAliases")}') + 120,
  );
  expect(aliasSwitch).toContain("showLabel");

  // 2. custom-add: a visible text label, not a tooltip. `title` is undiscoverable
  //    on touch, and wrapping it in Tooltip would nest <button> inside <button>.
  //    The glyph is aria-hidden so the accessible name is the visible words.
  expect(page).toContain('><span aria-hidden="true">+</span> {t("models.customAdd")}</button>');

  // 3. cap switch: the label must name the FUNCTION. It used to be
  //    models.capValue ("기본 128k"), a value masquerading as a name.
  expect(page).toMatch(/on=\{capOn\}[\s\S]{0,200}label=\{t\("models\.contextCapLabel"\)\}[\s\S]{0,40}showLabel/);
  expect(page).not.toMatch(/on=\{capOn\}[\s\S]{0,200}label=\{t\("models\.capValue"/);

  // The cap Select says what its number means; the value itself stays its name.
  const capSelect = page.slice(page.indexOf("onSelectProviderCap(provider, v)"), page.indexOf("onSelectProviderCap(provider, v)") + 400);
  expect(capSelect).toContain('title={t("models.contextCapLabel")}');
});

test("no new i18n key was invented: every string used already exists in all locales", async () => {
  const { DICTS } = await import("../src/i18n/shared");
  const keys = ["models.useDefaultAliases", "models.customAdd", "models.contextCapLabel"] as const;
  for (const [locale, dict] of Object.entries(DICTS)) {
    for (const key of keys) {
      expect((dict as Record<string, string>)[key], `${locale} is missing ${key}`).toBeTruthy();
    }
  }
});
