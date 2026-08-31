import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { providerIconSrc } from "../src/provider-icons";

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
