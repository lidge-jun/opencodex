/**
 * Copy missing English keys into the base locale catalogs (to be translated before shipping).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { en } from "../src/i18n/en.ts";

const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n");

for (const file of readdirSync(directory).filter(file => /^(?!en\.ts$)[a-z]{2}(?:-[A-Z]{2})?\.ts$/.test(file)).sort()) {
  const loc = file.slice(0, -3);
  const path = join(directory, file);
  // A spread from a shared copy table counts as a translation. Inspect the base
  // catalog itself so runtime overlays cannot hide keys missing from the file.
  const catalog = (await import(pathToFileURL(path).href))[loc === "zh-TW" ? "zhTW" : loc];
  const missing = Object.entries(en).filter(([key]) => !Object.hasOwn(catalog, key));
  if (missing.length === 0) {
    console.log(`${loc}: up to date`);
    continue;
  }
  const block = missing
    .map(([key, value]) => `  "${key}": ${JSON.stringify(value)},`)
    .join("\n");

  const text = readFileSync(path, "utf8");
  const close = /\r?\n\}(?: as const| satisfies Record<TKey, string>)?;[ \t]*$/m;
  if (!close.test(text)) {
    throw new Error(`${path}: missing closing brace for locale object`);
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(path, text.replace(close, closing => newline + block.replaceAll("\n", newline) + closing));
  console.log(`${loc}: added ${missing.length} keys`);
}
