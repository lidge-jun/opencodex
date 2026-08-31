import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_MARKS, CLIENTS, MONOCHROME_CLIENT_MARKS } from "../src/components/apikeys-workspace/client-config-clients";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

/** Every literal color a mark paints with, lowercased; `currentColor` is not one. */
function inksOf(body: string): Set<string> {
  const matches = body.match(/(?:fill|stop-color)\s*[:=]\s*"?#[0-9a-fA-F]{3,8}/g) ?? [];
  return new Set(matches.map(raw => raw.split(/[:=]/).pop()!.replace(/"/g, "").trim().toLowerCase()));
}

/*
 * A mark that 404s renders as a broken image, which is worse than the monogram
 * it replaced. CLIENT_MARKS is a plain string map, so nothing else checks that
 * the file it names was actually committed.
 */
test("every client mark names a file that exists", () => {
  const missing = Object.entries(CLIENT_MARKS)
    .filter(([, src]) => !existsSync(join(PUBLIC_DIR, src!.replace(/^\//, ""))));
  expect(missing).toEqual([]);
});

/*
 * The Hermes favicon was rejected for exactly this: it passed an SVG parse and a
 * render probe while being a single <text> glyph with no path data, so it draws
 * differently per machine and blank where the font lacks the character. A mark
 * has to carry geometry.
 */
test("every client mark is drawn geometry, not text or an embedded raster", () => {
  for (const [clientId, src] of Object.entries(CLIENT_MARKS)) {
    const body = readFileSync(join(PUBLIC_DIR, src!.replace(/^\//, "")), "utf8");
    expect(body, `${clientId} mark should not render text`).not.toMatch(/<text[\s>]/);
    expect(body, `${clientId} mark should not embed a raster`).not.toMatch(/<image[\s>]/);
    expect(body, `${clientId} mark should carry vector geometry`)
      .toMatch(/<(path|circle|rect|polygon|ellipse|line|polyline)[\s>]/);
  }
});

/*
 * Membership in MONOCHROME_CLIENT_MARKS decides whether a mark draws as an <img>
 * or as a themed mask, and the wrong answer is invisible in code review. Masking
 * a multi-color mark silently flattens its palette into one ink; that direction
 * is what this guards, and it is the destructive one, because the mark still
 * renders and still looks deliberate.
 *
 * The other direction is not symmetric, so it is not asserted here: a single-ink
 * mark is only a candidate for masking. Whether it SHOULD be masked depends on
 * whether that ink is neutral or is the brand itself, which no property of the
 * file can answer -- see the dsh case below.
 */
test("no multi-color mark is masked, which would flatten its palette", () => {
  const flattened: string[] = [];
  for (const [clientId, src] of Object.entries(CLIENT_MARKS)) {
    if (!MONOCHROME_CLIENT_MARKS.has(clientId as never)) continue;
    const body = readFileSync(join(PUBLIC_DIR, src!.replace(/^\//, "")), "utf8");
    const inks = inksOf(body);
    const gradient = /<(linearGradient|radialGradient)[\s>]/.test(body);
    if (gradient || inks.size > 1) {
      flattened.push(`${clientId}: ${inks.size} ink(s)${gradient ? " + gradient" : ""}`);
    }
  }
  expect(flattened).toEqual([]);
});

/*
 * The failure that shipped: prime is white-on-transparent and was invisible in
 * light mode, opencode (#211E1E) and kimi (#1A1A1A) invisible in dark. Each has
 * exactly one ink and no way to follow the theme, so each must be masked. Pinned
 * by name because the general rule cannot express it -- dsh is also single-ink
 * and must NOT be masked.
 */
test("the marks that were invisible against a theme are masked", () => {
  for (const clientId of ["prime", "opencode", "kimi", "aside"] as const) {
    expect(MONOCHROME_CLIENT_MARKS.has(clientId), `${clientId} must be masked`).toBe(true);
  }
});

/*
 * A masked mark is painted with the row's text color, so whatever ink the file
 * carries is discarded. For `dsh` that would be wrong in the other direction --
 * it is a single ink, but that ink is DeepSeek blue and part of the brand, so it
 * stays an <img>. Recorded here because "single ink" alone would have masked it.
 */
test("a single-ink mark whose ink is a brand color is not masked", () => {
  expect(MONOCHROME_CLIENT_MARKS.has("dsh")).toBe(false);
  const body = readFileSync(join(PUBLIC_DIR, CLIENT_MARKS.dsh!.replace(/^\//, "")), "utf8");
  expect([...inksOf(body)]).toEqual(["#4d6bfe"]);
});

/*
 * Every mark here is somebody else's trademark, used on the strength of being
 * that vendor's own published asset. The README is where that claim lives -- the
 * source it came from and when -- and it is the only record of it. A mark added
 * without an entry is one nobody can later confirm the provenance of, which is
 * the state this directory is specifically trying not to be in.
 *
 * Prose is checked here rather than a manifest because prose is what the README
 * is; the assertion is only that each committed mark is named somewhere in it.
 */
test("every mark's provenance is recorded in the README", () => {
  const readme = readFileSync(join(PUBLIC_DIR, "provider-icons", "README.md"), "utf8");
  const undocumented = Object.values(CLIENT_MARKS)
    .map(src => src!.split("/").pop()!)
    .filter(file => !readme.includes(file));
  expect(undocumented).toEqual([]);
});

/*
 * Every export client now has a mark, and that is a property worth pinning
 * rather than a coincidence of the current map. The monogram branch in
 * ClientConfigRow stays -- it is the correct fallback and a future client will
 * arrive without an asset -- but a client SILENTLY losing its mark, because a
 * key was renamed or an entry dropped in a merge, looks identical to a client
 * that never had one. This is the difference.
 */
test("every export client has a mark", () => {
  const monogram = CLIENTS.filter(clientId => CLIENT_MARKS[clientId] === undefined);
  expect(monogram).toEqual([]);
});

/*
 * Provenance is documented; how a mark is PAINTED was not, and that is the fact
 * that actually broke. `grok.svg` sat unmasked at roughly 1.9:1 on the dark card
 * because the reasoning for leaving it an image lived only in a code comment that
 * was wrong about what masking does.
 *
 * This pins the README section rather than the decision itself -- the decision is
 * enforced in integration-marks.test.ts. What it prevents is the next person
 * re-litigating a case that was already measured, which is how grok stayed broken
 * through two passes over the same file.
 */
test("the README explains how marks are painted, not only where they came from", () => {
  const readme = readFileSync(join(PUBLIC_DIR, "provider-icons", "README.md"), "utf8");
  expect(readme).toContain("## How a mark is painted");

  /*
   * Every masked mark has to be argued for by name. A mark added to the mask set
   * without a line here is a decision nobody can review, and "it looked
   * monochrome" is precisely the reasoning that needs to be written down.
   */
  const section = readme.slice(readme.indexOf("## How a mark is painted"));
  const unexplained = [...MONOCHROME_CLIENT_MARKS]
    .map(clientId => CLIENT_MARKS[clientId]!.split("/").pop()!)
    .filter(file => !section.includes(file));
  expect(unexplained).toEqual([]);

  // The two cases a reader is most likely to get backwards.
  expect(section).toContain("grok.svg");
  expect(section).toContain("openai.svg");
});

/*
 * Two of the newest marks are traced from raster sources, which is a different
 * provenance claim from "fetched" and the one a reader is most likely to doubt.
 * The README has to carry the reproduction detail: the source file, and the
 * tracer parameters. Named files rather than a general rule because only these
 * two are traced -- a fetched mark has nothing to reproduce.
 */
test("a traced mark records the source it was traced from", () => {
  const readme = readFileSync(join(PUBLIC_DIR, "provider-icons", "README.md"), "utf8");
  for (const [file, source] of [
    ["hermes-agent.svg", "apps/desktop/assets/icon.png"],
    ["gajae-code.svg", "assets/character.png"],
  ] as const) {
    expect(readme, `${file} should name its raster source`).toContain(source);
  }
  expect(readme, "a traced mark should record its tracer invocation").toContain("potrace");
});
