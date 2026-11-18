/**
 * The Guides dropdown shows six picked guides and ends in one overflow row that
 * links to the landing page's `#docs-map` band. That band is a curated overview
 * (12 of the 40 guide pages in the content tree), and even the docs sidebar
 * lists 34 of the 40. A row promising "All guides" therefore lies about its
 * destination, and the comment beside it repeated the same false claim about the
 * sidebar.
 *
 * The landing band it targets is already titled "Explore the docs", so the row
 * says the same thing: explore. This regression pins the copy in every supported
 * locale, proves the link still reaches the existing map band, and keeps the
 * corrected comment from drifting back to the completeness claim.
 *
 * Docs-only pull requests run `docs-site-build` rather than this Bun suite, so the
 * Astro build remains the authority for the rendered site; this file is the
 * repository-side copy contract alongside the other docs-*.test.ts guards.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

const HEADER = repoPath("docs-site/src/components/Header.astro");
const LANDING = repoPath("docs-site/src/components/Landing.astro");

// Argument order of Header.astro's `t(en, ko, zh, ru, ja, zhTW, tr)` helper.
const LOCALE_ORDER = ["en", "ko", "zh-cn", "ru", "ja", "zh-tw", "tr"] as const;

const EXPLORE_GUIDES: Record<(typeof LOCALE_ORDER)[number], string> = {
  en: "Explore guides",
  ko: "가이드 둘러보기",
  "zh-cn": "浏览指南",
  ru: "Обзор руководств",
  ja: "ガイドを探る",
  "zh-tw": "瀏覽指南",
  tr: "Kılavuzlara göz atın",
};

// Wording that claims the destination is exhaustive. The destination is not.
const TOTALITY: Record<(typeof LOCALE_ORDER)[number], RegExp> = {
  en: /\b(?:all|every|full|complete|entire|whole)\b/i,
  ko: /전체|모든/,
  "zh-cn": /全部|所有/,
  ru: /все|всех|полн/i,
  ja: /すべて|全て|全部/,
  "zh-tw": /全部|所有/,
  tr: /\btüm\b/i,
};

const GUIDE_PICKS = ["providers", "model-routing", "codex-integration", "claude-code", "sidecars", "web-dashboard"];

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function moreBlock(): string {
  const header = source(HEADER);
  const start = header.indexOf("guides.more = {");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = header.indexOf("};", start);
  expect(end).toBeGreaterThan(start);
  return header.slice(start, end);
}

function labelArgs(): string[] {
  const call = /label:\s*t\(([^)]*)\)/.exec(moreBlock());
  expect(call).not.toBeNull();
  return [...call![1]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

test("the Guides overflow row promises exploration, not a complete index", () => {
  const args = labelArgs();
  expect(args).toHaveLength(LOCALE_ORDER.length);
  const labels = Object.fromEntries(LOCALE_ORDER.map((locale, index) => [locale, args[index]!]));
  expect(labels).toEqual(EXPLORE_GUIDES);
  for (const locale of LOCALE_ORDER) {
    expect(TOTALITY[locale].test(labels[locale]!), `${locale}: ${labels[locale]}`).toBe(false);
  }
});

test("the overflow row keeps pointing at the landing documentation map", () => {
  expect(moreBlock()).toContain("href: `${prefix}#docs-map`");
});

test("the landing documentation map band still exists and keeps its curated links", () => {
  const landing = source(LANDING);
  expect(landing).toContain('id="docs-map"');
  const start = landing.indexOf("const docsMap = [");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = landing.indexOf("\n];", start);
  expect(end).toBeGreaterThan(start);
  const map = landing.slice(start, end);
  const guideLinks = [...map.matchAll(/href: `\$\{prefix\}guides\/[^`]+`/g)];
  expect(guideLinks.length).toBeGreaterThanOrEqual(12);
});

test("the Guides dropdown keeps every existing picked route", () => {
  const header = source(HEADER);
  const picks = /const GUIDE_PICKS = \[([^\]]*)\]/.exec(header);
  expect(picks).not.toBeNull();
  const slugs = [...picks![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  expect(slugs).toEqual(GUIDE_PICKS);
  expect(header).toContain("guides.links = guides.links.filter");
});

test("French renders a real label instead of the undefined fallback", () => {
  const header = source(HEADER);
  const start = header.indexOf("const fr = {");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = header.indexOf("} as const;", start);
  expect(end).toBeGreaterThan(start);
  expect(header.slice(start, end)).toContain("'Explore guides': 'Explorer les guides'");
});

test("the code comment stops claiming the sidebar lists every guide", () => {
  const header = source(HEADER);
  const picksAt = header.indexOf("const GUIDE_PICKS");
  expect(picksAt).toBeGreaterThanOrEqual(0);
  // The note is a contiguous block of `//` lines directly above GUIDE_PICKS; slice
  // the whole block so the assertion reads every line, not just the last one.
  const lines = header.slice(0, picksAt).split("\n").slice(0, -1);
  let first = lines.length;
  while (first > 0 && lines[first - 1]!.trimStart().startsWith("//")) first -= 1;
  const comment = lines.slice(first).join("\n");
  // The old comment asserted "the sidebar still lists every guide". The sidebar
  // lists 34 of the 40 guide pages, so that assertion is the defect. Match the
  // exact sentence so a rewording cannot quietly restore the completeness claim,
  // and so the fix's own "instead of claiming it lists every guide" phrasing does
  // not trip a blanket word match.
  expect(comment).not.toContain("sidebar still lists every guide");
  expect(comment).toMatch(/curated|picked|selection|subset/i);
});
