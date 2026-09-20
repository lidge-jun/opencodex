#!/usr/bin/env bun
/**
 * Render every app icon from `src-tauri/icons/icon.svg`.
 *
 * The icon set used to be eighteen independent raster files with no vector source, so each size
 * was a separate artifact that could drift from the others and nothing could detect it. This makes
 * the sizes derived: one curve, rendered at each dimension the platforms ask for.
 *
 * The SVG reproduces the raster it replaced to within antialiasing (430 of 262144 pixels at 512),
 * measured rather than assumed — the geometry in that file was read off the original bitmap.
 *
 * `--check` regenerates into a temporary directory and compares, so CI can fail on a hand-edited
 * PNG instead of letting the source and the shipped icons disagree quietly.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const iconsDir = join(desktopDir, "src-tauri", "icons");
const source = join(iconsDir, "icon.svg");

/** Square PNGs Tauri and the Windows store manifests reference, by output filename. */
const PNG_SIZES: Record<string, number> = {
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
  "Square30x30Logo.png": 30,
  "Square44x44Logo.png": 44,
  "Square71x71Logo.png": 71,
  "Square89x89Logo.png": 89,
  "Square107x107Logo.png": 107,
  "Square142x142Logo.png": 142,
  "Square150x150Logo.png": 150,
  "Square284x284Logo.png": 284,
  "Square310x310Logo.png": 310,
  "StoreLogo.png": 50,
};

/** Sizes an .icns carries, as iconutil names them. */
const ICNS_ENTRIES: Array<{ name: string; size: number }> = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

/** Sizes packed into the .ico, which stores each one as an embedded PNG. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/**
 * The menu bar image, which is the same mark with no backdrop and the prompt cut through.
 *
 * It needs its own source because a status item is a template image: macOS reads the alpha as
 * coverage and paints it with the menu bar tint, so the backdrop has to be gone rather than
 * recoloured. 44px is 22pt at @2x, which is the menu bar working height and the size this asset
 * already shipped at.
 */
const TRAY_OUTPUT = "tray/icon.png";
const TRAY_SIZE = 44;
const traySource = join(iconsDir, "tray", "icon.svg");

function render(size: number, out: string, from: string = source): void {
  const result = spawnSync("rsvg-convert", ["-w", String(size), "-h", String(size), from, "-o", out]);
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString().trim() ?? "unknown error";
    throw new Error(`rsvg-convert failed for ${size}px: ${detail}`);
  }
}

/**
 * Pack PNGs into an ICO.
 *
 * Written here rather than shelled out because the alternative is ImageMagick, and adding a
 * system dependency to regenerate an icon is a worse trade than 30 lines of a container format
 * that has not changed in decades. A 256px entry records its dimension as 0, which is how ICO
 * spells "256".
 */
function buildIco(entries: Array<{ size: number; bytes: Buffer }>): Buffer {
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

/**
 * Render the whole set into `target`, and report which artifacts were actually produced.
 *
 * The return value matters: `iconutil` is macOS-only, so on another platform no `.icns` exists to
 * compare against. Reporting that is the difference between "the icns matches" and "nothing looked
 * at the icns", and the check must not spell the second as the first.
 */
function generateInto(target: string): { produced: string[]; icnsSkipped: boolean } {
  mkdirSync(target, { recursive: true });
  const produced: string[] = [];
  for (const [name, size] of Object.entries(PNG_SIZES)) {
    render(size, join(target, name));
    produced.push(name);
  }

  const iconset = join(target, "icon.iconset");
  mkdirSync(iconset, { recursive: true });
  for (const entry of ICNS_ENTRIES) render(entry.size, join(iconset, entry.name));
  const icns = spawnSync("iconutil", ["-c", "icns", iconset, "-o", join(target, "icon.icns")]);
  const icnsSkipped = icns.status !== 0;
  if (!icnsSkipped) produced.push("icon.icns");
  rmSync(iconset, { recursive: true, force: true });

  const icoParts: Array<{ size: number; bytes: Buffer }> = [];
  for (const size of ICO_SIZES) {
    const scratch = join(target, `.ico-${size}.png`);
    render(size, scratch);
    icoParts.push({ size, bytes: readFileSync(scratch) });
    rmSync(scratch, { force: true });
  }
  writeFileSync(join(target, "icon.ico"), buildIco(icoParts));
  produced.push("icon.ico");

  mkdirSync(join(target, "tray"), { recursive: true });
  render(TRAY_SIZE, join(target, TRAY_OUTPUT), traySource);
  produced.push(TRAY_OUTPUT);

  return { produced, icnsSkipped };
}

function main(): number {
  if (!existsSync(source)) {
    console.error(`[icons] missing source: ${source}`);
    return 1;
  }
  if (!existsSync(traySource)) {
    console.error(`[icons] missing source: ${traySource}`);
    return 1;
  }
  const check = process.argv.includes("--check");
  if (!check) {
    // Render into scratch first so a failure half way through cannot leave the committed set
    // partly replaced, then move the finished artifacts over in one pass.
    const scratch = mkdtempSync(join(tmpdir(), "ocx-icons-"));
    try {
      const { produced, icnsSkipped } = generateInto(scratch);
      if (icnsSkipped) {
        // Abort before touching the committed set. Copying the PNGs and the .ico and then
        // reporting the missing .icns would leave the icons half regenerated: the rasters new,
        // the .icns whatever it was, and no way to tell from the tree which is which.
        console.error("[icons] iconutil is unavailable here, so the .icns cannot be regenerated.");
        console.error("[icons] nothing was written; run this on a machine with iconutil.");
        return 1;
      }
      for (const name of produced) writeFileSync(join(iconsDir, name), readFileSync(join(scratch, name)));
      console.log(`[icons] regenerated ${produced.length} artifacts from ${source}`);
      return 0;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), "ocx-icons-"));
  try {
    const { produced, icnsSkipped } = generateInto(scratch);
    const drifted: string[] = [];
    for (const name of produced) {
      const fresh = join(scratch, name);
      const committed = join(iconsDir, name);
      if (!existsSync(committed) || !readFileSync(fresh).equals(readFileSync(committed))) {
        drifted.push(name);
      }
    }
    if (drifted.length > 0) {
      console.error(`[icons] these do not match their source: ${drifted.join(", ")}`);
      console.error("[icons] regenerate with: bun run icons");
      return 1;
    }
    console.log(`[icons] ${produced.length} generated icons match the source`);
    if (icnsSkipped) {
      console.error("[icons] iconutil is unavailable here, so icon.icns was NOT compared.");
      return 1;
    }
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(main());
