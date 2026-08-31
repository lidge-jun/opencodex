import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INTEGRATION_MARKS, MASKED_MARKS } from "../src/components/integration-marks";
import { CLIENT_MARKS, MONOCHROME_CLIENT_MARKS } from "../src/components/apikeys-workspace/client-config-clients";
import { TABS } from "../src/pages/integrations/integration-tabs";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

function bodyOf(src: string): string {
  return readFileSync(join(PUBLIC_DIR, src.replace(/^\//, "")), "utf8");
}

function inksOf(body: string): Set<string> {
  const matches = body.match(/(?:fill|stop-color)\s*[:=]\s*"?#[0-9a-fA-F]{3,8}/g) ?? [];
  return new Set(matches.map(raw => raw.split(/[:=]/).pop()!.replace(/"/g, "").trim().toLowerCase()));
}

/*
 * The page renders a mark for every row it draws, so a row whose id is missing
 * from the map renders nothing where a logo should be. The map is a Record over
 * OverviewClientId, so the compiler catches an omission -- but only for ids that
 * type already knows. This asserts the values are real.
 */
test("every Integrations row has a mark that resolves to a committed file", () => {
  const broken = Object.entries(INTEGRATION_MARKS)
    .filter(([, src]) => src !== null && !existsSync(join(PUBLIC_DIR, src.replace(/^\//, ""))));
  expect(broken).toEqual([]);
});

/*
 * A null value is a legitimate answer -- it renders a monogram -- but none of the
 * current rows should be taking it. If one does, either an asset was dropped or a
 * client was added without a mark decision, and both look like a rendering bug
 * from the outside.
 */
test("no Integrations row falls back to a monogram today", () => {
  const monogram = Object.entries(INTEGRATION_MARKS)
    .filter(([, src]) => src === null)
    .map(([id]) => id);
  expect(monogram).toEqual([]);
});

/*
 * Masking paints the artwork with the theme's text color, discarding whatever
 * the file carries. Doing that to a multi-color mark flattens a brand palette
 * into one ink, and the result still renders and still looks deliberate, which is
 * why this needs a test rather than review attention.
 */
test("no multi-color asset is masked", () => {
  const flattened: string[] = [];
  for (const src of MASKED_MARKS) {
    const body = bodyOf(src);
    const gradient = /<(linearGradient|radialGradient)[\s>]/.test(body);
    const inks = inksOf(body);
    if (gradient || inks.size > 1) flattened.push(`${src}: ${inks.size} ink(s)${gradient ? " + gradient" : ""}`);
  }
  expect(flattened).toEqual([]);
});

/*
 * The inverse rule, and the one that cannot be derived from the file: a mark may
 * be a single ink and still not be a masking candidate, because that ink is the
 * brand. openai.svg is #10A37F and deepseek-harness.svg is #4d6bfe; masking
 * either repaints a trademark in the theme's text color. Pinned with their inks
 * so a vendor changing its asset shows up here rather than silently satisfying
 * the assertion.
 */
test("a single-ink asset whose ink is a brand color is not masked", () => {
  for (const [src, ink] of [
    ["/provider-icons/openai.svg", "#10a37f"],
    ["/provider-icons/deepseek-harness.svg", "#4d6bfe"],
  ] as const) {
    expect(MASKED_MARKS.has(src), `${src} must not be masked`).toBe(false);
    expect([...inksOf(bodyOf(src))], `${src} ink changed upstream`).toEqual([ink]);
  }
});

/*
 * MASKED_MARKS is derived from MONOCHROME_CLIENT_MARKS rather than restated, and
 * this is what makes that derivation observable: the two must describe the same
 * assets. A second hand-maintained list would drift, and the drift would be a
* mark masked on one surface and not on another.
*/
test("the masked set is the monochrome client marks plus the native exceptions", () => {
  const fromClients = [...MONOCHROME_CLIENT_MARKS].map(id => CLIENT_MARKS[id]).filter(Boolean) as string[];
  /*
   * The only additions allowed are marks belonging to rows with no export client,
   * since MONOCHROME_CLIENT_MARKS is keyed by ExportClientId and structurally
   * cannot hold them. Named here so a mask added for any OTHER reason -- which is
   * how the two lists would start drifting -- fails.
   */
  const nativeExceptions = ["/provider-icons/grok.svg"];
  expect([...MASKED_MARKS].sort()).toEqual([...fromClients, ...nativeExceptions].sort());

  // Every export client's masking decision still comes from the derived set only.
  const clientMarks = new Set(Object.values(CLIENT_MARKS).filter(Boolean) as string[]);
  const maskedClientMarks = [...MASKED_MARKS].filter(src => clientMarks.has(src)).sort();
  expect(maskedClientMarks).toEqual([...fromClients].sort());
});

/*
 * The tab strip draws a mark per tab, and two tabs have no client behind them:
 * overview is the page and keys is a credential surface. Every OTHER tab must be
 * in the map, or its tab renders bare while its neighbours carry logos.
 */
test("every client tab has a mark", () => {
  const bare = TABS
    .filter(tab => tab.id !== "overview" && tab.id !== "keys")
    .filter(tab => !(tab.id in INTEGRATION_MARKS));
  expect(bare.map(tab => tab.id)).toEqual([]);
});

/**
 * Relative luminance, so "would this vanish?" is a measurement rather than a
 * judgement about a hex string.
 */
function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? [...raw].map(c => c + c).join("") : raw.slice(0, 6);
  const channel = (pair: string): number => {
    const v = parseInt(pair, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(full.slice(0, 2))
    + 0.7152 * channel(full.slice(2, 4))
    + 0.0722 * channel(full.slice(4, 6));
}

/*
 * The rule the other direction, and the one that actually shipped broken.
 *
 * `no multi-color asset is masked` stops a brand palette being flattened. Nothing
 * stopped the opposite: a mark that is one near-black ink drawn as an <img>, which
 * is invisible against a dark surface. That is not hypothetical -- prime, opencode
 * and kimi each shipped that way, and the fix was to mask them. Removing one from
 * MONOCHROME_CLIENT_MARKS today reintroduces it silently, because an invisible
 * <img> still renders, still has layout, and every existing assertion still holds.
 *
 * A near-neutral ink is one whose channels are close together: #0d1117 qualifies,
 * OpenAI's #10a37f does not, which is what keeps this from arguing with the
 * brand-color test above.
 */
test("a single-ink mark that would vanish against one theme is masked", () => {
  const vanishing: string[] = [];
  for (const src of new Set(Object.values(INTEGRATION_MARKS))) {
    if (src === null) continue;
    const body = bodyOf(src);
    if (/<(linearGradient|radialGradient)[\s>]/.test(body)) continue;
    const inks = [...inksOf(body)];
    if (inks.length !== 1) continue;
    const hex = inks[0]!.replace("#", "");
    const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex.slice(0, 6);
    const channels = [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)].map(p => parseInt(p, 16));
    const neutral = Math.max(...channels) - Math.min(...channels) <= 24;
    if (!neutral) continue;
    // Only the extremes vanish. A mid grey is legible on both surfaces.
    const l = luminance(inks[0]!);
    if (l > 0.12 && l < 0.75) continue;
    if (!MASKED_MARKS.has(src)) vanishing.push(`${src}: ${inks[0]} would be invisible in one theme`);
  }
  expect(vanishing).toEqual([]);
});

/*
 * The three marks added last, pinned by how they are PAINTED rather than by
 * existing. Rendered measurement at 1440px: hermes flips ink with the theme
 * (17.67:1 on the light card, 11.17:1 on the dark one), while gajae and minimax
 * keep their own colors in both. This is the cheap version of that check.
 */
test("the three newest marks are painted the way their artwork requires", () => {
  // A traced single-ink silhouette: invisible as an image on a dark surface.
  expect(MASKED_MARKS.has("/provider-icons/hermes-agent.svg")).toBe(true);
  // Multi-color artwork: masking would flatten a mascot and a gradient wave.
  expect(MASKED_MARKS.has("/provider-icons/gajae-code.svg")).toBe(false);
  expect(MASKED_MARKS.has("/provider-icons/minimax.svg")).toBe(false);
  expect(inksOf(bodyOf("/provider-icons/gajae-code.svg")).size).toBeGreaterThan(1);
  expect(/<linearGradient[\s>]/.test(bodyOf("/provider-icons/minimax.svg"))).toBe(true);
});

/*
 * The stylesheet rule the mobile dialog depends on.
 *
 * A config path is one long unbroken token and the dialog is 370px wide at a 390px
 * viewport, so without an in-word break opportunity the path overflows and the one
 * fact the user needs -- WHICH file is about to change -- goes off screen. This is
 * a CSS declaration with no type or render coverage in a DOM-less suite, so it is
 * asserted as text.
 */
test("the consequence dialog lets a long path break mid-token", () => {
  const css = readFileSync(join(import.meta.dir, "..", "src", "styles-integrations.css"), "utf8");
  const rule = css.match(/\.integration-consequence-body code \{[^}]*\}/);
  expect(rule).not.toBeNull();
  expect(rule![0]).toMatch(/overflow-wrap:\s*anywhere/);
});
