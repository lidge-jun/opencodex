#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIco, render } from "./lib/icon-render";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(root, "src", "tray", "assets");
const names = ["online", "warning", "offline"] as const;
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const;

function frames(bytes: Buffer): Map<number, Buffer> {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    throw new Error("invalid tray ICO header");
  }
  const count = bytes.readUInt16LE(4);
  if (count !== sizes.length) throw new Error(`tray ICO has ${count} frames, expected ${sizes.length}`);
  const result = new Map<number, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const at = 6 + 16 * i;
    if (at + 16 > bytes.length) throw new Error("truncated tray ICO directory");
    const size = bytes[at] || 256;
    const height = bytes[at + 1] || 256;
    const length = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    if (size !== height || !sizes.includes(size as typeof sizes[number]) || offset + length > bytes.length) {
      throw new Error("invalid tray ICO frame bounds or size");
    }
    const png = bytes.subarray(offset, offset + length);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("tray ICO frame is not PNG");
    }
    if (result.has(size)) throw new Error(`duplicate ${size}px tray ICO frame`);
    result.set(size, png);
  }
  if (sizes.some(size => !result.has(size))) throw new Error("tray ICO frame missing");
  return result;
}

function dottedFrame(base: Buffer, size: number, scratch: string): Buffer {
  const center = size * 0.79;
  const radius = Math.max(2, size * 0.115);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<image width="${size}" height="${size}" href="data:image/png;base64,${base.toString("base64")}"/>`
    + `<circle cx="${center}" cy="${center}" r="${radius + Math.max(1, size * 0.035)}" fill="#ffffff"/>`
    + `<circle cx="${center}" cy="${center}" r="${radius}" fill="#1683ff"/></svg>`;
  const source = join(scratch, `frame-${size}.svg`);
  const output = join(scratch, `frame-${size}.png`);
  writeFileSync(source, svg);
  render(size, output, source);
  return readFileSync(output);
}

function generated(name: typeof names[number], scratch: string): Buffer {
  const source = readFileSync(join(assets, `opencodex-tray-${name}.ico`));
  const originals = frames(source);
  return buildIco(sizes.map(size => ({ size, bytes: dottedFrame(originals.get(size)!, size, scratch) })));
}

function main(): number {
  const check = process.argv.slice(2).includes("--check");
  const scratch = mkdtempSync(join(tmpdir(), "ocx-tray-icons-"));
  try {
    let drift = false;
    for (const name of names) {
      const output = join(assets, `opencodex-tray-${name}-update.ico`);
      const expected = generated(name, scratch);
      if (check) {
        if (!existsSync(output) || !readFileSync(output).equals(expected)) {
          console.error(`[tray-icons] stale: ${name}-update.ico`);
          drift = true;
        }
      } else {
        writeFileSync(output, expected);
      }
    }
    if (!drift) console.log(check ? "[tray-icons] update ICOs match" : "[tray-icons] wrote update ICOs");
    return drift ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(main());
