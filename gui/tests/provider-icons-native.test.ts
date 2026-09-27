import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { providerIconAliasEntries, providerIconPaint } from "../src/provider-icons";

// The native menu bar panel embeds its own copy of the alias table
// (desktop/src-tauri/src/provider_icons.rs). Reading the Rust source as data keeps the two in step
// without a build step: an alias, file, or paint mode missing on either side fails here.
const root = join(import.meta.dir, "..", "..");
const rust = readFileSync(join(root, "desktop/src-tauri/src/provider_icons.rs"), "utf8");

function rustAliases(): Array<[string, string]> {
  const table = rust.slice(rust.indexOf("const ALIASES"), rust.indexOf("];", rust.indexOf("const ALIASES")));
  return [...table.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map(match => [match[1]!, match[2]!]);
}

function rustPaint(file: string): string {
  const body = rust.slice(rust.indexOf("fn paint("), rust.indexOf("fn svg("));
  // Each match arm is `"a.svg" | "b.svg" => "mode"`; anything unlisted falls through to image.
  for (const arm of body.matchAll(/((?:"[^"]+\.svg"\s*\|?\s*)+)=>\s*"([^"]+)"/g)) {
    if ([...arm[1]!.matchAll(/"([^"]+)"/g)].some(match => match[1] === file)) return arm[2]!;
  }
  return "image";
}

describe("native provider marks", () => {
  test("the Rust alias table is the dashboard's alias table", () => {
    const sort = (rows: Array<[string, string]>) => [...rows].sort((a, b) => a[0].localeCompare(b[0]));
    expect(sort(rustAliases())).toEqual(sort(providerIconAliasEntries()));
  });

  test("each file is painted the same way and exists", () => {
    const files = new Set(providerIconAliasEntries().map(([, file]) => file));
    for (const file of files) {
      expect({ file, paint: rustPaint(file) }).toEqual({ file, paint: providerIconPaint(`/provider-icons/${file}`) });
      expect(existsSync(join(root, "gui/public/provider-icons", file))).toBe(true);
      expect(rust).toContain(`svg!("${file}")`);
    }
  });
});
