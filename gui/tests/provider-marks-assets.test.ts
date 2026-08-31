import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { providerIconPaint, providerIconSrc } from "../src/provider-icons";

const PUBLIC_DIR = join(import.meta.dir, "..", "public", "provider-icons");

function bodyOf(src: string): string {
  return readFileSync(join(PUBLIC_DIR, src.replace(/^\/provider-icons\//, "")), "utf8");
}

/** Every asset a provider resolves to, deduplicated -- several ids share one file. */
function wiredAssets(): string[] {
  const seen = new Set<string>();
  for (const entry of PROVIDER_REGISTRY) {
    const src = providerIconSrc(entry.id);
    if (src) seen.add(src);
  }
  return [...seen].sort();
}

/*
 * The three ways a mark passes an SVG parse and still fails as artwork.
 *
 * A `<text>` glyph renders per-machine and blank where the font lacks the
 * character -- that is what disqualified the Hermes repo favicon, 113 bytes whose
 * entire body was one text element. An `<image>` or a base64 payload is a raster
 * wearing an SVG costume: it will not scale into the 19px tile and cannot be
 * masked. Neither is visible in review; both are visible here.
 */
test("every wired provider mark is drawn geometry, not text or a wrapped raster", () => {
  const broken: string[] = [];
  for (const src of wiredAssets()) {
    const body = bodyOf(src);
    if (/<text[\s>]/.test(body)) broken.push(`${src}: renders a <text> glyph`);
    if (/<image[\s>]/.test(body)) broken.push(`${src}: embeds a raster`);
    if (/;base64,/.test(body)) broken.push(`${src}: carries a base64 payload`);
    if (!/<(path|circle|rect|polygon|ellipse|line|polyline)[\s>]/.test(body)) {
      broken.push(`${src}: carries no vector geometry`);
    }
  }
  expect(broken).toEqual([]);
});

/*
 * A wordmark in a square slot.
 *
 * The rail draws a 19px box. A horizontal lockup scaled into it is an illegible
 * smear, which is what disqualified the MiniMax docs asset (129x32) in the
 * previous unit and several vendor logos in this one. The viewBox is the only
 * thing that says which shape a file is, and it is not something review catches.
 *
 * The threshold is deliberately loose: 2.5 admits a slightly wide mark and still
 * rejects the 4:1-and-up lockups that actually caused the problem.
 */
test("no wired provider mark is a horizontal wordmark", () => {
  const lockups: string[] = [];
  for (const src of wiredAssets()) {
    const box = bodyOf(src).match(/viewBox="[-\d.eE]+[ ,]+[-\d.eE]+[ ,]+([\d.eE]+)[ ,]+([\d.eE]+)"/);
    if (!box) continue;
    const ratio = Number(box[1]) / Number(box[2]);
    if (Number.isFinite(ratio) && ratio > 2.5) lockups.push(`${src}: ${ratio.toFixed(2)}:1`);
  }
  expect(lockups).toEqual([]);
});

/** Relative luminance, so "would this vanish?" is measured rather than judged. */
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

function inksOf(body: string): string[] {
  const matches = body.match(/(?:fill|stop-color)\s*[:=]\s*"?(#[0-9a-fA-F]{3,8})/g) ?? [];
  return [...new Set(matches.map(raw => raw.split(/[:=]/).pop()!.replace(/"/g, "").trim().toLowerCase()))];
}

/*
 * The rule that has now shipped broken five times.
 *
 * `prime` was white-on-transparent and invisible in light mode; `opencode`
 * (#211E1E) and `kimi` (#1A1A1A) invisible in dark; `grok` (#000000) sat at
 * 1.9:1 on the dark card through two passes because a comment argued it away.
 * Every one of those is a single fill of a near-neutral ink drawn as a plain
 * image, which is the one combination that cannot survive both themes.
 *
 * The provider tile resolves to #f4f4f4 light and #303030 dark, so an ink at
 * either extreme disappears into one of them. Such a mark must be masked (the ink
 * comes from the theme) or plated (the tile is pinned to the surface the artwork
 * assumes). What it must not be is `image`.
 */
test("a single-ink near-neutral mark is never left to be drawn plain", () => {
  const vanishing: string[] = [];
  for (const src of wiredAssets()) {
    const body = bodyOf(src);
    if (/<(linearGradient|radialGradient)[\s>]/.test(body)) continue;
    if (/prefers-color-scheme/.test(body)) continue; // solves it itself, see digitalocean
    const inks = inksOf(body);
    if (inks.length !== 1) continue;
    const hex = inks[0]!.replace("#", "");
    const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex.slice(0, 6);
    const channels = [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)].map(p => parseInt(p, 16));
    if (Math.max(...channels) - Math.min(...channels) > 24) continue; // a brand colour, not a neutral
    const l = luminance(inks[0]!);
    if (l > 0.12 && l < 0.75) continue; // a mid grey reads on both tiles
    if (providerIconPaint(src) === "image") {
      vanishing.push(`${src}: ${inks[0]} is drawn plain and vanishes against one tile`);
    }
  }
  expect(vanishing).toEqual([]);
});

/*
 * The inverse, and the more destructive direction. Masking discards every ink in
 * the file and repaints the silhouette in one colour, so applying it to a palette
 * flattens a brand -- and the result still renders, still looks deliberate, and is
 * invisible in review.
 */
test("no multi-colour provider mark is masked", () => {
  const flattened: string[] = [];
  for (const src of wiredAssets()) {
    if (providerIconPaint(src) !== "mask") continue;
    const body = bodyOf(src);
    const gradient = /<(linearGradient|radialGradient)[\s>]/.test(body);
    const inks = inksOf(body);
    if (gradient || inks.length > 1) {
      flattened.push(`${src}: ${inks.length} ink(s)${gradient ? " + gradient" : ""}`);
    }
  }
  expect(flattened).toEqual([]);
});

/*
 * A mark that adapts to the theme in its own file must be left alone. A constant
 * plate defeats its media query: `digitalocean.svg` repaints itself #F4F5F5 under
 * dark, so plating it light produced light-on-light at 1.01:1 -- worse than doing
 * nothing, and only visible by measuring the rendered result.
 */
test("a self-adapting mark is not plated", () => {
  const overridden = wiredAssets()
    .filter(src => /prefers-color-scheme/.test(bodyOf(src)))
    .filter(src => providerIconPaint(src) !== "image")
    .map(src => `${src}: carries its own media query but is painted ${providerIconPaint(src)}`);
  expect(overridden).toEqual([]);
});
