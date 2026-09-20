import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

/**
 * The committed desktop icons are generated from one SVG by `desktop/scripts/generate-icons.ts`.
 * That script's own `--check` compares byte for byte, which is the strongest statement available
 * — and it is not available here: it needs `rsvg-convert` and `iconutil`, and the renderer is not
 * pinned, so two machines with different librsvg builds disagree on bytes without anything being
 * wrong. Asserting byte identity in CI would mean asserting the runner's renderer version.
 *
 * What CI can assert on any platform with no renderer at all is that the committed set still has
 * the shape the generator declares: every size present, every raster actually that size, both
 * containers carrying exactly the members the script packs, and nothing hand-added alongside.
 * Every expectation below is read out of the generator, so adding a size there and forgetting to
 * regenerate fails here rather than being restated in two places that can drift apart.
 */
const GENERATOR = repoPath("desktop/scripts/generate-icons.ts");
const ICONS_DIR = repoPath("desktop/src-tauri/icons");

function generatorSource(): string {
  return readFileSync(GENERATOR, "utf8");
}

function block(source: string, opening: string, closing: string): string {
  const start = source.indexOf(opening);
  expect(start, `${opening} is missing from generate-icons.ts`).toBeGreaterThan(-1);
  const end = source.indexOf(closing, start + opening.length);
  expect(end, `${opening} is not terminated in generate-icons.ts`).toBeGreaterThan(-1);
  return source.slice(start + opening.length, end);
}

function declaredPngs(source: string): Map<string, number> {
  const body = block(source, "const PNG_SIZES: Record<string, number> = {", "};");
  const out = new Map<string, number>();
  for (const m of body.matchAll(/"([^"]+)":\s*(\d+)/g)) out.set(m[1]!, Number(m[2]));
  return out;
}

function declaredIcnsMembers(source: string): Array<{ name: string; size: number }> {
  const body = block(source, "const ICNS_ENTRIES: Array<{ name: string; size: number }> = [", "];");
  return [...body.matchAll(/name:\s*"([^"]+)",\s*size:\s*(\d+)/g)].map(m => ({ name: m[1]!, size: Number(m[2]) }));
}

function declaredIcoSizes(source: string): number[] {
  const body = block(source, "const ICO_SIZES = [", "]");
  return body.split(",").map(part => Number(part.trim())).filter(n => Number.isFinite(n));
}

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("desktop icon set", () => {
  const source = generatorSource();
  const pngs = declaredPngs(source);
  const icnsMembers = declaredIcnsMembers(source);
  const icoSizes = declaredIcoSizes(source);

  test("the generator still declares a set worth checking", () => {
    expect(pngs.size).toBeGreaterThan(10);
    expect(icnsMembers.length).toBeGreaterThan(5);
    expect(icoSizes.length).toBeGreaterThan(3);
  });

  test("every declared raster is committed at exactly its declared size", () => {
    const wrong: string[] = [];
    for (const [name, size] of pngs) {
      const bytes = readFileSync(join(ICONS_DIR, name));
      const { width, height } = pngDimensions(bytes);
      if (width !== size || height !== size) wrong.push(`${name}: ${width}x${height} != ${size}`);
    }
    expect(wrong).toEqual([]);
  });

  test("icon.ico carries exactly the sizes the generator packs, each a real PNG of that size", () => {
    const ico = readFileSync(join(ICONS_DIR, "icon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(icoSizes.length);

    const seen: number[] = [];
    for (let i = 0; i < icoSizes.length; i += 1) {
      const at = 6 + i * 16;
      const declared = icoSizes[i]!;
      // ICO spells 256 as 0 in a single byte, which is the one field width the format never grew.
      expect(ico.readUInt8(at)).toBe(declared >= 256 ? 0 : declared);
      expect(ico.readUInt8(at + 1)).toBe(declared >= 256 ? 0 : declared);
      const length = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      const { width, height } = pngDimensions(ico.subarray(offset, offset + length));
      expect(width).toBe(declared);
      expect(height).toBe(declared);
      seen.push(width);
    }
    expect(seen).toEqual(icoSizes);
  });

  test("icon.icns is well formed and carries one member per declared entry", () => {
    const icns = readFileSync(join(ICONS_DIR, "icon.icns"));
    expect(icns.subarray(0, 4).toString("latin1")).toBe("icns");
    // A truncated or concatenated icns still opens with the magic; the declared length is what
    // says the file is the one the tool wrote.
    expect(icns.readUInt32BE(4)).toBe(icns.length);

    const types: string[] = [];
    let at = 8;
    while (at < icns.length) {
      const type = icns.subarray(at, at + 4).toString("latin1");
      const length = icns.readUInt32BE(at + 4);
      expect(length).toBeGreaterThanOrEqual(8);
      expect(at + length).toBeLessThanOrEqual(icns.length);
      types.push(type);
      at += length;
    }
    // The walk has to land exactly on the end, or some member lied about its length.
    expect(at).toBe(icns.length);
    // 'TOC ' and 'info' are bookkeeping the tool adds; the rest are the images.
    const images = types.filter(type => type !== "TOC " && type !== "info");
    expect(images.length).toBe(icnsMembers.length);
  });

  test("nothing is hand-added beside the generated set", () => {
    const generated = new Set([...pngs.keys(), "icon.ico", "icon.icns", "icon.svg"]);
    const stray = readdirSync(ICONS_DIR)
      .filter(name => statSync(join(ICONS_DIR, name)).isFile())
      .filter(name => !generated.has(name))
      .sort();
    expect(stray).toEqual([]);
  });
});
