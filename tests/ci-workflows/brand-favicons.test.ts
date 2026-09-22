import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

/**
 * The favicons the dashboard and the documentation site serve are generated from the app icon
 * vector by scripts/brand-favicons.ts. That script's --check compares byte for byte and needs
 * rsvg-convert, which CI does not have, so what is asserted here is the shape of the committed
 * set: the sizes the sites reference, the alpha channel, and the one property the old artwork
 * failed.
 *
 * That property is worth naming. The documentation favicon used to be the dark variant of the
 * mark — white on transparency — so on a light browser tab strip it was white on white and the
 * site effectively had no favicon. Nothing about the file looks wrong until it is composited.
 */
const GENERATOR = repoPath("scripts/brand-favicons.ts");

function generatorSource(): string {
  return readFileSync(GENERATOR, "utf8");
}

function block(source: string, opening: string, closing: string): string {
  const start = source.indexOf(opening);
  expect(start, `${opening} is missing from brand-favicons.ts`).toBeGreaterThan(-1);
  const end = source.indexOf(closing, start + opening.length);
  expect(end, `${opening} is not terminated in brand-favicons.ts`).toBeGreaterThan(-1);
  return source.slice(start + opening.length, end);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Truecolour with alpha. */
const RGBA = 6;

function ihdr(bytes: Buffer): { width: number; height: number; colourType: number } {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25]! };
}

/** Decode an 8-bit RGBA PNG into one flat pixel buffer. */
function decode(bytes: Buffer): { width: number; height: number; pixels: Buffer } {
  const { width, height, colourType } = ihdr(bytes);
  expect(colourType).toBe(RGBA);
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    if (type === "IDAT") idat.push(Buffer.from(bytes.subarray(at + 8, at + 8 + length)));
    if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  let prior = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (1 + stride);
    const filter = raw[start]!;
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= 4 ? row[i - 4]! : 0;
      const b = prior[i]!;
      const c = i >= 4 ? prior[i - 4]! : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const guess = a + b - c;
        const pa = Math.abs(guess - a);
        const pb = Math.abs(guess - b);
        const pc = Math.abs(guess - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = (row[i]! + add) & 0xff;
    }
    row.copy(pixels, y * stride);
    prior = row;
  }
  return { width, height, pixels };
}

/** Rec. 709 luminance of the pixel starting at ''at''. */
function luminance(pixels: Buffer, at: number): number {
  return 0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!;
}

describe("brand favicons", () => {
  const source = generatorSource();
  const pngs = new Map<string, number>(
    [...block(source, "const FAVICON_SIZES: Record<string, number> = {", "};")
      .matchAll(/"([^"]+)":\s*(\d+)/g)].map(m => [m[1]!, Number(m[2])]),
  );
  const icoOutput = /const ICO_OUTPUT = "([^"]+)";/.exec(source)?.[1];
  const icoSizes = block(source, "const ICO_SIZES = [", "]")
    .split(",")
    .map(part => Number(part.trim()))
    .filter(n => Number.isFinite(n));

  test("the generator still declares the favicons the sites reference", () => {
    expect(pngs.size).toBeGreaterThan(1);
    expect(icoOutput).toBeTruthy();
    expect(icoSizes.length).toBeGreaterThan(2);

    // The sizes are not free choices: these are the numbers the two sites already ask for.
    expect(readFileSync(repoPath("gui/index.html"), "utf8")).toContain('href="/favicon.png"');
    const astro = readFileSync(repoPath("docs-site/astro.config.mjs"), "utf8");
    expect(astro).toContain('favicon: "/favicon.ico"');
    expect(astro).toContain('sizes: "192x192"');
    expect(pngs.get("docs-site/public/favicon.png")).toBe(192);
  });

  test("every declared favicon is committed at its declared size with alpha intact", () => {
    const wrong: string[] = [];
    for (const [output, size] of pngs) {
      const { width, height, colourType } = ihdr(readFileSync(repoPath(output)));
      if (width !== size || height !== size) wrong.push(`${output}: ${width}x${height} != ${size}`);
      if (colourType !== RGBA) wrong.push(`${output}: colour type ${colourType}`);
    }
    expect(wrong).toEqual([]);
  });

  test("the documentation .ico carries exactly the declared sizes as PNGs", () => {
    const ico = readFileSync(repoPath(icoOutput!));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(icoSizes.length);
    const seen: number[] = [];
    for (let i = 0; i < icoSizes.length; i += 1) {
      const entry = 6 + i * 16;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      const { width, height } = ihdr(ico.subarray(offset, offset + length));
      expect(width).toBe(height);
      expect(ico[entry]).toBe(width % 256);
      seen.push(width);
    }
    expect(seen).toEqual(icoSizes);
  });

  /**
   * The regression the generator exists for. Both favicons are now drawn on the opaque backdrop
   * the app icon uses, so they composite against a light tab strip instead of disappearing into
   * it. The documentation artwork this replaces was white on transparency with a corner alpha of
   * 3 and no fully opaque pixel anywhere.
   */
  test("both favicons show on a light tab instead of vanishing into it", () => {
    const failures: string[] = [];
    for (const output of pngs.keys()) {
      const { width, height, pixels } = decode(readFileSync(repoPath(output)));

      // An opaque light corner is the backdrop rather than transparency.
      const corner = luminance(pixels, 0);
      if (pixels[3] !== 255) failures.push(output + ": corner alpha " + pixels[3]);
      if (corner < 200) failures.push(output + ": corner luminance " + corner.toFixed(0));

      // A backdrop alone is not a favicon. An opaque white square passes the check above and is
      // still invisible, so the mark has to actually be there: count the pixels that survive
      // compositing and differ from the backdrop enough to read at tab size.
      let ink = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        if (pixels[at + 3]! < 128) continue;
        if (Math.abs(luminance(pixels, at) - corner) > 64) ink += 1;
      }
      const coverage = ink / (width * height);
      if (coverage < 0.1) failures.push(output + ": only " + (coverage * 100).toFixed(1) + "% ink");
    }
    expect(failures, "these favicons vanish on a light tab strip").toEqual([]);
  });
});
