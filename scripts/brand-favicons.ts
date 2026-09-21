#!/usr/bin/env bun
/**
 * Render the favicons the dashboard and the documentation site serve from the app icon vector.
 *
 * They used to be hand-made bitmaps with no source, and one of them was wrong in a way the file
 * itself does not show: docs-site/public/favicon.png was the dark variant of the mark, white on
 * transparency, 98.3% covered. A browser tab strip is light by default, so the documentation
 * site's favicon was white on white. The .ico beside it carried the same artwork at 16, 32 and 48.
 *
 * Sizes and names here are the ones gui/index.html and docs-site/astro.config.mjs already
 * reference, so nothing on either site has to change to pick these up.
 *
 * --check regenerates into a temporary directory and compares byte for byte, the same contract
 * desktop/scripts/generate-icons.ts has for the app icon set.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIco, render } from "./lib/icon-render";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repoRoot, "desktop", "src-tauri", "icons", "icon.svg");

/** Favicon PNGs the two sites reference, by path relative to the repository root. */
const FAVICON_SIZES: Record<string, number> = {
  "gui/public/favicon.png": 128,
  "docs-site/public/favicon.png": 192,
};

/** The documentation site's .ico, which Starlight names directly, and the sizes it carries. */
const ICO_OUTPUT = "docs-site/public/favicon.ico";
const ICO_SIZES = [16, 32, 48];

/** Scratch files are flat, so a nested output name becomes one path segment. */
function scratchName(output: string): string {
  return output.replaceAll("/", "__");
}

function generateInto(target: string): string[] {
  const produced: string[] = [];
  for (const [output, size] of Object.entries(FAVICON_SIZES)) {
    render(size, join(target, scratchName(output)), source);
    produced.push(output);
  }

  const parts: Array<{ size: number; bytes: Buffer }> = [];
  for (const size of ICO_SIZES) {
    const scratch = join(target, `.ico-${size}.png`);
    render(size, scratch, source);
    parts.push({ size, bytes: readFileSync(scratch) });
    rmSync(scratch, { force: true });
  }
  writeFileSync(join(target, scratchName(ICO_OUTPUT)), buildIco(parts));
  produced.push(ICO_OUTPUT);

  return produced;
}

function main(): number {
  if (!existsSync(source)) {
    console.error(`[favicons] missing source: ${source}`);
    return 1;
  }
  const check = process.argv.includes("--check");
  const scratch = mkdtempSync(join(tmpdir(), "ocx-favicons-"));
  try {
    const produced = generateInto(scratch);
    if (!check) {
      // Written in one pass at the end, so a renderer failure part way through cannot leave one
      // site on the new mark and the other on the old one.
      for (const output of produced) {
        writeFileSync(join(repoRoot, output), readFileSync(join(scratch, scratchName(output))));
      }
      console.log(`[favicons] regenerated ${produced.length} favicons from ${basename(source)}`);
      return 0;
    }

    const drifted = produced.filter(output => {
      const committed = join(repoRoot, output);
      if (!existsSync(committed)) return true;
      return !readFileSync(join(scratch, scratchName(output))).equals(readFileSync(committed));
    });
    if (drifted.length > 0) {
      console.error(`[favicons] these do not match the app icon vector: ${drifted.join(", ")}`);
      console.error("[favicons] regenerate with: bun run favicons");
      return 1;
    }
    console.log(`[favicons] ${produced.length} favicons match the source`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(main());

