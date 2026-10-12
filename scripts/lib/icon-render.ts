/**
 * Rendering and packing shared by the icon generators.
 *
 * Two generators read the same vector: desktop/scripts/generate-icons.ts builds the app icon set
 * and the menu bar image, and scripts/brand-favicons.ts builds the favicons the dashboard and the
 * documentation site serve. They shared nothing at first, and the PNG re-encode below is exactly
 * the kind of detail that would have been copied and then fixed in one place only.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

export function render(size: number, out: string, from: string): void {
  const result = spawnSync("rsvg-convert", ["-w", String(size), "-h", String(size), from, "-o", out]);
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString().trim() ?? "unknown error";
    throw new Error(`rsvg-convert failed for ${size}px: ${detail}`);
  }
  writeFileSync(out, toRgba(readFileSync(out)));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = -1;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Undo one PNG scanline filter in place, given the already reconstructed row above. */
function unfilter(kind: number, row: Buffer, prior: Buffer, stride: number): void {
  for (let i = 0; i < row.length; i += 1) {
    const a = i >= stride ? row[i - stride]! : 0;
    const b = prior[i]!;
    const c = i >= stride ? prior[i - stride]! : 0;
    let add = 0;
    if (kind === 1) add = a;
    else if (kind === 2) add = b;
    else if (kind === 3) add = (a + b) >> 1;
    else if (kind === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    } else if (kind !== 0) throw new Error(`unknown PNG filter ${kind}`);
    row[i] = (row[i]! + add) & 0xff;
  }
}

/**
 * Re-encode an 8-bit truecolour PNG as truecolour-with-alpha, and leave one that already has
 * alpha untouched.
 *
 * This exists because the icon has an opaque backdrop. librsvg notices that nothing in the render
 * is transparent and drops the alpha channel, which is a valid PNG and a broken icon: Tauri's
 * `generate_context!` rejects a window icon that is not RGBA, so `bun run build` fails at
 * compile time with "icon ... is not RGBA". Leaving that to the renderer would also make the
 * committed bytes depend on which librsvg drew them.
 */
export function toRgba(bytes: Buffer): Buffer {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("rsvg-convert did not emit a PNG");

  let header: { width: number; height: number } | null = null;
  let colourType = -1;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      colourType = data[9]!;
      if (data[8] !== 8 || data[12] !== 0) throw new Error("PNG is not 8-bit non-interlaced");
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4) };
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (colourType === 6) return bytes;
  if (colourType !== 2 || header === null) throw new Error(`unexpected PNG colour type ${colourType}`);

  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const out = Buffer.alloc(height * (1 + width * 4));
  let prior = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (1 + stride);
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    unfilter(raw[start]!, row, prior, 3);
    const target = y * (1 + width * 4);
    out[target] = 0;
    for (let x = 0; x < width; x += 1) {
      row.copy(out, target + 1 + x * 4, x * 3, x * 3 + 3);
      out[target + 1 + x * 4 + 3] = 0xff;
    }
    prior = row;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(out, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Pack PNGs into an ICO.
 *
 * Written here rather than shelled out because the alternative is ImageMagick, and adding a
 * system dependency to regenerate an icon is a worse trade than 30 lines of a container format
 * that has not changed in decades. A 256px entry records its dimension as 0, which is how ICO
 * spells "256".
 */
export function buildIco(entries: Array<{ size: number; bytes: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette colours
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.bytes.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.bytes.length;
  });

  return Buffer.concat([header, directory, ...entries.map(entry => entry.bytes)]);
}
